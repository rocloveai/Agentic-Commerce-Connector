import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { handleUcpRoute, type UcpDeps } from "../ucp/routes.js";
import {
  UCP_VERSION,
  UcpDiscoveryResponse,
  UcpProduct,
  UcpSearchResponse,
  UcpErrorResponse,
} from "../ucp/types.js";
import { createShopifyCatalog } from "../adapters/shopify/storefront-client.js";
import { createWooCatalog } from "../adapters/woocommerce/catalog.js";
import type { CatalogAdapter, MerchantAdapter } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Mock HTTP request/response helpers
// ---------------------------------------------------------------------------

function mockReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const r = new Readable({
    read() {
      if (opts.body !== undefined) {
        this.push(JSON.stringify(opts.body));
      }
      this.push(null);
    },
  }) as IncomingMessage;
  r.method = opts.method;
  r.url = opts.url;
  r.headers = opts.headers ?? {};
  return r;
}

function mockRes(): {
  res: ServerResponse;
  status: () => number;
  json: () => unknown;
} {
  let statusCode = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(chunk: string) {
      if (chunk) chunks.push(chunk);
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    json: () => JSON.parse(chunks.join("")),
  };
}

// ---------------------------------------------------------------------------
// UCP deps fixtures
// ---------------------------------------------------------------------------

function makeDeps(
  catalog: CatalogAdapter,
  merchant: MerchantAdapter | null = null,
): UcpDeps {
  return {
    config: {} as UcpDeps["config"],
    catalog,
    merchant,
    cartTokenConfig: { secret: "x".repeat(32), ttlSeconds: 900 },
    paymentHandlers: [
      {
        id: "com.nexus.nups",
        version: UCP_VERSION,
        available_instruments: [{ type: "crypto" }],
        config: { protocol: "NUPS/1.5" },
      },
    ],
    ucpEndpoint: "https://api.example.com/ucp/v1",
  };
}

// ---------------------------------------------------------------------------
// Fetch mocks for the two adapters
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init?: RequestInit };

