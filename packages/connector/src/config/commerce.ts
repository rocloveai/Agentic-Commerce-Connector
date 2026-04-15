// ---------------------------------------------------------------------------
// Commerce platform configuration (discriminated union).
//
// Each platform defines its own shape in its adapter directory; this module
// merely reads the `PLATFORM` env var and dispatches to the correct loader.
// Keeping platform-specific env vars here makes "which vars belong to which
// platform" a compile-time guarantee.
// ---------------------------------------------------------------------------

export type PlatformType = "shopify" | "woocommerce";

export interface ShopifyEnv {
  readonly platform: "shopify";
  readonly shopifyStoreUrl: string;
  readonly shopifyStorefrontToken: string;
  readonly shopifyAdminToken: string;
  readonly shopifyApiVersion: string;
  readonly storeUrl: string;
}

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

function loadShopifyEnv(
  env: Record<string, string | undefined>,
): ShopifyEnv {
  const shopifyStoreUrl = env.SHOPIFY_STORE_URL;
  if (!shopifyStoreUrl) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_STORE_URL is required. Get it from: your myshopify.com admin URL.",
    );
  }
  const shopifyStorefrontToken = env.SHOPIFY_STOREFRONT_TOKEN;
  if (!shopifyStorefrontToken) {
    throw new Error(
      "[Config/Shopify] SHOPIFY_STOREFRONT_TOKEN is required. Get it from: Shopify admin → Settings → Apps → Develop apps → your app → API credentials → Storefront API access token.",
    );
  }

  return {
    platform: "shopify",
    shopifyStoreUrl,
    shopifyStorefrontToken,
    shopifyAdminToken: env.SHOPIFY_ADMIN_TOKEN ?? "",
    shopifyApiVersion: env.SHOPIFY_API_VERSION ?? "2025-07",
    storeUrl: shopifyStoreUrl,
  };
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
