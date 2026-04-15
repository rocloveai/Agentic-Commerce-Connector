// ---------------------------------------------------------------------------
// Nexus orchestrate submission — extracted from services/checkout-session.ts
// so that the PaymentProvider surface is self-contained.
// ---------------------------------------------------------------------------

import type { PaymentQuote, SubmitResult } from "../types.js";

interface OrchestrateResponse {
  group_id?: string;
  checkout_url?: string;
}

export interface SubmitToNexusParams {
  readonly quote: PaymentQuote;
  readonly nexusCoreUrl: string;
  readonly checkoutBaseUrl: string;
  readonly payerWallet?: string;
}

export async function submitToNexusCore(
  params: SubmitToNexusParams,
): Promise<SubmitResult> {
  const url = `${params.nexusCoreUrl}/api/orchestrate`;
  const body = {
    quotes: [params.quote],
    ...(params.payerWallet ? { payer_wallet: params.payerWallet } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // 402 PAYMENT_REQUIRED is the normal "group created, awaiting payment" response
  if (!res.ok && res.status !== 402) {
    const errText = await res.text();
    throw new Error(
      `nexus-core orchestrate failed (${res.status}): ${errText}`,
    );
  }

  const data = (await res.json()) as OrchestrateResponse;
  const groupId = data.group_id;
  if (!groupId) {
    throw new Error("nexus-core orchestrate did not return group_id");
  }

  const checkoutUrl =
    data.checkout_url ?? `${params.checkoutBaseUrl}/checkout/${groupId}`;

  return { checkoutUrl, paymentGroupId: groupId };
}

// ---------------------------------------------------------------------------
// Settlement confirmation (fire-and-forget)
// ---------------------------------------------------------------------------

export async function requestNexusSettlement(
  nexusCoreUrl: string,
  paymentId: string,
  merchantDid: string,
): Promise<void> {
  const url = `${nexusCoreUrl}/api/merchant/confirm-fulfillment`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nexus_payment_id: paymentId,
        merchant_did: merchantDid,
      }),
      signal: controller.signal,
    });
    const body = await resp.text();
    console.error(`[NexusSettlement] ${paymentId}: ${resp.status} ${body}`);
  } finally {
    clearTimeout(timer);
  }
}
