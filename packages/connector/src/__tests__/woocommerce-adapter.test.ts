import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateWooConfig,
  buildAuthHeader,
  buildEndpoint,
  encodeVariantId,
  decodeVariantId,
  encodePageCursor,
  decodePageCursor,
} from "../adapters/woocommerce/config.js";
import { createWooCatalog } from "../adapters/woocommerce/catalog.js";
import { createWooMerchant } from "../adapters/woocommerce/merchant.js";
import type { WooCommercePlatformConfig } from "../adapters/woocommerce/config.js";
import type { CheckoutSession } from "../types.js";

const BASE_CONFIG: WooCommercePlatformConfig = {
  baseUrl: "https://shop.example.com",
  consumerKey: "ck_abc123",
  consumerSecret: "cs_def456",
  apiVersion: "wc/v3",
  requestTimeoutMs: 5000,
  maxRetries: 0,
};

// ---------------------------------------------------------------------------
// Config + pure helpers
// ---------------------------------------------------------------------------

describe("woocommerce/config", () => {
  it("validates required env fields", () => {
    expect(() => validateWooConfig({})).toThrow(/WOO_BASE_URL/);
    expect(() =>
      validateWooConfig({ WOO_BASE_URL: "https://x.example.com" }),
    ).toThrow(/WOO_CONSUMER_KEY/);
    expect(() =>
      validateWooConfig({
        WOO_BASE_URL: "https://x.example.com",
        WOO_CONSUMER_KEY: "ck",
      }),
    ).toThrow(/WOO_CONSUMER_SECRET/);
  });

  it("enforces HTTPS", () => {
    expect(() =>
      validateWooConfig({
        WOO_BASE_URL: "http://x.example.com",
        WOO_CONSUMER_KEY: "ck",
        WOO_CONSUMER_SECRET: "cs",
      }),
    ).toThrow(/HTTPS/);
  });

  it("strips trailing slashes from baseUrl", () => {
    const cfg = validateWooConfig({
      WOO_BASE_URL: "https://x.example.com/",
      WOO_CONSUMER_KEY: "ck",
      WOO_CONSUMER_SECRET: "cs",
    });
    expect(cfg.baseUrl).toBe("https://x.example.com");
  });

  it("builds Basic auth header", () => {
    const header = buildAuthHeader(BASE_CONFIG);
    expect(header.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("ck_abc123:cs_def456");
  });

  it("builds endpoint URLs", () => {
    expect(buildEndpoint(BASE_CONFIG, "/products")).toBe(
      "https://shop.example.com/wp-json/wc/v3/products",
    );
    expect(buildEndpoint(BASE_CONFIG, "orders/1/notes")).toBe(
      "https://shop.example.com/wp-json/wc/v3/orders/1/notes",
    );
  });

  it("variant id encodes and decodes (simple product)", () => {
    const encoded = encodeVariantId(42, null);
    expect(encoded).toBe("woo:42");
    expect(decodeVariantId(encoded)).toEqual({
      parentId: 42,
      variationId: null,
    });
  });

  it("variant id encodes and decodes (variable product)", () => {
    const encoded = encodeVariantId(42, 99);
    expect(encoded).toBe("woo:42:99");
    expect(decodeVariantId(encoded)).toEqual({
      parentId: 42,
      variationId: 99,
    });
  });

  it("rejects malformed variant ids", () => {
    expect(decodeVariantId("")).toBeNull();
    expect(decodeVariantId("shopify:1:2")).toBeNull();
    expect(decodeVariantId("woo:abc")).toBeNull();
    expect(decodeVariantId("woo:42:xx")).toBeNull();
  });

  it("page cursor encodes and decodes", () => {
    const cursor = encodePageCursor(3);
    expect(decodePageCursor(cursor)).toBe(3);
    expect(decodePageCursor(null)).toBe(1);
    expect(decodePageCursor(undefined)).toBe(1);
    expect(decodePageCursor("garbage")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Catalog — mocked fetch
// ---------------------------------------------------------------------------

function mockFetchSequence(
  responses: Array<{
    status?: number;
    body: unknown;
    expectUrl?: RegExp;
    expectAuth?: boolean;
  }>,
): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error(`Unexpected fetch #${i}: ${url}`);
    if (r.expectUrl) expect(url).toMatch(r.expectUrl);
    if (r.expectAuth !== false) {
      expect((init?.headers as Record<string, string>).Authorization).toMatch(
        /^Basic /,
      );
    }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  (fn as unknown as { __calls: typeof calls }).__calls = calls;
  return fn;
}

describe("woocommerce/catalog (mocked fetch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = origFetch;
  });

  it("searchProducts maps WC product into CommerceProduct", async () => {
    fetchMock = mockFetchSequence([
      // /settings/general → currency
      {
        expectUrl: /\/settings\/general$/,
        body: [{ id: "woocommerce_currency", value: "SGD" }],
      },
      // /products?search=board
      {
        expectUrl: /\/products\?.*search=board/,
        body: [
          {
            id: 10,
            name: "Snow Board",
            slug: "snow-board",
            description: "<p>Nice <strong>board</strong></p>",
            short_description: "",
            price: "120.00",
            regular_price: "120.00",
            images: [{ src: "https://cdn/a.jpg", alt: null }],
            type: "simple",
            variations: [],
            attributes: [],
            stock_status: "instock",
            stock_quantity: null,
            sku: "SB1",
          },
        ],
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const catalog = createWooCatalog(BASE_CONFIG);
    const res = await catalog.searchProducts("board", 20, null);

    expect(res.products).toHaveLength(1);
    expect(res.products[0]?.title).toBe("Snow Board");
    expect(res.products[0]?.description).toBe("Nice board");
    expect(res.products[0]?.variants[0]?.id).toBe("woo:10");
    expect(res.products[0]?.priceRange.min.currencyCode).toBe("SGD");
  });

  it("searchProducts marks hasNextPage=true when page is full", async () => {
    const PAGE = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `P${i}`,
      slug: `p-${i}`,
      description: "",
      short_description: "",
      price: "1.00",
      regular_price: "1.00",
      images: [],
      type: "simple",
      variations: [],
      attributes: [],
      stock_status: "instock",
      stock_quantity: null,
      sku: `SKU${i}`,
    }));
    fetchMock = mockFetchSequence([
      { body: [{ id: "woocommerce_currency", value: "USD" }] },
      { body: PAGE },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const catalog = createWooCatalog(BASE_CONFIG);
    const res = await catalog.searchProducts("p", 20, null);
    expect(res.pageInfo.hasNextPage).toBe(true);
    expect(res.pageInfo.endCursor).not.toBeNull();
    // Cursor should decode back to page 2
    if (res.pageInfo.endCursor) {
      expect(decodePageCursor(res.pageInfo.endCursor)).toBe(2);
    }
  });

  it("getVariantPrices groups by parent and decodes ids", async () => {
    fetchMock = mockFetchSequence([
      { body: [{ id: "woocommerce_currency", value: "USD" }] },
      // parent fetch
      {
        expectUrl: /\/products\/100$/,
        body: {
          id: 100,
          name: "Parent",
          slug: "parent",
          description: "",
          short_description: "",
          price: "50.00",
          regular_price: "50.00",
          images: [],
          type: "variable",
          variations: [200],
          attributes: [{ name: "Size", option: "L" }],
          stock_status: "instock",
          stock_quantity: null,
          sku: "P",
        },
      },
      // variation fetch
      {
        expectUrl: /\/products\/100\/variations\/200$/,
        body: {
          id: 200,
          sku: "P-L",
          price: "55.00",
          attributes: [{ name: "Size", option: "L" }],
          stock_status: "instock",
          stock_quantity: null,
        },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const catalog = createWooCatalog(BASE_CONFIG);
    const variants = await catalog.getVariantPrices(["woo:100:200"]);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.price.amount).toBe("55.00");
    expect(variants[0]?.price.currencyCode).toBe("USD");
    expect(variants[0]?.id).toBe("woo:100:200");
  });

  it("redacts Authorization header in logged urls (no consumer creds in query)", () => {
    // Sanity: buildAuthHeader + buildEndpoint never put secrets in URL
    const url = buildEndpoint(BASE_CONFIG, "/products");
    expect(url).not.toContain("ck_");
    expect(url).not.toContain("cs_");
  });
});

// ---------------------------------------------------------------------------
// Merchant — idempotent hasExistingOrder
// ---------------------------------------------------------------------------

const SAMPLE_SESSION: CheckoutSession = {
  id: "cs_abc",
  merchant_did: "did:nexus:test",
  store_url: "https://shop.example.com",
  line_items: [
    {
      variant_id: "woo:100:200",
      title: "Parent / L",
      quantity: 1,
      unit_price: { amount: "55.00", currency: "USD" },
      line_total: { amount: "55.00", currency: "USD" },
    },
  ],
  currency: "USD",
  subtotal: "55.00",
  token_amount: "55.00",
  rate: "1.000000",
  rate_locked_at: null,
  rate_expires_at: null,
  buyer: {
    email: "b@example.com",
    shipping_address: {
      first_name: "B",
      last_name: "Y",
      address1: "1 Main",
      city: "NY",
      country: "US",
      zip: "10001",
    },
  },
  status: "payment_pending",
  payment_group_id: "pg_1",
  order_ref: "WOO-1",
  tx_hash: null,
  platform_order_id: null,
  platform_order_name: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("woocommerce/merchant (mocked fetch)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("createOrder returns the existing order when meta_key lookup hits", async () => {
    const fetchMock = mockFetchSequence([
      // meta_query lookup succeeds
      {
        expectUrl: /\/orders\?.*meta_key=nexus_session_id/,
        body: [
          {
            id: 42,
            number: "42",
            status: "on-hold",
            total: "55.00",
            meta_data: [{ key: "nexus_session_id", value: "cs_abc" }],
          },
        ],
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const merchant = createWooMerchant(BASE_CONFIG);
    const res = await merchant.createOrder(SAMPLE_SESSION);
    expect(res.platformOrderId).toBe("42");
    expect(res.platformOrderName).toBe("#42");
  });

  it("createOrder falls back to recent-order scan when meta_query returns empty", async () => {
    const fetchMock = mockFetchSequence([
      // meta_query returns []
      { body: [] },
      // recent scan finds it in meta_data
      {
        expectUrl: /\/orders\?.*per_page=50/,
        body: [
          {
            id: 99,
            number: "99",
            status: "on-hold",
            total: "55.00",
            meta_data: [{ key: "nexus_session_id", value: "cs_abc" }],
          },
        ],
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const merchant = createWooMerchant(BASE_CONFIG);
    const res = await merchant.createOrder(SAMPLE_SESSION);
    expect(res.platformOrderId).toBe("99");
  });

  it("createOrder POSTs a new order when no existing is found", async () => {
    const fetchMock = mockFetchSequence([
      { body: [] }, // meta_query empty
      { body: [] }, // scan empty
      {
        expectUrl: /\/orders$/,
        body: {
          id: 7,
          number: "7",
          status: "on-hold",
          total: "55.00",
          meta_data: [],
        },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const merchant = createWooMerchant(BASE_CONFIG);
    const res = await merchant.createOrder(SAMPLE_SESSION);
    expect(res.platformOrderId).toBe("7");
    expect(res.platformOrderName).toBe("#7");
  });

  it("markOrderPaid issues PUT + POST /notes", async () => {
    const fetchMock = mockFetchSequence([
      {
        expectUrl: /\/orders\/7$/,
        body: { id: 7, number: "7", status: "processing", total: "55.00", meta_data: [] },
      },
      { expectUrl: /\/orders\/7\/notes$/, body: { id: 1 } },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const merchant = createWooMerchant(BASE_CONFIG);
    await merchant.markOrderPaid("7", "0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancelOrder sets status and optionally posts note", async () => {
    const fetchMock = mockFetchSequence([
      {
        expectUrl: /\/orders\/7$/,
        body: { id: 7, number: "7", status: "cancelled", total: "55.00", meta_data: [] },
      },
      { expectUrl: /\/orders\/7\/notes$/, body: { id: 1 } },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const merchant = createWooMerchant(BASE_CONFIG);
    await merchant.cancelOrder("7", "customer request");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
