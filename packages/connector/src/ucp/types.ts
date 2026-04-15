// ---------------------------------------------------------------------------
// UCP/1.0 (2026-04-08) — type & schema definitions
//
// Aligns with https://ucp.dev/specification/overview.
// Envelope is capability-based, not a fixed 5-stage lifecycle. All responses
// that advertise UCP capabilities carry a top-level `ucp` envelope. Resource
// payloads live as sibling fields (e.g. checkout-session fields).
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

export const UCP_VERSION = "2026-04-08" as const;
export const CAP_CHECKOUT = "dev.ucp.shopping.checkout" as const;
export const CAP_CATALOG = "dev.ucp.shopping.catalog" as const;
export const CAP_ORDER = "dev.ucp.shopping.order" as const;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const UcpServiceEntry = z.object({
  version: z.string(),
  spec: z.string().url().optional(),
  transport: z.enum(["rest", "mcp", "a2a", "embedded"]),
  endpoint: z.string().url(),
  schema: z.string().url().optional(),
});

export const UcpCapabilityEntry = z.object({
  version: z.string(),
  spec: z.string().url().optional(),
  schema: z.string().url().optional(),
  extends: z.union([z.string(), z.array(z.string())]).optional(),
});

export const UcpPaymentInstrument = z.object({
  type: z.enum(["card", "wallet", "crypto", "bank_transfer"]),
});

export const UcpPaymentHandler = z.object({
  id: z.string(),
  version: z.string(),
  spec: z.string().url().optional(),
  schema: z.string().url().optional(),
  available_instruments: z.array(UcpPaymentInstrument).optional(),
  config: z.record(z.unknown()).optional(),
});

export const UcpSigningKey = z.object({
  kid: z.string(),
  kty: z.string(),
  crv: z.string().optional(),
  use: z.string().optional(),
  alg: z.string().optional(),
});

