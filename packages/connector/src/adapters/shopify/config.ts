// ---------------------------------------------------------------------------
// Shopify-specific platform configuration
// ---------------------------------------------------------------------------

export interface ShopifyPlatformConfig {
  readonly storeUrl: string;
  readonly storefrontToken: string;
  readonly adminToken: string;
  readonly apiVersion: string;
}

export function validateShopifyConfig(
  env: Record<string, string | undefined>,
): ShopifyPlatformConfig {
  const storeUrl = env.SHOPIFY_STORE_URL;
  if (!storeUrl) {
    throw new Error("[ShopifyConfig] SHOPIFY_STORE_URL is required");
  }

  const storefrontToken = env.SHOPIFY_STOREFRONT_TOKEN;
  if (!storefrontToken) {
    throw new Error("[ShopifyConfig] SHOPIFY_STOREFRONT_TOKEN is required");
  }

  return {
    storeUrl,
    storefrontToken,
    adminToken: env.SHOPIFY_ADMIN_TOKEN ?? "",
    apiVersion: env.SHOPIFY_API_VERSION ?? "2025-07",
  };
}
