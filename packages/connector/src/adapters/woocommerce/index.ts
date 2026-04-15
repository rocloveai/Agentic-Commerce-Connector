import type { AdapterPair } from "../types.js";
import type { WooCommercePlatformConfig } from "./config.js";
import { createWooCatalog } from "./catalog.js";
import { createWooMerchant } from "./merchant.js";

// ---------------------------------------------------------------------------
// WooCommerce adapter factory
// ---------------------------------------------------------------------------

export function createWooCommerceAdapters(
  wooConfig: WooCommercePlatformConfig,
): AdapterPair {
  const catalog = createWooCatalog(wooConfig);
  // Order writeback requires the same credentials used by the Storefront side.
  // WC REST is a single endpoint (unlike Shopify's split Storefront/Admin),
  // so the merchant adapter is always available if credentials are present.
  const merchant = createWooMerchant(wooConfig);
  return { catalog, merchant };
}

export { createWooCatalog } from "./catalog.js";
export { createWooMerchant } from "./merchant.js";
export {
  validateWooConfig,
  encodeVariantId,
  decodeVariantId,
  encodePageCursor,
  decodePageCursor,
} from "./config.js";
export type { WooCommercePlatformConfig } from "./config.js";
