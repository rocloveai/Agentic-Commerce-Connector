/**
 * Pure scope-diff — normalisation, missing/extra split, immutability.
 */
import { describe, it, expect } from "vitest";
import { diffScopes } from "../adapters/shopify/oauth/scope-diff.js";

describe("diffScopes", () => {
  it("reports ok when granted is a superset of requested", () => {
    const d = diffScopes(
      ["read_products", "write_orders"],
      ["read_products", "write_orders", "read_customers"],
    );
    expect(d.ok).toBe(true);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual(["read_customers"]);
  });

  it("reports missing scopes with stable ordering", () => {
    const d = diffScopes(
      ["read_products", "write_orders", "read_inventory"],
      ["read_products"],
    );
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual(["write_orders", "read_inventory"]);
  });

  it("normalises case and trims whitespace", () => {
    const d = diffScopes([" Read_Products ", "WRITE_ORDERS"], ["read_products", "write_orders"]);
    expect(d.ok).toBe(true);
    expect(d.requested).toEqual(["read_products", "write_orders"]);
  });

  it("deduplicates repeated scopes", () => {
    const d = diffScopes(
      ["read_products", "read_products"],
      ["read_products", "read_products"],
    );
    expect(d.requested).toEqual(["read_products"]);
    expect(d.granted).toEqual(["read_products"]);
  });

  it("ignores empty strings from sloppy comma-split env vars", () => {
    const d = diffScopes(["read_products", "", "  "], ["read_products"]);
    expect(d.ok).toBe(true);
    expect(d.requested).toEqual(["read_products"]);
  });

  it("empty requested is trivially ok", () => {
    expect(diffScopes([], ["anything"]).ok).toBe(true);
  });

  it("empty granted surfaces all requested as missing", () => {
    const d = diffScopes(["a", "b"], []);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual(["a", "b"]);
  });
});
