import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookPayload, WebhookEventType } from "../types.js";
import type { Config } from "../config.js";
import { updateOrderStatus } from "./order-store.js";
import { findSessionByOrderRef, updateSession } from "./db/session-repo.js";
import { handlePaymentCompleted } from "./order-writeback.js";
import type { MerchantAdapter } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Settlement request — fire-and-forget call to nexus-core
// ---------------------------------------------------------------------------

export async function requestSettlement(
  nexusCoreUrl: string,
  nexusPaymentId: string,
  merchantDid: string,
): Promise<void> {
  const url = `${nexusCoreUrl}/api/merchant/confirm-fulfillment`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nexus_payment_id: nexusPaymentId,
        merchant_did: merchantDid,
      }),
      signal: controller.signal,
    });

    const body = await resp.text();
    console.error(`[Settlement] ${nexusPaymentId}: ${resp.status} ${body}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TIMESTAMP_DRIFT_S = 300;
const processedEvents = new Map<string, number>();
const EVENT_TTL_MS = 3_600_000;

function pruneProcessedEvents(): void {
  const now = Date.now();
  for (const [id, ts] of processedEvents) {
    if (now - ts > EVENT_TTL_MS) processedEvents.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  readonly valid: boolean;
  readonly reason?: string;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
): VerifyResult {
  if (!signatureHeader || !timestampHeader) {
    return { valid: false, reason: "Missing signature or timestamp header" };
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) {
    return { valid: false, reason: "Invalid timestamp" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_S) {
    return { valid: false, reason: "Timestamp outside allowed window" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const providedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(providedHex, "hex");

  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: "Signature mismatch" };
  }

  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

const STATUS_MAP: Partial<
  Record<WebhookEventType, "PAID" | "EXPIRED" | "CANCELLED">
> = {
  "payment.escrowed": "PAID",
  "payment.settled": "PAID",
  "payment.expired": "EXPIRED",
  "payment.cancelled": "CANCELLED",
};

export interface WebhookHandleResult {
  readonly accepted: boolean;
  readonly action: string;
}

export interface WebhookConfig {
  readonly nexusCoreUrl: string;
  readonly merchantDid: string;
  readonly merchant?: MerchantAdapter;
}

export async function handleWebhookEvent(
  payload: WebhookPayload,
  webhookConfig: WebhookConfig,
): Promise<WebhookHandleResult> {
  const { event_id, event_type, data } = payload;

  pruneProcessedEvents();

  // Idempotency check
  if (processedEvents.has(event_id)) {
    return { accepted: true, action: "duplicate_ignored" };
  }

  const newStatus = STATUS_MAP[event_type];

  if (newStatus) {
    const updated = await updateOrderStatus(data.merchant_order_ref, newStatus);
    processedEvents.set(event_id, Date.now());

    if (updated) {
      console.error(
        `[Webhook] ${event_type}: order ${data.merchant_order_ref} → ${newStatus}`,
      );

      // On escrowed: trigger order writeback (mark PAID) + settlement
      if (event_type === "payment.escrowed") {
        const session = await findSessionByOrderRef(data.merchant_order_ref);
        if (session && webhookConfig.merchant) {
          const txHash = data.settlement?.tx_hash ?? "";
          handlePaymentCompleted(
            session.id,
            txHash,
            webhookConfig.merchant,
          ).catch((err) => console.error("[Webhook] Writeback failed:", err));
        }

        // Fire-and-forget settlement
        requestSettlement(
          webhookConfig.nexusCoreUrl,
          data.payment_id,
          webhookConfig.merchantDid,
        ).catch((err) =>
          console.error("[Webhook] Settlement request failed:", err),
        );
      }

      // On expired/cancelled: cancel the pre-created platform order
      if (
        event_type === "payment.expired" ||
        event_type === "payment.cancelled"
      ) {
        const session = await findSessionByOrderRef(data.merchant_order_ref);
        if (session) {
          // Cancel platform order if it was pre-created
          if (session.platform_order_id && webhookConfig.merchant) {
            webhookConfig.merchant
              .cancelOrder(
                session.platform_order_id,
                `Payment ${event_type.replace("payment.", "")}`,
              )
              .then(() =>
                console.error(
                  `[Webhook] Cancelled platform order ${session.platform_order_name} for ${data.merchant_order_ref}`,
                ),
              )
              .catch((err) =>
                console.error(
                  `[Webhook] Failed to cancel platform order ${session.platform_order_name}:`,
                  err,
                ),
              );
          }

          // Update session status
          await updateSession(session.id, { status: "cancelled" });
        }
      }

      return { accepted: true, action: `status_updated_to_${newStatus}` };
    }

    console.error(
      `[Webhook] ${event_type}: order ${data.merchant_order_ref} not found`,
    );
    return { accepted: true, action: "order_not_found" };
  }

  processedEvents.set(event_id, Date.now());
  console.error(`[Webhook] ${event_type}: acknowledged (no status change)`);
  return { accepted: true, action: "acknowledged" };
}
