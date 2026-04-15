/**
 * Adapter Contract Tests
 *
 * Shared test suite that any CatalogAdapter / MerchantAdapter implementation
 * must pass. Tests verify normalized output shapes, null handling, and
 * interface compliance — NOT platform-specific behavior.
 */
import { describe, it, expect } from "vitest";
import type {
  CatalogAdapter,
  MerchantAdapter,
  OrderCreateResult,
} from "../adapters/types.js";
import type {
  CommerceProduct,
  CommerceVariant,
  ProductSearchResult,
  StoreMeta,
} from "../types/commerce.js";
import type { CheckoutSession } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixtures — minimal valid objects
// ---------------------------------------------------------------------------

function makeVariant(overrides: Partial<CommerceVariant> = {}): CommerceVariant {
  return {
    id: "gid://test/variant/1",
    title: "Default",
    price: { amount: "29.99", currencyCode: "USD" },
    availableForSale: true,
    selectedOptions: [{ name: "Size", value: "M" }],
    ...overrides,
  };
}

function makeProduct(overrides: Partial<CommerceProduct> = {}): CommerceProduct {
  return {
    id: "gid://test/product/1",
    title: "Test Product",
    description: "A product for testing",
    handle: "test-product",
    images: [{ url: "https://example.com/img.jpg", altText: "Test" }],
    variants: [makeVariant()],
    priceRange: {
      min: { amount: "29.99", currencyCode: "USD" },
      max: { amount: "29.99", currencyCode: "USD" },
    },
    ...overrides,
  };
}

