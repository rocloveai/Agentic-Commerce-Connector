/**
 * Integration tests: webhook handler + order writeback + checkout session
 *
 * Uses mock adapters (no real Shopify/network calls).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyWebhookSignature,
  handleWebhookEvent,
} from "../services/webhook-handler.js";
import { handlePaymentCompleted } from "../services/order-writeback.js";
import {
  createOrder,
  updateOrderStatus,
  getOrder,
} from "../services/order-store.js";
import {
  createSession,
  getSession,
  findSessionByOrderRef,
} from "../services/db/session-repo.js";
import { createHmac } from "node:crypto";
import { makeSession, createMockMerchant } from "./adapter-contract.test.js";
import type { PaymentQuote } from "../payment/types.js";
import type { MerchantAdapter } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const secret = "test_webhook_secret_123";

  function sign(body: string, timestampSeconds: number): string {
    return createHmac("sha256", secret)
      .update(`${timestampSeconds}.${body}`)
      .digest("hex");
  }

  it("accepts valid signature", () => {
    const body = '{"event_type":"payment.escrowed"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(body, ts);

    const result = verifyWebhookSignature(secret, body, sig, String(ts));

    expect(result.valid).toBe(true);
  });

  it("accepts sha256= prefixed signature", () => {
    const body = '{"test": true}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = `sha256=${sign(body, ts)}`;

    const result = verifyWebhookSignature(secret, body, sig, String(ts));

    expect(result.valid).toBe(true);
  });

  it("rejects missing signature", () => {
    const result = verifyWebhookSignature(secret, "{}", undefined, "123");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Missing");
  });

  it("rejects missing timestamp", () => {
    const result = verifyWebhookSignature(secret, "{}", "abc", undefined);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Missing");
  });

  it("rejects invalid timestamp", () => {
    const result = verifyWebhookSignature(secret, "{}", "abc", "not-a-number");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Invalid timestamp");
  });

  it("rejects expired timestamp (>300s drift)", () => {
    const body = "{}";
    const oldTs = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
    const sig = sign(body, oldTs);

    const result = verifyWebhookSignature(secret, body, sig, String(oldTs));

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("outside allowed window");
  });

  it("rejects wrong signature", () => {
    const body = '{"data": "real"}';
    const ts = Math.floor(Date.now() / 1000);
    const fakeSig = createHmac("sha256", "wrong_secret")
      .update(`${ts}.${body}`)
      .digest("hex");

    const result = verifyWebhookSignature(secret, body, fakeSig, String(ts));

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Signature mismatch");
  });
});

// ---------------------------------------------------------------------------
// Webhook event handling
// ---------------------------------------------------------------------------

describe("handleWebhookEvent", () => {
  const basePayload = {
    event_id: "",
    event_type: "payment.escrowed" as const,
    data: {
      nexus_payment_id: "np_test_123",
      merchant_order_ref: "ORD-test-001",
      settlement: { tx_hash: "0xdeadbeef" },
    },
  };

  beforeEach(async () => {
    // Pre-create an order so the webhook handler can find it
    const quote: PaymentQuote = {
      merchant_did: "did:test:merchant",
      merchant_order_ref: "ORD-test-001",
      amount: "29.99",
      currency: "XSGD",
      chain_id: 20250407,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      context: {
        summary: "Test Product x1",
        line_items: [{ name: "Test Product", qty: 1, amount: "29.99" }],
      },
      signature: "0x" + "ab".repeat(65),
    };
    await createOrder(quote);
  });

  it("updates order status on payment.escrowed", async () => {
    const result = await handleWebhookEvent(
      { ...basePayload, event_id: "evt_1" },
      {
        nexusCoreUrl: "https://api.test.com",
        merchantDid: "did:test:merchant",
      },
    );

    expect(result.accepted).toBe(true);
    expect(result.action).toBe("status_updated_to_PAID");

    const order = await getOrder("ORD-test-001");
    expect(order?.status).toBe("PAID");
  });

  it("deduplicates events by event_id", async () => {
    const payload = { ...basePayload, event_id: "evt_dedup" };

    const first = await handleWebhookEvent(payload, {
      nexusCoreUrl: "https://api.test.com",
      merchantDid: "did:test:merchant",
    });
    const second = await handleWebhookEvent(payload, {
      nexusCoreUrl: "https://api.test.com",
      merchantDid: "did:test:merchant",
    });

    expect(first.action).toBe("status_updated_to_PAID");
    expect(second.action).toBe("duplicate_ignored");
  });

  it("handles unknown event types gracefully", async () => {
    const result = await handleWebhookEvent(
      {
        event_id: "evt_unknown",
        event_type: "payment.unknown_event" as any,
        data: {
          nexus_payment_id: "np_test",
          merchant_order_ref: "ORD-test-001",
        },
      },
      {
        nexusCoreUrl: "https://api.test.com",
        merchantDid: "did:test:merchant",
      },
    );

    expect(result.accepted).toBe(true);
    expect(result.action).toBe("acknowledged");
  });

  it("maps payment.expired to EXPIRED status", async () => {
    const result = await handleWebhookEvent(
      {
        event_id: "evt_expired",
        event_type: "payment.expired",
        data: {
          nexus_payment_id: "np_test",
          merchant_order_ref: "ORD-test-001",
        },
      },
      {
        nexusCoreUrl: "https://api.test.com",
        merchantDid: "did:test:merchant",
      },
    );

    expect(result.action).toBe("status_updated_to_EXPIRED");
  });

  it("maps payment.cancelled to CANCELLED status", async () => {
    // Need a fresh order for this test
    const quote: PaymentQuote = {
      merchant_did: "did:test:merchant",
      merchant_order_ref: "ORD-cancel-001",
      amount: "10.00",
      currency: "XSGD",
      chain_id: 20250407,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      context: {
        summary: "Cancel Test",
        line_items: [{ name: "Item", qty: 1, amount: "10.00" }],
      },
      signature: "0x" + "cd".repeat(65),
    };
    await createOrder(quote);

    const result = await handleWebhookEvent(
      {
        event_id: "evt_cancel",
        event_type: "payment.cancelled",
        data: {
          nexus_payment_id: "np_cancel",
          merchant_order_ref: "ORD-cancel-001",
        },
      },
      {
        nexusCoreUrl: "https://api.test.com",
        merchantDid: "did:test:merchant",
      },
    );

    expect(result.action).toBe("status_updated_to_CANCELLED");
    const order = await getOrder("ORD-cancel-001");
    expect(order?.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Order writeback
// ---------------------------------------------------------------------------

describe("handlePaymentCompleted", () => {
  it("returns error for nonexistent session", async () => {
    const merchant = createMockMerchant();
    const result = await handlePaymentCompleted(
      "nonexistent_session",
      "0xabc",
      merchant,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("creates order via merchant when no pre-created order exists", async () => {
    // Create a session without platform_order_id
    const session = makeSession({
      id: "cs_writeback_1",
      platform_order_id: null,
      platform_order_name: null,
    });
    await createSession(session);

    const merchant = createMockMerchant();
    const result = await handlePaymentCompleted(
      "cs_writeback_1",
      "0xtxhash",
      merchant,
    );

    expect(result.success).toBe(true);
    expect(result.platformOrderId).toBeTruthy();
    expect(result.platformOrderName).toBeTruthy();

    // Session should be updated to completed
    const updated = await getSession("cs_writeback_1");
    expect(updated?.status).toBe("completed");
    expect(updated?.tx_hash).toBe("0xtxhash");
  });

  it("marks existing pre-created order as paid", async () => {
    const session = makeSession({
      id: "cs_writeback_2",
      platform_order_id: "gid://shopify/Order/pre_created",
      platform_order_name: "#PRE-1",
    });
    await createSession(session);

    let markPaidCalled = false;
    const merchant: MerchantAdapter = {
      createOrder: async () => ({
        platformOrderId: "unused",
        platformOrderName: "unused",
      }),
      markOrderPaid: async (id, txHash) => {
        markPaidCalled = true;
        expect(id).toBe("gid://shopify/Order/pre_created");
        expect(txHash).toBe("0xhash123");
      },
      cancelOrder: async () => {},
      hasExistingOrder: async () => false,
    };

    const result = await handlePaymentCompleted(
      "cs_writeback_2",
      "0xhash123",
      merchant,
    );

    expect(result.success).toBe(true);
    expect(markPaidCalled).toBe(true);
  });

  it("is idempotent — returns success for already completed session", async () => {
    const session = makeSession({
      id: "cs_writeback_3",
      status: "completed",
      platform_order_id: "gid://shopify/Order/done",
      platform_order_name: "#DONE-1",
    });
    await createSession(session);

    const merchant = createMockMerchant();
    const result = await handlePaymentCompleted(
      "cs_writeback_3",
      "0x",
      merchant,
    );

    expect(result.success).toBe(true);
    expect(result.platformOrderId).toBe("gid://shopify/Order/done");
  });
});
