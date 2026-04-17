// ---------------------------------------------------------------------------
// Shopify OAuth HMAC verification.
//
// Shopify signs the query string on the install callback with the app's
// client_secret. We rebuild the canonical form and compare timing-safely.
//
// Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
//
// Canonical form (per Shopify + @shopify/shopify-api reference implementation):
//   1. Drop the `hmac` and `signature` params.
//   2. Percent-encode `%`, `&`, `=` inside each VALUE (not the key) so that the
//      delimiter-based join round-trips unambiguously.
//   3. Sort remaining params alphabetically by key.
//   4. Join as `k=v` pairs with `&`.
//   5. HMAC-SHA256 with client_secret; hex digest.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_64 = /^[0-9a-f]{64}$/i;

function escapeValue(v: string): string {
  // Only these three chars are ambiguous in the canonical form.
  return v.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
}

/**
 * Build the canonical string Shopify signs over. Exported for testing and
 * debug-level logging on verification failures.
 */
export function canonicalizeQuery(
  params: Record<string, string | readonly string[] | undefined>,
): string {
  const entries: Array<readonly [string, string]> = [];
  for (const key of Object.keys(params)) {
    if (key === "hmac" || key === "signature") continue;
    const raw = params[key];
    if (raw === undefined) continue;
    // Shopify never sends repeat keys on the OAuth callback in practice, but
    // if a hostile proxy did, we stringify deterministically so the forgery
    // can't pick the order to tunnel past the HMAC.
    const value = Array.isArray(raw) ? raw.join(",") : (raw as string);
    entries.push([key, escapeValue(value)] as const);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Verify an OAuth callback query's HMAC. `hmacHex` is the hex string sent by
 * Shopify in the `hmac` param; compare in constant time.
 */
export function verifyCallbackHmac(
  params: Record<string, string | readonly string[] | undefined>,
  hmacHex: string,
  clientSecret: string,
): boolean {
  if (!hmacHex || typeof hmacHex !== "string") return false;
  if (!HEX_64.test(hmacHex)) return false;
  if (!clientSecret) return false;

  const canonical = canonicalizeQuery(params);
  const expected = createHmac("sha256", clientSecret)
    .update(canonical)
    .digest();
  const provided = Buffer.from(hmacHex.toLowerCase(), "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}
