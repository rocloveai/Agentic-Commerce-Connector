// Unit tests for the OAuth adapter factory: ShopInstallation → AdapterPair
import { describe, it, expect } from "vitest";
import { createShopifyAdaptersFromInstallation } from "../adapters/shopify/oauth/adapter-factory.js";
import type { ShopInstallation } from "../adapters/shopify/oauth/types.js";

function makeInstallation(
  overrides: Partial<ShopInstallation> = {},
): ShopInstallation {
  return {
    shopDomain: "test-store.myshopify.com",
    adminToken: "shpat_admin_xxx",
    storefrontToken: "shpat_storefront_xxx",
    scopes: ["read_products", "write_orders"],
    installedAt: 1_700_000_000_000,
    uninstalledAt: null,
    ...overrides,
  };
}

describe("createShopifyAdaptersFromInstallation", () => {
  it("returns a populated AdapterPair for a well-formed installation", () => {
    const pair = createShopifyAdaptersFromInstallation(makeInstallation(), {
      apiVersion: "2025-07",
    });
    expect(pair.catalog).toBeTruthy();
    expect(pair.merchant).toBeTruthy();
    expect(typeof pair.catalog.searchProducts).toBe("function");
    expect(typeof pair.catalog.listProducts).toBe("function");
    expect(typeof pair.catalog.getProduct).toBe("function");
  });

  it("produces no merchant adapter when adminToken is empty", () => {
    const pair = createShopifyAdaptersFromInstallation(
      makeInstallation({ adminToken: "" }),
      { apiVersion: "2025-07" },
    );
    expect(pair.merchant).toBeNull();
  });

  it("tolerates null storefrontToken (passes empty string through)", () => {
    // Storefront-token provisioning can fail at install time; the factory
    // must not throw — catalog will 401 at request time, that's fine.
    const pair = createShopifyAdaptersFromInstallation(
      makeInstallation({ storefrontToken: null }),
      { apiVersion: "2025-07" },
    );
    expect(pair.catalog).toBeTruthy();
  });
});
