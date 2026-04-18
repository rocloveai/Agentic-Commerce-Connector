// ---------------------------------------------------------------------------
// POST /pair/refresh
//
// Called by merchant-deployed ACC connectors when their admin token is
// close to expiry. The merchant's connector does NOT hold the shared
// Shopify Partners app's client_secret (that would defeat the "shared
// app" model). Instead it posts its current `refresh_token` here, and
// this relay performs the actual refresh_token grant against Shopify
// using the secret it holds.
//
// Body:
//   { shop: "xxx.myshopify.com", refresh_token: "shprt_..." }
//
// Response on success (200):
//   {
//     shop: "xxx.myshopify.com",
//     admin_token: "shpat_...",
//     refresh_token: "shprt_...",   // rotated — caller must persist this
//     expires_at: <unix seconds>,
//     scopes: ["read_products", ...]
//   }
//
// Failure modes:
//   400 bad_json / missing_fields / invalid_shop
//   401 refresh_rejected      — refresh_token is invalid/rotated-already/revoked
//   502 upstream_error        — Shopify returned a non-2xx or unparseable body
//
// No rate limiting yet. If abuse becomes a problem, add per-shop limits.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertShopDomain,
  refreshAccessToken,
} from "@acc/connector/shopify-oauth";
import type { RelayConfig } from "../config.js";
import { readJson, sendJson } from "./_http.js";

interface RefreshRequest {
  readonly shop?: string;
  readonly refresh_token?: string;
}

export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
): Promise<void> {
  let body: RefreshRequest;
  try {
    body = await readJson<RefreshRequest>(req);
  } catch {
    sendJson(res, 400, { error: "bad_json" });
    return;
  }

  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    sendJson(res, 400, {
      error: "missing_fields",
      message: "refresh_token is required.",
    });
    return;
  }

  let shop: string;
  try {
    shop = assertShopDomain(body.shop);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_shop",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let result: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    result = await refreshAccessToken({
      shopDomain: shop,
      clientId: config.shopifyClientId,
      clientSecret: config.shopifyClientSecret,
      refreshToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Shopify returns 400 for invalid/expired refresh tokens. We translate
    // to 401 so the connector's refresh helper can tell "your refresh
    // token is dead, ask the merchant to reinstall" from network errors.
    const isAuthProblem =
      /\b40[01]\b/.test(message) ||
      /invalid_grant/i.test(message) ||
      /expired/i.test(message);
    sendJson(res, isAuthProblem ? 401 : 502, {
      error: isAuthProblem ? "refresh_rejected" : "upstream_error",
      message,
    });
    return;
  }

  // Shopify sometimes omits scope on refresh — keep caller's previous set if
  // that happens (signalled by empty result.scope). Caller persists whatever
  // we return, so returning [] would overwrite a real scope list.
  const scopes = result.scope.length > 0 ? result.scope : undefined;

  sendJson(res, 200, {
    shop,
    admin_token: result.accessToken,
    refresh_token: result.refreshToken,
    expires_at: result.expiresAt,
    scopes,
  });
}
