// Tests for the lazy UCP deps resolver used by OAuth-only mode.
import { describe, it, expect } from "vitest";
import { createOauthUcpResolver } from "../adapters/shopify/oauth/ucp-binding.js";
import { createInMemoryInstallationStore } from "../adapters/shopify/oauth/installation-store.js";
import type { Config } from "../config.js";
import type { ShopInstallation } from "../adapters/shopify/oauth/types.js";

function makeConfig(): Config {
  return {
    platform: "shopify",
    mode: "oauth",
    merchantDid: "did:test",
    portalPort: 10010,
    databaseUrl: "",
    selfUrl: "https://acc.example.com",
    portalToken: "",
    paymentCurrency: "USD",
    fixedRate: 1,
    rateLockMinutes: 5,
    storeUrl: "",
    accEncryptionKey: "",
    accSkillMdPath: "",
    shopifyClientId: "x",
    shopifyClientSecret: "y",
    shopifyOAuthScopes: ["read_products"],
    shopifyOAuthRedirect: "",
    shopifyStoreUrl: "",
    shopifyApiVersion: "2025-07",
  } as unknown as Config;
}

function makeResolverOpts(store = createInMemoryInstallationStore()) {
  return {
    config: makeConfig(),
    installationStore: store,
    apiVersion: "2025-07",
    ucpEndpoint: "https://acc.example.com/ucp/v1",
    cartTokenConfig: { secret: "x".repeat(32) },
    paymentHandlers: [],
    // Tests use null relayUrl so no network I/O from refresh logic; with
    // null + tokenExpiresAt also null (legacy fixtures) the refresh branch
    // is skipped entirely.
    relayUrl: null,
  };
}

function makeInstallation(
  overrides: Partial<ShopInstallation> = {},
): ShopInstallation {
  return {
    shopDomain: "store-a.myshopify.com",
    adminToken: "shpat_a",
    storefrontToken: "shpat_sf_a",
    scopes: ["read_products"],
    installedAt: 1_700_000_000_000,
    uninstalledAt: null,
    tokenExpiresAt: null,
    refreshToken: null,
    ...overrides,
  };
}

describe("createOauthUcpResolver", () => {
  it("returns no-installation before any install", async () => {
    const opts = makeResolverOpts();
    const resolve = createOauthUcpResolver(opts);
    const result = await resolve();
    expect(result.kind).toBe("no-installation");
  });

  it("returns ready with working adapters after an install", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation());
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const result = await resolve();
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.shopDomain).toBe("store-a.myshopify.com");
      expect(result.deps.catalog).toBeTruthy();
      expect(result.deps.merchant).toBeTruthy();
      expect(result.deps.ucpEndpoint).toBe("https://acc.example.com/ucp/v1");
    }
  });

  it("returns the cached deps when (shopDomain, installedAt) unchanged", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation());
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const a = await resolve();
    const b = await resolve();
    expect(a.kind).toBe("ready");
    expect(b.kind).toBe("ready");
    if (a.kind === "ready" && b.kind === "ready") {
      expect(a.deps).toBe(b.deps);
    }
  });

  it("rebuilds deps when installedAt changes (re-grant)", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ installedAt: 1_700_000_000_000 }));
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const a = await resolve();
    await store.save(makeInstallation({ installedAt: 1_700_000_900_000 }));
    const b = await resolve();
    if (a.kind === "ready" && b.kind === "ready") {
      expect(a.deps).not.toBe(b.deps);
    } else {
      throw new Error("expected both ready");
    }
  });

  it("skips uninstalled installations, even if newer", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ shopDomain: "old.myshopify.com", installedAt: 1_000 }));
    await store.save(
      makeInstallation({
        shopDomain: "new.myshopify.com",
        installedAt: 9_000,
        uninstalledAt: 9_500,
      }),
    );
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const result = await resolve();
    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.shopDomain).toBe("old.myshopify.com");
  });

  it("returns no-installation when every installation has been uninstalled", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ uninstalledAt: 9_500 }));
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const result = await resolve();
    expect(result.kind).toBe("no-installation");
  });

  it("picks the most recently installed when multiple are active", async () => {
    const store = createInMemoryInstallationStore();
    await store.save(makeInstallation({ shopDomain: "a.myshopify.com", installedAt: 1_000 }));
    await store.save(makeInstallation({ shopDomain: "b.myshopify.com", installedAt: 2_000 }));
    const resolve = createOauthUcpResolver(makeResolverOpts(store));
    const result = await resolve();
    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.shopDomain).toBe("b.myshopify.com");
  });
});
