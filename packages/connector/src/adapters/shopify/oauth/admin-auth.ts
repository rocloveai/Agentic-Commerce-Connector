// ---------------------------------------------------------------------------
// Minimal bearer check for /admin/shopify routes.
//
// Accepts either:
//   - `Authorization: Bearer <token>` header (machine/cURL/CLI)
//   - `?token=<token>` query param (browser bookmark)
//
// Comparison is constant-time. Empty configured token fails closed — we
// refuse to expose the admin surface without a bearer set in env.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AdminAuthOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

function extractPresented(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) return match[1].trim();
  }
  const q = url.searchParams.get("token");
  if (q) return q;
  return null;
}

export function checkAdminBearer(
  req: IncomingMessage,
  url: URL,
  configuredToken: string,
): AdminAuthOutcome {
  if (!configuredToken) {
    return {
      ok: false,
      status: 503,
      reason:
        "admin endpoint requires PORTAL_TOKEN to be set. Set it in env, then retry with Authorization: Bearer <token> (or ?token=<token>).",
    };
  }
  const presented = extractPresented(req, url);
  if (!presented) {
    return { ok: false, status: 401, reason: "missing_bearer" };
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length) return { ok: false, status: 401, reason: "invalid_bearer" };
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, status: 401, reason: "invalid_bearer" };
}
