// ---------------------------------------------------------------------------
// GET /auth/shopify/callback
//
// Shopify redirects here after the merchant approves install. Per OAuth
// flow, we get `code`, `shop`, `state`, `hmac`, `timestamp`. We:
//   1. Verify HMAC (so we know Shopify sent this, not an attacker).
//   2. Verify timestamp freshness.
//   3. Use `state` (== pair code) to look up the pending pairing.
//   4. Exchange code for access token at Shopify.
//   5. Provision a Storefront access token (best-effort).
//   6. Fulfil the pairing so the CLI's /pair/poll returns tokens.
//
// Then render a "You can close this tab" HTML page.
//
// ⚠️  Note: This session (v0.7.0-pre) uses Shopify's *authorization-code*
// OAuth flow which, for apps created after 2024-Q4, returns non-expiring
// offline tokens that the Admin API later rejects. We accept that failure
// mode for the skeleton; Session 2 switches to Token Exchange (embedded
// iframe + App Bridge) which returns expiring tokens.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertShopDomain,
  exchangeCodeForToken,
  createStorefrontToken,
  verifyCallbackHmac,
} from "@acc/connector/shopify-oauth";
import type { RelayConfig } from "../config.js";
import type { PairStore } from "../pair-store.js";
import { sendHtml, sendJson } from "./_http.js";

const MAX_TIMESTAMP_SKEW_SEC = 300;

export async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  store: PairStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", config.selfUrl);
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) params[k] = v;

  // 1. Shop domain.
  let shop: string;
  try {
    shop = assertShopDomain(params.shop);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_shop",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 2. HMAC over all params except hmac/signature.
  if (!verifyCallbackHmac(params, params.hmac ?? "", config.shopifyClientSecret)) {
    sendJson(res, 400, {
      error: "hmac_mismatch",
      message: "HMAC verification failed.",
    });
    return;
  }

  // 3. Timestamp freshness.
  const tsNum = Number(params.timestamp ?? "");
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    sendJson(res, 400, { error: "bad_timestamp" });
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > MAX_TIMESTAMP_SKEW_SEC) {
    sendJson(res, 400, {
      error: "timestamp_skew",
      message: `|now - ts| > ${MAX_TIMESTAMP_SKEW_SEC}s`,
    });
    return;
  }

  // 4. `state` is the pair code.
  const pairCode = params.state ?? "";
  const pairing = await store.get(pairCode);
  if (!pairing) {
    sendJson(res, 400, {
      error: "unknown_pair",
      message: "This install URL no longer matches a valid pair. Re-run `acc init`.",
    });
    return;
  }
  if (pairing.expiresAt <= Date.now()) {
    sendJson(res, 410, { error: "pair_expired" });
    return;
  }
  if (pairing.status !== "pending") {
    sendJson(res, 409, { error: "pair_already_fulfilled" });
    return;
  }

  // 5. Code.
  const code = params.code;
  if (!code) {
    sendJson(res, 400, { error: "missing_code" });
    return;
  }

  // 6. Token exchange.
  let token: Awaited<ReturnType<typeof exchangeCodeForToken>>;
  try {
    token = await exchangeCodeForToken({
      shopDomain: shop,
      clientId: config.shopifyClientId,
      clientSecret: config.shopifyClientSecret,
      code,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: "token_exchange_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 7. Storefront token (best-effort — Session-2 Token-Exchange flow will
  //    likely supersede this; keeping it so the skeleton can still mint a
  //    storefront token on apps that happen to have admin-token validity).
  let storefrontToken: string | null = null;
  try {
    const sf = await createStorefrontToken({
      shopDomain: shop,
      adminToken: token.accessToken,
      apiVersion: config.shopifyApiVersion,
    });
    storefrontToken = sf.accessToken;
    if (sf.userErrors.length > 0) {
      console.error(
        `[install-relay] storefront token userErrors for ${shop}:`,
        sf.userErrors.map((e) => e.message).join("; "),
      );
    }
  } catch (err) {
    console.error(
      `[install-relay] storefront token mint threw for ${shop}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // 8. Fulfil the pair. expiresAt/refreshToken come straight from the
  //    TokenExchangeResponse — both null for legacy non-expiring tokens.
  await store.fulfil(pairCode, {
    shopDomain: shop,
    adminToken: token.accessToken,
    storefrontToken,
    scopes: token.scope,
    tokenExpiresAt: token.expiresAt,
    refreshToken: token.refreshToken,
  });

  // 9. Human-facing success page.
  sendHtml(res, 200, renderSuccessPage(shop));
}

function renderSuccessPage(shop: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ACC Connector — Install complete</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 520px; margin: 80px auto; padding: 0 24px; line-height: 1.55;
           color: #111; background: #fafafa; }
    h1 { font-size: 1.6rem; margin-bottom: 8px; }
    code { background: rgba(127,127,127,0.12); padding: 0.1em 0.35em; border-radius: 4px; }
    .ok { color: #1f7a1f; }
  </style>
</head>
<body>
  <h1><span class="ok">✅</span> Install complete</h1>
  <p>Connected shop: <code>${escapeHtml(shop)}</code></p>
  <p>Return to your terminal — <code>acc init</code> will pick up the tokens automatically.</p>
  <p>You can close this tab.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}
