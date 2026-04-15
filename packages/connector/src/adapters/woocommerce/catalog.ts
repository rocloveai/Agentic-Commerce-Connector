// ---------------------------------------------------------------------------
// WooCommerce CatalogAdapter — read-only product catalog over WC REST v3.
// ---------------------------------------------------------------------------

import type {
  CommerceProduct,
  CommerceVariant,
  ProductSearchResult,
  StoreMeta,
} from "../../types/commerce.js";
import type { CatalogAdapter } from "../types.js";
import {
  decodeVariantId,
  encodeVariantId,
  encodePageCursor,
  decodePageCursor,
  type WooCommercePlatformConfig,
} from "./config.js";
import { wooFetch } from "./http.js";

// ---------------------------------------------------------------------------
// Raw WC REST payload shapes (partial)
// ---------------------------------------------------------------------------

interface WcImage {
  src: string;
  alt: string | null;
}

interface WcAttribute {
  name: string;
  option: string;
}

interface WcProduct {
  id: number;
  name: string;
  slug: string;
  description: string;
  short_description: string;
  price: string;
  regular_price: string;
  currency?: string; // not standard; may be absent
  images: WcImage[];
  type: "simple" | "variable" | "grouped" | "external";
  variations: number[];
  attributes: WcAttribute[];
  stock_status: "instock" | "outofstock" | "onbackorder";
  stock_quantity: number | null;
  sku: string;
}

interface WcVariation {
  id: number;
  sku: string;
  price: string;
  attributes: WcAttribute[];
  stock_status: "instock" | "outofstock" | "onbackorder";
  stock_quantity: number | null;
}

interface WcSystemStatus {
  environment?: { site_title?: string; site_url?: string };
  settings?: { currency?: string };
}

