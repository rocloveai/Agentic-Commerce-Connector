#!/usr/bin/env node
// ---------------------------------------------------------------------------
// install-relay HTTP server entry.
//
// Binds to PORT on localhost (127.0.0.1); nginx on the host reverse-proxies
// from https://install.xagenpay.com/ to here. Keeps a single DB handle
// open for the lifetime of the process; systemd restarts on failure.
// ---------------------------------------------------------------------------
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadRelayConfig } from "./config.js";
import { createSqlitePairStore, type PairStore } from "./pair-store.js";
import { handlePairNew } from "./routes/pair-new.js";
import { handleInstallStart } from "./routes/install-start.js";
import { handleCallback } from "./routes/callback.js";
import { handlePoll } from "./routes/poll.js";
import { handleRefresh } from "./routes/refresh.js";
import { sendJson } from "./routes/_http.js";

async function main(): Promise<void> {
  const config = loadRelayConfig();
  const pairStore = await createSqlitePairStore(config.pairDbPath);

  // Sweep expired rows every minute. Cheap (single DELETE) and keeps the
  // DB from growing for TTL-exceeded pairs that nobody consumed.
  const sweeper = setInterval(() => {
    void pairStore.sweepExpired(Date.now()).catch((err) => {
      console.error("[install-relay] sweep failed:", err);
    });
  }, 60_000);
  sweeper.unref();

  const server = createServer((req, res) => {
    handle(req, res, config, pairStore).catch((err) => {
      console.error("[install-relay] unhandled error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.error(
      `[install-relay] listening on 127.0.0.1:${config.port}, self=${config.selfUrl}`,
    );
  });

  const shutdown = (sig: string): void => {
    console.error(`[install-relay] ${sig} received, shutting down…`);
    clearInterval(sweeper);
    server.close(() => {
      pairStore.close();
      process.exit(0);
    });
    // Force exit if close hangs.
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ReturnType<typeof loadRelayConfig>,
  store: PairStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", config.selfUrl);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS preflight (CLI sometimes sends OPTIONS from browsers; not strictly
  // needed here but cheap to support).
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Routes.
  if (path === "/healthz" && method === "GET") {
    sendJson(res, 200, { ok: true, version: "0.7.0-pre" });
    return;
  }

  if (path === "/" && method === "GET") {
    sendJson(res, 200, {
      service: "acc-install-relay",
      version: "0.7.0-pre",
      endpoints: [
        "POST /pair/new",
        "GET  /auth/shopify/install?pair=…",
        "GET  /auth/shopify/callback (OAuth return)",
        "GET  /pair/poll?pair=…",
        "POST /pair/refresh (admin-token refresh on behalf of merchant ACC)",
      ],
    });
    return;
  }

  if (path === "/pair/new" && method === "POST") {
    await handlePairNew(req, res, config, store);
    return;
  }

  if (path === "/auth/shopify/install" && method === "GET") {
    await handleInstallStart(req, res, config, store);
    return;
  }

  if (path === "/auth/shopify/callback" && method === "GET") {
    await handleCallback(req, res, config, store);
    return;
  }

  if (path === "/pair/poll" && method === "GET") {
    await handlePoll(req, res, store);
    return;
  }

  if (path === "/pair/refresh" && method === "POST") {
    await handleRefresh(req, res, config);
    return;
  }

  sendJson(res, 404, { error: "not_found", path, method });
}

main().catch((err) => {
  console.error("[install-relay] fatal:", err);
  process.exit(1);
});
