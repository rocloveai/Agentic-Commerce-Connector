import type { NexusQuotePayload } from "../types.js";
import type { Order, OrderStatus } from "../types.js";

// ---------------------------------------------------------------------------
// In-memory store (fallback when no DATABASE_URL)
// ---------------------------------------------------------------------------

const memStore = new Map<string, Order>();

let orderCounter = 0;
let orderPrefix = "ORD";

export function setOrderPrefix(prefix: string): void {
  orderPrefix = prefix;
}

export function newOrderRef(): string {
  orderCounter += 1;
  const ts = Date.now().toString(36);
  const seq = orderCounter.toString(36).padStart(3, "0");
  return `${orderPrefix}-${ts}-${seq}`;
}

export async function createOrder(quote: NexusQuotePayload): Promise<Order> {
  const now = new Date().toISOString();
  const order: Order = {
    order_ref: quote.merchant_order_ref,
    status: "UNPAID",
    quote_payload: quote,
    payer_wallet: quote.context.payer_wallet,
    created_at: now,
    updated_at: now,
  };
  memStore.set(order.order_ref, order);
  return order;
}

export async function getOrder(orderRef: string): Promise<Order | null> {
  return memStore.get(orderRef) ?? null;
}

export async function updateOrderStatus(
  orderRef: string,
  status: OrderStatus,
  payerWallet?: string,
): Promise<Order | null> {
  const order = memStore.get(orderRef);
  if (!order) return null;
  const updated: Order = {
    ...order,
    status,
    payer_wallet: payerWallet ?? order.payer_wallet,
    updated_at: new Date().toISOString(),
  };
  memStore.set(orderRef, updated);
  return updated;
}

export async function listOrders(): Promise<readonly Order[]> {
  return [...memStore.values()];
}
