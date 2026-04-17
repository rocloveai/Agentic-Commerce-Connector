// ---------------------------------------------------------------------------
// OAuth install + callback HTTP handlers.
//
// Pure route handlers — take req/res/deps, return when response is sent. No
// singletons, no process.env reads, no network side-effects outside the
// injected fetchImpl. That makes them trivially testable.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import type { InstallationStore } from "./installation-store.js";
import type { OAuthConfig, StateStore } from "./types.js";
import { assertShopDomain } from "./shop-domain.js";
import { verifyCallbackHmac } from "./hmac.js";
import { exchangeCodeForToken } from "./token-exchange.js";
import { createStorefrontToken } from "./storefront.js";
import {
  registerWebhooks,
  type RegisteredWebhook,
} from "./webhooks-register.js";
import { renderAdminShopifyPage } from "./admin-page.js";
import { checkAdminBearer } from "./admin-auth.js";

/**
 * Maximum allowed skew (in seconds) between Shopify's timestamp and local
 * clock. Matches the state nonce TTL — a callback older than the state
 * store's TTL would already fail state consumption, so being consistent
 * avoids one failure mode dominating another.
 */
export const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

export interface OAuthRouteDeps {
  readonly oauthConfig: OAuthConfig;
  readonly stateStore: StateStore;
  readonly installationStore: InstallationStore;
  /**
   * Public HTTPS URL of this connector — used to build webhook callback
   * URLs ({selfUrl}/webhooks/shopify/*) and reinstall links on the admin
   * page. If empty, webhook registration is skipped with a recorded reason.
   */
  readonly selfUrl: string;
  /**
   * Bearer token gating /admin/shopify and /admin/shopify/rotate-storefront.
   * Empty → those routes fail closed with a 503 telling the operator to set
   * PORTAL_TOKEN in env.
   */
  readonly adminBearer: string;
  /** Injectable fetch for the token exchange; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock; defaults to Date.now. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Tiny response helpers — kept local so the oauth module has no portal dep.
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

// ---------------------------------------------------------------------------
// Install — redirect to Shopify's authorize endpoint with a fresh state.
// ---------------------------------------------------------------------------

export async function handleInstall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): Promise<void> {
  const url = parseUrl(req);
  const shopParam = url.searchParams.get("shop");

  let shop: string;
  try {
    shop = assertShopDomain(shopParam);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_shop",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!deps.oauthConfig.redirectUri) {
    sendJson(res, 500, {
      error: "missing_redirect_uri",
      message:
        "SHOPIFY_OAUTH_REDIRECT is empty and no fallback was derived from SELF_URL. Set one in env.",
    });
    return;
  }

  const state = deps.stateStore.issue(shop);

  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", deps.oauthConfig.clientId);
  authorize.searchParams.set("scope", deps.oauthConfig.scopes.join(","));
  authorize.searchParams.set("redirect_uri", deps.oauthConfig.redirectUri);
  authorize.searchParams.set("state", state);

  sendRedirect(res, authorize.toString());
}

// ---------------------------------------------------------------------------
// Callback — verify signature + state + timestamp, exchange code, persist.
// ---------------------------------------------------------------------------

export async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): Promise<void> {
  const url = parseUrl(req);
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) params[k] = v;

  // 1. Shop domain — done first so HMAC canonicalisation can trust it.
  let shop: string;
  try {
    shop = assertShopDomain(params.shop);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_shop",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 2. HMAC — verified over all params except `hmac`/`signature`.
  if (
    !verifyCallbackHmac(
      params,
      params.hmac ?? "",
      deps.oauthConfig.clientSecret,
    )
  ) {
    sendJson(res, 400, {
      error: "hmac_mismatch",
      message: "HMAC verification failed.",
    });
    return;
  }

  // 3. Timestamp — defensive clock-skew check (see MAX_TIMESTAMP_SKEW_SEC).
  const now = deps.now ?? Date.now;
  const tsStr = params.timestamp;
  const ts = tsStr ? Number(tsStr) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) {
    sendJson(res, 400, {
      error: "bad_timestamp",
      message: "Missing or non-numeric timestamp.",
    });
    return;
  }
  const nowSec = Math.floor(now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_SKEW_SEC) {
    sendJson(res, 400, {
      error: "timestamp_skew",
      message: `Timestamp skew exceeds ${MAX_TIMESTAMP_SKEW_SEC}s.`,
    });
    return;
  }

  // 4. State — single-use, shop-bound, TTL-bounded.
  if (!params.state || !deps.stateStore.consume(params.state, shop)) {
    sendJson(res, 400, {
      error: "state_mismatch",
      message: "state nonce missing, expired, or bound to a different shop.",
    });
    return;
  }

  // 5. Code — required for the token exchange.
  const code = params.code;
  if (!code) {
    sendJson(res, 400, {
      error: "missing_code",
      message: "Callback did not include `code`.",
    });
    return;
  }

  // 6. Exchange.
  let token;
  try {
    token = await exchangeCodeForToken({
      shopDomain: shop,
      clientId: deps.oauthConfig.clientId,
      clientSecret: deps.oauthConfig.clientSecret,
      code,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: "token_exchange_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 7. Storefront token (best-effort — catalog adapter can fall back to
  //    Admin API reads if this fails, per design doc §6.3).
  let storefrontToken: string | null = null;
  const storefrontWarnings: string[] = [];
  try {
    const sf = await createStorefrontToken({
      shopDomain: shop,
      adminToken: token.accessToken,
      apiVersion: deps.oauthConfig.apiVersion,
      fetchImpl: deps.fetchImpl,
    });
    storefrontToken = sf.accessToken;
    if (sf.userErrors.length > 0) {
      storefrontWarnings.push(...sf.userErrors.map((e) => e.message));
    }
  } catch (err) {
    storefrontWarnings.push(err instanceof Error ? err.message : String(err));
  }

  // 8. Webhook registration (best-effort — merchant can re-register from
  //    /admin/shopify later).
  let webhookResults: readonly RegisteredWebhook[] = [];
  if (deps.selfUrl) {
    try {
      webhookResults = await registerWebhooks({
        shopDomain: shop,
        adminToken: token.accessToken,
        apiVersion: deps.oauthConfig.apiVersion,
        selfUrl: deps.selfUrl,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      webhookResults = [
        {
          topic: "APP_UNINSTALLED",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }

  // 9. Persist — one write including storefront token + whatever scopes we got.
  await deps.installationStore.save({
    shopDomain: shop,
    adminToken: token.accessToken,
    storefrontToken,
    scopes: token.scope,
    installedAt: now(),
    uninstalledAt: null,
  });

  // 10. Log non-fatal issues so operators see them in startup logs.
  if (storefrontWarnings.length > 0) {
    console.error(
      `[Shopify/OAuth] storefront token not minted for ${shop}: ${storefrontWarnings.join("; ")}`,
    );
  }
  const webhookFailures = webhookResults.filter((r) => !r.ok);
  if (webhookFailures.length > 0) {
    console.error(
      `[Shopify/OAuth] webhook registration issues for ${shop}: ${webhookFailures
        .map((f) => `${f.topic}=${f.error ?? "?"}`)
        .join("; ")}`,
    );
  }

  // 11. Redirect to the (Phase 6) admin page.
  sendRedirect(
    res,
    `/admin/shopify/installed?shop=${encodeURIComponent(shop)}`,
  );
}

// ---------------------------------------------------------------------------
// Placeholder success page — Phase 6 replaces this with the full status page.
// ---------------------------------------------------------------------------

export async function handleInstalledSuccess(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): Promise<void> {
  const url = parseUrl(req);
  const shopParam = url.searchParams.get("shop") ?? "";
  let shop = "";
  try {
    shop = assertShopDomain(shopParam);
  } catch {
    sendHtml(
      res,
      `<!doctype html><meta charset="utf-8"><title>ACC</title><p>Invalid shop.</p>`,
    );
    return;
  }

  const installation = await deps.installationStore.get(shop);
  const scopes = installation?.scopes.join(", ") ?? "(none)";
  const status = installation ? "connected" : "unknown";

  sendHtml(
    res,
    `<!doctype html>
<meta charset="utf-8">
<title>ACC \u2014 Installed</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1rem;color:#111}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
<h1>\u2705 Connected</h1>
<p>Shop: <code>${shop}</code></p>
<p>Status: <code>${status}</code></p>
<p>Granted scopes: <code>${scopes}</code></p>
<p>Next: open <a href="/admin/shopify"><code>/admin/shopify</code></a> for the full status dashboard (bearer-gated \u2014 set <code>PORTAL_TOKEN</code> in env then pass it as <code>Authorization: Bearer &lt;token&gt;</code> or <code>?token=&lt;token&gt;</code>).</p>`,
  );
}

// ---------------------------------------------------------------------------
// /admin/shopify — status page + scope-drift detection + rotate button.
// Bearer-gated (Authorization header OR ?token= query).
// ---------------------------------------------------------------------------

export async function handleAdminShopify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): Promise<void> {
  const url = parseUrl(req);
  const auth = checkAdminBearer(req, url, deps.adminBearer);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.reason });
    return;
  }
  const installations = await deps.installationStore.list();
  const now = (deps.now ?? Date.now)();
  sendHtml(
    res,
    renderAdminShopifyPage({
      oauthConfig: deps.oauthConfig,
      selfUrl: deps.selfUrl,
      installations,
      bearerToken: deps.adminBearer,
      now,
    }),
  );
}

// ---------------------------------------------------------------------------
// POST /admin/shopify/rotate-storefront — mints a fresh storefront token
// for one shop using the stored admin token; updates the row.
//
// Accepts the bearer in the form body (`token=...`) as well as headers /
// query so the `<form>` on the admin page doesn't need JS to propagate it.
// ---------------------------------------------------------------------------

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    out[k] = v;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleRotateStorefront(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthRouteDeps,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const rawBody = await readBody(req);
  const form = parseForm(rawBody);

  // Accept the bearer either from the header/query OR the form body so the
  // admin page's <form> can post it without JS.
  const url = parseUrl(req);
  const headerAuth = checkAdminBearer(req, url, deps.adminBearer);
  const bodyAuth =
    !form.token || !deps.adminBearer || form.token !== deps.adminBearer
      ? {
          ok: false as const,
          status: 401 as const,
          reason: "invalid_bearer",
        }
      : { ok: true as const };

  if (!headerAuth.ok && !bodyAuth.ok) {
    if (headerAuth.status === 503) {
      sendJson(res, 503, { error: headerAuth.reason });
      return;
    }
    sendJson(res, 401, { error: "invalid_bearer" });
    return;
  }

  let shop: string;
  try {
    shop = assertShopDomain(form.shop);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_shop",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const existing = await deps.installationStore.get(shop);
  if (!existing) {
    sendJson(res, 404, { error: "not_installed" });
    return;
  }
  if (existing.uninstalledAt !== null) {
    sendJson(res, 409, { error: "uninstalled", message: "Reinstall first." });
    return;
  }

  try {
    const result = await createStorefrontToken({
      shopDomain: shop,
      adminToken: existing.adminToken,
      apiVersion: deps.oauthConfig.apiVersion,
      fetchImpl: deps.fetchImpl,
    });
    if (!result.accessToken) {
      sendJson(res, 502, {
        error: "rotate_failed",
        userErrors: result.userErrors,
      });
      return;
    }
    await deps.installationStore.save({
      ...existing,
      storefrontToken: result.accessToken,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: "rotate_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Redirect back to /admin/shopify, carrying the bearer as a query param so
  // the subsequent GET is authorised.
  const back = `/admin/shopify?token=${encodeURIComponent(deps.adminBearer)}`;
  sendRedirect(res, back);
}

// ---------------------------------------------------------------------------
// Router helper — returns a single handler that dispatches all OAuth paths.
// `portal.ts` registers this via registerShopifyOAuthRouter(router).
// ---------------------------------------------------------------------------

export function createShopifyOAuthRouter(deps: OAuthRouteDeps) {
  return async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseUrl(req);
    const path = url.pathname;

    if (req.method === "POST" && path === "/admin/shopify/rotate-storefront") {
      await handleRotateStorefront(req, res, deps);
      return true;
    }

    if (req.method !== "GET") return false;

    if (path === "/auth/shopify/install") {
      await handleInstall(req, res, deps);
      return true;
    }
    if (path === "/auth/shopify/callback") {
      await handleCallback(req, res, deps);
      return true;
    }
    if (path === "/admin/shopify/installed") {
      await handleInstalledSuccess(req, res, deps);
      return true;
    }
    if (path === "/admin/shopify") {
      await handleAdminShopify(req, res, deps);
      return true;
    }
    return false;
  };
}

export type ShopifyOAuthRouter = ReturnType<typeof createShopifyOAuthRouter>;