function sequencedFetch(responses: Array<{ body: unknown; status?: number }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error(`Unexpected fetch #${i}: ${url}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  });
  (fn as unknown as { __calls: typeof calls }).__calls = calls;
  return fn;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

// ---------------------------------------------------------------------------
// Shopify adapter — contract tests
// ---------------------------------------------------------------------------

const SHOPIFY_CFG = {
  storeUrl: "https://shop.example.com",
  storefrontToken: "st_xxx",
  adminToken: "at_xxx",
  apiVersion: "2025-07",
};

const SHOPIFY_PRODUCT_NODE = {
  id: "gid://shopify/Product/1",
  title: "Snowboard",
  description: "Great board",
  handle: "snowboard",
  vendor: "Acme",
  images: { edges: [{ node: { url: "https://cdn/a.jpg", altText: "Front" } }] },
  variants: {
    edges: [
      {
        node: {
          id: "gid://shopify/ProductVariant/10",
          title: "Default",
          sku: "SB-1",
          quantityAvailable: 5,
          price: { amount: "99.00", currencyCode: "SGD" },
          availableForSale: true,
          selectedOptions: [{ name: "Size", value: "M" }],
        },
      },
    ],
  },
  priceRange: {
    minVariantPrice: { amount: "99.00", currencyCode: "SGD" },
    maxVariantPrice: { amount: "99.00", currencyCode: "SGD" },
  },
};

describe("UCP contract (Shopify adapter)", () => {
  it("discovery returns a schema-valid UCP envelope", async () => {
    globalThis.fetch = sequencedFetch([
      {
        body: {
          data: {
            shop: {
              name: "Shop",
              primaryDomain: { url: "https://shop.example.com" },
              paymentSettings: { currencyCode: "SGD" },
            },
          },
        },
      },
    ]) as unknown as typeof fetch;

    const catalog = createShopifyCatalog(SHOPIFY_CFG);
    const deps = makeDeps(catalog);
    const req = mockReq({ method: "GET", url: "/ucp/v1/discovery" });
    const { res, status, json } = mockRes();

    const handled = await handleUcpRoute(
      "/ucp/v1/discovery",
      req,
      res,
      deps,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const body = json();
    const parsed = UcpDiscoveryResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("search returns a schema-valid UCP search response with enriched fields", async () => {
    globalThis.fetch = sequencedFetch([
      {
        body: {
          data: {
            search: {
              edges: [{ node: SHOPIFY_PRODUCT_NODE }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]) as unknown as typeof fetch;

    const catalog = createShopifyCatalog(SHOPIFY_CFG);
    const deps = makeDeps(catalog);
    const req = mockReq({
      method: "POST",
      url: "/ucp/v1/search",
      body: { query: "snow" },
    });
    const { res, status, json } = mockRes();

    await handleUcpRoute("/ucp/v1/search", req, res, deps);
    expect(status()).toBe(200);
    const body = json() as { items: unknown[] };
    const parsed = UcpSearchResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.items).toHaveLength(1);
    const p = UcpProduct.parse(body.items[0]);
    expect(p.brand).toBe("Acme");
    expect(p.variants[0]?.sku).toBe("SB-1");
    expect(p.variants[0]?.inventory_quantity).toBe(5);
  });

  it("returns a UCP-shaped error envelope for invalid search requests", async () => {
    const catalog = createShopifyCatalog(SHOPIFY_CFG);
    const deps = makeDeps(catalog);
    const req = mockReq({
      method: "POST",
      url: "/ucp/v1/search",
      body: { first: 999 }, // out of range
    });
    const { res, status, json } = mockRes();
    await handleUcpRoute("/ucp/v1/search", req, res, deps);
    expect(status()).toBe(400);
    const body = json();
    const parsed = UcpErrorResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WooCommerce adapter — contract tests
// ---------------------------------------------------------------------------

const WOO_CFG = {
  baseUrl: "https://store.example.com",
  consumerKey: "ck",
  consumerSecret: "cs",
  apiVersion: "wc/v3",
  requestTimeoutMs: 5000,
  maxRetries: 0,
};

const WOO_PRODUCT = {
  id: 7,
  name: "Hat",
  slug: "hat",
  description: "<p>Warm hat</p>",
  short_description: "",
  price: "25.00",
  regular_price: "25.00",
  images: [{ src: "https://cdn/hat.jpg", alt: null }],
  type: "simple",
  variations: [],
  attributes: [],
  stock_status: "instock",
  stock_quantity: 12,
  sku: "HAT-1",
};

describe("UCP contract (WooCommerce adapter)", () => {
  beforeEach(() => {
    // Woo currency call happens first, cached for subsequent calls
  });

  it("discovery returns a schema-valid UCP envelope", async () => {
    globalThis.fetch = sequencedFetch([
      { body: [{ id: "woocommerce_currency", value: "USD" }] }, // /settings/general
      {
        body: {
          environment: {
            site_title: "Woo Shop",
            site_url: "https://store.example.com",
          },
        },
      }, // /system_status
    ]) as unknown as typeof fetch;

    const catalog = createWooCatalog(WOO_CFG);
    const deps = makeDeps(catalog);
    const req = mockReq({ method: "GET", url: "/ucp/v1/discovery" });
    const { res, status, json } = mockRes();

    await handleUcpRoute("/ucp/v1/discovery", req, res, deps);
    expect(status()).toBe(200);
    const body = json();
    const parsed = UcpDiscoveryResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("search returns schema-valid UCP search response with Woo fields", async () => {
    globalThis.fetch = sequencedFetch([
      { body: [{ id: "woocommerce_currency", value: "USD" }] },
      { body: [WOO_PRODUCT] },
    ]) as unknown as typeof fetch;

    const catalog = createWooCatalog(WOO_CFG);
    const deps = makeDeps(catalog);
    const req = mockReq({
      method: "POST",
      url: "/ucp/v1/search",
      body: { query: "hat" },
    });
    const { res, status, json } = mockRes();

    await handleUcpRoute("/ucp/v1/search", req, res, deps);
    expect(status()).toBe(200);
    const body = json() as { items: unknown[] };
    const parsed = UcpSearchResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    const p = UcpProduct.parse(body.items[0]);
    expect(p.variants[0]?.sku).toBe("HAT-1");
    expect(p.variants[0]?.inventory_quantity).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter parity: both must produce the same UCP envelope shape
// ---------------------------------------------------------------------------

describe("UCP contract parity (Shopify ≡ Woo)", () => {
  it("search response has identical top-level shape for both adapters", async () => {
    // Shopify call
    globalThis.fetch = sequencedFetch([
      {
        body: {
          data: {
            search: {
              edges: [{ node: SHOPIFY_PRODUCT_NODE }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]) as unknown as typeof fetch;

    const shopifyReq = mockReq({
      method: "POST",
      url: "/ucp/v1/search",
      body: { query: "x" },
    });
    const shopifyCtx = mockRes();
    await handleUcpRoute(
      "/ucp/v1/search",
      shopifyReq,
      shopifyCtx.res,
      makeDeps(createShopifyCatalog(SHOPIFY_CFG)),
    );

    // Woo call
    globalThis.fetch = sequencedFetch([
      { body: [{ id: "woocommerce_currency", value: "USD" }] },
      { body: [WOO_PRODUCT] },
    ]) as unknown as typeof fetch;

    const wooReq = mockReq({
      method: "POST",
      url: "/ucp/v1/search",
      body: { query: "x" },
    });
    const wooCtx = mockRes();
    await handleUcpRoute(
      "/ucp/v1/search",
      wooReq,
      wooCtx.res,
      makeDeps(createWooCatalog(WOO_CFG)),
    );

    const shopifyKeys = Object.keys(shopifyCtx.json() as object).sort();
    const wooKeys = Object.keys(wooCtx.json() as object).sort();
    expect(wooKeys).toEqual(shopifyKeys);
    // Both should contain the canonical UCP keys
    expect(shopifyKeys).toEqual(["items", "page_info", "ucp"]);
  });
});