function makeSearchResult(
  products: readonly CommerceProduct[] = [makeProduct()],
): ProductSearchResult {
  return {
    products,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function makeStoreMeta(): StoreMeta {
  return {
    name: "Test Store",
    primaryDomainUrl: "https://test-store.example.com",
    currencyCode: "USD",
  };
}

function makeSession(
  overrides: Partial<CheckoutSession> = {},
): CheckoutSession {
  const now = new Date().toISOString();
  return {
    id: "cs_test_123",
    merchant_did: "did:test:merchant",
    store_url: "https://test-store.example.com",
    line_items: [
      {
        variant_id: "gid://test/variant/1",
        title: "Test Product",
        quantity: 1,
        unit_price: { amount: "29.99", currency: "USD" },
        line_total: { amount: "29.99", currency: "USD" },
      },
    ],
    currency: "USD",
    subtotal: "29.99",
    token_amount: "29.99",
    rate: "1.000000",
    rate_locked_at: now,
    rate_expires_at: now,
    buyer: null,
    status: "payment_pending",
    payment_group_id: "grp_test",
    order_ref: "ORD-abc-001",
    tx_hash: null,
    platform_order_id: null,
    platform_order_name: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CatalogAdapter contract
// ---------------------------------------------------------------------------

export function runCatalogContractTests(
  name: string,
  createAdapter: () => CatalogAdapter,
): void {
  describe(`CatalogAdapter contract: ${name}`, () => {
    it("searchProducts returns ProductSearchResult shape", async () => {
      const catalog = createAdapter();
      const result = await catalog.searchProducts("test", 5);

      expect(result).toHaveProperty("products");
      expect(result).toHaveProperty("pageInfo");
      expect(Array.isArray(result.products)).toBe(true);
      expect(result.pageInfo).toHaveProperty("hasNextPage");
      expect(result.pageInfo).toHaveProperty("endCursor");
    });

    it("listProducts returns ProductSearchResult shape", async () => {
      const catalog = createAdapter();
      const result = await catalog.listProducts(5);

      expect(result).toHaveProperty("products");
      expect(Array.isArray(result.products)).toBe(true);
    });

    it("getProduct returns null for unknown handle", async () => {
      const catalog = createAdapter();
      const result = await catalog.getProduct("nonexistent-handle-xyz");

      expect(result).toBeNull();
    });

    it("getVariantPrices returns empty array for empty input", async () => {
      const catalog = createAdapter();
      const result = await catalog.getVariantPrices([]);

      expect(result).toEqual([]);
    });

    it("getStoreMeta returns StoreMeta shape", async () => {
      const catalog = createAdapter();
      const meta = await catalog.getStoreMeta();

      expect(meta).toHaveProperty("name");
      expect(meta).toHaveProperty("primaryDomainUrl");
      expect(meta).toHaveProperty("currencyCode");
      expect(typeof meta.name).toBe("string");
      expect(typeof meta.currencyCode).toBe("string");
    });

    it("products have required fields", async () => {
      const catalog = createAdapter();
      const result = await catalog.searchProducts("test", 1);

      for (const p of result.products) {
        expect(p).toHaveProperty("id");
        expect(p).toHaveProperty("title");
        expect(p).toHaveProperty("description");
        expect(p).toHaveProperty("handle");
        expect(p).toHaveProperty("images");
        expect(p).toHaveProperty("variants");
        expect(p).toHaveProperty("priceRange");
        expect(Array.isArray(p.images)).toBe(true);
        expect(Array.isArray(p.variants)).toBe(true);
        expect(p.priceRange).toHaveProperty("min");
        expect(p.priceRange).toHaveProperty("max");
      }
    });

    it("variants have required fields", async () => {
      const catalog = createAdapter();
      const result = await catalog.searchProducts("test", 1);

      for (const p of result.products) {
        for (const v of p.variants) {
          expect(v).toHaveProperty("id");
          expect(v).toHaveProperty("title");
          expect(v).toHaveProperty("price");
          expect(v.price).toHaveProperty("amount");
          expect(v.price).toHaveProperty("currencyCode");
          expect(typeof v.availableForSale).toBe("boolean");
          expect(Array.isArray(v.selectedOptions)).toBe(true);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// MerchantAdapter contract
// ---------------------------------------------------------------------------

export function runMerchantContractTests(
  name: string,
  createAdapter: () => MerchantAdapter,
): void {
  describe(`MerchantAdapter contract: ${name}`, () => {
    it("createOrder returns OrderCreateResult shape", async () => {
      const merchant = createAdapter();
      const result = await merchant.createOrder(makeSession());

      expect(result).toHaveProperty("platformOrderId");
      expect(result).toHaveProperty("platformOrderName");
      expect(typeof result.platformOrderId).toBe("string");
      expect(typeof result.platformOrderName).toBe("string");
    });

    it("createOrder accepts PENDING financialStatus", async () => {
      const merchant = createAdapter();
      const result = await merchant.createOrder(makeSession(), {
        financialStatus: "PENDING",
      });

      expect(result.platformOrderId).toBeTruthy();
    });

    it("createOrder accepts PAID financialStatus", async () => {
      const merchant = createAdapter();
      const result = await merchant.createOrder(makeSession(), {
        financialStatus: "PAID",
      });

      expect(result.platformOrderId).toBeTruthy();
    });

    it("hasExistingOrder returns boolean", async () => {
      const merchant = createAdapter();
      const exists = await merchant.hasExistingOrder("nonexistent-session");

      expect(typeof exists).toBe("boolean");
    });
  });
}

// ---------------------------------------------------------------------------
// Mock adapter for running contract tests in this file
// ---------------------------------------------------------------------------

function createMockCatalog(): CatalogAdapter {
  return {
    searchProducts: async (_query, first = 10) =>
      makeSearchResult(first > 0 ? [makeProduct()] : []),
    listProducts: async () => makeSearchResult(),
    getProduct: async (handle) =>
      handle === "test-product" ? makeProduct() : null,
    getVariantPrices: async (ids) =>
      ids.length === 0
        ? []
        : ids.map((id) => makeVariant({ id })),
    getStoreMeta: async () => makeStoreMeta(),
  };
}

function createMockMerchant(): MerchantAdapter {
  const orders = new Map<string, string>();
  return {
    createOrder: async (session, opts) => {
      const id = `mock_order_${Date.now()}`;
      const name = `#MOCK-${Math.floor(Math.random() * 10000)}`;
      orders.set(session.id, id);
      return { platformOrderId: id, platformOrderName: name };
    },
    markOrderPaid: async () => {},
    cancelOrder: async () => {},
    hasExistingOrder: async (sessionId) => orders.has(sessionId),
  };
}

// Run contract tests against mock adapters
runCatalogContractTests("MockCatalog", createMockCatalog);
runMerchantContractTests("MockMerchant", createMockMerchant);

// Export fixtures for use in other test files
export {
  makeVariant,
  makeProduct,
  makeSearchResult,
  makeStoreMeta,
  makeSession,
  createMockCatalog,
  createMockMerchant,
};
