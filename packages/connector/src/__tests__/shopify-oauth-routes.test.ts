/**
 * Integration-shaped tests for the Shopify OAuth install + callback routes.
 *
 * Everything is mocked:
 *   - Incoming requests are built from a small helper.
 *   - Responses capture status + headers + body for assertions.
 *   - `fetch` is replaced so token exchange never touches the network.
 *   - `Date.now` is not mocked directly; we inject a clock via deps.now.
 *
 * What we verify end-to-end:
 *   1. install → 302 to Shopify's authorize URL with our client_id, scopes,
 *      redirect_uri, state.
 *   2. callback happy path → fetch Shopify, persist installation, 302 to
 *      /admin/shopify/installed?shop=…
 *   3. callback rejects bad shop / bad HMAC / bad state / stale timestamp /
 *      missing code.
 *   4. token exchange failure surfaces as 502.
 *   5. state is single-use across the full callback path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createShopifyOAuthRouter,
  MAX_TIMESTAMP_SKEW_SEC,
} from "../adapters/shopify/oauth/routes.js";
import { createInMemoryStateStore } from "../adapters/shopify/oauth/state.js";
import { createInMemoryInstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type {
  OAuthConfig,
  StateStore,
} from "../adapters/shopify/oauth/types.js";
import type { InstallationStore } from "../adapters/shopify/oauth/installation-store.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const CLIENT_ID = "client_abc";
const CLIENT_SECRET = "secret_xyz";
const SHOP = "foo.myshopify.com";
const REDIRECT = "https://acc.example.com/auth/shopify/callback";

function defaultOAuthConfig(): OAuthConfig {
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: ["read_products", "write_orders"],
    redirectUri: REDIRECT,
    apiVersion: "2025-07",
  };
}

interface MockRes {
  readonly res: ServerResponse;
  status(): number;
  headers(): Record<string, string>;
  body(): string;
}

function mockReq(url: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: { host: "acc.example.com" },
  } as unknown as IncomingMessage;
}

function mockRes(): MockRes {
  let statusCode = 0;
  let capturedHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    writeHead(code: number, headers: Record<string, string> = {}) {
      statusCode = code;
      capturedHeaders = { ...capturedHeaders, ...headers };
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(chunk.toString());
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    headers: () => capturedHeaders,
    body: () => chunks.join(""),
  };
}

function signCanonical(params: Record<string, string>): string {
  const entries = Object.entries(params)
    .filter(([k]) => k !== "hmac")
    .map(
      ([k, v]) =>
        [
          k,
          v.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D"),
        ] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonical = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return createHmac("sha256", CLIENT_SECRET).update(canonical).digest("hex");
}

function buildCallbackUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams(params);
  return `/auth/shopify/callback?${qs.toString()}`;
}

/**
 * Build a deterministic clock for the "current" timestamp that matches what
 * Shopify would set on the callback, so our skew check passes by default.
 */
function makeClock(
  shopifyTsSec: number,
  localOffsetSec: number = 0,
): () => number {
  return () => (shopifyTsSec + localOffsetSec) * 1000;
}

// ---------------------------------------------------------------------------
// Shared deps construction
// ---------------------------------------------------------------------------

interface Harness {
  stateStore: StateStore;
  installationStore: InstallationStore;
  router: ReturnType<typeof createShopifyOAuthRouter>;
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  /** Override only the token exchange response (default: success). */
  setTokenExchangeResponse(resp: Response): void;
}

/**
 * Build a fetch impl that returns plausible responses for all three of the
 * endpoints hit during the callback: token exchange, storefront token
 * mutation, webhook registration. Tests can override the token-exchange
 * response to simulate Shopify rejecting the code.
 */
