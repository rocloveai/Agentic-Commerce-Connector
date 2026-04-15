// ---------------------------------------------------------------------------
// UCP/1.0 REST façade
//
// Routes (all under /ucp/v1):
//   GET  /discovery
//   POST /search
//   GET  /products/:handle
//   POST /checkout-sessions
//   GET  /checkout-sessions/:id
//   POST /checkout-sessions/:id/complete
//   GET  /orders/:id
//
// Cart tokens authenticate access to a specific session id across requests;
// the DB table is the source of truth. PATCH (update line items) is deferred
// to a later milestone since it requires quote re-issuance.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { CatalogAdapter, MerchantAdapter } from "../adapters/types.js";
import {
  createCheckoutSession,
  getCheckoutStatus,
} from "../services/checkout-session.js";
import { getSession } from "../services/db/session-repo.js";
import {
  UCP_ERR,
  UCP_VERSION,
  UcpCheckoutCreateRequest,
  UcpSearchRequest,
  type UcpErrorResponseT,
  type UcpPaymentHandlerT,
} from "./types.js";
import {
  buildDiscoveryEnvelope,
  buildMinimalEnvelope,
  checkoutSessionToUcp,
  commerceProductToUcp,
} from "./mappers.js";
import {
  issueCartToken,
  verifyCartToken,
  type CartTokenConfig,
} from "./cart-token.js";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface UcpDeps {
  readonly config: Config;
  readonly catalog: CatalogAdapter;
  readonly merchant: MerchantAdapter | null;
  readonly cartTokenConfig: CartTokenConfig;
  /** Payment handlers advertised via /discovery. Sourced from PaymentProvider. */
  readonly paymentHandlers: readonly UcpPaymentHandlerT[];
  /** Absolute base URL for the UCP façade, e.g. https://api.example.com/ucp/v1. */
  readonly ucpEndpoint: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendUcp(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function ucpError(
  code: string,
  content: string,
  status: number,
  continueUrl?: string,
): { status: number; body: UcpErrorResponseT } {
  return {
    status,
    body: {
      ucp: { version: UCP_VERSION, status: "error" },
      error: {
        code,
        content,
        ...(continueUrl ? { continue_url: continueUrl } : {}),
      },
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function extractCartToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const xt = req.headers["x-ucp-cart-token"];
  if (typeof xt === "string" && xt.length > 0) return xt;
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleDiscovery(deps: UcpDeps, res: ServerResponse): Promise<void> {
  const storeMeta = await deps.catalog.getStoreMeta();
  const envelope = buildDiscoveryEnvelope(
    {
      endpointBase: deps.ucpEndpoint,
      paymentHandlers: deps.paymentHandlers,
    },
    storeMeta,
  );
  sendUcp(res, 200, envelope);
}

async function handleSearch(
  deps: UcpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJson(req);
  const parsed = UcpSearchRequest.safeParse(raw);
  if (!parsed.success) {
    const { status, body } = ucpError(
      UCP_ERR.INVALID_REQUEST,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      400,
    );
    sendUcp(res, status, body);
    return;
  }

  const { query, first, after } = parsed.data;
  const result = query
    ? await deps.catalog.searchProducts(query, first, after ?? null)
    : await deps.catalog.listProducts(first, after ?? null);

  sendUcp(res, 200, {
    ucp: buildMinimalEnvelope(),
    items: result.products.map(commerceProductToUcp),
    page_info: {
      has_next_page: result.pageInfo.hasNextPage,
      end_cursor: result.pageInfo.endCursor,
    },
  });
}

async function handleGetProduct(
  deps: UcpDeps,
  handle: string,
  res: ServerResponse,
): Promise<void> {
  const product = await deps.catalog.getProduct(handle);
  if (!product) {
    const { status, body } = ucpError(
      UCP_ERR.PRODUCT_NOT_FOUND,
      `Product "${handle}" not found`,
      404,
    );
    sendUcp(res, status, body);
    return;
  }
  sendUcp(res, 200, {
    ucp: buildMinimalEnvelope(),
    product: commerceProductToUcp(product),
  });
}

async function handleCreateCheckout(
  deps: UcpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJson(req);
  const parsed = UcpCheckoutCreateRequest.safeParse(raw);
  if (!parsed.success) {
    const { status, body } = ucpError(
      UCP_ERR.INVALID_REQUEST,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      400,
    );
    sendUcp(res, status, body);
    return;
  }

  try {
    const items = parsed.data.line_items.map((li) => ({
      variant_id: li.id,
      quantity: li.quantity,
    }));

    const { session } = await createCheckoutSession(
      {
        items,
        buyerEmail: parsed.data.buyer?.email,
        payerWallet: parsed.data.buyer?.wallet_address,
        shippingAddress: parsed.data.shipping_address,
      },
      deps.catalog,
      deps.config,
      deps.merchant,
    );

    const cartToken = issueCartToken(session.id, deps.cartTokenConfig);
    sendUcp(res, 201, {
      ucp: buildMinimalEnvelope(),
      ...checkoutSessionToUcp(session),
      cart_token: cartToken,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { status, body } = ucpError(UCP_ERR.INTERNAL, msg, 500);
    sendUcp(res, status, body);
  }
}

async function handleGetCheckout(
  deps: UcpDeps,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const tokenOrErr = authorizeSession(deps, sessionId, req);
  if (!tokenOrErr.ok) {
    sendUcp(res, tokenOrErr.status, tokenOrErr.body);
    return;
  }

  const session = await getCheckoutStatus(sessionId);
  if (!session) {
    const { status, body } = ucpError(
      UCP_ERR.CHECKOUT_NOT_FOUND,
      `Session "${sessionId}" not found`,
      404,
    );
    sendUcp(res, status, body);
    return;
  }
  sendUcp(res, 200, {
    ucp: buildMinimalEnvelope(),
    ...checkoutSessionToUcp(session),
  });
}

async function handleCompleteCheckout(
  deps: UcpDeps,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const tokenOrErr = authorizeSession(deps, sessionId, req);
  if (!tokenOrErr.ok) {
    sendUcp(res, tokenOrErr.status, tokenOrErr.body);
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    const { status, body } = ucpError(
      UCP_ERR.CHECKOUT_NOT_FOUND,
      `Session "${sessionId}" not found`,
      404,
    );
    sendUcp(res, status, body);
    return;
  }

  const continueUrl =
    session.payment_group_id
      ? `${deps.config.checkoutBaseUrl}/checkout/${session.payment_group_id}`
      : null;

  if (!continueUrl) {
    const { status, body } = ucpError(
      UCP_ERR.PAYMENT_PROVIDER_UNAVAILABLE,
      "Payment group not yet provisioned for this session",
      409,
    );
    sendUcp(res, status, body);
    return;
  }

  sendUcp(res, 200, {
    status: "requires_escalation",
    continue_url: continueUrl,
    payment_id: session.payment_group_id,
    expires_at: session.rate_expires_at ?? undefined,
  });
}

async function handleGetOrder(
  deps: UcpDeps,
  orderId: string,
  res: ServerResponse,
): Promise<void> {
  // Order id in UCP corresponds to our `order_ref` (e.g. SHP-xxxxx or WOO-xxxxx)
  // For MVP we look up via merchant.hasExistingOrder + session lookup.
  const session = await findSessionByPlatformOrder(orderId);
  if (!session) {
    const { status, body } = ucpError(
      UCP_ERR.ORDER_NOT_FOUND,
      `Order "${orderId}" not found`,
      404,
    );
    sendUcp(res, status, body);
    return;
  }
  sendUcp(res, 200, {
    ucp: buildMinimalEnvelope(),
    id: orderId,
    status: mapSessionStatusToOrderStatus(session.status),
    checkout_session_id: session.id,
    platform_order_id: session.platform_order_id ?? undefined,
    platform_order_name: session.platform_order_name ?? undefined,
    total: { amount: session.subtotal, currency_code: session.currency.toUpperCase() },
    transaction_id: session.tx_hash,
    created_at: session.created_at,
    updated_at: session.updated_at,
  });

  // `deps` intentionally read later if needed; suppress unused-var warning:
  void deps;
}

// ---------------------------------------------------------------------------
// Session authorization
// ---------------------------------------------------------------------------

type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly body: UcpErrorResponseT };

function authorizeSession(
  deps: UcpDeps,
  sessionId: string,
  req: IncomingMessage,
): AuthResult {
  const token = extractCartToken(req);
  if (!token) {
    return {
      ok: false,
      ...ucpError(UCP_ERR.CART_TOKEN_INVALID, "Missing cart token", 401),
    };
  }
  const verdict = verifyCartToken(token, deps.cartTokenConfig);
  if (!verdict.ok) {
    const code =
      verdict.reason === "expired"
        ? UCP_ERR.CART_TOKEN_EXPIRED
        : UCP_ERR.CART_TOKEN_INVALID;
    return { ok: false, ...ucpError(code, verdict.reason, 401) };
  }
  if (verdict.payload.session_id !== sessionId) {
    return {
      ok: false,
      ...ucpError(UCP_ERR.CART_TOKEN_INVALID, "Cart token does not match session", 403),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers (order lookup + status mapping)
// ---------------------------------------------------------------------------

async function findSessionByPlatformOrder(
  orderRef: string,
): Promise<Awaited<ReturnType<typeof getSession>>> {
  // Using order_ref which is stable per session
  const { findSessionByOrderRef } = await import("../services/db/session-repo.js");
  return findSessionByOrderRef(orderRef);
}

function mapSessionStatusToOrderStatus(
  status: import("../types.js").SessionStatus,
): "pending" | "paid" | "fulfilled" | "cancelled" | "refunded" {
  switch (status) {
    case "completed":
      return "fulfilled";
    case "cancelled":
    case "rate_expired":
      return "cancelled";
    case "payment_pending":
    case "rate_locked":
    case "created":
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export async function handleUcpRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: UcpDeps,
): Promise<boolean> {
  try {
    if (path === "/ucp/v1/discovery" && req.method === "GET") {
      await handleDiscovery(deps, res);
      return true;
    }
    if (path === "/ucp/v1/search" && req.method === "POST") {
      await handleSearch(deps, req, res);
      return true;
    }
    const productMatch = path.match(/^\/ucp\/v1\/products\/([a-zA-Z0-9_-]+)$/);
    if (productMatch && req.method === "GET") {
      await handleGetProduct(deps, productMatch[1], res);
      return true;
    }
    if (path === "/ucp/v1/checkout-sessions" && req.method === "POST") {
      await handleCreateCheckout(deps, req, res);
      return true;
    }
    const sessionMatch = path.match(
      /^\/ucp\/v1\/checkout-sessions\/([a-zA-Z0-9_-]+)(\/complete)?$/,
    );
    if (sessionMatch) {
      const [, id, completeSuffix] = sessionMatch;
      if (completeSuffix && req.method === "POST") {
        await handleCompleteCheckout(deps, id, req, res);
        return true;
      }
      if (!completeSuffix && req.method === "GET") {
        await handleGetCheckout(deps, id, req, res);
        return true;
      }
    }
    const orderMatch = path.match(/^\/ucp\/v1\/orders\/([a-zA-Z0-9_-]+)$/);
    if (orderMatch && req.method === "GET") {
      await handleGetOrder(deps, orderMatch[1], res);
      return true;
    }
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { status, body } = ucpError(UCP_ERR.INTERNAL, msg, 500);
    sendUcp(res, status, body);
    return true;
  }
}
