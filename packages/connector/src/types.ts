// ---------------------------------------------------------------------------
// Public type re-exports
// ---------------------------------------------------------------------------

// Commerce types (platform-agnostic)
export type {
  CommerceImage,
  CommerceVariant,
  CommerceProduct,
  ProductSearchResult,
  StoreMeta,
} from "./types/commerce.js";

// Backward-compatible aliases (remove in Phase 2 when Shopify adapter is isolated)
import type {
  CommerceImage,
  CommerceVariant,
  CommerceProduct,
  StoreMeta,
} from "./types/commerce.js";
export type ShopifyImage = CommerceImage;
export type ShopifyVariant = CommerceVariant;
export type ShopifyProduct = CommerceProduct;
export type ShopMetadata = StoreMeta;

// Payment provider types
export type {
  PaymentLineItem,
  PaymentQuote,
  SubmitResult,
  WebhookEventType,
  WebhookPayload,
  PaymentProvider,
} from "./payment/types.js";

// Backward-compatible aliases for nexus-core types
import type {
  PaymentLineItem,
  PaymentQuote,
  WebhookEventType as _WebhookEventType,
  WebhookPayload as _WebhookPayload,
} from "./payment/types.js";
export type LineItem = PaymentLineItem;
export type NexusQuotePayload = PaymentQuote;
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

// Adapter interfaces
export type {
  CatalogAdapter,
  MerchantAdapter,
  OrderCreateResult,
  OrderCreateOpts,
  AdapterPair,
} from "./adapters/types.js";

// ---------------------------------------------------------------------------
// Order types
// ---------------------------------------------------------------------------

export type OrderStatus = "UNPAID" | "PAID" | "EXPIRED" | "CANCELLED";

export interface Order {
  readonly order_ref: string;
  readonly status: OrderStatus;
  readonly quote_payload: PaymentQuote;
  readonly payer_wallet?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Shipping address
// ---------------------------------------------------------------------------

export interface ShippingAddress {
  readonly first_name: string;
  readonly last_name: string;
  readonly address1: string;
  readonly address2?: string;
  readonly city: string;
  readonly province?: string;
  readonly country: string;
  readonly zip: string;
  readonly phone?: string;
}

// ---------------------------------------------------------------------------
// Checkout session types
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "created"
  | "rate_locked"
  | "rate_expired"
  | "payment_pending"
  | "completed"
  | "cancelled";

export interface ResolvedLineItem {
  readonly variant_id: string;
  readonly title: string;
  readonly quantity: number;
  readonly unit_price: { readonly amount: string; readonly currency: string };
  readonly line_total: { readonly amount: string; readonly currency: string };
}

export interface CheckoutSession {
  readonly id: string;
  readonly merchant_did: string;
  readonly store_url: string;
  readonly line_items: readonly ResolvedLineItem[];
  readonly currency: string;
  readonly subtotal: string;
  readonly token_amount: string | null;
  readonly rate: string | null;
  readonly rate_locked_at: string | null;
  readonly rate_expires_at: string | null;
  readonly buyer: {
    readonly email?: string;
    readonly shipping_address?: ShippingAddress;
  } | null;
  readonly status: SessionStatus;
  readonly payment_group_id: string | null;
  readonly order_ref: string | null;
  readonly tx_hash: string | null;
  readonly platform_order_id: string | null;
  readonly platform_order_name: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
