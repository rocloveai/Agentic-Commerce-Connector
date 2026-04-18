// ---------------------------------------------------------------------------
// GET /auth/shopify/install?pair=<code>
//
// The merchant's browser lands here from the URL the CLI showed them.
// If `shop` is already known (optional ?shop= param from CLI's hint), we
// redirect straight to Shopify's OAuth authorize. Otherwise we render a
// tiny HTML form that asks "Which Shopify store?" then posts back to
// continue.
//
// The `state` nonce carried through Shopify's flow *is* the pair code —
// that's how the callback knows which pairing to fulfil.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertShopDomain } from "@acc/connector/shopify-oauth";
import type { RelayConfig } from "../config.js";
import type { PairStore } from "../pair-store.js";
import { sendHtml, sendRedirect, sendJson } from "./_http.js";

export async function handleInstallStart(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  store: PairStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", config.selfUrl);
  const pairCode = url.searchParams.get("pair") ?? "";
  const shopRaw = url.searchParams.get("shop");

  // Pair must exist + still pending + not expired.
  const pairing = await store.get(pairCode);
  if (!pairing) {
    sendJson(res, 404, {
      error: "invalid_pair_code",
      message:
        "This install link is unknown or has expired. Re-run `acc init` in your terminal to get a fresh link.",
    });
    return;
  }
  if (pairing.expiresAt <= Date.now()) {
    sendJson(res, 410, {
      error: "pair_code_expired",
      message:
        "This install link has expired. Re-run `acc init` in your terminal.",
    });
    return;
  }
  if (pairing.status !== "pending") {
    sendJson(res, 409, {
      error: "pair_code_already_consumed",
      message:
        "This link has already been used to complete an install. Re-run `acc init` for a new one.",
    });
    return;
  }

  if (shopRaw) {
    let shop: string;
    try {
      shop = assertShopDomain(shopRaw);
    } catch (err) {
      sendJson(res, 400, {
        error: "invalid_shop",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    return redirectToShopify(res, config, shop, pairCode);
  }

  // No shop yet → tiny form.
  sendHtml(
    res,
    200,
    renderShopForm(config.selfUrl, pairCode),
  );
}

function redirectToShopify(
  res: ServerResponse,
  config: RelayConfig,
  shop: string,
  pairCode: string,
): void {
  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", config.shopifyClientId);
  authorize.searchParams.set("scope", config.shopifyScopes.join(","));
  // Classic headless OAuth flow: Shopify redirects the merchant's browser
  // to /auth/shopify/callback with ?code=... after approval. Our handler
  // exchanges the code with `expiring=1` (Dec-2025 Shopify policy) to
  // obtain an expiring offline token + refresh_token that Admin API
  // accepts. NOT using embedded / App Bridge / Token Exchange grant —
  // those are for Shopify-admin-hosted UI apps, which ACC is not.
  authorize.searchParams.set(
    "redirect_uri",
    `${config.selfUrl}/auth/shopify/callback`,
  );
  // Using the pair code as the OAuth state gives us a single-use binding
  // without needing a separate nonce table. Pair codes are 128-bit random
  // so the unguessability property holds.
  authorize.searchParams.set("state", pairCode);
  sendRedirect(res, authorize.toString());
}

function renderShopForm(selfUrl: string, pairCode: string): string {
  const action = `${selfUrl}/auth/shopify/install`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Install ACC Connector</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 520px; margin: 80px auto; padding: 0 24px; line-height: 1.55;
           color: #111; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p.tagline { color: #666; margin-top: 0; }
    input[type=text] { width: 100%; padding: 10px 12px; font-size: 1rem;
                       border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 18px; font-size: 1rem; color: #fff;
             background: #0b74de; border: 0; border-radius: 6px; cursor: pointer; }
    small { color: #888; display: block; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Install ACC Connector on your Shopify store</h1>
  <p class="tagline">Enter the Shopify domain where this connector will run.</p>
  <form method="GET" action="${action}">
    <input type="hidden" name="pair" value="${escapeHtml(pairCode)}" />
    <label for="shop">Store domain</label>
    <input type="text" id="shop" name="shop"
           placeholder="your-shop.myshopify.com" required
           pattern="[a-z0-9][a-z0-9-]*\\.myshopify\\.com"
           autofocus />
    <small>Must end in <code>.myshopify.com</code>.</small>
    <button type="submit">Continue to Shopify →</button>
  </form>
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
