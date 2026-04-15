/**
 * NexusPay Core types — merchant-facing subset.
 *
 * Source of truth: src/nexus-core/src/types.ts
 * This is a copy of the types merchants need. Keep in sync manually
 * until nexus-core is published as an npm package.
 */

export type PaymentStatus =
  | "CREATED"
  | "AWAITING_TX"
  | "BROADCASTED"
  | "SETTLED"
  | "COMPLETED"
  | "EXPIRED"
  | "TX_FAILED"
  | "RISK_REJECTED"
  | "ESCROWED"
  | "REFUNDED"
  | "DISPUTE_OPEN"
  | "DISPUTE_RESOLVED"
  | "CANCELLED";

export type PaymentMethod = "DIRECT_TRANSFER" | "ESCROW_CONTRACT";

export type WebhookEventType =
  | "payment.created"
  | "payment.settled"
  | "payment.expired"
  | "payment.failed"
  | "payment.escrowed"
  | "payment.refunded"
  | "dispute.opened"
  | "dispute.resolved"
  | "payment.cancelled";

export interface LineItem {
  readonly name: string;
  readonly qty: number;
  readonly amount: string;
}

export interface NexusQuotePayload {
  readonly merchant_did: string;
  readonly merchant_order_ref: string;
  readonly amount: string;
  readonly currency: string;
  readonly chain_id: number;
  readonly expiry: number;
  readonly payment_method?: PaymentMethod;
  readonly context: {
    readonly summary: string;
    readonly line_items: readonly LineItem[];
    readonly original_amount?: string;
    readonly payer_wallet?: string;
  };
  readonly signature: string;
}

export interface WebhookPayload {
  readonly event_id: string;
  readonly event_type: WebhookEventType;
  readonly created_at: string;
  readonly data: {
    readonly nexus_payment_id: string;
    readonly merchant_order_ref: string;
    readonly merchant_did: string;
    readonly status: PaymentStatus;
    readonly amount: string;
    readonly amount_display: string;
    readonly currency: string;
    readonly chain_id: number;
    readonly payer_wallet: string;
    readonly settlement?: {
      readonly tx_hash: string;
      readonly block_number: number;
      readonly block_timestamp: string;
      readonly payment_address: string;
    };
  };
}
