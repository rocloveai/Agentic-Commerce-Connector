// ---------------------------------------------------------------------------
// GET /embed  —  the App URL Shopify's embedded-app flow redirects to.
//
// When the Partners app is configured with:
//   - Embedded = true
//   - App URL  = https://install.xagenpay.com/embed
// Shopify's OAuth authorize flow ends by loading this page *inside the
// Shopify admin iframe*, which is the only context where App Bridge JS
// can mint session JWTs. The page loads App Bridge from Shopify's CDN,
// grabs a session JWT via `shopify.idToken()`, then POSTs it to our
// `/auth/shopify/token-exchange` endpoint along with the pair code
// (passed as the `state` parameter from the earlier authorize step).
//
// Rendered HTML intentionally lightweight: inline CSS/JS, no framework,
// no build step for the browser side. Comments in the JS explain
// what App Bridge is doing.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayConfig } from "../config.js";
import { sendHtml } from "./_http.js";

export async function handleEmbed(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", config.selfUrl);
  const shop = url.searchParams.get("shop") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const host = url.searchParams.get("host") ?? "";

  // `state` is the pair code we threaded through Shopify's authorize flow.
  // Without it we can't know which merchant CLI is waiting on this install.
  if (!state) {
    sendHtml(
      res,
      400,
      simplePage(
        "Missing install context",
        `<p>This page expects a <code>state</code> query parameter. You may have reached it directly; start the install flow from your terminal with <code>acc init</code>.</p>`,
      ),
    );
    return;
  }

  sendHtml(
    res,
    200,
    renderEmbedPage({
      clientId: config.shopifyClientId,
      pairCode: state,
      shop,
      host,
      tokenExchangeUrl: `${config.selfUrl}/auth/shopify/token-exchange`,
    }),
  );
}

function renderEmbedPage(opts: {
  clientId: string;
  pairCode: string;
  shop: string;
  host: string;
  tokenExchangeUrl: string;
}): string {
  const { clientId, pairCode, shop, host, tokenExchangeUrl } = opts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${escapeAttr(clientId)}" />
  <title>ACC Connector — Installing…</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 560px; margin: 48px auto; padding: 0 24px; line-height: 1.55;
           color: #111; background: #fafafa; }
    h1 { font-size: 1.4rem; margin: 0 0 8px; }
    .status { padding: 14px 16px; border-radius: 8px; margin-top: 16px;
              background: #fff; border: 1px solid #e2e2e2; }
    .status.ok { border-color: #b7e4c7; background: #f0fff4; }
    .status.err { border-color: #f5c6cb; background: #fff5f5; }
    code { background: rgba(127,127,127,0.12); padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Installing ACC Connector…</h1>
  <p>Pair: <code>${escapeHtml(pairCode)}</code> · Shop: <code>${escapeHtml(shop)}</code></p>
  <div id="status" class="status">Waiting for Shopify App Bridge…</div>

  <script>
  (async function() {
    const statusEl = document.getElementById("status");
    function setStatus(text, variant) {
      statusEl.textContent = text;
      statusEl.className = "status" + (variant ? " " + variant : "");
    }

    // App Bridge v4+: the global "shopify" object is available after the
    // script tag loads. If it isn't, either the page was opened outside
    // the Shopify admin iframe (no session) or the API key is wrong.
    const appBridge = window.shopify;
    if (!appBridge || typeof appBridge.idToken !== "function") {
      setStatus(
        "App Bridge failed to initialize. This page must be opened inside Shopify admin (after clicking Install), not directly. " +
          "Re-run 'acc init' in your terminal and click the URL it prints.",
        "err",
      );
      return;
    }

    let idToken;
    try {
      idToken = await appBridge.idToken();
    } catch (e) {
      setStatus("Could not obtain a Shopify session token: " + e.message, "err");
      return;
    }

    setStatus("Exchanging token with Shopify…");
    try {
      const res = await fetch(${JSON.stringify(tokenExchangeUrl)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id_token: idToken,
          pair_code: ${JSON.stringify(pairCode)},
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus("Exchange failed: " + (body.error || res.status) + " — " + (body.message || ""), "err");
        return;
      }
      setStatus(
        "✅ Connected " + body.shop + ". Return to your terminal — acc init will pick up the tokens automatically. You can close this tab.",
        "ok",
      );
    } catch (e) {
      setStatus("Network error during exchange: " + e.message, "err");
    }
  })();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function simplePage(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:60px auto;padding:0 24px;"><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;
}
