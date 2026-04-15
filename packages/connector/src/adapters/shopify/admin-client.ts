import type { CheckoutSession, ShippingAddress } from "../../types.js";
import type {
  MerchantAdapter,
  OrderCreateResult,
  OrderCreateOpts,
} from "../types.js";
import type { ShopifyPlatformConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Admin API GraphQL mutations
// ---------------------------------------------------------------------------

const ORDER_CREATE_MUTATION = `
mutation OrderCreate($order: OrderCreateOrderInput!) {
  orderCreate(order: $order) {
    order {
      id
      name
      createdAt
    }
    userErrors {
      field
      message
    }
  }
}`;

const ORDER_MARK_PAID_MUTATION = `
mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order {
      id
      name
      displayFinancialStatus
    }
    userErrors {
      field
      message
    }
  }
}`;

const ORDER_CANCEL_MUTATION = `
mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    orderCancelUserErrors {
      field
      message
    }
  }
}`;

const ORDER_UPDATE_MUTATION = `
mutation OrderUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order {
      id
      tags
    }
    userErrors {
      field
      message
    }
  }
}`;

const ORDER_TAG_QUERY = `
query OrdersByTag($query: String!) {
  orders(first: 1, query: $query) {
    edges {
      node {
        id
        name
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toShopifyAddress(addr: ShippingAddress): Record<string, string> {
  return {
    firstName: addr.first_name,
    lastName: addr.last_name,
    address1: addr.address1,
    ...(addr.address2 ? { address2: addr.address2 } : {}),
    city: addr.city,
    ...(addr.province ? { province: addr.province } : {}),
    country: addr.country,
    zip: addr.zip,
    ...(addr.phone ? { phone: addr.phone } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shopify Merchant Adapter — implements MerchantAdapter
// ---------------------------------------------------------------------------

export function createShopifyMerchant(
  shopifyConfig: ShopifyPlatformConfig,
): MerchantAdapter {
  const endpoint = `${shopifyConfig.storeUrl}/admin/api/${shopifyConfig.apiVersion}/graphql.json`;

  async function adminGql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    if (!shopifyConfig.adminToken) {
      throw new Error("SHOPIFY_ADMIN_TOKEN is required for order writeback");
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shopifyConfig.adminToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Admin API ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: readonly { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(
        `Admin GraphQL: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    if (!json.data) {
      throw new Error("Admin API returned no data");
    }

    return json.data;
  }

  // ── createOrder ─────────────────────────────────────────────────────────

  async function createOrder(
    session: CheckoutSession,
    opts?: OrderCreateOpts,
  ): Promise<OrderCreateResult> {
    const financialStatus = opts?.financialStatus ?? "PENDING";

    const lineItems = session.line_items.map((li) => ({
      variantId: li.variant_id,
      quantity: li.quantity,
    }));

    const tags = [
      `commerce_session:${session.id}`,
      `commerce_order:${session.order_ref}`,
    ];

    const note = [
      financialStatus === "PENDING"
        ? `Awaiting stablecoin payment`
        : `Paid via stablecoin (on-chain)`,
      `Session: ${session.id}`,
      `Order Ref: ${session.order_ref}`,
      `Token Amount: ${session.token_amount}`,
      `Rate: ${session.rate}`,
    ].join("\n");

    const shippingAddr = session.buyer?.shipping_address;

    const orderInput = {
      lineItems,
      financialStatus,
      tags,
      note,
      ...(session.buyer?.email ? { email: session.buyer.email } : {}),
      ...(shippingAddr
        ? { shippingAddress: toShopifyAddress(shippingAddr) }
        : {}),
    };

    const data = await adminGql<{
      orderCreate: {
        order: { id: string; name: string; createdAt: string } | null;
        userErrors: readonly { field: string[]; message: string }[];
      };
    }>(ORDER_CREATE_MUTATION, { order: orderInput });

    const { order, userErrors } = data.orderCreate;

    if (userErrors.length > 0) {
      throw new Error(
        `Shopify orderCreate failed: ${userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    if (!order) {
      throw new Error("Shopify orderCreate returned no order");
    }

    return {
      platformOrderId: order.id,
      platformOrderName: order.name,
    };
  }

  // ── markOrderPaid ──────────────────────────────────────────────────────

  async function markOrderPaid(
    platformOrderId: string,
    txHash: string,
  ): Promise<void> {
    const paidData = await adminGql<{
      orderMarkAsPaid: {
        order: { id: string } | null;
        userErrors: readonly { field: string[]; message: string }[];
      };
    }>(ORDER_MARK_PAID_MUTATION, { input: { id: platformOrderId } });

    const paidErrors = paidData.orderMarkAsPaid.userErrors;
    if (paidErrors.length > 0) {
      throw new Error(
        `Shopify markAsPaid failed: ${paidErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // Add tx hash tag (best-effort)
    if (txHash) {
      await adminGql<{
        orderUpdate: {
          order: { id: string } | null;
          userErrors: readonly { field: string[]; message: string }[];
        };
      }>(ORDER_UPDATE_MUTATION, {
        input: { id: platformOrderId, tags: [`payment_tx:${txHash}`] },
      }).catch((err) =>
        console.error(`[ShopifyMerchant] Failed to add tx tag: ${err}`),
      );
    }
  }

  // ── cancelOrder ────────────────────────────────────────────────────────

  async function cancelOrder(
    platformOrderId: string,
    reason?: string,
  ): Promise<void> {
    const data = await adminGql<{
      orderCancel: {
        orderCancelUserErrors: readonly {
          field: string[];
          message: string;
        }[];
      };
    }>(ORDER_CANCEL_MUTATION, {
      orderId: platformOrderId,
      reason: "OTHER",
      notifyCustomer: false,
      staffNote: reason ?? "Payment expired or cancelled",
    });

    const errors = data.orderCancel.orderCancelUserErrors;
    if (errors.length > 0) {
      throw new Error(
        `Shopify orderCancel failed: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  // ── hasExistingOrder (idempotency) ─────────────────────────────────────

  async function hasExistingOrder(sessionId: string): Promise<boolean> {
    const tagQuery = `tag:commerce_session:${sessionId}`;

    const data = await adminGql<{
      orders: { edges: readonly { node: { id: string } }[] };
    }>(ORDER_TAG_QUERY, { query: tagQuery });

    return data.orders.edges.length > 0;
  }

  return { createOrder, markOrderPaid, cancelOrder, hasExistingOrder };
}