function newHarness(
  opts: {
    clock?: () => number;
    randomHex?: () => string;
  } = {},
): Harness {
  const stateStore = createInMemoryStateStore({
    randomHex: opts.randomHex ?? (() => "fixed-state-nonce"),
    now: opts.clock,
  });
  const installationStore = createInMemoryInstallationStore();
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

  let tokenExchangeResponse: Response = new Response(
    JSON.stringify({
      access_token: "shpat_stubbed_offline_token",
      scope: "read_products,write_orders",
    }),
    { status: 200 },
  );

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.endsWith("/admin/oauth/access_token")) {
      return tokenExchangeResponse;
    }
    if (url.includes("/admin/api/") && url.endsWith("/graphql.json")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const query = String(body.query ?? "");
      if (/storefrontAccessTokenCreate/.test(query)) {
        return new Response(
          JSON.stringify({
            data: {
              storefrontAccessTokenCreate: {
                storefrontAccessToken: {
                  accessToken: "shpsf_stubbed_storefront_token",
                  title: "ACC Connector",
                },
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (/webhookSubscriptionCreate/.test(query)) {
        return new Response(
          JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: { id: "gid://shopify/WebhookSub/1" },
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }
    }
    return new Response("unexpected endpoint", { status: 418 });
  }) as typeof fetch;

  const router = createShopifyOAuthRouter({
    oauthConfig: defaultOAuthConfig(),
    stateStore,
    installationStore,
    selfUrl: "https://acc.example.com",
    adminBearer: "test-bearer",
    fetchImpl,
    now: opts.clock,
  });
  return {
    stateStore,
    installationStore,
    router,
    fetchCalls,
    setTokenExchangeResponse(resp) {
      tokenExchangeResponse = resp;
    },
  };
}

// ---------------------------------------------------------------------------
// /auth/shopify/install
// ---------------------------------------------------------------------------

describe("handleInstall", () => {
  it("redirects to Shopify's authorize URL with our params", async () => {
    const h = newHarness();
    const res = mockRes();
    const handled = await h.router(
      mockReq(`/auth/shopify/install?shop=${SHOP}`),
      res.res,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(302);
    const loc = res.headers().Location;
    expect(loc).toBeDefined();
    const u = new URL(loc);
    expect(u.origin).toBe(`https://${SHOP}`);
    expect(u.pathname).toBe("/admin/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("scope")).toBe("read_products,write_orders");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("state")).toBe("fixed-state-nonce");
  });

  it("400s on a bogus shop domain", async () => {
    const h = newHarness();
    const res = mockRes();
    await h.router(mockReq("/auth/shopify/install?shop=evil.com"), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("invalid_shop");
  });

  it("400s on missing shop param", async () => {
    const h = newHarness();
    const res = mockRes();
    await h.router(mockReq("/auth/shopify/install"), res.res);
    expect(res.status()).toBe(400);
  });

  it("normalises uppercase shop to lowercase in the redirect", async () => {
    const h = newHarness();
    const res = mockRes();
    await h.router(
      mockReq(`/auth/shopify/install?shop=Foo.MyShopify.Com`),
      res.res,
    );
    const loc = res.headers().Location;
    expect(new URL(loc).origin).toBe(`https://${SHOP}`);
  });
});

// ---------------------------------------------------------------------------
// /auth/shopify/callback
// ---------------------------------------------------------------------------

describe("handleCallback", () => {
  const nowSec = 1_700_000_000;
  let harness: Harness;
  let state: string;

  beforeEach(() => {
    harness = newHarness({ clock: makeClock(nowSec) });
    // Pre-issue a state via the install path so the state store has it.
    state = harness.stateStore.issue(SHOP);
  });

  function buildParams(
    overrides: Record<string, string> = {},
  ): Record<string, string> {
    const params: Record<string, string> = {
      code: "authcode_xyz",
      shop: SHOP,
      state,
      timestamp: String(nowSec),
      ...overrides,
    };
    params.hmac = signCanonical(params);
    return params;
  }

  it("happy path: exchanges code, persists installation, redirects", async () => {
    const params = buildParams();
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);

    expect(res.status()).toBe(302);
    expect(res.headers().Location).toBe(
      `/admin/shopify/installed?shop=${encodeURIComponent(SHOP)}`,
    );

    // Token exchange (1) + storefront mutation (1) + webhook registrations (4) = 6
    expect(harness.fetchCalls).toHaveLength(6);
    const tokenExchangeCall = harness.fetchCalls[0];
    expect(tokenExchangeCall.url).toBe(
      `https://${SHOP}/admin/oauth/access_token`,
    );
    const sentBody = JSON.parse(String(tokenExchangeCall.init?.body));
    expect(sentBody).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "authcode_xyz",
    });

    // Subsequent calls all hit the Admin GraphQL endpoint.
    for (const call of harness.fetchCalls.slice(1)) {
      expect(call.url).toBe(`https://${SHOP}/admin/api/2025-07/graphql.json`);
    }

    const installation = await harness.installationStore.get(SHOP);
    expect(installation?.shopDomain).toBe(SHOP);
    expect(installation?.adminToken).toBe("shpat_stubbed_offline_token");
    expect(installation?.storefrontToken).toBe(
      "shpsf_stubbed_storefront_token",
    );
    expect(installation?.scopes).toEqual(["read_products", "write_orders"]);
    expect(installation?.uninstalledAt).toBeNull();
  });

  it("rejects a tampered param (HMAC mismatch)", async () => {
    const params = buildParams();
    params.shop = "evil.myshopify.com";
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("hmac_mismatch");
    expect(await harness.installationStore.list()).toHaveLength(0);
  });

  it("rejects a replayed state nonce", async () => {
    const params = buildParams();
    const res1 = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res1.res);
    expect(res1.status()).toBe(302);

    const res2 = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res2.res);
    expect(res2.status()).toBe(400);
    expect(JSON.parse(res2.body()).error).toBe("state_mismatch");
  });

  it("rejects a state bound to a different shop", async () => {
    const params = buildParams({ shop: "bar.myshopify.com" });
    // Re-sign with the new shop so HMAC check passes; state should still fail
    // because it was issued against SHOP, not bar.myshopify.com.
    params.hmac = signCanonical(params);
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("state_mismatch");
  });

  it("rejects a stale timestamp (beyond skew window)", async () => {
    const staleTs = nowSec - MAX_TIMESTAMP_SKEW_SEC - 1;
    const params = buildParams({ timestamp: String(staleTs) });
    params.hmac = signCanonical(params);
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("timestamp_skew");
  });

  it("rejects a non-numeric timestamp", async () => {
    const params = buildParams({ timestamp: "notanumber" });
    params.hmac = signCanonical(params);
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("bad_timestamp");
  });

  it("rejects when `code` is missing", async () => {
    const params = buildParams();
    delete params.code;
    params.hmac = signCanonical(params);
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("missing_code");
  });

  it("rejects a bogus shop domain outright", async () => {
    const qs = new URLSearchParams({
      shop: "not-a-real-shopify",
      code: "x",
      state,
      timestamp: String(nowSec),
      hmac: "0".repeat(64),
    });
    const res = mockRes();
    await harness.router(mockReq(`/auth/shopify/callback?${qs}`), res.res);
    expect(res.status()).toBe(400);
    expect(JSON.parse(res.body()).error).toBe("invalid_shop");
  });

  it("502s when Shopify rejects the token exchange", async () => {
    harness.setTokenExchangeResponse(new Response("bad_code", { status: 400 }));
    const params = buildParams();
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(502);
    expect(JSON.parse(res.body()).error).toBe("token_exchange_failed");
    expect(await harness.installationStore.list()).toHaveLength(0);
  });

  it("502s when Shopify returns success with no access_token", async () => {
    harness.setTokenExchangeResponse(
      new Response(JSON.stringify({ scope: "read_products" }), { status: 200 }),
    );
    const params = buildParams();
    const res = mockRes();
    await harness.router(mockReq(buildCallbackUrl(params)), res.res);
    expect(res.status()).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// /admin/shopify/installed
// ---------------------------------------------------------------------------

describe("handleInstalledSuccess", () => {
  it("renders an HTML page with the installation summary", async () => {
    const h = newHarness();
    await h.installationStore.save({
      shopDomain: SHOP,
      adminToken: "t",
      storefrontToken: null,
      scopes: ["read_products"],
      installedAt: 1,
      uninstalledAt: null,
    });
    const res = mockRes();
    await h.router(mockReq(`/admin/shopify/installed?shop=${SHOP}`), res.res);
    expect(res.status()).toBe(200);
    expect(res.headers()["Content-Type"]).toMatch(/text\/html/);
    expect(res.body()).toContain(SHOP);
    expect(res.body()).toContain("read_products");
  });

  it("still renders (with 'unknown' status) when no installation exists", async () => {
    const h = newHarness();
    const res = mockRes();
    await h.router(mockReq(`/admin/shopify/installed?shop=${SHOP}`), res.res);
    expect(res.status()).toBe(200);
    expect(res.body()).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// Router unknowns
// ---------------------------------------------------------------------------

describe("createShopifyOAuthRouter", () => {
  it("returns false for non-OAuth paths so the portal 404s them normally", async () => {
    const h = newHarness();
    const res = mockRes();
    const handled = await h.router(mockReq("/some/other/path"), res.res);
    expect(handled).toBe(false);
  });

  it("returns false for non-GET methods", async () => {
    const h = newHarness();
    const res = mockRes();
    const req = {
      method: "POST",
      url: "/auth/shopify/install?shop=foo.myshopify.com",
      headers: { host: "acc.example.com" },
    } as unknown as IncomingMessage;
    const handled = await h.router(req, res.res);
    expect(handled).toBe(false);
  });
});
