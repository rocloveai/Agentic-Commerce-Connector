/**
 * Unit tests for the Shopify commerce-env loader — specifically the
 * manual-vs-OAuth mode split introduced in Phase 1 of the Shopify OAuth
 * rollout (see docs/plans/2026-04-16-shopify-oauth-design.md).
 *
 * Invariants verified here:
 *   - Absent SHOPIFY_CLIENT_ID → manual mode (preserves pre-Phase-1 behaviour).
 *   - Present SHOPIFY_CLIENT_ID → OAuth mode + client_secret required.
 *   - OAuth scopes default to the four write-path scopes when unset.
 *   - ACC_ENCRYPTION_KEY required + hex-validated in OAuth mode only.
 *   - loadCommerceEnv itself is env-only (no process.env leakage).
 */
import { describe, it, expect } from "vitest";
import { loadCommerceEnv } from "../config/commerce.js";
import { loadConfig } from "../config.js";

const VALID_ENC_KEY = "a".repeat(64);

function baseEnv(): Record<string, string> {
  return {
    MERCHANT_SIGNER_PRIVATE_KEY: "0xtest",
    MERCHANT_PAYMENT_ADDRESS: "0xaddr",
    PLATFORM: "shopify",
  };
}

describe("loadCommerceEnv — Shopify mode discrimination", () => {
  it("selects manual mode when SHOPIFY_CLIENT_ID is absent", () => {
    const env = loadCommerceEnv({
      SHOPIFY_STORE_URL: "https://my-store.myshopify.com",
      SHOPIFY_STOREFRONT_TOKEN: "sf_token",
      SHOPIFY_ADMIN_TOKEN: "shpat_x",
    });
    expect(env.platform).toBe("shopify");
    if (env.platform !== "shopify") return;
    expect(env.mode).toBe("manual");
    if (env.mode !== "manual") return;
    expect(env.shopifyStorefrontToken).toBe("sf_token");
    expect(env.shopifyAdminToken).toBe("shpat_x");
  });

  it("selects OAuth mode when SHOPIFY_CLIENT_ID is set", () => {
    const env = loadCommerceEnv({
      SHOPIFY_CLIENT_ID: "client_abc",
      SHOPIFY_CLIENT_SECRET: "secret_xyz",
    });
    expect(env.platform).toBe("shopify");
    if (env.platform !== "shopify") return;
    expect(env.mode).toBe("oauth");
    if (env.mode !== "oauth") return;
    expect(env.shopifyClientId).toBe("client_abc");
    expect(env.shopifyClientSecret).toBe("secret_xyz");
  });

  it("treats an empty SHOPIFY_CLIENT_ID as manual mode", () => {
    const env = loadCommerceEnv({
      SHOPIFY_CLIENT_ID: "   ",
      SHOPIFY_STORE_URL: "https://s.myshopify.com",
      SHOPIFY_STOREFRONT_TOKEN: "t",
    });
    expect(env.platform === "shopify" && env.mode).toBe("manual");
  });

  it("throws when OAuth mode is selected without SHOPIFY_CLIENT_SECRET", () => {
    expect(() =>
      loadCommerceEnv({
        SHOPIFY_CLIENT_ID: "client_abc",
      }),
    ).toThrow(/SHOPIFY_CLIENT_SECRET is required/);
  });

  it("throws on manual mode without SHOPIFY_STOREFRONT_TOKEN", () => {
    expect(() =>
      loadCommerceEnv({
        SHOPIFY_STORE_URL: "https://s.myshopify.com",
      }),
    ).toThrow(/SHOPIFY_STOREFRONT_TOKEN is required/);
  });

  it("applies the default OAuth scope list when unset", () => {
    const env = loadCommerceEnv({
      SHOPIFY_CLIENT_ID: "c",
      SHOPIFY_CLIENT_SECRET: "s",
    });
    if (env.platform !== "shopify" || env.mode !== "oauth") {
      throw new Error("narrowing failed");
    }
    expect(env.shopifyOAuthScopes).toEqual([
      "read_products",
      "read_inventory",
      "write_orders",
      "read_orders",
    ]);
  });

  it("parses a custom comma-separated scope list, trimming whitespace", () => {
    const env = loadCommerceEnv({
      SHOPIFY_CLIENT_ID: "c",
      SHOPIFY_CLIENT_SECRET: "s",
      SHOPIFY_OAUTH_SCOPES: " read_products , write_orders ,,",
    });
    if (env.platform !== "shopify" || env.mode !== "oauth") {
      throw new Error("narrowing failed");
    }
    expect(env.shopifyOAuthScopes).toEqual(["read_products", "write_orders"]);
  });

  it("allows OAuth mode without SHOPIFY_STORE_URL (bound at install time)", () => {
    const env = loadCommerceEnv({
      SHOPIFY_CLIENT_ID: "c",
      SHOPIFY_CLIENT_SECRET: "s",
    });
    if (env.platform !== "shopify" || env.mode !== "oauth") {
      throw new Error("narrowing failed");
    }
    expect(env.shopifyStoreUrl).toBe("");
    expect(env.storeUrl).toBe("");
  });
});

describe("loadConfig — OAuth mode cross-validation of ACC_ENCRYPTION_KEY", () => {
  it("throws when OAuth mode is active but ACC_ENCRYPTION_KEY is unset", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        SHOPIFY_CLIENT_ID: "c",
        SHOPIFY_CLIENT_SECRET: "s",
      }),
    ).toThrow(/ACC_ENCRYPTION_KEY is required/);
  });

  it("throws when ACC_ENCRYPTION_KEY is not 32 bytes of hex", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        SHOPIFY_CLIENT_ID: "c",
        SHOPIFY_CLIENT_SECRET: "s",
        ACC_ENCRYPTION_KEY: "notlongenough",
      }),
    ).toThrow(/must be 64.*hex chars/);
  });

  it("throws when ACC_ENCRYPTION_KEY contains non-hex chars", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        SHOPIFY_CLIENT_ID: "c",
        SHOPIFY_CLIENT_SECRET: "s",
        ACC_ENCRYPTION_KEY: "z".repeat(64),
      }),
    ).toThrow(/must be 64.*hex chars/);
  });

  it("accepts a valid hex key and returns an OAuth-mode config", () => {
    const config = loadConfig({
      ...baseEnv(),
      SHOPIFY_CLIENT_ID: "c",
      SHOPIFY_CLIENT_SECRET: "s",
      ACC_ENCRYPTION_KEY: VALID_ENC_KEY,
    });
    expect(config.platform).toBe("shopify");
    if (config.platform !== "shopify") return;
    expect(config.mode).toBe("oauth");
    expect(config.accEncryptionKey).toBe(VALID_ENC_KEY);
  });

  it("does not require ACC_ENCRYPTION_KEY in manual mode", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        SHOPIFY_STORE_URL: "https://s.myshopify.com",
        SHOPIFY_STOREFRONT_TOKEN: "t",
      }),
    ).not.toThrow();
  });
});
