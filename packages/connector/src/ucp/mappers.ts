// ---------------------------------------------------------------------------
// UCP ↔ internal type mapping
//
// Internal types (CommerceProduct, CheckoutSession) are platform-neutral but
// NUPS-shaped. This layer translates them to/from the UCP/1.0 wire shape so
// the rest of the codebase does not need to know UCP.
// ---------------------------------------------------------------------------

import type {
  CommerceImage,
  CommerceProduct,
  CommerceVariant,
  StoreMeta,
} from "../types/commerce.js";
import type { CheckoutSession, ResolvedLineItem } from "../types.js";
import {
  UCP_VERSION,
  type UcpEnvelopeT,
  type UcpCheckoutSessionT,
  type UcpLineItemT,
  type UcpMoneyT,
  type UcpPaymentHandlerT,
  type UcpProductT,
  type UcpProductVariantT,
} from "./types.js";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function moneyToUcp(amount: string, currencyCode: string): UcpMoneyT {
  return { amount, currency_code: currencyCode.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

function imageToUcp(img: CommerceImage): {
  readonly url: string;
  readonly alt: string | null;
} {
  return { url: img.url, alt: img.altText };
}

function variantToUcp(v: CommerceVariant): UcpProductVariantT {
  return {
    id: v.id,
    title: v.title,
    price: moneyToUcp(v.price.amount, v.price.currencyCode),
    available: v.availableForSale,
    options: v.selectedOptions.map((o) => ({ name: o.name, value: o.value })),
    sku: v.sku ?? null,
    inventory_quantity: v.inventoryQuantity ?? null,
  };
}

export function commerceProductToUcp(p: CommerceProduct): UcpProductT {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    brand: p.brand ?? null,
    images: p.images.map(imageToUcp),
    variants: p.variants.map(variantToUcp),
    price_range: {
      min: moneyToUcp(p.priceRange.min.amount, p.priceRange.min.currencyCode),
      max: moneyToUcp(p.priceRange.max.amount, p.priceRange.max.currencyCode),
    },
  };
}

// ---------------------------------------------------------------------------
// Checkout session
// ---------------------------------------------------------------------------

function lineItemToUcp(li: ResolvedLineItem): UcpLineItemT {
  return {
    id: li.variant_id,
    quantity: li.quantity,
    unit_price: moneyToUcp(li.unit_price.amount, li.unit_price.currency),
    line_total: moneyToUcp(li.line_total.amount, li.line_total.currency),
  };
}

const STATUS_MAP: Record<
  CheckoutSession["status"],
  UcpCheckoutSessionT["status"]
> = {
  created: "incomplete",
  rate_locked: "ready",
  rate_expired: "incomplete",
  payment_pending: "ready",
  completed: "completed",
  cancelled: "cancelled",
};

export function checkoutSessionToUcp(
  session: CheckoutSession,
): UcpCheckoutSessionT {
  return {
    id: session.id,
    status: STATUS_MAP[session.status],
    line_items: session.line_items.map(lineItemToUcp),
    subtotal: moneyToUcp(session.subtotal, session.currency),
    currency_code: session.currency.toUpperCase(),
    buyer: session.buyer?.email ? { email: session.buyer.email } : undefined,
    shipping_address: session.buyer?.shipping_address,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

export interface BuildEnvelopeOpts {
  readonly endpointBase: string; // e.g. "https://api.example.com/ucp/v1"
  readonly paymentHandlers: readonly UcpPaymentHandlerT[];
  readonly capabilities?: readonly string[];
}

export function buildDiscoveryEnvelope(
  opts: BuildEnvelopeOpts,
  storeMeta: StoreMeta,
): {
  readonly ucp: UcpEnvelopeT;
  readonly store: {
    readonly name: string;
    readonly currency_code: string;
    readonly primary_domain: string;
  };
} {
  const caps = opts.capabilities ?? [
    "dev.ucp.shopping.catalog",
    "dev.ucp.shopping.checkout",
    "dev.ucp.shopping.order",
  ];

  const capabilities: Record<string, Array<{ version: string }>> = {};
  for (const c of caps) capabilities[c] = [{ version: UCP_VERSION }];

  const paymentHandlers: Record<string, UcpPaymentHandlerT[]> = {};
  for (const h of opts.paymentHandlers) {
    const key = h.id.split(".").slice(0, -1).join(".") || h.id;
    const bucket = paymentHandlers[key] ?? [];
    bucket.push(h);
    paymentHandlers[key] = bucket;
  }

  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [
          {
            version: UCP_VERSION,
            transport: "rest",
            endpoint: opts.endpointBase,
          },
        ],
      },
      capabilities,
      payment_handlers: paymentHandlers,
    },
    store: {
      name: storeMeta.name,
      currency_code: storeMeta.currencyCode.toUpperCase(),
      primary_domain: storeMeta.primaryDomainUrl,
    },
  };
}

export function buildMinimalEnvelope(): UcpEnvelopeT {
  return {
    version: UCP_VERSION,
    capabilities: {
      "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
    },
  };
}
