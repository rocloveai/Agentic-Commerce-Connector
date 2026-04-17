/**
 * Shopify webhook HMAC verifier — distinct from the OAuth callback HMAC
 * (different payload shape + base64 header).
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyWebhookHmac } from "../adapters/shopify/oauth/webhook-hmac.js";

const SECRET = "shpss_app_client_secret";
const BODY = '{"id":12345,"shop_domain":"foo.myshopify.com"}';

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyShopifyWebhookHmac", () => {
  it("accepts a correctly signed body (string input)", () => {
    expect(verifyShopifyWebhookHmac(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("accepts a Buffer body verbatim (no re-encoding)", () => {
    const buf = Buffer.from(BODY, "utf8");
    expect(verifyShopifyWebhookHmac(buf, sign(buf), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(BODY);
    expect(
      verifyShopifyWebhookHmac(BODY + " ", sig, SECRET),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(
      verifyShopifyWebhookHmac(BODY, sign(BODY, "other"), SECRET),
    ).toBe(false);
  });

  it("rejects missing header", () => {
    expect(verifyShopifyWebhookHmac(BODY, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(BODY, "", SECRET)).toBe(false);
  });

  it("rejects empty client secret", () => {
    expect(verifyShopifyWebhookHmac(BODY, sign(BODY), "")).toBe(false);
  });

  it("rejects headers that are not base64", () => {
    expect(
      verifyShopifyWebhookHmac(BODY, "!!!not base64!!!", SECRET),
    ).toBe(false);
  });

  it("rejects when the decoded header has the wrong length", () => {
    expect(
      verifyShopifyWebhookHmac(BODY, Buffer.from("short").toString("base64"), SECRET),
    ).toBe(false);
  });

  it("accepts unicode bodies byte-for-byte", () => {
    const body = '{"title":"\u4f60\u597d"}';
    expect(verifyShopifyWebhookHmac(body, sign(body), SECRET)).toBe(true);
  });
});
