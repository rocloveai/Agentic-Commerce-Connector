// ---------------------------------------------------------------------------
// Shopify webhook HMAC verification.
//
// Different shape from the OAuth callback HMAC (which is over a canonicalised
// query string). Webhook HMAC is over the *raw request body* and arrives in
// the `X-Shopify-Hmac-Sha256` header, base64-encoded. Both use the app's
// `client_secret` as the key — the same secret, different payloads.
//
// CRITICAL: this is NOT the Nexus webhook HMAC (services/webhook-handler.ts).
// The Nexus one uses `WEBHOOK_SECRET` and a different header format. Mixing
// them is an easy footgun; the route handler must route to the right
// verifier based on the URL path.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/=]+$/;

export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | undefined,
  clientSecret: string,
): boolean {
  if (!hmacHeader || !clientSecret) return false;
  if (!BASE64.test(hmacHeader)) return false;

  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

  const expected = createHmac("sha256", clientSecret)
    .update(bodyBuf)
    .digest();
  const provided = Buffer.from(hmacHeader, "base64");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}
