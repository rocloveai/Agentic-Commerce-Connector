import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { ShippingAddress, WebhookPayload } from "./types.js";
import { handleUcpRoute, type UcpDeps } from "./ucp/routes.js";
import type { ShopifyOAuthRouter } from "./adapters/shopify/oauth/routes.js";
import type { ShopifyWebhookRouter } from "./adapters/shopify/oauth/webhook-handler.js";

const AGENT_NAME = "Commerce Agent";
const startedAt = Date.now();

// ── Webhook handler registry (injected by server.ts) ────────────────────────

type WebhookHandler = (
  config: Config,
  rawBody: string,
  sig: string | undefined,
  ts: string | undefined,
) => Promise<unknown>;

let webhookHandler: WebhookHandler | null = null;

export function registerWebhookHandler(handler: WebhookHandler): void {
  webhookHandler = handler;
}

// ── MCP handler registry (injected by server.ts in HTTP mode) ───────────────

type McpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

let mcpHandler: McpHandler | null = null;

export function registerMcpHandler(handler: McpHandler): void {
  mcpHandler = handler;
}

// ── REST handler registry ───────────────────────────────────────────────────

export interface RestHandlers {
  readonly searchProducts: (args: {
    query: string;
    first: number;
    after?: string | null;
  }) => Promise<{ text: string; data: unknown }>;

  readonly getProduct: (args: {
    handle: string;
  }) => Promise<{ text: string; data: unknown }>;

  readonly createCheckout: (args: {
    items: ReadonlyArray<{ variant_id: string; quantity: number }>;
    buyer_email?: string;
    payer_wallet?: string;
    shipping_address?: ShippingAddress;
  }) => Promise<{ session: unknown; checkout_url: string }>;

  readonly getCheckoutStatus: (sessionId: string) => Promise<unknown | null>;
}

let restHandlers: RestHandlers | null = null;

export function registerRestHandlers(handlers: RestHandlers): void {
  restHandlers = handlers;
}

// ── UCP deps registry ──────────────────────────────────────────────────────

let ucpDeps: UcpDeps | null = null;

export function registerUcpDeps(deps: UcpDeps): void {
  ucpDeps = deps;
}

// ── Shopify OAuth router (registered only in OAuth mode) ────────────────────

let shopifyOAuthRouter: ShopifyOAuthRouter | null = null;

export function registerShopifyOAuthRouter(router: ShopifyOAuthRouter): void {
  shopifyOAuthRouter = router;
}

// ── Shopify webhook router (registered only in OAuth mode) ──────────────────

let shopifyWebhookRouter: ShopifyWebhookRouter | null = null;

