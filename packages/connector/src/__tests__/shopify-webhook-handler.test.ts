/**
 * Incoming Shopify webhook handler — app/uninstalled flips `uninstalled_at`,
 * GDPR topics acknowledge with 200. HMAC verification must use Shopify's
 * `client_secret`, NOT the Nexus `webhookSecret`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createShopifyWebhookRouter } from "../adapters/shopify/oauth/webhook-handler.js";
import { createInMemoryInstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type { InstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type { OAuthConfig } from "../adapters/shopify/oauth/types.js";

const CLIENT_SECRET = "shpss_secret";
const NEXUS_SECRET = "different_webhook_secret";
const SHOP = "foo.myshopify.com";

function oauthConfig(): OAuthConfig {
  return {
    clientId: "c",
    clientSecret: CLIENT_SECRET,
    scopes: ["read_products"],
    redirectUri: "https://acc.example.com/auth/shopify/callback",
    apiVersion: "2025-07",
  };
}

function sign(body: string, secret = CLIENT_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
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
  r.method = opts.method ?? "POST";
  r.url = opts.url;
  r.headers = {
    host: "acc.example.com",
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  return r;
}

function mockRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let statusCode = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(chunk.toString());
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => chunks.join(""),
  };
}

describe("Shopify webhook handler — app/uninstalled", () => {
  let store: InstallationStore;
  let router: ReturnType<typeof createShopifyWebhookRouter>;
  const body = '{"shop_id":123,"shop_domain":"foo.myshopify.com"}';

  beforeEach(async () => {
    store = createInMemoryInstallationStore();
    await store.save({
      shopDomain: SHOP,
      adminToken: "t",
      storefrontToken: null,
      scopes: ["read_products"],
      installedAt: 1,
      uninstalledAt: null,
    });
    router = createShopifyWebhookRouter({
      oauthConfig: oauthConfig(),
      installationStore: store,
      now: () => 9_999_999,
    });
  });

  it("flips uninstalled_at when HMAC + shop header are valid", async () => {
    const res = mockRes();
    const handled = await router(
      mockReq({
        url: "/webhooks/shopify/app-uninstalled",
        headers: {
          "x-shopify-hmac-sha256": sign(body),
          "x-shopify-shop-domain": SHOP,
        },
        body,
      }),
      res.res,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const row = await store.get(SHOP);
    expect(row?.uninstalledAt).toBe(9_999_999);
  });

  it("rejects requests signed with the Nexus webhook secret (wrong key)", async () => {
    const res = mockRes();
    await router(
      mockReq({
        url: "/webhooks/shopify/app-uninstalled",
        headers: {
          "x-shopify-hmac-sha256": sign(body, NEXUS_SECRET),
          "x-shopify-shop-domain": SHOP,
        },
        body,
      }),
      res.res,
    );
    expect(res.status()).toBe(401);
    const row = await store.get(SHOP);
    expect(row?.uninstalledAt).toBeNull();
  });

  it("rejects requests with an invalid shop header", async () => {
    const res = mockRes();
    await router(
      mockReq({
        url: "/webhooks/shopify/app-uninstalled",
        headers: {
          "x-shopify-hmac-sha256": sign(body),
          "x-shopify-shop-domain": "evil.example.com",
        },
        body,
      }),
      res.res,
    );
    expect(res.status()).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = mockRes();
    await router(
      mockReq({
        method: "GET",
        url: "/webhooks/shopify/app-uninstalled",
        headers: { "x-shopify-hmac-sha256": sign(""), "x-shopify-shop-domain": SHOP },
      }),
      res.res,
    );
    expect(res.status()).toBe(405);
  });

  it("is a no-op when the shop has no installation row (idempotent)", async () => {
    const unknownShop = "never-installed.myshopify.com";
    const res = mockRes();
    await router(
      mockReq({
        url: "/webhooks/shopify/app-uninstalled",
        headers: {
          "x-shopify-hmac-sha256": sign(body),
          "x-shopify-shop-domain": unknownShop,
        },
        body,
      }),
      res.res,
    );
    expect(res.status()).toBe(200);
    expect(await store.get(unknownShop)).toBeNull();
  });
});

describe("Shopify webhook handler — GDPR topics", () => {
  let router: ReturnType<typeof createShopifyWebhookRouter>;
  const body = '{"customer":{"id":1}}';

  beforeEach(() => {
    router = createShopifyWebhookRouter({
      oauthConfig: oauthConfig(),
      installationStore: createInMemoryInstallationStore(),
    });
  });

  for (const path of [
    "/webhooks/shopify/customers-data-request",
    "/webhooks/shopify/customers-redact",
    "/webhooks/shopify/shop-redact",
  ]) {
    it(`acknowledges ${path} with 200 when signed correctly`, async () => {
      const res = mockRes();
      await router(
        mockReq({
          url: path,
          headers: {
            "x-shopify-hmac-sha256": sign(body),
            "x-shopify-shop-domain": SHOP,
          },
          body,
        }),
        res.res,
      );
      expect(res.status()).toBe(200);
    });

    it(`rejects ${path} on bad HMAC`, async () => {
      const res = mockRes();
      await router(
        mockReq({
          url: path,
          headers: {
            "x-shopify-hmac-sha256": sign(body, "wrong"),
            "x-shopify-shop-domain": SHOP,
          },
          body,
        }),
        res.res,
      );
      expect(res.status()).toBe(401);
    });
  }
});

describe("Shopify webhook router — unknown paths", () => {
  it("returns false for non-webhook paths so the portal 404s them", async () => {
    const router = createShopifyWebhookRouter({
      oauthConfig: oauthConfig(),
      installationStore: createInMemoryInstallationStore(),
    });
    const res = mockRes();
    const handled = await router(
      mockReq({ url: "/not/a/webhook", body: "" }),
      res.res,
    );
    expect(handled).toBe(false);
  });
});
