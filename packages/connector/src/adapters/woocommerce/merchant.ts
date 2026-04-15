// ---------------------------------------------------------------------------
// WooCommerce MerchantAdapter — order lifecycle via WC REST v3.
//
// Strategy:
//   createOrder    → POST /orders, status=on-hold, session id in meta_data
//   markOrderPaid  → PUT /orders/{id}, status=processing, transaction_id set
//   cancelOrder    → PUT /orders/{id}, status=cancelled + /notes
//   hasExistingOrder
//     - Primary:   GET /orders?meta_key=nexus_session_id&meta_value=…
//     - Fallback:  scan recent orders and inspect meta_data (some shared hosts
//                  disable `meta_query`; the fallback protects idempotency).
// ---------------------------------------------------------------------------

import type { CheckoutSession } from "../../types.js";
import type {
  MerchantAdapter,
  OrderCreateOpts,
  OrderCreateResult,
} from "../types.js";
import { decodeVariantId, type WooCommercePlatformConfig } from "./config.js";
import { wooFetch } from "./http.js";

// ---------------------------------------------------------------------------
// WC REST payload shapes (partial)
// ---------------------------------------------------------------------------

interface WcOrderMeta {
  key: string;
  value: unknown;
  id?: number;
}

interface WcOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  transaction_id?: string;
  meta_data: WcOrderMeta[];
}

interface WcLineItemInput {
  product_id: number;
  variation_id?: number;
  quantity: number;
  // price is typically derived from product; passing `total` overrides
  total?: string;
  subtotal?: string;
}

interface WcOrderCreateInput {
  status: "pending" | "on-hold" | "processing" | "completed" | "cancelled";
  currency: string;
  billing?: Record<string, string>;
  shipping?: Record<string, string>;
  line_items: WcLineItemInput[];
  meta_data: WcOrderMeta[];
  customer_note?: string;
}

// ---------------------------------------------------------------------------
// Address mapping
// ---------------------------------------------------------------------------

function sessionToWcAddress(
  session: CheckoutSession,
): {
  billing?: Record<string, string>;
  shipping?: Record<string, string>;
} {
  const addr = session.buyer?.shipping_address;
  const email = session.buyer?.email;
  if (!addr && !email) return {};

  const base: Record<string, string> = {};
  if (addr) {
    base.first_name = addr.first_name;
    base.last_name = addr.last_name;
    base.address_1 = addr.address1;
    if (addr.address2) base.address_2 = addr.address2;
    base.city = addr.city;
    if (addr.province) base.state = addr.province;
    base.country = addr.country;
    base.postcode = addr.zip;
    if (addr.phone) base.phone = addr.phone;
  }
  if (email) base.email = email;

  return { billing: base, shipping: addr ? base : undefined };
}

// ---------------------------------------------------------------------------
// Meta helpers — idempotency + attribution
// ---------------------------------------------------------------------------

const META_KEY_SESSION = "nexus_session_id";
const META_KEY_GROUP = "nexus_group_id";
const META_KEY_CART_TOKEN = "ucp_cart_token";

function buildOrderMeta(session: CheckoutSession): WcOrderMeta[] {
  const meta: WcOrderMeta[] = [
    { key: META_KEY_SESSION, value: session.id },
  ];
  if (session.payment_group_id) {
    meta.push({ key: META_KEY_GROUP, value: session.payment_group_id });
  }
  if (session.order_ref) {
    meta.push({ key: "nexus_order_ref", value: session.order_ref });
  }
  return meta;
}

