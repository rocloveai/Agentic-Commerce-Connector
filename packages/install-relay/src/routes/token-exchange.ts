// ---------------------------------------------------------------------------
// POST /auth/shopify/token-exchange
//
// Called by the /embed page (not directly by CLI). Body:
//   { id_token: "<App Bridge JWT>", pair_code: "acp_…" }
//
// Flow:
//   1. Look up pair; must exist, not expired, not yet fulfilled.
//   2. Verify the JWT locally (HMAC w/ our client_secret, shop from `dest`).
//   3. Shopify Token Exchange: JWT → expiring offline access token.
//   4. Best-effort: mint a Storefront Access Token from the new admin token.
//   5. Fulfil the pair so CLI's /pair/poll returns the tokens.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  exchangeIdTokenForAccessToken,
  verifyIdToken,
  createStorefrontToken,
} from "@acc/connector/shopify-oauth";
import type { RelayConfig } from "../config.js";
import type { PairStore } from "../pair-store.js";
import { readJson, sendJson } from "./_http.js";

interface TokenExchangeRequest {
  readonly id_token?: string;
  readonly pair_code?: string;
}

export async function handleTokenExchange(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  store: PairStore,
): Promise<void> {
  let body: TokenExchangeRequest;
  try {
    body = await readJson<TokenExchangeRequest>(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }
  const idToken = body.id_token;
  const pairCode = body.pair_code;
  if (!idToken || !pairCode) {
    sendJson(res, 400, {
      error: "missing_fields",
      message: "Both id_token and pair_code are required.",
    });
    return;
  }

  // 1. Pair lookup.
  const pairing = await store.get(pairCode);
  if (!pairing) {
    sendJson(res, 404, { error: "unknown_pair" });
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

  // 2. JWT verify (signature + claims + expiry).
  let claims;
  try {
    claims = verifyIdToken(idToken, {
      clientSecret: config.shopifyClientSecret,
      expectedClientId: config.shopifyClientId,
    });
  } catch (err) {
    sendJson(res, 401, {
      error: "invalid_id_token",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 3. Token Exchange at Shopify.
  let token: Awaited<ReturnType<typeof exchangeIdTokenForAccessToken>>;
  try {
    token = await exchangeIdTokenForAccessToken({
      shopDomain: claims.shop,
      clientId: config.shopifyClientId,
      clientSecret: config.shopifyClientSecret,
      idToken,
    });
  } catch (err) {
    console.error(
      `[install-relay/token-exchange] Shopify rejected Token Exchange for ${claims.shop}:`,
      err instanceof Error ? err.message : String(err),
    );
    sendJson(res, 502, {
      error: "token_exchange_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 4. Storefront token (best-effort).
  let storefrontToken: string | null = null;
  try {
    const sf = await createStorefrontToken({
      shopDomain: claims.shop,
      adminToken: token.accessToken,
      apiVersion: config.shopifyApiVersion,
    });
    storefrontToken = sf.accessToken;
    if (sf.userErrors.length > 0) {
      console.error(
        `[install-relay/token-exchange] storefront userErrors for ${claims.shop}:`,
        sf.userErrors.map((e) => e.message).join("; "),
      );
    }
  } catch (err) {
    console.error(
      `[install-relay/token-exchange] storefront mint threw for ${claims.shop}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // 5. Fulfil pair.
  await store.fulfil(pairCode, {
    shopDomain: claims.shop,
    adminToken: token.accessToken,
    storefrontToken,
    scopes: token.scope,
    tokenExpiresAt: token.expiresAt,
    refreshToken: token.refreshToken,
  });

  sendJson(res, 200, {
    ok: true,
    shop: claims.shop,
    scopes: token.scope,
    expires_in:
      token.expiresAt !== null
        ? token.expiresAt - Math.floor(Date.now() / 1000)
        : null,
    refresh_token_issued: token.refreshToken !== null,
    storefront_token_issued: storefrontToken !== null,
  });
}