interface WcGeneralSettings {
  title?: string;
  url?: string;
  woocommerce_currency?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCommerceProduct(p: WcProduct, currency: string): CommerceProduct {
  const description = stripHtml(p.description || p.short_description || "");

  // For simple products, the only variant is the product itself.
  // For variable products, we emit one entry per WC variation (resolved later via getVariantPrices).
  // At list/search time, WC REST doesn't give us inline variation prices,
  // so we derive a min/max price range from `p.price` (simple) or
  // placeholder equal prices (variable) — consumer should call getVariantPrices
  // for authoritative per-variation prices before checkout.
  const basePrice = p.price || p.regular_price || "0";

  const variants: CommerceVariant[] =
    p.type === "variable" && p.variations.length > 0
      ? p.variations.map((vid) => ({
          id: encodeVariantId(p.id, vid),
          title: p.attributes.map((a) => a.option).join(" / ") || "Default",
          price: { amount: basePrice, currencyCode: currency },
          availableForSale: p.stock_status === "instock",
          selectedOptions: p.attributes.map((a) => ({
            name: a.name,
            value: a.option,
          })),
          // sku/inventory come from variation fetch, not the list call
          sku: null,
          inventoryQuantity: null,
        }))
      : [
          {
            id: encodeVariantId(p.id, null),
            title: "Default",
            price: { amount: basePrice, currencyCode: currency },
            availableForSale: p.stock_status === "instock",
            selectedOptions: p.attributes.map((a) => ({
              name: a.name,
              value: a.option,
            })),
            sku: p.sku || null,
            inventoryQuantity: p.stock_quantity,
          },
        ];

  const prices = variants
    .map((v) => parseFloat(v.price.amount))
    .filter((n) => !isNaN(n));
  const min = prices.length > 0 ? Math.min(...prices).toFixed(2) : basePrice;
  const max = prices.length > 0 ? Math.max(...prices).toFixed(2) : basePrice;

  return {
    id: String(p.id),
    title: p.name,
    description,
    handle: p.slug,
    images: p.images.map((i) => ({ url: i.src, altText: i.alt })),
    variants,
    priceRange: {
      min: { amount: min, currencyCode: currency },
      max: { amount: max, currencyCode: currency },
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWooCatalog(
  cfg: WooCommercePlatformConfig,
): CatalogAdapter {
  // Store-level currency cache (cheap call, cache for the lifetime of the adapter)
  let currencyCache: string | null = null;

  async function getStoreCurrency(): Promise<string> {
    if (currencyCache) return currencyCache;
    try {
      const settings = await wooFetch<WcGeneralSettings[]>(cfg, {
        method: "GET",
        path: "/settings/general",
      });
      const cur = settings.find(
        (s: unknown) =>
          typeof s === "object" &&
          s !== null &&
          (s as { id?: string }).id === "woocommerce_currency",
      );
      const value = (cur as { value?: string } | undefined)?.value;
      currencyCache = value ?? "USD";
    } catch {
      currencyCache = "USD";
    }
    return currencyCache;
  }

  async function searchOrList(
    query: string,
    first: number,
    after: string | null,
  ): Promise<ProductSearchResult> {
    const page = decodePageCursor(after);
    const perPage = Math.min(Math.max(first, 1), 50);
    const currency = await getStoreCurrency();

    const products = await wooFetch<WcProduct[]>(cfg, {
      method: "GET",
      path: "/products",
      query: {
        search: query || undefined,
        per_page: perPage,
        page,
        status: "publish",
      },
    });

    const hasNextPage = products.length === perPage;
    return {
      products: products.map((p) => toCommerceProduct(p, currency)),
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? encodePageCursor(page + 1) : null,
      },
    };
  }

  return {
    async searchProducts(query, first = 20, after = null) {
      return searchOrList(query, first, after);
    },

    async listProducts(first = 20, after = null) {
      return searchOrList("", first, after);
    },

    async getProduct(handle) {
      const currency = await getStoreCurrency();
      const products = await wooFetch<WcProduct[]>(cfg, {
        method: "GET",
        path: "/products",
        query: { slug: handle, per_page: 1 },
      });
      const p = products[0];
      if (!p) return null;
      return toCommerceProduct(p, currency);
    },

    async getVariantPrices(variantIds) {
      const currency = await getStoreCurrency();
      const results: CommerceVariant[] = [];

      // Group by parentId to minimize parent fetches
      const byParent = new Map<
        number,
        Array<{ encoded: string; variationId: number | null }>
      >();
      for (const encoded of variantIds) {
        const decoded = decodeVariantId(encoded);
        if (!decoded) continue;
        const bucket = byParent.get(decoded.parentId) ?? [];
        bucket.push({ encoded, variationId: decoded.variationId });
        byParent.set(decoded.parentId, bucket);
      }

      for (const [parentId, entries] of byParent) {
        // Fetch parent once — needed for attributes/title/stock fallback
        let parent: WcProduct | null = null;
        try {
          parent = await wooFetch<WcProduct>(cfg, {
            method: "GET",
            path: `/products/${parentId}`,
          });
        } catch {
          continue;
        }

        for (const { encoded, variationId } of entries) {
          if (variationId === null) {
            // Simple product: use parent price directly
            results.push({
              id: encoded,
              title: parent.name,
              price: {
                amount: parent.price || parent.regular_price || "0",
                currencyCode: currency,
              },
              availableForSale: parent.stock_status === "instock",
              selectedOptions: parent.attributes.map((a) => ({
                name: a.name,
                value: a.option,
              })),
              sku: parent.sku || null,
              inventoryQuantity: parent.stock_quantity,
            });
            continue;
          }

          try {
            const v = await wooFetch<WcVariation>(cfg, {
              method: "GET",
              path: `/products/${parentId}/variations/${variationId}`,
            });
            results.push({
              id: encoded,
              title:
                v.attributes.map((a) => a.option).join(" / ") || parent.name,
              price: { amount: v.price, currencyCode: currency },
              availableForSale: v.stock_status === "instock",
              selectedOptions: v.attributes.map((a) => ({
                name: a.name,
                value: a.option,
              })),
              sku: v.sku || null,
              inventoryQuantity: v.stock_quantity,
            });
          } catch {
            // Skip unresolvable variants; caller will surface "variant not found"
          }
        }
      }

      return results;
    },

    async getStoreMeta(): Promise<StoreMeta> {
      const currency = await getStoreCurrency();
      // system_status is the most reliable source of site title+url
      try {
        const status = await wooFetch<WcSystemStatus>(cfg, {
          method: "GET",
          path: "/system_status",
        });
        return {
          name: status.environment?.site_title ?? "WooCommerce Store",
          currencyCode: currency,
          primaryDomainUrl: status.environment?.site_url ?? cfg.baseUrl,
        };
      } catch {
        return {
          name: "WooCommerce Store",
          currencyCode: currency,
          primaryDomainUrl: cfg.baseUrl,
        };
      }
    },
  };
}
