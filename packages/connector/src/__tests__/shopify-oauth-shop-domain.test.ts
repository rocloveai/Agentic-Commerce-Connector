/**
 * Tests for the shop-domain validator. The `?shop=` param is attacker-
 * controlled on the install URL, so anything slipping through the regex
 * becomes a potential open-redirect or CSRF-to-attacker-shop.
 */
import { describe, it, expect } from "vitest";
import {
  assertShopDomain,
  isValidShopDomain,
} from "../adapters/shopify/oauth/shop-domain.js";

describe("isValidShopDomain", () => {
  it("accepts a typical myshopify.com handle", () => {
    expect(isValidShopDomain("my-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("store1.myshopify.com")).toBe(true);
    expect(isValidShopDomain("a.myshopify.com")).toBe(true);
  });

  it("normalises case when asserting", () => {
    expect(isValidShopDomain("My-Store.MyShopify.COM")).toBe(true);
    expect(assertShopDomain("My-Store.MyShopify.COM")).toBe(
      "my-store.myshopify.com",
    );
  });

  it("rejects leading hyphens", () => {
    expect(isValidShopDomain("-evil.myshopify.com")).toBe(false);
  });

  it("rejects nested subdomain attacks", () => {
    expect(isValidShopDomain("foo.myshopify.com.attacker.com")).toBe(false);
    expect(isValidShopDomain("myshopify.com.attacker.com")).toBe(false);
    expect(isValidShopDomain("attacker.com")).toBe(false);
  });

  it("rejects path / scheme / query injection", () => {
    expect(isValidShopDomain("foo.myshopify.com/evil")).toBe(false);
    expect(isValidShopDomain("https://foo.myshopify.com")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.com?q=1")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.com#frag")).toBe(false);
    expect(isValidShopDomain("user@foo.myshopify.com")).toBe(false);
  });

  it("rejects whitespace and control characters", () => {
    expect(isValidShopDomain(" foo.myshopify.com")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.com ")).toBe(false);
    expect(isValidShopDomain("foo .myshopify.com")).toBe(false);
    expect(isValidShopDomain("foo\n.myshopify.com")).toBe(false);
  });

  it("rejects empty, too-long, and non-string input", () => {
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("a".repeat(260) + ".myshopify.com")).toBe(false);
    expect(isValidShopDomain(null)).toBe(false);
    expect(isValidShopDomain(undefined)).toBe(false);
    expect(isValidShopDomain(123)).toBe(false);
  });

  it("rejects underscore and special chars outside a-z0-9 hyphen", () => {
    expect(isValidShopDomain("foo_bar.myshopify.com")).toBe(false);
    expect(isValidShopDomain("foo+bar.myshopify.com")).toBe(false);
    expect(isValidShopDomain("foo%20bar.myshopify.com")).toBe(false);
  });

  it("rejects the wrong top-level domain", () => {
    expect(isValidShopDomain("foo.shopify.com")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.co")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.net")).toBe(false);
  });
});

describe("assertShopDomain", () => {
  it("throws on invalid input with a clear message", () => {
    expect(() => assertShopDomain("evil.com")).toThrow(/Invalid shop domain/);
    expect(() => assertShopDomain(null)).toThrow(/Invalid shop domain/);
  });

  it("returns the lowercased domain on success", () => {
    expect(assertShopDomain("Foo.MyShopify.com")).toBe("foo.myshopify.com");
  });
});
