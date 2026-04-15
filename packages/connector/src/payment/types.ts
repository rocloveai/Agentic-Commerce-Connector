// ---------------------------------------------------------------------------
// Payment provider interface — the contract every payment provider implements.
//
// Nexus Protocol is the default (and currently only) provider.
// The architecture supports adding Stripe ACP, x402, or custom providers.
// ---------------------------------------------------------------------------

export interface PaymentLineItem {
  readonly name: string;
  readonly qty: number;
  readonly amount: string;
}

export interface QuoteParams {
  readonly merchantDid: string;
  readonly orderRef: string;
  readonly stablecoinAmount: string;
  readonly currency: string;
  readonly summary: string;
  readonly lineItems: readonly PaymentLineItem[];
  readonly payerWallet?: string;
  readonly originalAmount?: string;
}

export interface PaymentQuote {
  readonly merchant_did: string;
  readonly merchant_order_ref: string;
  readonly amount: string;
  readonly currency: string;
  readonly chain_id: number;
  readonly expiry: number;
  readonly context: {
    readonly summary: string;
    readonly line_items: readonly PaymentLineItem[];
    readonly original_amount?: string;
    readonly payer_wallet?: string;
  };
  readonly signature: string;
}

export interface SubmitResult {
  readonly checkoutUrl: string;
  readonly paymentGroupId: string;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Webhook event types — generic across providers
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "payment.created"
  | "payment.settled"
  | "payment.expired"
  | "payment.failed"
  | "payment.escrowed"
  | "payment.refunded"
  | "payment.cancelled"
  | "dispute.opened"
  | "dispute.resolved";

export interface WebhookPayload {
  readonly event_id: string;
  readonly event_type: WebhookEventType;
  readonly created_at: string;
  readonly data: {
    readonly payment_id: string;
    readonly merchant_order_ref: string;
    readonly merchant_did: string;
    readonly status: string;
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

// ---------------------------------------------------------------------------
// PaymentProvider — the abstract interface
// ---------------------------------------------------------------------------

export interface PaymentProvider {
  readonly buildQuote: (params: QuoteParams) => Promise<PaymentQuote>;

  readonly submitToPaymentNetwork: (
    quote: PaymentQuote,
    payerWallet?: string,
  ) => Promise<SubmitResult>;

  readonly confirmFulfillment: (paymentId: string) => Promise<void>;

  readonly verifyWebhook: (
    rawBody: string,
    signature: string | undefined,
    timestamp: string | undefined,
  ) => VerifyResult;
}
