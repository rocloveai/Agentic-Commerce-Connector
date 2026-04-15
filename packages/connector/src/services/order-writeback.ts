import type { CheckoutSession } from "../types.js";
import type { MerchantAdapter } from "../adapters/types.js";
import { updateSession, getSession } from "./db/session-repo.js";

export interface WritebackResult {
  readonly success: boolean;
  readonly platformOrderId?: string;
  readonly platformOrderName?: string;
  readonly error?: string;
}

/**
 * Handle payment completion: mark existing platform order as paid,
 * or create one if it wasn't pre-created at checkout.
 *
 * Idempotent — checks session status before acting.
 */
export async function handlePaymentCompleted(
  sessionId: string,
  txHash: string,
  merchant: MerchantAdapter,
): Promise<WritebackResult> {
  const session = await getSession(sessionId);
  if (!session) {
    return { success: false, error: `Session "${sessionId}" not found` };
  }

  // Already completed
  if (session.status === "completed" && session.platform_order_id) {
    return {
      success: true,
      platformOrderId: session.platform_order_id,
      platformOrderName: session.platform_order_name ?? undefined,
    };
  }

  let platformOrderId = session.platform_order_id;
  let platformOrderName = session.platform_order_name;

  if (platformOrderId) {
    // Order was pre-created at checkout → mark as paid
    await merchant.markOrderPaid(platformOrderId, txHash);
    console.error(
      `[Writeback] Marked platform order ${platformOrderName} as PAID for session ${sessionId}`,
    );
  } else {
    // Fallback: order wasn't pre-created → create with PAID status
    const exists = await merchant.hasExistingOrder(sessionId);
    if (exists) {
      console.error(
        `[Writeback] Platform order already exists for session ${sessionId}`,
      );
      await updateSession(sessionId, {
        status: "completed",
        tx_hash: txHash,
        completed_at: new Date().toISOString(),
      });
      return { success: true };
    }

    const result = await merchant.createOrder(session, {
      financialStatus: "PAID",
    });
    platformOrderId = result.platformOrderId;
    platformOrderName = result.platformOrderName;
    console.error(
      `[Writeback] Created platform order ${platformOrderName} (PAID) for session ${sessionId}`,
    );
  }

  await updateSession(sessionId, {
    status: "completed",
    tx_hash: txHash,
    platform_order_id: platformOrderId,
    platform_order_name: platformOrderName,
    completed_at: new Date().toISOString(),
  });

  return {
    success: true,
    platformOrderId: platformOrderId ?? undefined,
    platformOrderName: platformOrderName ?? undefined,
  };
}
