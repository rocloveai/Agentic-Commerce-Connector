/**
 * Tests for Shopify OAuth callback HMAC verification.
 *
 * Covers the canonicalisation rules (drop `hmac`/`signature`, escape `%&=`
 * in values, sort by key) and constant-time comparison semantics.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  canonicalizeQuery,
  verifyCallbackHmac,
} from "../adapters/shopify/oauth/hmac.js";

const CLIENT_SECRET = "shpss_secret_abcdef";

function sign(canonical: string): string {
  return createHmac("sha256", CLIENT_SECRET).update(canonical).digest("hex");
}

describe("canonicalizeQuery", () => {
  it("sorts keys alphabetically and drops hmac", () => {
    const canonical = canonicalizeQuery({
      shop: "foo.myshopify.com",
      code: "abc",
      timestamp: "1700000000",
      hmac: "deadbeef",
    });
    expect(canonical).toBe(
      "code=abc&shop=foo.myshopify.com&timestamp=1700000000",
    );
  });

  it("drops the `signature` param as well", () => {
    const canonical = canonicalizeQuery({
      shop: "foo.myshopify.com",
      signature: "ignored",
    });
    expect(canonical).toBe("shop=foo.myshopify.com");
  });

  it("escapes %, &, = inside values only", () => {
    const canonical = canonicalizeQuery({ state: "a&b=c%d" });
    expect(canonical).toBe("state=a%26b%3Dc%25d");
  });

  it("skips undefined params without crashing", () => {
    const canonical = canonicalizeQuery({
      shop: "foo.myshopify.com",
      extra: undefined,
    });
    expect(canonical).toBe("shop=foo.myshopify.com");
  });

  it("joins repeated values deterministically", () => {
    const canonical = canonicalizeQuery({
      ids: ["3", "1", "2"],
    });
    expect(canonical).toBe("ids=3,1,2");
  });
});

describe("verifyCallbackHmac", () => {
  const params = {
    code: "authcode123",
    shop: "foo.myshopify.com",
    state: "nonce-abcdef",
    timestamp: "1700000000",
  };
  const canonical = "code=authcode123&shop=foo.myshopify.com&state=nonce-abcdef&timestamp=1700000000";

  it("accepts a correctly signed request", () => {
    const hmac = sign(canonical);
    expect(verifyCallbackHmac(params, hmac, CLIENT_SECRET)).toBe(true);
  });

  it("rejects a request signed with the wrong secret", () => {
    const hmac = createHmac("sha256", "wrong_secret")
      .update(canonical)
      .digest("hex");
    expect(verifyCallbackHmac(params, hmac, CLIENT_SECRET)).toBe(false);
  });

  it("rejects when one param is tampered", () => {
    const hmac = sign(canonical);
    const tampered = { ...params, shop: "evil.myshopify.com" };
    expect(verifyCallbackHmac(tampered, hmac, CLIENT_SECRET)).toBe(false);
  });

  it("rejects when extra params are injected after signing", () => {
    const hmac = sign(canonical);
    const extra = { ...params, extra: "surprise" };
    expect(verifyCallbackHmac(extra, hmac, CLIENT_SECRET)).toBe(false);
  });

  it("accepts the canonical form even when params arrive in different order", () => {
    const reordered = {
      timestamp: "1700000000",
      state: "nonce-abcdef",
      shop: "foo.myshopify.com",
      code: "authcode123",
    };
    const hmac = sign(canonical);
    expect(verifyCallbackHmac(reordered, hmac, CLIENT_SECRET)).toBe(true);
  });

  it("rejects an hmac that is not 64 hex chars", () => {
    expect(verifyCallbackHmac(params, "deadbeef", CLIENT_SECRET)).toBe(false);
    expect(verifyCallbackHmac(params, "", CLIENT_SECRET)).toBe(false);
    expect(
      verifyCallbackHmac(params, "zz" + "a".repeat(62), CLIENT_SECRET),
    ).toBe(false);
  });

  it("rejects when client_secret is empty", () => {
    const hmac = sign(canonical);
    expect(verifyCallbackHmac(params, hmac, "")).toBe(false);
  });

  it("is case-insensitive on the hex hmac string", () => {
    const hmac = sign(canonical);
    expect(verifyCallbackHmac(params, hmac.toUpperCase(), CLIENT_SECRET)).toBe(
      true,
    );
  });
});
