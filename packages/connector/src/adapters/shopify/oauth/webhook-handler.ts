// ---------------------------------------------------------------------------
// Incoming Shopify webhook handler.
//
// Today it handles APP_UNINSTALLED (flip `uninstalled_at` on the shop row)
// and returns 200 with no body for the GDPR topics — those exist so we can
// satisfy App Store submission (future Shape C) without re-registering
// webhooks. We don't retain customer data today, so the GDPR topics are
// effectively no-ops.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import { assertShopDomain, isValidShopDomain } from "./shop-domain.js";
import { verifyShopifyWebhookHmac } from "./webhook-hmac.js";
import type { InstallationStore } from "./installation-store.js";
import type { OAuthConfig } from "./types.js";

export interface WebhookHandlerDeps {
  readonly oauthConfig: OAuthConfig;
  readonly installationStore: InstallationStore;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Response helpers (duplicated from routes.ts to keep this module self-contained)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Shared verification step.
// ---------------------------------------------------------------------------

async function verifyAndExtract(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookHandlerDeps,
): Promise<{ shop: string; rawBody: string } | null> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return null;
  }

  const hmacHeader = req.headers["x-shopify-hmac-sha256"] as
    | string
    | undefined;
  const shopHeader = req.headers["x-shopify-shop-domain"] as string | undefined;

  const rawBody = await readBody(req);

  if (
    !verifyShopifyWebhookHmac(
      rawBody,
      hmacHeader,
      deps.oauthConfig.clientSecret,
    )
  ) {
    sendJson(res, 401, { error: "hmac_mismatch" });
    return null;
  }

  if (!isValidShopDomain(shopHeader)) {
    sendJson(res, 400, { error: "invalid_shop" });
    return null;
  }

  return { shop: assertShopDomain(shopHeader), rawBody };
}

// ---------------------------------------------------------------------------
// app/uninstalled — mark installation as uninstalled, 200.
// ---------------------------------------------------------------------------

export async function handleAppUninstalled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const verified = await verifyAndExtract(req, res, deps);
  if (!verified) return;

  const now = (deps.now ?? Date.now)();
  await deps.installationStore.markUninstalled(verified.shop, now);
  sendEmpty(res, 200);
}

// ---------------------------------------------------------------------------
// GDPR topics — acknowledge only (no-op today; no customer data retained).
// ---------------------------------------------------------------------------

export async function handleGdprAcknowledge(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const verified = await verifyAndExtract(req, res, deps);
  if (!verified) return;
  sendEmpty(res, 200);
}

// ---------------------------------------------------------------------------
// Router — dispatches the four webhook paths.
// ---------------------------------------------------------------------------

export function createShopifyWebhookRouter(deps: WebhookHandlerDeps) {
  return async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const path = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    ).pathname;

    if (path === "/webhooks/shopify/app-uninstalled") {
      await handleAppUninstalled(req, res, deps);
      return true;
    }
    if (
      path === "/webhooks/shopify/customers-data-request" ||
      path === "/webhooks/shopify/customers-redact" ||
      path === "/webhooks/shopify/shop-redact"
    ) {
      await handleGdprAcknowledge(req, res, deps);
      return true;
    }
    return false;
  };
}

export type ShopifyWebhookRouter = ReturnType<
  typeof createShopifyWebhookRouter
>;