export function registerShopifyWebhookRouter(
  router: ShopifyWebhookRouter,
): void {
  shopifyWebhookRouter = router;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendText(
  res: ServerResponse,
  text: string,
  contentType: string,
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function send404(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function loadSkillMd(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const skillPath = resolve(currentDir, "..", "skill.md");
  return readFileSync(skillPath, "utf-8");
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── API handlers ────────────────────────────────────────────────────────────

function handleApiInfo(res: ServerResponse, config: Config): void {
  sendJson(res, 200, {
    name: AGENT_NAME,
    did: config.merchantDid,
    platform: config.platform,
    store: config.storeUrl,
    uptime: formatUptime(Date.now() - startedAt),
    started_at: new Date(startedAt).toISOString(),
  });
}

// ── Dashboard HTML ──────────────────────────────────────────────────────────

function renderDashboard(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${AGENT_NAME} Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
</style>
</head>
<body class="bg-slate-900 text-slate-50 min-h-screen font-sans antialiased">
<header class="border-b border-slate-800 px-6 py-4">
  <div class="max-w-4xl mx-auto flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-9 h-9 rounded-lg bg-emerald-500/20 flex items-center justify-center">
        <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.15c0 .415.336.75.75.75z" />
        </svg>
      </div>
      <h1 class="text-lg font-semibold tracking-tight">${AGENT_NAME}</h1>
      <span class="flex items-center gap-1.5 bg-emerald-500/15 text-emerald-400 text-xs font-medium px-2.5 py-1 rounded-full">
        <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full pulse-dot"></span>
        ONLINE
      </span>
    </div>
    <div id="info" class="text-right text-xs text-slate-400"></div>
  </div>
</header>

<main class="max-w-4xl mx-auto p-6 space-y-6">
  <div class="bg-slate-800 rounded-xl border border-slate-700 p-5">
    <h2 class="text-sm font-semibold text-slate-300 mb-3">HTTP API</h2>
    <pre class="bg-slate-950 text-slate-300 p-4 rounded-lg border border-slate-700 text-xs overflow-x-auto">Base URL: ${"${window.location.origin}"}

GET  /api/v1/products?q=snowboard&first=10
GET  /api/v1/products/:handle
POST /api/v1/checkout  { items, buyer_email?, payer_wallet?, shipping_address? }
GET  /api/v1/checkout/:sessionId</pre>
  </div>

  <div class="bg-slate-800 rounded-xl border border-slate-700 p-5">
    <h2 class="text-sm font-semibold text-slate-300 mb-3">Resources</h2>
    <div class="space-y-2">
      <a href="/skill.md" class="block bg-slate-950 rounded-lg border border-slate-700 p-3 hover:border-emerald-500/50 transition-colors">
        <div class="text-sm font-medium text-slate-300">skill.md</div>
        <div class="text-xs text-slate-500">Agent capability manifest (HTTP API docs)</div>
      </a>
      <a href="/health" class="block bg-slate-950 rounded-lg border border-slate-700 p-3 hover:border-emerald-500/50 transition-colors">
        <div class="text-sm font-medium text-slate-300">Health Check</div>
        <div class="text-xs text-slate-500">Service status endpoint</div>
      </a>
      <a href="/mcp" class="block bg-slate-950 rounded-lg border border-slate-700 p-3 hover:border-emerald-500/50 transition-colors">
        <div class="text-sm font-medium text-slate-300">MCP Endpoint</div>
        <div class="text-xs text-slate-500">Model Context Protocol (alternative)</div>
      </a>
    </div>
  </div>
</main>

<script>
async function refresh() {
  try {
    const info = await (await fetch("/api/info")).json();
    document.getElementById("info").innerHTML =
      '<div>' + info.did + '</div>' +
      '<div class="text-slate-500">' + info.store + '</div>' +
      '<div class="text-slate-500">Uptime: ' + info.uptime + '</div>';
  } catch(e) { console.error(e); }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

// ── REST route handler ──────────────────────────────────────────────────────

async function handleRestRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  handlers: RestHandlers,
): Promise<boolean> {
  try {
    // GET /api/v1/products?q=xxx&first=10&after=cursor
    if (path === "/api/v1/products" && req.method === "GET") {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const query = url.searchParams.get("q") ?? "";
      const first = Math.min(
        Math.max(parseInt(url.searchParams.get("first") ?? "10", 10) || 10, 1),
        50,
      );
      const after = url.searchParams.get("after") || undefined;

      const result = await handlers.searchProducts({ query, first, after });
      sendJson(res, 200, { ok: true, data: result.data });
      return true;
    }

    // GET /api/v1/products/:handle
    const productMatch = path.match(/^\/api\/v1\/products\/([a-zA-Z0-9_-]+)$/);
    if (productMatch && req.method === "GET") {
      const handle = productMatch[1];
      const result = await handlers.getProduct({ handle });
      if (!result.data) {
        sendJson(res, 404, {
          ok: false,
          error: `Product "${handle}" not found`,
        });
        return true;
      }
      sendJson(res, 200, { ok: true, data: result.data });
      return true;
    }

    // POST /api/v1/checkout
    if (path === "/api/v1/checkout" && req.method === "POST") {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as {
        items?: Array<{ variant_id: string; quantity: number }>;
        buyer_email?: string;
        payer_wallet?: string;
        shipping_address?: ShippingAddress;
      };

      if (
        !body.items ||
        !Array.isArray(body.items) ||
        body.items.length === 0
      ) {
        sendJson(res, 400, {
          ok: false,
          error: "Missing or empty 'items' array",
        });
        return true;
      }

      const result = await handlers.createCheckout({
        items: body.items,
        buyer_email: body.buyer_email,
        payer_wallet: body.payer_wallet,
        shipping_address: body.shipping_address,
      });
      sendJson(res, 200, { ok: true, data: result });
      return true;
    }

    // GET /api/v1/checkout/:sessionId
    const checkoutMatch = path.match(/^\/api\/v1\/checkout\/([a-zA-Z0-9_-]+)$/);
    if (checkoutMatch && req.method === "GET") {
      const sessionId = checkoutMatch[1];
      const session = await handlers.getCheckoutStatus(sessionId);
      if (!session) {
        sendJson(res, 404, {
          ok: false,
          error: `Session "${sessionId}" not found`,
        });
        return true;
      }
      sendJson(res, 200, { ok: true, data: session });
      return true;
    }

    return false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: message });
    return true;
  }
}

// ── Request router ──────────────────────────────────────────────────────────

async function handleRequest(
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // Health check
  if (path === "/health" && req.method === "GET") {
    sendJson(res, 200, { status: "ok", mcpHandler: !!mcpHandler });
    return;
  }

  // Shopify OAuth install / callback / post-install landing page. Only
  // registered in OAuth mode (see server.ts); silently falls through to 404
  // otherwise so the routes don't leak in manual-mode deployments.
  if (
    shopifyOAuthRouter &&
    (path.startsWith("/auth/shopify/") || path.startsWith("/admin/shopify/"))
  ) {
    const handled = await shopifyOAuthRouter(req, res);
    if (handled) return;
  }

  // Shopify-delivered webhooks (app/uninstalled + GDPR topics). NOTE: uses
  // Shopify's `client_secret` to verify the HMAC — a different secret from
  // the Nexus payment webhook handled on /webhook further down. Do not mix.
  if (shopifyWebhookRouter && path.startsWith("/webhooks/shopify/")) {
    const handled = await shopifyWebhookRouter(req, res);
    if (handled) return;
  }

  // MCP Streamable HTTP endpoint
  if (path === "/mcp") {
    if (!mcpHandler) {
      sendJson(res, 503, {
        error:
          "MCP handler not registered. TRANSPORT may not be set to 'http'.",
      });
      return;
    }
    const handled = await mcpHandler(req, res);
    if (handled) return;
  }

  // ── UCP/1.0 façade ────────────────────────────────────────────────────────
  if (path.startsWith("/ucp/v1/")) {
    if (!ucpDeps) {
      sendJson(res, 503, { error: "UCP deps not registered." });
      return;
    }
    const handled = await handleUcpRoute(path, req, res, ucpDeps);
    if (handled) return;
    send404(res);
    return;
  }

  // ── Legacy REST API routes (NUPS/1.5, kept for backward compatibility) ──
  if (path.startsWith("/api/v1/") && path !== "/api/info") {
    if (!restHandlers) {
      sendJson(res, 503, { error: "REST handlers not registered." });
      return;
    }
    const handled = await handleRestRoute(path, req, res, restHandlers);
    if (handled) return;
  }

  // Dashboard
  if (path === "/" && req.method === "GET") {
    sendHtml(res, renderDashboard(config));
    return;
  }

  // Skill file
  if (path === "/skill.md" && req.method === "GET") {
    try {
      const content = loadSkillMd();
      sendText(res, content, "text/markdown; charset=utf-8");
    } catch {
      sendJson(res, 500, { error: "skill.md not found" });
    }
    return;
  }

  // Merchant-owned marketplace skill file, self-hosted. This is what the
  // zero-argument `acc publish` points to when the operator doesn't supply
  // `--url=`. We stream the raw bytes verbatim so the server-side sha256
  // matches what the CLI signed over.
  if (path === "/.well-known/acc-skill.md" && req.method === "GET") {
    try {
      const bytes = readFileSync(config.accSkillMdPath);
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Access-Control-Allow-Origin": "*",
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, {
        error: "acc-skill.md not found",
        hint: `No file at ${config.accSkillMdPath}. Run \`acc skill init\` or set ACC_SKILL_MD_PATH.`,
      });
    }
    return;
  }

  // API info
  if (path === "/api/info" && req.method === "GET") {
    handleApiInfo(res, config);
    return;
  }

  // Webhook endpoint
  if (path === "/webhook" && req.method === "POST") {
    if (!webhookHandler) {
      sendJson(res, 503, { error: "Webhook handler not registered" });
      return;
    }
    const rawBody = await readBody(req);
    const sig = req.headers["x-nexus-signature"] as string | undefined;
    const ts = req.headers["x-nexus-timestamp"] as string | undefined;
    try {
      const result = await webhookHandler(config, rawBody, sig, ts);
      sendJson(res, 200, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  send404(res);
}

// ── Start portal ────────────────────────────────────────────────────────────

export function startPortal(config: Config): Server {
  const httpServer = createServer((req, res) => {
    handleRequest(config, req, res).catch((err) => {
      console.error("[Portal] Request error:", err);
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, {
          error: "Internal server error",
          detail: message,
          path: req.url,
        });
      }
    });
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[Portal] Port ${config.portalPort} is in use, portal disabled`,
      );
    } else {
      console.error("[Portal] Server error:", err);
    }
    httpServer.close();
  });

  const host = process.env.PORTAL_HOST ?? "0.0.0.0";
  httpServer.listen(config.portalPort, host, () => {
    console.error(
      `[Portal] ${AGENT_NAME} dashboard at http://localhost:${config.portalPort}`,
    );
  });

  return httpServer;
}
