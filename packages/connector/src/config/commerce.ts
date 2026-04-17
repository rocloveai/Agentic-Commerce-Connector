// ---------------------------------------------------------------------------
// Commerce platform configuration (discriminated union).
//
// Each platform defines its own shape in its adapter directory; this module
// merely reads the `PLATFORM` env var and dispatches to the correct loader.
// Keeping platform-specific env vars here makes "which vars belong to which
// platform" a compile-time guarantee.
//
// Shopify is further split into two modes (discriminated on `mode`):
//   - `manual` — operator pastes Admin + Storefront tokens into env.
//   - `oauth`  — operator supplies a Partners app client_id/secret; tokens
//                are minted at install time and persisted (Phase 3+).
// The presence of SHOPIFY_CLIENT_ID at boot selects OAuth mode; absent,
// we fall back to manual mode (the original behaviour).
// ---------------------------------------------------------------------------

export type PlatformType = "shopify" | "woocommerce";

interface ShopifyCommon {
  readonly platform: "shopify";
  readonly shopifyApiVersion: string;
  readonly storeUrl: string;
}

export interface ShopifyManualEnv extends ShopifyCommon {
  readonly mode: "manual";
  readonly shopifyStoreUrl: string;
  readonly shopifyStorefrontToken: string;
  readonly shopifyAdminToken: string;
}

export interface ShopifyOAuthEnv extends ShopifyCommon {
  readonly mode: "oauth";
  readonly shopifyClientId: string;
  readonly shopifyClientSecret: string;
  readonly shopifyOAuthScopes: readonly string[];
  /** Empty string if operator left it unset — server.ts derives from selfUrl. */
  readonly shopifyOAuthRedirect: string;
  /** Empty string until the first OAuth install binds a shop. */
  readonly shopifyStoreUrl: string;
}

export type ShopifyEnv = ShopifyManualEnv | ShopifyOAuthEnv;

export interface WooCommerceEnv {
  readonly platform: "woocommerce";
  readonly wooBaseUrl: string;
  readonly wooConsumerKey: string;
  readonly wooConsumerSecret: string;
  readonly wooApiVersion: string;
  readonly wooRequestTimeoutMs: string | undefined;
  readonly wooMaxRetries: string | undefined;
  readonly storeUrl: string;
}

export type CommerceEnv = ShopifyEnv | WooCommerceEnv;

const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  "read_products",
  "read_inventory",
  "write_orders",
  "read_orders",
];

function parseOAuthScopes(raw: string | undefined): readonly string[] {
  const source = raw && raw.trim() !== "" ? raw : DEFAULT_OAUTH_SCOPES.join(",");
  const scopes = source
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_OAUTH_SCOPES cannot be empty once parsed.",
    );
  }
  return scopes;
}

function loadShopifyOAuthEnv(
  env: Record<string, string | undefined>,
): ShopifyOAuthEnv {
  const clientId = env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    // Defensive — this loader is only reached when the dispatcher already saw
    // SHOPIFY_CLIENT_ID. Keep the check so refactors can't silently break it.
    throw new Error(
      "[Config/Shopify] loadShopifyOAuthEnv invoked without SHOPIFY_CLIENT_ID.",
    );
  }
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_CLIENT_SECRET is required when SHOPIFY_CLIENT_ID is set (OAuth mode). Get it from: Shopify Partners → your app → Client credentials.",
    );
  }

  const scopes = parseOAuthScopes(env.SHOPIFY_OAUTH_SCOPES);
  const storeUrl = env.SHOPIFY_STORE_URL ?? "";

  return {
    platform: "shopify",
    mode: "oauth",
    shopifyClientId: clientId,
    shopifyClientSecret: clientSecret,
    shopifyOAuthScopes: scopes,
    shopifyOAuthRedirect: env.SHOPIFY_OAUTH_REDIRECT ?? "",
    shopifyStoreUrl: storeUrl,
    shopifyApiVersion: env.SHOPIFY_API_VERSION ?? "2025-07",
    storeUrl,
  };
}

function loadShopifyManualEnv(
  env: Record<string, string | undefined>,
): ShopifyManualEnv {
  const shopifyStoreUrl = env.SHOPIFY_STORE_URL;
  if (!shopifyStoreUrl) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_STORE_URL is required. Get it from: your myshopify.com admin URL.",
    );
  }
  const shopifyStorefrontToken = env.SHOPIFY_STOREFRONT_TOKEN;
  if (!shopifyStorefrontToken) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_STOREFRONT_TOKEN is required in manual mode. Get it from: Shopify admin → Settings → Apps → Develop apps → your app → API credentials → Storefront API access token. To use OAuth instead, set SHOPIFY_CLIENT_ID.",
    );
  }

  return {
    platform: "shopify",
    mode: "manual",
    shopifyStoreUrl,
    shopifyStorefrontToken,
    shopifyAdminToken: env.SHOPIFY_ADMIN_TOKEN ?? "",
    shopifyApiVersion: env.SHOPIFY_API_VERSION ?? "2025-07",
    storeUrl: shopifyStoreUrl,
  };
}

function loadShopifyEnv(
  env: Record<string, string | undefined>,
): ShopifyEnv {
  const hasClientId = env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_ID.trim() !== "";
  return hasClientId ? loadShopifyOAuthEnv(env) : loadShopifyManualEnv(env);
}

function loadWooCommerceEnv(
  env: Record<string, string | undefined>,
): WooCommerceEnv {
  const wooBaseUrl = env.WOO_BASE_URL;
  if (!wooBaseUrl) {
    throw new Error(
      "[Config/Woo] WOO_BASE_URL is required. Get it from: the HTTPS URL of your WordPress site (e.g. https://store.example.com).",
    );
  }
  const wooConsumerKey = env.WOO_CONSUMER_KEY;
  if (!wooConsumerKey) {
    throw new Error(
      "[Config/Woo] WOO_CONSUMER_KEY is required. Get it from: WooCommerce admin → Settings → Advanced → REST API → Add Key (Read/Write).",
    );
  }
  const wooConsumerSecret = env.WOO_CONSUMER_SECRET;
  if (!wooConsumerSecret) {
    throw new Error(
      "[Config/Woo] WOO_CONSUMER_SECRET is required. Shown once when generating the REST API key; copy it then.",
    );
  }

  return {
    platform: "woocommerce",
    wooBaseUrl,
    wooConsumerKey,
    wooConsumerSecret,
    wooApiVersion: env.WOO_API_VERSION ?? "wc/v3",
    wooRequestTimeoutMs: env.WOO_REQUEST_TIMEOUT_MS,
    wooMaxRetries: env.WOO_MAX_RETRIES,
    storeUrl: wooBaseUrl,
  };
}

export function loadCommerceEnv(
  env: Record<string, string | undefined>,
): CommerceEnv {
  const platform = (env.PLATFORM ?? "shopify") as PlatformType;
  switch (platform) {
    case "shopify":
      return loadShopifyEnv(env);
    case "woocommerce":
      return loadWooCommerceEnv(env);
    default:
      throw new Error(
        `[Config] Unsupported PLATFORM: "${platform}". Expected "shopify" or "woocommerce".`,
      );
  }
}
