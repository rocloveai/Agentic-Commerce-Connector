/**
 * Tests for AES-256-GCM token cipher. Round-trip, tamper detection, and
 * key-mismatch behaviour all come from the AEAD construction — the tests
 * codify the contract we rely on so regressions are caught fast.
 */
import { describe, it, expect } from "vitest";
import {
  encryptToken,
  decryptToken,
} from "../services/crypto/token-cipher.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("token-cipher round-trip", () => {
  it("encrypts then decrypts to the same plaintext", () => {
    const blob = encryptToken("shpat_live_token", KEY_A);
    expect(decryptToken(blob, KEY_A)).toBe("shpat_live_token");
  });

  it("produces a different ciphertext on each call (fresh IV)", () => {
    const a = encryptToken("token", KEY_A);
    const b = encryptToken("token", KEY_A);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY_A)).toBe("token");
    expect(decryptToken(b, KEY_A)).toBe("token");
  });

  it("round-trips unicode values", () => {
    const plain = "\u4e2d\u6587 + \uD83D\uDE80";
    expect(decryptToken(encryptToken(plain, KEY_A), KEY_A)).toBe(plain);
  });

  it("pass-through on empty string so null-token rows don't branch", () => {
    expect(encryptToken("", KEY_A)).toBe("");
    expect(decryptToken("", KEY_A)).toBe("");
  });
});

describe("token-cipher security properties", () => {
  it("rejects decryption with a different key", () => {
    const blob = encryptToken("token", KEY_A);
    expect(() => decryptToken(blob, KEY_B)).toThrow();
  });

  it("rejects ciphertext whose auth tag was flipped (tampering)", () => {
    const blob = encryptToken("token", KEY_A);
    const buf = Buffer.from(blob, "hex");
    // Flip a bit inside the auth tag region (bytes 12..28).
    buf[20] ^= 0x01;
    const tampered = buf.toString("hex");
    expect(() => decryptToken(tampered, KEY_A)).toThrow();
  });

  it("rejects ciphertext whose body was flipped", () => {
    const blob = encryptToken("token", KEY_A);
    const buf = Buffer.from(blob, "hex");
    // Flip a bit inside the ciphertext region (after iv+tag).
    buf[buf.length - 1] ^= 0x01;
    const tampered = buf.toString("hex");
    expect(() => decryptToken(tampered, KEY_A)).toThrow();
  });

  it("rejects truncated ciphertext", () => {
    const blob = encryptToken("token", KEY_A);
    const truncated = blob.slice(0, 20); // shorter than IV + tag
    expect(() => decryptToken(truncated, KEY_A)).toThrow(/too short|hex/);
  });

  it("rejects non-hex ciphertext", () => {
    expect(() => decryptToken("ZZZZ", KEY_A)).toThrow(/hex/);
  });
});

describe("token-cipher key validation", () => {
  it("rejects an empty key on encrypt and decrypt", () => {
    expect(() => encryptToken("x", "")).toThrow(/key is empty/);
    // Encrypt first with a valid key so decrypt has something to chew on.
    const blob = encryptToken("x", KEY_A);
    expect(() => decryptToken(blob, "")).toThrow(/key is empty/);
  });

  it("rejects a key that is not 64 hex chars", () => {
    expect(() => encryptToken("x", "short")).toThrow(/64 hex chars/);
    expect(() => encryptToken("x", "g".repeat(64))).toThrow(/64 hex chars/);
  });
});
