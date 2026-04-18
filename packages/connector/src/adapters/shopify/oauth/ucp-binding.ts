// ---------------------------------------------------------------------------
// Lazy UCP deps resolver for OAuth-only mode.
//
// In OAuth-only mode the adapter pair can't exist at boot: there's no Shopify
// token to talk to until a merchant completes the install flow. This resolver
// reads the current active installation on each UCP request, checks whether
// the admin token is close to expiry, refreshes it via the shared relay if
// so, and builds (or returns a cached) UcpDeps bound to the current token.
//
// Single-tenant assumption: each ACC instance serves exactly one merchant
// store. If more than one active installation exists, we pick the most
// recently installed and log a warning — multi-tenant routing is a separate
// design problem (header/subdomain scoping) out of scope here.
//
// Cache keying: (shopDomain, adminToken-prefix). A token refresh rotates the
// token value → cache miss → adapter rebuild against the new token. Uninstall
// sets uninstalledAt; we filter uninstalled installations out before picking,
// so cache naturally goes cold on uninstall.
// ---------------------------------------------------------------------------
import type { Config } from "../../../config.js";
import type { CartTokenConfig } from "../../../ucp/cart-token.js";
import type { UcpDeps } from "../../../ucp/routes.js";
import type { UcpPaymentHandlerT } from "../../../ucp/types.js";
import type { InstallationStore } from "./installation-store.js";
import type { ShopInstallation } from "./types.js";
import { createShopifyAdaptersFromInstallation } from "./adapter-factory.js";
import { refreshViaRelay, RelayRefreshRejected } from "./relay-refresh.js";

/**
 * Refresh the admin token when the current one has <5min remaining. This
 * window absorbs clock skew between our server and Shopify's, and the
 * latency of a round-trip to the relay without letting a real request
 * fire on an about-to-die token.
 */
const REFRESH_WINDOW_SEC = 300;

export interface OauthUcpResolverOptions {
  readonly config: Config;
  readonly installationStore: InstallationStore;
  readonly apiVersion: string;
  readonly ucpEndpoint: string;
  readonly cartTokenConfig: CartTokenConfig;
  readonly paymentHandlers: readonly UcpPaymentHandlerT[];
  /**
   * Base URL of the shared install-relay — e.g. `https://install.xagenpay.com`.
   * Required when installations carry a `refreshToken` (post-Dec-2025 tokens).
   * If omitted, we skip refresh even when tokens are near expiry; UCP calls
   * will start failing once Shopify rejects the expired token, and the
   * merchant will need to re-install. Operators running in Custom-App mode
   * (their own Partners app with client_secret in env) can pass `null` and
   * swap the refresh mechanism later.
   */
  readonly relayUrl: string | null;
}

export type UcpBindingResult =
  | { readonly kind: "ready"; readonly deps: UcpDeps; readonly shopDomain: string }
  | { readonly kind: "no-installation" };

/**
 * Returns a function that, when called, resolves the current installation
 * into UcpDeps. Safe to call on every UCP request — caches by
 * (shopDomain, adminToken prefix). Thread-safe only in the sense that Node
 * is single-threaded; concurrent calls during a refresh may trigger two
 * refreshes in a race window, which is harmless — the second just rotates
 * the token again.
 */
export function createOauthUcpResolver(
  opts: OauthUcpResolverOptions,
): () => Promise<UcpBindingResult> {
  let cache: { key: string; deps: UcpDeps; shopDomain: string } | null = null;
  let multiTenantWarned = false;

  return async () => {
    const all = await opts.installationStore.list();
    const active = all.filter((i) => i.uninstalledAt === null);
    if (active.length === 0) {
      return { kind: "no-installation" };
    }

    if (active.length > 1 && !multiTenantWarned) {
      console.error(
        `[UcpResolver] Multiple active installations (${active.length}) detected; serving UCP for the most recently installed. Multi-tenant routing is not supported in this mode.`,
      );
      multiTenantWarned = true;
    }

    let installation = active.reduce((a, b) =>
      a.installedAt > b.installedAt ? a : b,
    );

    // Refresh admin token if it's expiring soon. Only applies to post-Dec-2025
    // installations (those with refreshToken + tokenExpiresAt). Skips silently
    // for legacy non-expiring tokens and for Custom-App mode (no relayUrl).
    installation = await maybeRefresh(
      installation,
      opts.installationStore,
      opts.relayUrl,
    );

    // Cache key covers both re-grant (new installedAt) and token refresh
    // (same installedAt, rotated adminToken). Using the token fingerprint
    // rather than the full token keeps the string short and avoids leaking
    // tokens if cache keys ever end up in logs.
    const tokenFingerprint = installation.adminToken.slice(0, 8);
    const key = `${installation.shopDomain}:${installation.installedAt}:${tokenFingerprint}`;
    if (cache && cache.key === key) {
      return { kind: "ready", deps: cache.deps, shopDomain: cache.shopDomain };
    }

    const { catalog, merchant } = createShopifyAdaptersFromInstallation(
      installation,
      { apiVersion: opts.apiVersion },
    );
    const deps: UcpDeps = {
      config: opts.config,
      catalog,
      merchant,
      cartTokenConfig: opts.cartTokenConfig,
      paymentHandlers: opts.paymentHandlers,
      ucpEndpoint: opts.ucpEndpoint,
    };
    cache = { key, deps, shopDomain: installation.shopDomain };
    return { kind: "ready", deps, shopDomain: installation.shopDomain };
  };
}

async function maybeRefresh(
  installation: ShopInstallation,
  store: InstallationStore,
  relayUrl: string | null,
): Promise<ShopInstallation> {
  // Legacy non-expiring token (no expires_at set): nothing to refresh.
  if (installation.tokenExpiresAt === null) return installation;
  // No refresh_token available (e.g. Custom-App mode): can't refresh.
  if (!installation.refreshToken) return installation;
  // Still plenty of time left.
  const nowSec = Math.floor(Date.now() / 1000);
  if (installation.tokenExpiresAt > nowSec + REFRESH_WINDOW_SEC) {
    return installation;
  }
  // Need to refresh but no relay configured → surface the problem loudly once
  // and fall through with the old token; Shopify will 401, the UCP request
  // will 502, and the operator will see why.
  if (!relayUrl) {
    console.error(
      `[UcpResolver] admin token for ${installation.shopDomain} is expiring at ${installation.tokenExpiresAt} but no relayUrl configured. Set ACC_INSTALL_RELAY_URL to enable auto-refresh.`,
    );
    return installation;
  }

  try {
    const fresh = await refreshViaRelay({
      relayUrl,
      shopDomain: installation.shopDomain,
      refreshToken: installation.refreshToken,
    });
    const updated: ShopInstallation = {
      ...installation,
      adminToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? installation.refreshToken,
      tokenExpiresAt: fresh.expiresAt,
      scopes: fresh.scopes ?? installation.scopes,
    };
    await store.save(updated);
    console.error(
      `[UcpResolver] refreshed admin token for ${installation.shopDomain}; new expires_at=${updated.tokenExpiresAt}`,
    );
    return updated;
  } catch (err) {
    if (err instanceof RelayRefreshRejected) {
      // Refresh-token dead (rotated by someone else, revoked, or expired).
      // Log loudly — merchant needs to re-install.
      console.error(
        `[UcpResolver] refresh-token rejected for ${installation.shopDomain}; merchant must re-install. Relay said: ${err.message}`,
      );
    } else {
      console.error(
        `[UcpResolver] refresh failed for ${installation.shopDomain}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return installation;
  }
}
