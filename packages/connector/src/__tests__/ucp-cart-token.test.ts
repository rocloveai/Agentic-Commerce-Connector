import { describe, it, expect } from "vitest";
import {
  issueCartToken,
  verifyCartToken,
  loadCartTokenConfig,
} from "../ucp/cart-token.js";

const SECRET = "x".repeat(32);
const cfg = { secret: SECRET, ttlSeconds: 900 };

describe("cart-token", () => {
  it("roundtrips a valid token", () => {
    const token = issueCartToken("cs_abc", cfg);
    const verdict = verifyCartToken(token, cfg);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.session_id).toBe("cs_abc");
  });

  it("rejects a tampered signature", () => {
    const token = issueCartToken("cs_abc", cfg);
    const tampered = token.slice(0, -4) + "AAAA";
    const verdict = verifyCartToken(tampered, cfg);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("invalid_signature");
  });

  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const token = issueCartToken("cs_abc", cfg, past);
    const verdict = verifyCartToken(token, cfg);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("expired");
  });

  it("rejects malformed input", () => {
    expect(verifyCartToken("not-a-token", cfg).ok).toBe(false);
    expect(verifyCartToken("a.b.c", cfg).ok).toBe(false);
  });

  it("uses constant-time compare (signatures of equal length)", () => {
    const t1 = issueCartToken("cs_abc", cfg);
    const t2 = issueCartToken("cs_def", cfg);
    const [b1, s1] = t1.split(".");
    const [, s2] = t2.split(".");
    expect(s1.length).toBe(s2.length);
    expect(verifyCartToken(`${b1}.${s2}`, cfg).ok).toBe(false);
  });

  it("rejects short secret when loading config", () => {
    expect(() =>
      loadCartTokenConfig({ UCP_CART_TOKEN_SECRET: "short" }),
    ).toThrow();
    expect(() =>
      loadCartTokenConfig({ UCP_CART_TOKEN_SECRET: "y".repeat(32) }),
    ).not.toThrow();
  });

  it("accepts TTL override", () => {
    const loaded = loadCartTokenConfig({
      UCP_CART_TOKEN_SECRET: "y".repeat(32),
      UCP_TOKEN_TTL_SECONDS: "300",
    });
    expect(loaded.ttlSeconds).toBe(300);
  });

  it("rejects out-of-range TTL", () => {
    expect(() =>
      loadCartTokenConfig({
        UCP_CART_TOKEN_SECRET: "y".repeat(32),
        UCP_TOKEN_TTL_SECONDS: "10",
      }),
    ).toThrow();
  });
});
