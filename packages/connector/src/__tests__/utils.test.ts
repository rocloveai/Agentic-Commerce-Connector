/**
 * Unit tests for utility modules:
 * - Product cache (TTL, eviction)
 * - Order store (prefix, CRUD, immutability)
 * - Rate service (conversion, validation)
 * - Config (discriminated union, validation)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProductCache } from "../adapters/shopify/product-cache.js";
import {
  newOrderRef,
  setOrderPrefix,
  createOrder,
  getOrder,
  updateOrderStatus,
  listOrders,
} from "../services/order-store.js";
import { convertToStablecoin } from "../services/rate-service.js";
import { loadConfig } from "../config.js";
import { makeProduct } from "./adapter-contract.test.js";
import type { PaymentQuote } from "../payment/types.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Product Cache
// ---------------------------------------------------------------------------

describe("createProductCache", () => {
  it("stores and retrieves products by handle", () => {
    const cache = createProductCache();
    const product = makeProduct({ handle: "my-product" });

    cache.set("my-product", product);
    const cached = cache.get("my-product");

    expect(cached).not.toBeNull();
    expect(cached!.handle).toBe("my-product");
  });

  it("returns null for cache miss", () => {
    const cache = createProductCache();

    expect(cache.get("nonexistent")).toBeNull();
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    const cache = createProductCache(100); // 100ms TTL

    cache.set("short-lived", makeProduct());
    expect(cache.get("short-lived")).not.toBeNull();

    vi.advanceTimersByTime(150);
    expect(cache.get("short-lived")).toBeNull();

    vi.useRealTimers();
  });

  it("clears all entries", () => {
    const cache = createProductCache();
    cache.set("a", makeProduct({ handle: "a" }));
    cache.set("b", makeProduct({ handle: "b" }));

    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("size() evicts expired entries", () => {
    vi.useFakeTimers();
    const cache = createProductCache(50);

    cache.set("x", makeProduct());
    expect(cache.size()).toBe(1);

    vi.advanceTimersByTime(100);
    expect(cache.size()).toBe(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Order Store
// ---------------------------------------------------------------------------

describe("order-store", () => {
  const makeQuote = (orderRef: string): PaymentQuote => ({
    merchant_did: "did:test:merchant",
    merchant_order_ref: orderRef,
    amount: "50.00",
    currency: "XSGD",
    chain_id: 20250407,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    context: {
      summary: "Test x1",
      line_items: [{ name: "Test", qty: 1, amount: "50.00" }],
    },
    signature: "0x" + "00".repeat(65),
  });

  describe("newOrderRef", () => {
    it("generates refs with configured prefix", () => {
      setOrderPrefix("TST");
      const ref = newOrderRef();

      expect(ref).toMatch(/^TST-/);
    });

    it("generates unique refs", () => {
      const refs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        refs.add(newOrderRef());
      }
      expect(refs.size).toBe(100);
    });
  });

  describe("CRUD operations", () => {
    it("createOrder stores and returns order", async () => {
      const ref = `store-test-${Date.now()}`;
      const order = await createOrder(makeQuote(ref));

      expect(order.order_ref).toBe(ref);
      expect(order.status).toBe("UNPAID");
      expect(order.created_at).toBeTruthy();
    });

    it("getOrder retrieves existing order", async () => {
      const ref = `get-test-${Date.now()}`;
      await createOrder(makeQuote(ref));

      const order = await getOrder(ref);
      expect(order).not.toBeNull();
      expect(order!.order_ref).toBe(ref);
    });

    it("getOrder returns null for missing order", async () => {
      const order = await getOrder("nonexistent-order-ref");
      expect(order).toBeNull();
    });

    it("updateOrderStatus creates new object (immutable)", async () => {
      const ref = `immut-test-${Date.now()}`;
      const original = await createOrder(makeQuote(ref));

      const updated = await updateOrderStatus(ref, "PAID");

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("PAID");
      expect(updated!.order_ref).toBe(ref);
      // Immutability: original object unchanged
      expect(original.status).toBe("UNPAID");
    });

    it("updateOrderStatus returns null for missing order", async () => {
      const result = await updateOrderStatus("ghost-ref", "PAID");
      expect(result).toBeNull();
    });

    it("listOrders returns all orders", async () => {
      const ref1 = `list-a-${Date.now()}`;
      const ref2 = `list-b-${Date.now()}`;
      await createOrder(makeQuote(ref1));
      await createOrder(makeQuote(ref2));

      const all = await listOrders();
      const refs = all.map((o) => o.order_ref);

      expect(refs).toContain(ref1);
      expect(refs).toContain(ref2);
    });
  });
});

// ---------------------------------------------------------------------------
// Rate Service
// ---------------------------------------------------------------------------

describe("convertToStablecoin", () => {
  const configBase: Config = {
    platform: "shopify",
    merchantDid: "did:test",
    portalPort: 10000,
    databaseUrl: "",
    webhookSecret: "secret",
    paymentAddress: "0x123",
    signerPrivateKey: "0xabc",
    nexusCoreUrl: "https://test.com",
    selfUrl: "http://localhost:10000",
    portalToken: "",
    storeUrl: "https://store.myshopify.com",
    shopifyStoreUrl: "https://store.myshopify.com",
    shopifyStorefrontToken: "token",
    shopifyAdminToken: "",
    shopifyApiVersion: "2025-07",
    checkoutBaseUrl: "https://checkout.test.com",
    paymentCurrency: "XSGD",
    fixedRate: 1.0,
    rateLockMinutes: 5,
  };

  it("converts SGD to stablecoin at fixed rate", () => {
    const result = convertToStablecoin("100.00", "SGD", configBase);

    expect(result.stablecoinAmount).toBe("100.00");
    expect(result.rate).toBe("1.000000");
    expect(result.lockedAt).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();
  });

  it("supports USD currency", () => {
    const result = convertToStablecoin("50.50", "USD", configBase);

    expect(result.stablecoinAmount).toBe("50.50");
  });

  it("applies custom fixed rate", () => {
    const config = { ...configBase, fixedRate: 1.35 };
    const result = convertToStablecoin("100.00", "SGD", config);

    expect(result.stablecoinAmount).toBe("135.00");
    expect(result.rate).toBe("1.350000");
  });

  it("throws for unsupported currency", () => {
    expect(() => convertToStablecoin("100.00", "EUR", configBase)).toThrow(
      "Unsupported currency",
    );
  });

  it("throws for invalid amount", () => {
    expect(() => convertToStablecoin("abc", "SGD", configBase)).toThrow(
      "Invalid fiat amount",
    );
  });

  it("throws for zero amount", () => {
    expect(() => convertToStablecoin("0", "SGD", configBase)).toThrow(
      "Invalid fiat amount",
    );
  });

  it("throws for negative amount", () => {
    expect(() => convertToStablecoin("-10", "SGD", configBase)).toThrow(
      "Invalid fiat amount",
    );
  });

  it("rate lock expiry is configurable", () => {
    const config = { ...configBase, rateLockMinutes: 10 };
    const result = convertToStablecoin("100.00", "SGD", config);

    const lockedAt = new Date(result.lockedAt).getTime();
    const expiresAt = new Date(result.expiresAt).getTime();

    // Should expire ~10 minutes after lock
    const diffMinutes = (expiresAt - lockedAt) / 60_000;
    expect(diffMinutes).toBeCloseTo(10, 0);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when MERCHANT_SIGNER_PRIVATE_KEY is missing", () => {
    // Set platform env first so we reach the payment-provider check
    process.env.SHOPIFY_STORE_URL = "https://store.myshopify.com";
    process.env.SHOPIFY_STOREFRONT_TOKEN = "token";
    delete process.env.MERCHANT_SIGNER_PRIVATE_KEY;
    delete process.env.MERCHANT_PAYMENT_ADDRESS;

    expect(() => loadConfig()).toThrow(
      "MERCHANT_SIGNER_PRIVATE_KEY is required",
    );
  });

  it("throws when MERCHANT_PAYMENT_ADDRESS is missing", () => {
    process.env.SHOPIFY_STORE_URL = "https://store.myshopify.com";
    process.env.SHOPIFY_STOREFRONT_TOKEN = "token";
    process.env.MERCHANT_SIGNER_PRIVATE_KEY = "0xtest";
    delete process.env.MERCHANT_PAYMENT_ADDRESS;

    expect(() => loadConfig()).toThrow("MERCHANT_PAYMENT_ADDRESS is required");
  });

  it("defaults PLATFORM to shopify", () => {
    process.env.MERCHANT_SIGNER_PRIVATE_KEY = "0xtest";
    process.env.MERCHANT_PAYMENT_ADDRESS = "0xaddr";
    process.env.SHOPIFY_STORE_URL = "https://store.myshopify.com";
    process.env.SHOPIFY_STOREFRONT_TOKEN = "token";
    delete process.env.PLATFORM;

    const config = loadConfig();
    expect(config.platform).toBe("shopify");
  });

  it("loads shopify config with all fields", () => {
    process.env.MERCHANT_SIGNER_PRIVATE_KEY = "0xtest";
    process.env.MERCHANT_PAYMENT_ADDRESS = "0xaddr";
    process.env.SHOPIFY_STORE_URL = "https://my-store.myshopify.com";
    process.env.SHOPIFY_STOREFRONT_TOKEN = "sf_token";
    process.env.SHOPIFY_ADMIN_TOKEN = "admin_token";
    process.env.PLATFORM = "shopify";

    const config = loadConfig();

    expect(config.platform).toBe("shopify");
    expect(config.storeUrl).toBe("https://my-store.myshopify.com");
    if (config.platform === "shopify") {
      expect(config.shopifyStoreUrl).toBe("https://my-store.myshopify.com");
      expect(config.shopifyStorefrontToken).toBe("sf_token");
      expect(config.shopifyAdminToken).toBe("admin_token");
    }
  });

  it("throws for unsupported PLATFORM", () => {
    process.env.MERCHANT_SIGNER_PRIVATE_KEY = "0xtest";
    process.env.MERCHANT_PAYMENT_ADDRESS = "0xaddr";
    process.env.PLATFORM = "magento";

    expect(() => loadConfig()).toThrow('Unsupported PLATFORM: "magento"');
  });

  it("throws for woocommerce when WOO_BASE_URL is missing", () => {
    process.env.MERCHANT_SIGNER_PRIVATE_KEY = "0xtest";
    process.env.MERCHANT_PAYMENT_ADDRESS = "0xaddr";
    process.env.PLATFORM = "woocommerce";
    delete process.env.WOO_BASE_URL;

    expect(() => loadConfig()).toThrow("WOO_BASE_URL is required");
  });
});
