// ---------------------------------------------------------------------------
// Shopify session-token (ID-token) verification.
//
// App Bridge issues short-lived JWTs that identify the current Shopify
// admin session to our app. The JWT is signed HMAC-SHA256 with the app's
// client_secret and carries these claims we care about:
//
//   iss  — issuer; always `https://<shop>.myshopify.com/admin`
//   dest — destination; the shop URL
//   aud  — client_id of our app
//   sub  — user id inside Shopify
//   exp  — expiry unix-seconds (usually now + ~60s)
//   iat  — issued-at unix-seconds
//   nbf  — not-before unix-seconds
//   jti  — unique id
//
// Verifying locally before hitting Shopify's Token Exchange endpoint lets
// us reject garbage with a fast 400 instead of paying a network roundtrip.
// The true authority is Shopify anyway — they re-verify server-side.
// ---------------------------------------------------------------------------
import { createHmac, timingSafeEqual } from "node:crypto";

export interface IdTokenClaims {
  readonly shop: string;            // just host, e.g. "xyz.myshopify.com"
  readonly aud: string;             // client_id
  readonly sub: string;             // user id
  readonly exp: number;             // unix seconds
  readonly iat: number;
}

const CLOCK_SKEW_SEC = 60;

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function verifyIdToken(
  idToken: string,
  opts: {
    readonly clientSecret: string;
    readonly expectedClientId?: string;
    readonly now?: () => number;
  },
): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("[Shopify/JWT] malformed: expected 3 dot-separated parts");
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // 1. Signature.
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", opts.clientSecret)
    .update(signingInput)
    .digest("base64url");
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("[Shopify/JWT] signature invalid (wrong client_secret?)");
  }

  // 2. Payload decode.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new Error("[Shopify/JWT] malformed payload JSON");
  }

  // 3. dest → shop.
  const dest = typeof payload.dest === "string" ? payload.dest : "";
  let shopHost: string;
  try {
    shopHost = new URL(dest).host;
  } catch {
    throw new Error(`[Shopify/JWT] bad dest claim: ${String(payload.dest)}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopHost)) {
    throw new Error(`[Shopify/JWT] dest not a myshopify.com host: ${shopHost}`);
  }

  // 4. Audience — if caller pinned a client_id, enforce it.
  const aud = typeof payload.aud === "string" ? payload.aud : "";
  if (!aud) throw new Error("[Shopify/JWT] missing aud");
  if (opts.expectedClientId && aud !== opts.expectedClientId) {
    throw new Error(
      `[Shopify/JWT] aud mismatch: got ${aud}, expected ${opts.expectedClientId}`,
    );
  }

  // 5. exp / iat / nbf (with small skew window).
  const now = (opts.now ?? (() => Date.now()))();
  const nowSec = Math.floor(now / 1000);
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) {
    throw new Error("[Shopify/JWT] missing or non-numeric exp/iat");
  }
  if (exp < nowSec - CLOCK_SKEW_SEC) {
    throw new Error("[Shopify/JWT] expired");
  }
  if (iat > nowSec + CLOCK_SKEW_SEC) {
    throw new Error("[Shopify/JWT] iat in the future");
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + CLOCK_SKEW_SEC) {
    throw new Error("[Shopify/JWT] not yet valid (nbf)");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new Error("[Shopify/JWT] missing sub");

  return { shop: shopHost, aud, sub, exp, iat };
}
