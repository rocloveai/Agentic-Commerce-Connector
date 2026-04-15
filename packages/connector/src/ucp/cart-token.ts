// ---------------------------------------------------------------------------
// Stateless cart tokens (HMAC-SHA256 signed)
//
// A cart token authenticates subsequent requests to the same checkout session
// without requiring session cookies. The DB-persisted `checkout_sessions`
// table remains the source of truth; the token merely binds a client to a
// session id and carries a short-lived expiry.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 900; // 15 min

export interface CartTokenPayload {
  readonly session_id: string;
  readonly issued_at: number;   // unix seconds
  readonly expires_at: number;  // unix seconds
}

export interface CartTokenConfig {
  readonly secret: string;        // min 32 chars
  readonly ttlSeconds?: number;
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueCartToken(
  sessionId: string,
  config: CartTokenConfig,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (!config.secret || config.secret.length < 32) {
    throw new Error(
      "[UCP] UCP_CART_TOKEN_SECRET must be at least 32 characters",
    );
  }
  const ttl = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload: CartTokenPayload = {
    session_id: sessionId,
    issued_at: now,
    expires_at: now + ttl,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = sign(body, config.secret);
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { readonly ok: true; readonly payload: CartTokenPayload }
  | { readonly ok: false; readonly reason: "malformed" | "invalid_signature" | "expired" };

export function verifyCartToken(
  token: string,
  config: CartTokenConfig,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!config.secret) {
    return { ok: false, reason: "invalid_signature" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [body, sig] = parts;
  const expected = sign(body, config.secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: CartTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload.session_id !== "string" ||
    typeof payload.issued_at !== "number" ||
    typeof payload.expires_at !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.expires_at <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

export function loadCartTokenConfig(
  env: Record<string, string | undefined>,
): CartTokenConfig {
  const secret = env.UCP_CART_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "[UCP] UCP_CART_TOKEN_SECRET is required (min 32 chars). Generate with: openssl rand -hex 32",
    );
  }
  const ttlRaw = env.UCP_TOKEN_TTL_SECONDS;
  const ttlSeconds = ttlRaw ? parseInt(ttlRaw, 10) : DEFAULT_TTL_SECONDS;
  if (isNaN(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) {
    throw new Error(
      "[UCP] UCP_TOKEN_TTL_SECONDS must be between 60 and 86400",
    );
  }
  return { secret, ttlSeconds };
}
