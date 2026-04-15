import type { AdapterPair } from "../types.js";
import type { ShopifyPlatformConfig } from "./config.js";
import { createShopifyCatalog } from "./storefront-client.js";
import { createShopifyMerchant } from "./admin-client.js";

// ---------------------------------------------------------------------------
// Shopify adapter factory
// ---------------------------------------------------------------------------

export function createShopifyAdapters(
  shopifyConfig: ShopifyPlatformConfig,
): AdapterPair {
  const catalog = createShopifyCatalog(shopifyConfig);

  // Merchant adapter requires the Admin API token — if absent, merchant is null
  const merchant = shopifyConfig.adminToken
    ? createShopifyMerchant(shopifyConfig)
    : null;

  return { catalog, merchant };
}

export { createShopifyCatalog } from "./storefront-client.js";
export { createShopifyMerchant } from "./admin-client.js";
export { createProductCache } from "./product-cache.js";
export { validateShopifyConfig } from "./config.js";
export type { ShopifyPlatformConfig } from "./config.js";
export type { ProductCache } from "./product-cache.js";
