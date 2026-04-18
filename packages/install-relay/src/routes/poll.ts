// ---------------------------------------------------------------------------
// GET /pair/poll?pair=<code>
//
// CLI polls this endpoint at ~2s intervals after the merchant opens the
// install URL in a browser. Response semantics:
//   202 { status: "pending" }   — merchant hasn't completed OAuth yet
//   200 { status: "ready", shop, admin_token, storefront_token, scopes }
//                               — tokens delivered; row is deleted (one-shot)
//   404 { status: "expired" | "unknown" }
//                               — pair code doesn't exist or TTL elapsed
//
// After a successful `ready` response the pair row is gone. A retry from
// the CLI will hit 404. The CLI is expected to persist tokens atomically
// before it can afford to lose this single response.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PairStore } from "../pair-store.js";
import { sendJson } from "./_http.js";

export async function handlePoll(
  req: IncomingMessage,
  res: ServerResponse,
  store: PairStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://_local");
  const pairCode = url.searchParams.get("pair") ?? "";
  if (!pairCode) {
    sendJson(res, 400, { error: "missing_pair" });
    return;
  }

  const pairing = await store.get(pairCode);
  if (!pairing) {
    sendJson(res, 404, { status: "unknown" });
    return;
  }

  const now = Date.now();
  if (pairing.expiresAt <= now) {
    sendJson(res, 404, { status: "expired" });
    return;
  }

  if (pairing.status === "pending") {
    sendJson(res, 202, {
      status: "pending",
      expires_in: Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)),
    });
    return;
  }

  // status === "ready" — consume atomically.
  const consumed = await store.consume(pairCode, now);
  if (!consumed) {
    // Lost the race (another poll or a sweep removed the row between our
    // read and consume). Treat as unknown so the CLI gives up.
    sendJson(res, 404, { status: "unknown" });
    return;
  }

  sendJson(res, 200, {
    status: "ready",
    shop: consumed.shopDomain,
    admin_token: consumed.adminToken,
    storefront_token: consumed.storefrontToken,
    scopes: consumed.scopes,
    token_expires_at: consumed.tokenExpiresAt,
    refresh_token: consumed.refreshToken,
  });
}
