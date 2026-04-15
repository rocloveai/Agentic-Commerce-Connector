/**
 * Shopify Adapter Unit Tests
 *
 * Mocks global fetch to simulate Shopify GraphQL responses.
 * Verifies that raw Shopify data is correctly mapped to CommerceProduct/CommerceVariant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShopifyCatalog } from "../adapters/shopify/storefront-client.js";
import { createShopifyMerchant } from "../adapters/shopify/admin-client.js";
import { validateShopifyConfig } from "../adapters/shopify/config.js";
import type { ShopifyPlatformConfig } from "../adapters/shopify/config.js";
import {
  runCatalogContractTests,
  runMerchantContractTests,
  makeSession,
} from "./adapter-contract.test.js";

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: ShopifyPlatformConfig = {
  storeUrl: "https://test-store.myshopify.com",
  storefrontToken: "test-storefront-token",
  adminToken: "test-admin-token",
  apiVersion: "2025-07",
};

// ---------------------------------------------------------------------------
// Mock Shopify GraphQL responses
// ---------------------------------------------------------------------------

function makeShopifyProductNode() {
  return {
    id: "gid://shopify/Product/123",
    title: "Test Snowboard",
    description: "A great snowboard for testing",
    handle: "test-snowboard",
    images: {
      edges: [
        { node: { url: "https://cdn.shopify.com/img.jpg", altText: "Board" } },
      ],
    },
    variants: {
      edges: [
        {
          node: {
            id: "gid://shopify/ProductVariant/456",
            title: "Default Title",
            price: { amount: "99.00", currencyCode: "SGD" },
            availableForSale: true,
            selectedOptions: [{ name: "Title", value: "Default Title" }],
          },
        },
        {
          node: {
            id: "gid://shopify/ProductVariant/789",
            title: "Large",
            price: { amount: "119.00", currencyCode: "SGD" },
            availableForSale: false,
            selectedOptions: [{ name: "Size", value: "Large" }],
          },
        },
      ],
    },
    priceRange: {
      minVariantPrice: { amount: "99.00", currencyCode: "SGD" },
      maxVariantPrice: { amount: "119.00", currencyCode: "SGD" },
    },
  };
}

function mockFetch(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data }),
    text: async () => JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe("validateShopifyConfig", () => {
  it("validates required fields", () => {
    const config = validateShopifyConfig({
      SHOPIFY_STORE_URL: "https://store.myshopify.com",
      SHOPIFY_STOREFRONT_TOKEN: "token123",
    });

    expect(config.storeUrl).toBe("https://store.myshopify.com");
    expect(config.storefrontToken).toBe("token123");
    expect(config.adminToken).toBe("");
    expect(config.apiVersion).toBe("2025-07");
  });

  it("throws on missing SHOPIFY_STORE_URL", () => {
    expect(() =>
      validateShopifyConfig({ SHOPIFY_STOREFRONT_TOKEN: "token123" }),
    ).toThrow("SHOPIFY_STORE_URL is required");
  });

  it("throws on missing SHOPIFY_STOREFRONT_TOKEN", () => {
    expect(() =>
      validateShopifyConfig({
        SHOPIFY_STORE_URL: "https://store.myshopify.com",
      }),
    ).toThrow("SHOPIFY_STOREFRONT_TOKEN is required");
  });

  it("uses custom API version when provided", () => {
    const config = validateShopifyConfig({
      SHOPIFY_STORE_URL: "https://store.myshopify.com",
      SHOPIFY_STOREFRONT_TOKEN: "token",
      SHOPIFY_API_VERSION: "2025-10",
    });

    expect(config.apiVersion).toBe("2025-10");
  });
});

// ---------------------------------------------------------------------------
// Storefront (CatalogAdapter) tests
// ---------------------------------------------------------------------------

describe("createShopifyCatalog", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("searchProducts maps Shopify edges to CommerceProduct[]", async () => {
    globalThis.fetch = mockFetch({
      search: {
        edges: [{ node: makeShopifyProductNode() }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.searchProducts("snowboard", 5);

    expect(result.products).toHaveLength(1);

    const p = result.products[0];
    expect(p.id).toBe("gid://shopify/Product/123");
    expect(p.title).toBe("Test Snowboard");
    expect(p.handle).toBe("test-snowboard");
    expect(p.variants).toHaveLength(2);
    expect(p.priceRange.min.amount).toBe("99.00");
    expect(p.priceRange.max.amount).toBe("119.00");
  });

  it("variants are correctly mapped with selectedOptions", async () => {
    globalThis.fetch = mockFetch({
      search: {
        edges: [{ node: makeShopifyProductNode() }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.searchProducts("snowboard", 5);
    const variants = result.products[0].variants;

    expect(variants[0].id).toBe("gid://shopify/ProductVariant/456");
    expect(variants[0].availableForSale).toBe(true);
    expect(variants[0].selectedOptions).toEqual([
      { name: "Title", value: "Default Title" },
    ]);

    expect(variants[1].id).toBe("gid://shopify/ProductVariant/789");
    expect(variants[1].availableForSale).toBe(false);
  });

  it("listProducts uses products query (not search)", async () => {
    globalThis.fetch = mockFetch({
      products: {
        edges: [{ node: makeShopifyProductNode() }],
        pageInfo: { hasNextPage: true, endCursor: "cursor_abc" },
      },
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.listProducts(10);

    expect(result.products).toHaveLength(1);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.endCursor).toBe("cursor_abc");
  });

  it("getProduct returns null for missing product", async () => {
    globalThis.fetch = mockFetch({ product: null });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.getProduct("nonexistent");

    expect(result).toBeNull();
  });

  it("getProduct maps single product correctly", async () => {
    globalThis.fetch = mockFetch({ product: makeShopifyProductNode() });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.getProduct("test-snowboard");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Test Snowboard");
    expect(result!.images).toHaveLength(1);
    expect(result!.images[0].url).toBe("https://cdn.shopify.com/img.jpg");
  });

  it("getVariantPrices returns empty array for empty input", async () => {
    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.getVariantPrices([]);

    expect(result).toEqual([]);
    // Should not call fetch for empty array
  });

  it("getVariantPrices maps variant nodes", async () => {
    globalThis.fetch = mockFetch({
      nodes: [
        {
          id: "gid://shopify/ProductVariant/456",
          title: "Default",
          price: { amount: "99.00", currencyCode: "SGD" },
          availableForSale: true,
          selectedOptions: [{ name: "Title", value: "Default" }],
        },
        null, // Shopify can return null for deleted variants
      ],
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const result = await catalog.getVariantPrices([
      "gid://shopify/ProductVariant/456",
      "gid://shopify/ProductVariant/deleted",
    ]);

    // Should filter out nulls
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gid://shopify/ProductVariant/456");
  });

  it("getStoreMeta maps shop info correctly", async () => {
    globalThis.fetch = mockFetch({
      shop: {
        name: "My Test Store",
        primaryDomain: { url: "https://mystore.com" },
        paymentSettings: { currencyCode: "SGD" },
      },
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    const meta = await catalog.getStoreMeta();

    expect(meta.name).toBe("My Test Store");
    expect(meta.primaryDomainUrl).toBe("https://mystore.com");
    expect(meta.currencyCode).toBe("SGD");
  });

  it("sends correct headers to Shopify Storefront API", async () => {
    const fetchSpy = mockFetch({
      search: {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    globalThis.fetch = fetchSpy;

    const catalog = createShopifyCatalog(TEST_CONFIG);
    await catalog.searchProducts("test", 1);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://test-store.myshopify.com/api/2025-07/graphql.json",
    );
    expect(opts.headers["X-Shopify-Storefront-Access-Token"]).toBe(
      "test-storefront-token",
    );
    expect(opts.method).toBe("POST");
  });

  it("throws on GraphQL errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: "Access denied" }],
      }),
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    await expect(catalog.searchProducts("test")).rejects.toThrow(
      "Storefront GraphQL: Access denied",
    );
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const catalog = createShopifyCatalog(TEST_CONFIG);
    await expect(catalog.searchProducts("test")).rejects.toThrow(
      "Storefront API 401: Unauthorized",
    );
  });
});

// ---------------------------------------------------------------------------
// Admin (MerchantAdapter) tests
// ---------------------------------------------------------------------------

describe("createShopifyMerchant", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when adminToken is missing", async () => {
    const merchant = createShopifyMerchant({
      ...TEST_CONFIG,
      adminToken: "",
    });

    await expect(merchant.createOrder(makeSession())).rejects.toThrow(
      "SHOPIFY_ADMIN_TOKEN is required",
    );
  });

  it("createOrder returns platformOrderId and platformOrderName", async () => {
    globalThis.fetch = mockFetch({
      orderCreate: {
        order: {
          id: "gid://shopify/Order/111",
          name: "#1001",
          createdAt: "2026-04-13T00:00:00Z",
        },
        userErrors: [],
      },
    });

    const merchant = createShopifyMerchant(TEST_CONFIG);
    const result = await merchant.createOrder(makeSession());

    expect(result.platformOrderId).toBe("gid://shopify/Order/111");
    expect(result.platformOrderName).toBe("#1001");
  });

  it("createOrder throws on userErrors", async () => {
    globalThis.fetch = mockFetch({
      orderCreate: {
        order: null,
        userErrors: [{ field: ["lineItems"], message: "Invalid variant" }],
      },
    });

    const merchant = createShopifyMerchant(TEST_CONFIG);
    await expect(merchant.createOrder(makeSession())).rejects.toThrow(
      "Shopify orderCreate failed: Invalid variant",
    );
  });

  it("markOrderPaid calls orderMarkAsPaid mutation", async () => {
    const fetchSpy = mockFetch({
      orderMarkAsPaid: {
        order: { id: "gid://shopify/Order/111" },
        userErrors: [],
      },
    });
    globalThis.fetch = fetchSpy;

    const merchant = createShopifyMerchant(TEST_CONFIG);
    await merchant.markOrderPaid("gid://shopify/Order/111", "0xabc");

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.variables.input.id).toBe("gid://shopify/Order/111");
  });

  it("cancelOrder calls orderCancel mutation", async () => {
    const fetchSpy = mockFetch({
      orderCancel: {
        orderCancelUserErrors: [],
      },
    });
    globalThis.fetch = fetchSpy;

    const merchant = createShopifyMerchant(TEST_CONFIG);
    await merchant.cancelOrder("gid://shopify/Order/111", "Payment expired");

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.variables.orderId).toBe("gid://shopify/Order/111");
  });

  it("hasExistingOrder returns true when order exists", async () => {
    globalThis.fetch = mockFetch({
      orders: {
        edges: [{ node: { id: "gid://shopify/Order/111" } }],
      },
    });

    const merchant = createShopifyMerchant(TEST_CONFIG);
    const exists = await merchant.hasExistingOrder("cs_test_123");

    expect(exists).toBe(true);
  });

  it("hasExistingOrder returns false when no order found", async () => {
    globalThis.fetch = mockFetch({
      orders: { edges: [] },
    });

    const merchant = createShopifyMerchant(TEST_CONFIG);
    const exists = await merchant.hasExistingOrder("cs_nonexistent");

    expect(exists).toBe(false);
  });

  it("sends correct headers to Shopify Admin API", async () => {
    const fetchSpy = mockFetch({
      orders: { edges: [] },
    });
    globalThis.fetch = fetchSpy;

    const merchant = createShopifyMerchant(TEST_CONFIG);
    await merchant.hasExistingOrder("cs_test");

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://test-store.myshopify.com/admin/api/2025-07/graphql.json",
    );
    expect(opts.headers["X-Shopify-Access-Token"]).toBe("test-admin-token");
  });
});

// ---------------------------------------------------------------------------
// Run contract tests against Shopify adapters with mocked fetch
// ---------------------------------------------------------------------------

describe("Shopify adapters pass contract tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Set up a mock fetch that handles all query types
    globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const query = body.query as string;

      if (query.includes("SearchProducts") || query.includes("search(")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              search: {
                edges: [{ node: makeShopifyProductNode() }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (query.includes("ListProducts") || query.includes("products(")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              products: {
                edges: [{ node: makeShopifyProductNode() }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      if (query.includes("GetProduct") || query.includes("product(handle:")) {
        const handle = body.variables?.handle;
        return {
          ok: true,
          json: async () => ({
            data: {
              product:
                handle === "nonexistent-handle-xyz"
                  ? null
                  : makeShopifyProductNode(),
            },
          }),
        };
      }
      if (query.includes("GetVariantPrices") || query.includes("nodes(ids:")) {
        return {
          ok: true,
          json: async () => ({
            data: { nodes: [] },
          }),
        };
      }
      if (query.includes("ShopInfo") || query.includes("shop {")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              shop: {
                name: "Test Store",
                primaryDomain: { url: "https://test.myshopify.com" },
                paymentSettings: { currencyCode: "SGD" },
              },
            },
          }),
        };
      }
      if (query.includes("OrderCreate")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              orderCreate: {
                order: {
                  id: "gid://shopify/Order/999",
                  name: "#TEST-1",
                  createdAt: new Date().toISOString(),
                },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("OrdersByTag")) {
        return {
          ok: true,
          json: async () => ({
            data: { orders: { edges: [] } },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ data: {} }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  runCatalogContractTests("Shopify", () => createShopifyCatalog(TEST_CONFIG));
  runMerchantContractTests("Shopify", () =>
    createShopifyMerchant(TEST_CONFIG),
  );
});