export const UcpEnvelope = z.object({
  version: z.string(),
  services: z.record(z.array(UcpServiceEntry)).optional(),
  capabilities: z.record(z.array(UcpCapabilityEntry)).optional(),
  payment_handlers: z.record(z.array(UcpPaymentHandler)).optional(),
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const UcpDiscoveryResponse = z.object({
  ucp: UcpEnvelope,
  signing_keys: z.array(UcpSigningKey).optional(),
  store: z
    .object({
      name: z.string(),
      currency_code: z.string().length(3),
      primary_domain: z.string().url(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Catalog — Search / Lookup
// ---------------------------------------------------------------------------

export const UcpMoney = z.object({
  amount: z.string(), // decimal string, e.g. "12.34"
  currency_code: z.string().length(3),
});

export const UcpProductVariant = z.object({
  id: z.string(),
  sku: z.string().nullable().optional(),
  title: z.string(),
  price: UcpMoney,
  available: z.boolean(),
  inventory_quantity: z.number().int().nullable().optional(),
  options: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});

export const UcpProduct = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  description: z.string(),
  brand: z.string().nullable().optional(),
  images: z
    .array(z.object({ url: z.string().url(), alt: z.string().nullable() }))
    .default([]),
  variants: z.array(UcpProductVariant),
  price_range: z.object({ min: UcpMoney, max: UcpMoney }),
});

export const UcpSearchRequest = z.object({
  query: z.string().optional().default(""),
  first: z.number().int().min(1).max(50).optional().default(20),
  after: z.string().nullable().optional(),
});

export const UcpPageInfo = z.object({
  has_next_page: z.boolean(),
  end_cursor: z.string().nullable(),
});

export const UcpSearchResponse = z.object({
  ucp: UcpEnvelope,
  items: z.array(UcpProduct),
  page_info: UcpPageInfo,
});

// ---------------------------------------------------------------------------
// Checkout — sessions resource
//
// POST /ucp/v1/checkout-sessions              create
// GET  /ucp/v1/checkout-sessions/{id}         retrieve
// PATCH /ucp/v1/checkout-sessions/{id}        update (line items / address)
// POST /ucp/v1/checkout-sessions/{id}/complete  finalize → payment link
// ---------------------------------------------------------------------------

export const UcpLineItem = z.object({
  id: z.string(), // variant id
  quantity: z.number().int().min(1),
  unit_price: UcpMoney.optional(), // server-computed on create/update
  line_total: UcpMoney.optional(),
});

export const UcpBuyer = z.object({
  email: z.string().email().optional(),
  wallet_address: z.string().optional(),
});

export const UcpShippingAddress = z.object({
  first_name: z.string(),
  last_name: z.string(),
  address1: z.string(),
  address2: z.string().optional(),
  city: z.string(),
  province: z.string().optional(),
  country: z.string(),
  zip: z.string(),
  phone: z.string().optional(),
});

export const UcpCheckoutStatus = z.enum([
  "incomplete",
  "ready",
  "completed",
  "cancelled",
  "expired",
]);

export const UcpCheckoutSession = z.object({
  id: z.string(),
  status: UcpCheckoutStatus,
  line_items: z.array(UcpLineItem),
  subtotal: UcpMoney.optional(),
  currency_code: z.string().length(3).optional(),
  buyer: UcpBuyer.optional(),
  shipping_address: UcpShippingAddress.optional(),
  expires_at: z.string().datetime().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const UcpCheckoutCreateRequest = z.object({
  line_items: z
    .array(
      z.object({
        id: z.string(),
        quantity: z.number().int().min(1),
      }),
    )
    .min(1),
  buyer: UcpBuyer.optional(),
  shipping_address: UcpShippingAddress.optional(),
});

export const UcpCheckoutUpdateRequest = UcpCheckoutCreateRequest.partial();

export const UcpCheckoutResponse = z.object({
  ucp: UcpEnvelope,
  ...UcpCheckoutSession.shape,
});

// ---------------------------------------------------------------------------
// Complete checkout (payment redirect / escalation)
// ---------------------------------------------------------------------------

export const UcpCheckoutMessage = z.object({
  type: z.enum(["info", "warning", "error"]),
  code: z.string(),
  content: z.string(),
  severity: z
    .enum(["info", "requires_buyer_input", "fatal"])
    .optional(),
});

export const UcpCheckoutCompleteResponse = z.object({
  status: z.enum(["success", "requires_escalation", "failed"]),
  messages: z.array(UcpCheckoutMessage).optional(),
  continue_url: z.string().url().optional(), // payment redirect (3DS / wallet approval / checkout page)
  payment_id: z.string().optional(),
  expires_at: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Order (attribution + webhook events)
// ---------------------------------------------------------------------------

export const UcpOrderStatus = z.enum([
  "pending",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
]);

export const UcpOrder = z.object({
  id: z.string(),
  status: UcpOrderStatus,
  checkout_session_id: z.string(),
  platform_order_id: z.string().optional(),
  platform_order_name: z.string().optional(),
  total: UcpMoney,
  transaction_id: z.string().nullable().optional(), // payment handler's tx ref (e.g. tx hash)
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const UcpOrderAttributionEvent = z.object({
  event: z.enum(["order.created", "order.paid", "order.fulfilled", "order.cancelled"]),
  occurred_at: z.string().datetime(),
  order: UcpOrder,
});

// ---------------------------------------------------------------------------
// Error envelope (UCP-style)
// ---------------------------------------------------------------------------

export const UcpError = z.object({
  code: z.string(),
  content: z.string(),
  continue_url: z.string().url().optional(),
});

export const UcpErrorResponse = z.object({
  ucp: z
    .object({
      version: z.string(),
      status: z.literal("error").optional(),
    })
    .optional(),
  error: UcpError,
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type UcpEnvelopeT = z.infer<typeof UcpEnvelope>;
export type UcpDiscoveryResponseT = z.infer<typeof UcpDiscoveryResponse>;
export type UcpProductT = z.infer<typeof UcpProduct>;
export type UcpProductVariantT = z.infer<typeof UcpProductVariant>;
export type UcpMoneyT = z.infer<typeof UcpMoney>;
export type UcpPageInfoT = z.infer<typeof UcpPageInfo>;
export type UcpSearchRequestT = z.infer<typeof UcpSearchRequest>;
export type UcpSearchResponseT = z.infer<typeof UcpSearchResponse>;
export type UcpLineItemT = z.infer<typeof UcpLineItem>;
export type UcpCheckoutSessionT = z.infer<typeof UcpCheckoutSession>;
export type UcpCheckoutCreateRequestT = z.infer<typeof UcpCheckoutCreateRequest>;
export type UcpCheckoutUpdateRequestT = z.infer<typeof UcpCheckoutUpdateRequest>;
export type UcpCheckoutResponseT = z.infer<typeof UcpCheckoutResponse>;
export type UcpCheckoutCompleteResponseT = z.infer<typeof UcpCheckoutCompleteResponse>;
export type UcpOrderT = z.infer<typeof UcpOrder>;
export type UcpOrderAttributionEventT = z.infer<typeof UcpOrderAttributionEvent>;
export type UcpErrorT = z.infer<typeof UcpError>;
export type UcpErrorResponseT = z.infer<typeof UcpErrorResponse>;
export type UcpPaymentHandlerT = z.infer<typeof UcpPaymentHandler>;
export type UcpShippingAddressT = z.infer<typeof UcpShippingAddress>;
export type UcpBuyerT = z.infer<typeof UcpBuyer>;

// ---------------------------------------------------------------------------
// UCP error codes used by this implementation
// ---------------------------------------------------------------------------

export const UCP_ERR = {
  INVALID_REQUEST: "invalid_request",
  CART_TOKEN_INVALID: "cart_token_invalid",
  CART_TOKEN_EXPIRED: "cart_token_expired",
  CHECKOUT_NOT_FOUND: "checkout_not_found",
  CHECKOUT_LOCKED: "checkout_locked",
  PRODUCT_NOT_FOUND: "product_not_found",
  VARIANT_UNAVAILABLE: "variant_unavailable",
  PAYMENT_PROVIDER_UNAVAILABLE: "payment_provider_unavailable",
  ORDER_NOT_FOUND: "order_not_found",
  INTERNAL: "internal_error",
} as const;
