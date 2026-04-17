// ---------------------------------------------------------------------------
// AES-256-GCM token cipher.
//
// Encrypts small secrets (Shopify admin/storefront tokens) at rest. The
// wire format is a single hex string: iv (12) || authTag (16) || ciphertext.
// An authenticated-encryption scheme is non-negotiable here: we need the
// tag so flipping bits in the stored ciphertext is detected.
//
// Key rotation: the cipher itself is single-key. The `key_version` column in
// the installation schema is intentionally reserved so future dual-key
// rotation (decrypt-with-old, re-encrypt-with-new) lands as a migration,
// not a redesign. Until that day, rotating the key means re-installing every
// shop — see docs/plans/2026-04-16-shopify-oauth-design.md §5.
// ---------------------------------------------------------------------------

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(hex: string): Buffer {
  if (!hex) {
    throw new Error("[TokenCipher] encryption key is empty.");
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      "[TokenCipher] encryption key must be 64 hex chars (32 bytes).",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a UTF-8 string, returning a hex-encoded blob safe for text columns.
 *
 * Empty input returns empty output so callers can round-trip null/empty
 * tokens without branching. An operator reading the DB will still see empty
 * cells and know those rows have no token to decrypt.
 */
export function encryptToken(plaintext: string, keyHex: string): string {
  if (plaintext === "") return "";
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("hex");
}

/**
 * Decrypt a hex blob produced by `encryptToken`. Throws if the ciphertext
 * is too short to contain iv+tag, if the hex is malformed, or if the
 * authentication tag fails (key rotated, data tampered, wrong record).
 */
export function decryptToken(blobHex: string, keyHex: string): string {
  if (blobHex === "") return "";
  if (!/^[0-9a-f]*$/i.test(blobHex) || blobHex.length % 2 !== 0) {
    throw new Error("[TokenCipher] ciphertext is not valid hex.");
  }
  const payload = Buffer.from(blobHex, "hex");
  if (payload.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("[TokenCipher] ciphertext too short to be valid.");
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  const key = parseKey(keyHex);
  const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
