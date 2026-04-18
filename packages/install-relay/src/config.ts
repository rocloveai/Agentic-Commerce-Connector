// ---------------------------------------------------------------------------
// Install-relay configuration.
//
// This service holds the shared Shopify Partners app credentials (one app
// used by every merchant who adopts ACC). It is *not* the merchant's
// connector — it does the OAuth dance on their behalf and relays tokens
// back to the merchant's CLI via short-lived pair codes.
//
// Deployment model: runs on the same infra as acc.xagenpay.com but on a
// separate subdomain (install.xagenpay.com) with its own systemd unit so a
// bug here can't take out merchant instances.
// ---------------------------------------------------------------------------

export interface RelayConfig {
  /** Absolute public URL of this service, no trailing slash. */
  readonly selfUrl: string;
  /** Port to bind on localhost (nginx reverse-proxies to this). */
  readonly port: number;
  /** Shopify Partners app client_id (shared across all merchants). */
  readonly shopifyClientId: string;
  /** Shopify Partners app client_secret. */
  readonly shopifyClientSecret: string;
  /** Scopes requested in OAuth authorize URL. */
  readonly shopifyScopes: readonly string[];
  /** Admin API version used for storefront-token provisioning. */
  readonly shopifyApiVersion: string;
  /** Filesystem path for the SQLite pair-store DB. */
  readonly pairDbPath: string;
  /** How long a pair code is valid after creation (seconds). */
  readonly pairTtlSeconds: number;
}

const DEFAULT_SCOPES = [
  "read_products",
  "read_inventory",
  "read_orders",
  "write_orders",
];

function parsePort(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  if (isNaN(n) || n < 1 || n > 65535) {
    throw new Error(`[install-relay/Config] invalid port "${raw}"`);
  }
  return n;
}

export function loadRelayConfig(
  env: Record<string, string | undefined> = process.env,
): RelayConfig {
  const selfUrl = (env.RELAY_SELF_URL ?? "").replace(/\/+$/, "");
  if (!selfUrl.startsWith("https://") && !selfUrl.startsWith("http://")) {
    throw new Error(
      "[install-relay/Config] RELAY_SELF_URL must be an absolute http(s) URL.",
    );
  }

  const shopifyClientId = env.SHOPIFY_CLIENT_ID ?? "";
  const shopifyClientSecret = env.SHOPIFY_CLIENT_SECRET ?? "";
  if (!shopifyClientId || !shopifyClientSecret) {
    throw new Error(
      "[install-relay/Config] SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required.",
    );
  }

  const scopesRaw = env.SHOPIFY_OAUTH_SCOPES;
  const scopes = scopesRaw
    ? scopesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : DEFAULT_SCOPES;

  const pairTtlRaw = env.RELAY_PAIR_TTL_SECONDS;
  const pairTtlSeconds = pairTtlRaw ? parseInt(pairTtlRaw, 10) : 900;
  if (isNaN(pairTtlSeconds) || pairTtlSeconds < 60 || pairTtlSeconds > 3600) {
    throw new Error(
      "[install-relay/Config] RELAY_PAIR_TTL_SECONDS must be 60-3600.",
    );
  }

  return {
    selfUrl,
    port: parsePort(env.RELAY_PORT, 10020),
    shopifyClientId,
    shopifyClientSecret,
    shopifyScopes: scopes,
    shopifyApiVersion: env.SHOPIFY_API_VERSION ?? "2025-07",
    pairDbPath: env.RELAY_PAIR_DB_PATH ?? "/var/lib/acc-install-relay/pairs.sqlite",
    pairTtlSeconds,
  };
}