function findMetaValue(meta: WcOrderMeta[], key: string): string | null {
  const entry = meta.find((m) => m.key === key);
  return entry && typeof entry.value === "string" ? entry.value : null;
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

function sessionToLineItems(session: CheckoutSession): WcLineItemInput[] {
  const items: WcLineItemInput[] = [];
  for (const li of session.line_items) {
    const decoded = decodeVariantId(li.variant_id);
    if (!decoded) {
      throw new Error(
        `[WooMerchant] Cannot decode variant id ${li.variant_id}`,
      );
    }
    const item: WcLineItemInput = {
      product_id: decoded.parentId,
      quantity: li.quantity,
    };
    if (decoded.variationId !== null) item.variation_id = decoded.variationId;
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWooMerchant(
  cfg: WooCommercePlatformConfig,
): MerchantAdapter {
  return {
    async createOrder(
      session: CheckoutSession,
      opts?: OrderCreateOpts,
    ): Promise<OrderCreateResult> {
      // Idempotency: if we already created an order for this session, return it.
      const existing = await lookupOrderBySession(cfg, session.id);
      if (existing) {
        return {
          platformOrderId: String(existing.id),
          platformOrderName: `#${existing.number}`,
        };
      }

      const { billing, shipping } = sessionToWcAddress(session);
      const status =
        opts?.financialStatus === "PAID" ? "processing" : "on-hold";

      const payload: WcOrderCreateInput = {
        status,
        currency: session.currency.toUpperCase(),
        line_items: sessionToLineItems(session),
        meta_data: buildOrderMeta(session),
        customer_note: `Nexus session ${session.id}`,
        ...(billing ? { billing } : {}),
        ...(shipping ? { shipping } : {}),
      };

      const order = await wooFetch<WcOrder>(cfg, {
        method: "POST",
        path: "/orders",
        body: payload,
      });

      return {
        platformOrderId: String(order.id),
        platformOrderName: `#${order.number}`,
      };
    },

    async markOrderPaid(platformOrderId: string, txHash: string): Promise<void> {
      await wooFetch<WcOrder>(cfg, {
        method: "PUT",
        path: `/orders/${platformOrderId}`,
        body: {
          status: "processing",
          transaction_id: txHash,
        },
      });
      await wooFetch(cfg, {
        method: "POST",
        path: `/orders/${platformOrderId}/notes`,
        body: {
          note: `Paid via Nexus. tx=${txHash}`,
          customer_note: false,
        },
      });
    },

    async cancelOrder(
      platformOrderId: string,
      reason?: string,
    ): Promise<void> {
      await wooFetch<WcOrder>(cfg, {
        method: "PUT",
        path: `/orders/${platformOrderId}`,
        body: { status: "cancelled" },
      });
      if (reason) {
        await wooFetch(cfg, {
          method: "POST",
          path: `/orders/${platformOrderId}/notes`,
          body: { note: `Cancelled: ${reason}`, customer_note: false },
        });
      }
    },

    async hasExistingOrder(sessionId: string): Promise<boolean> {
      const order = await lookupOrderBySession(cfg, sessionId);
      return order !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Lookup (meta_query primary, recent-scan fallback)
// ---------------------------------------------------------------------------

async function lookupOrderBySession(
  cfg: WooCommercePlatformConfig,
  sessionId: string,
): Promise<WcOrder | null> {
  // Primary: meta_query — not guaranteed on all hosts
  try {
    const orders = await wooFetch<WcOrder[]>(cfg, {
      method: "GET",
      path: "/orders",
      query: {
        meta_key: META_KEY_SESSION,
        meta_value: sessionId,
        per_page: 1,
        status: "any",
      },
    });
    if (orders.length > 0) {
      return orders[0];
    }
  } catch {
    // fall through to scan
  }

  // Fallback: scan last N orders and inspect meta_data locally.
  // This is acceptable because merchants rarely receive > a few hundred orders
  // during the cart-token TTL window; we're only verifying idempotency.
  try {
    const recent = await wooFetch<WcOrder[]>(cfg, {
      method: "GET",
      path: "/orders",
      query: { per_page: 50, status: "any", orderby: "date", order: "desc" },
    });
    for (const o of recent) {
      if (findMetaValue(o.meta_data, META_KEY_SESSION) === sessionId) {
        return o;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export { META_KEY_SESSION, META_KEY_GROUP, META_KEY_CART_TOKEN };
