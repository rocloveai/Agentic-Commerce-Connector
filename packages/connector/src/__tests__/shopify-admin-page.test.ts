/**
 * Admin page integration — bearer gate, rendering, rotate endpoint.
 * Uses the same fake-req/res helpers as other HTTP tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createShopifyOAuthRouter } from "../adapters/shopify/oauth/routes.js";
import { createInMemoryStateStore } from "../adapters/shopify/oauth/state.js";
import { createInMemoryInstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type { InstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type { OAuthConfig, ShopInstallation } from "../adapters/shopify/oauth/types.js";

const BEARER = "test-portal-token";

function oauthConfig(): OAuthConfig {
  return {
    clientId: "c",
    clientSecret: "s",
    scopes: ["read_products", "read_inventory", "write_orders", "read_orders"],
    redirectUri: "https://acc.example.com/auth/shopify/callback",
    apiVersion: "2025-07",
  };
}

function mockReq(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const r = new Readable({
    read() {
      if (opts.body !== undefined) this.push(opts.body);
      this.push(null);
    },
  }) as IncomingMessage;
  r.method = opts.method ?? "GET";
  r.url = opts.url;
  r.headers = { host: "acc.example.com", ...(opts.headers ?? {}) };
  return r;
}

function mockRes(): {
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, string>;
  body: () => string;
  contentType: () => string | undefined;
} {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    writeHead(code: number, h: Record<string, string> = {}) {
      statusCode = code;
      headers = { ...headers, ...h };
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(chunk.toString());
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    headers: () => headers,
    body: () => chunks.join(""),
    contentType: () => headers["Content-Type"],
  };
}

function newRouter(opts: {
  bearer?: string;
  fetchImpl?: typeof fetch;
  store?: InstallationStore;
  now?: () => number;
}): {
  router: ReturnType<typeof createShopifyOAuthRouter>;
  store: InstallationStore;
} {
  const store = opts.store ?? createInMemoryInstallationStore();
  const router = createShopifyOAuthRouter({
    oauthConfig: oauthConfig(),
    stateStore: createInMemoryStateStore(),
    installationStore: store,
    selfUrl: "https://acc.example.com",
    adminBearer: opts.bearer ?? BEARER,
    fetchImpl: opts.fetchImpl ?? ((async () =>
      new Response("unused", { status: 200 })) as typeof fetch),
    now: opts.now,
  });
  return { router, store };
}

function makeInstallation(overrides: Partial<ShopInstallation> = {}): ShopInstallation {
  return {
    shopDomain: "foo.myshopify.com",
    adminToken: "shpat_x",
    storefrontToken: "shpsf_y",
    scopes: ["read_products", "read_inventory", "write_orders", "read_orders"],
    installedAt: 1_700_000_000_000,
    uninstalledAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /admin/shopify
// ---------------------------------------------------------------------------

describe("GET /admin/shopify — bearer gate", () => {
  it("503s when PORTAL_TOKEN is empty (fail-closed)", async () => {
    const { router } = newRouter({ bearer: "" });
    const res = mockRes();
    await router(mockReq({ url: "/admin/shopify" }), res.res);
    expect(res.status()).toBe(503);
    expect(JSON.parse(res.body()).error).toMatch(/PORTAL_TOKEN/);
  });

  it("401 without a bearer", async () => {
    const { router } = newRouter({});
    const res = mockRes();
    await router(mockReq({ url: "/admin/shopify" }), res.res);
    expect(res.status()).toBe(401);
  });

  it("401 on wrong bearer", async () => {
    const { router } = newRouter({});
    const res = mockRes();
    await router(
      mockReq({
        url: "/admin/shopify",
        headers: { authorization: "Bearer wrong" },
      }),
      res.res,
    );
    expect(res.status()).toBe(401);
  });

  it("accepts bearer via Authorization header", async () => {
    const { router } = newRouter({});
    const res = mockRes();
    await router(
      mockReq({
        url: "/admin/shopify",
        headers: { authorization: `Bearer ${BEARER}` },
      }),
      res.res,
    );
    expect(res.status()).toBe(200);
  });

  it("accepts bearer via ?token= query param", async () => {
    const { router } = newRouter({});
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/shopify — page content
// ---------------------------------------------------------------------------

describe("GET /admin/shopify — content", () => {
  it("renders empty-state HTML when no installations exist", async () => {
    const { router } = newRouter({});
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.status()).toBe(200);
    expect(res.contentType()).toMatch(/text\/html/);
    expect(res.body()).toContain("No installations yet");
  });

  it("renders 'scopes ok' badge when granted superset of requested", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation());
    const { router } = newRouter({ store });
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.body()).toContain("foo.myshopify.com");
    expect(res.body()).toContain("scopes ok");
    expect(res.body()).not.toContain("needs");
  });

  it("renders scope-drift badge + upgrade CTA when missing scopes", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ scopes: ["read_products"] }));
    const { router } = newRouter({ store });
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.body()).toContain("needs 3 more scope");
    expect(res.body()).toContain("Reinstall to upgrade scopes");
    expect(res.body()).toContain(
      "/auth/shopify/install?shop=foo.myshopify.com",
    );
  });

  it("renders 'no storefront token' badge when storefrontToken is null", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ storefrontToken: null }));
    const { router } = newRouter({ store });
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.body()).toContain("no storefront token");
  });

  it("renders 'uninstalled' badge when uninstalled_at is set", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ uninstalledAt: 1_700_000_999_000 }));
    const { router } = newRouter({ store });
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    expect(res.body()).toContain("uninstalled");
  });

  it("does not leak the bearer token into reinstall links (only rotate form)", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation());
    const { router } = newRouter({ store });
    const res = mockRes();
    await router(
      mockReq({ url: `/admin/shopify?token=${BEARER}` }),
      res.res,
    );
    const html = res.body();
    // The reinstall <a href="..."> shouldn't include ?token=.
    expect(html).not.toMatch(/href="[^"]*\/install[^"]*token=/);
    // The rotate form's hidden input is the only legitimate bearer carrier.
    expect(html).toMatch(/<input type="hidden" name="token" value="test-portal-token"/);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/shopify/rotate-storefront
// ---------------------------------------------------------------------------

describe("POST /admin/shopify/rotate-storefront", () => {
  let store: InstallationStore;
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  let fetchImpl: typeof fetch;

  beforeEach(async () => {
    store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ storefrontToken: null }));
    fetchCalls = [];
    fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: {
            storefrontAccessTokenCreate: {
              storefrontAccessToken: {
                accessToken: "shpsf_fresh",
                title: "ACC Connector",
              },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  it("mints + persists a fresh storefront token, then redirects", async () => {
    const { router } = newRouter({ store, fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `shop=foo.myshopify.com&token=${BEARER}`,
      }),
      res.res,
    );
    expect(res.status()).toBe(302);
    expect(res.headers().Location).toContain("/admin/shopify?token=");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/admin/api/2025-07/graphql.json");

    const updated = await store.get("foo.myshopify.com");
    expect(updated?.storefrontToken).toBe("shpsf_fresh");
  });

  it("rejects without the bearer (neither header, query, nor body)", async () => {
    const { router } = newRouter({ store, fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: "shop=foo.myshopify.com",
      }),
      res.res,
    );
    expect(res.status()).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it("503s when PORTAL_TOKEN is unset", async () => {
    const { router } = newRouter({ store, fetchImpl, bearer: "" });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: "shop=foo.myshopify.com&token=anything",
      }),
      res.res,
    );
    expect(res.status()).toBe(503);
  });

  it("405 on GET", async () => {
    const { router } = newRouter({ store, fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "GET",
        url: `/admin/shopify/rotate-storefront?shop=foo.myshopify.com&token=${BEARER}`,
      }),
      res.res,
    );
    // GET falls through to "not handled" since the router only matches POST.
    // Portal would then 404. We assert the router returned false.
    expect(res.status()).toBe(0);
  });

  it("400 on invalid shop", async () => {
    const { router } = newRouter({ store, fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: `shop=evil.com&token=${BEARER}`,
      }),
      res.res,
    );
    expect(res.status()).toBe(400);
  });

  it("404 when the shop isn't installed", async () => {
    const { router } = newRouter({ fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: `shop=never.myshopify.com&token=${BEARER}`,
      }),
      res.res,
    );
    expect(res.status()).toBe(404);
  });

  it("409 when the shop is uninstalled", async () => {
    const s2 = createInMemoryInstallationStore();
    await s2.save(makeInstallation({ uninstalledAt: 1 }));
    const { router } = newRouter({ store: s2, fetchImpl });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: `shop=foo.myshopify.com&token=${BEARER}`,
      }),
      res.res,
    );
    expect(res.status()).toBe(409);
  });

  it("502 when Shopify rejects the mutation (no access token)", async () => {
    const badFetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            storefrontAccessTokenCreate: {
              storefrontAccessToken: null,
              userErrors: [{ field: null, message: "Something broke" }],
            },
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const { router } = newRouter({ store, fetchImpl: badFetch });
    const res = mockRes();
    await router(
      mockReq({
        method: "POST",
        url: "/admin/shopify/rotate-storefront",
        body: `shop=foo.myshopify.com&token=${BEARER}`,
      }),
      res.res,
    );
    expect(res.status()).toBe(502);
  });
});
