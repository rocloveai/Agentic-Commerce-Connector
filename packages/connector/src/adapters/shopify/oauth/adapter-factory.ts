// ---------------------------------------------------------------------------
// Build Shopify CatalogAdapter + MerchantAdapter from a persisted
// OAuth installation record. Used by the OAuth-only HTTP mode to lazily
// wire UCP deps after a merchant completes the install flow — before that,
// there are no tokens to talk to Shopify with.
//
// This is a pure, synchronous factory. Token/URL handling lives here so the
// UCP resolver (ucp-binding.ts) stays storage-shaped and doesn't need to
// know Shopify's URL conventions.
// ---------------------------------------------------------------------------
import type { AdapterPair } from "../../types.js";
import { createShopifyAdapters } from "../index.js";
import type { ShopInstallation } from "./types.js";

export interface AdaptersFromInstallationOptions {
  readonly apiVersion: string;
}

/**
 * Map a persisted `ShopInstallation` into a live adapter pair.
 *
 * Notes:
 *   - `storeUrl` is reconstructed as `https://<shopDomain>` because
 *     installations store only the bare `*.myshopify.com` host.
 *   - If `storefrontToken` is null (storefront-token provisioning failed
 *     at install time; common when the app lacks
 *     `unauthenticated_read_product_listings`), we pass "" through.
 *     The resulting catalog will 401 at request time — caller should
 *     surface a clear error. We do not silently fall back to Admin API
 *     reads here; that's a scope fix, not a code fix.
 */
export function createShopifyAdaptersFromInstallation(
  installation: ShopInstallation,
  opts: AdaptersFromInstallationOptions,
): AdapterPair {
  return createShopifyAdapters({
    storeUrl: `https://${installation.shopDomain}`,
    adminToken: installation.adminToken,
    storefrontToken: installation.storefrontToken ?? "",
    apiVersion: opts.apiVersion,
  });
}
