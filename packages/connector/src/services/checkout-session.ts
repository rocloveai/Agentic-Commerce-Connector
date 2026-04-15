import type { Config } from "../config.js";
import type {
  CheckoutSession,
  ResolvedLineItem,
  ShippingAddress,
  CommerceVariant,
} from "../types.js";
import type { CatalogAdapter, MerchantAdapter } from "../adapters/types.js";
import { convertToStablecoin } from "./rate-service.js";
import { buildQuote } from "./quote-builder.js";
import { newOrderRef, createOrder } from "./order-store.js";
import {
  newSessionId,
  createSession,
  getSession,
  updateSession,
} from "./db/session-repo.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckoutItem {
  readonly variant_id: string;
  readonly quantity: number;
}

interface CreateCheckoutParams {
  readonly items: readonly CheckoutItem[];
  readonly buyerEmail?: string;
  readonly payerWallet?: string;
  readonly shippingAddress?: ShippingAddress;
}

interface CheckoutResult {
  readonly session: CheckoutSession;
  readonly checkout_url: string;
}

// ---------------------------------------------------------------------------
// Create Checkout Session
// ---------------------------------------------------------------------------

export async function createCheckoutSession(
  params: CreateCheckoutParams,
  catalog: CatalogAdapter,
  config: Config,
  merchant?: MerchantAdapter | null,
): Promise<CheckoutResult> {
  if (params.items.length === 0) {
    throw new Error("At least one item is required");
  }

  // 1. Fetch real-time variant prices from platform
  const variantIds = params.items.map((i) => i.variant_id);
  const variants = await catalog.getVariantPrices(variantIds);

  // Build variant lookup
  const variantMap = new Map<string, CommerceVariant>();
  for (const v of variants) {
    variantMap.set(v.id, v);
  }

  // 2. Resolve line items with real prices
  const lineItems: ResolvedLineItem[] = [];
  let subtotalCents = 0;
  let currency = "";

  for (const item of params.items) {
    const variant = variantMap.get(item.variant_id);
    if (!variant) {
      throw new Error(`Variant "${item.variant_id}" not found`);
    }
    if (!variant.availableForSale) {
      throw new Error(`Variant "${variant.title}" is sold out`);
    }

    const unitPrice = parseFloat(variant.price.amount);
    const lineTotal = unitPrice * item.quantity;
    subtotalCents += Math.round(lineTotal * 100);

    if (!currency) {
      currency = variant.price.currencyCode;
    }

    lineItems.push({
      variant_id: variant.id,
      title: variant.title,
      quantity: item.quantity,
      unit_price: {
        amount: variant.price.amount,
        currency: variant.price.currencyCode,
      },
      line_total: {
        amount: lineTotal.toFixed(2),
        currency: variant.price.currencyCode,
      },
    });
  }

  const subtotal = (subtotalCents / 100).toFixed(2);

  // 3. Convert fiat → stablecoin (SGD→XSGD or USD→USDC)
  const rateResult = convertToStablecoin(subtotal, currency, config);

  // 4. Build EIP-712 quote
  const orderRef = newOrderRef();
  const summary = lineItems
    .map((li) => `${li.title} x${li.quantity}`)
    .join(", ");

  const quote = await buildQuote({
    merchantDid: config.merchantDid,
    orderRef,
    stablecoinAmount: rateResult.stablecoinAmount,
    currency: config.paymentCurrency,
    summary,
    lineItems: lineItems.map((li) => ({
      name: li.title,
      qty: li.quantity,
      amount: li.line_total.amount,
    })),
    originalAmount: subtotal,
    payerWallet: params.payerWallet,
    signerPrivateKey: config.signerPrivateKey,
  });

  // 5. Call nexus-core /api/orchestrate
  const orchestrateUrl = `${config.nexusCoreUrl}/api/orchestrate`;
  const orchestrateBody = {
    quotes: [quote],
    ...(params.payerWallet ? { payer_wallet: params.payerWallet } : {}),
  };

  const orchestrateRes = await fetch(orchestrateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orchestrateBody),
  });

  // 402 = PAYMENT_REQUIRED is the normal "group created, awaiting payment" response
  if (!orchestrateRes.ok && orchestrateRes.status !== 402) {
    const errText = await orchestrateRes.text();
    throw new Error(
      `nexus-core orchestrate failed (${orchestrateRes.status}): ${errText}`,
    );
  }

  const orchestrateData = (await orchestrateRes.json()) as {
    group_id?: string;
    checkout_url?: string;
  };

  const groupId = orchestrateData.group_id;
  const checkoutUrl =
    orchestrateData.checkout_url ??
    `${config.checkoutBaseUrl}/checkout/${groupId}`;

  // 6. Create local order record
  await createOrder(quote);

  // 7. Create checkout session (build object first for platform order pre-creation)
  const now = new Date().toISOString();
  const sessionId = newSessionId();

  let platformOrderId: string | null = null;
  let platformOrderName: string | null = null;

  const sessionBase: CheckoutSession = {
    id: sessionId,
    merchant_did: config.merchantDid,
    store_url: config.storeUrl,
    line_items: lineItems,
    currency,
    subtotal,
    token_amount: rateResult.stablecoinAmount,
    rate: rateResult.rate,
    rate_locked_at: rateResult.lockedAt,
    rate_expires_at: rateResult.expiresAt,
    buyer:
      params.buyerEmail || params.shippingAddress
        ? {
            ...(params.buyerEmail ? { email: params.buyerEmail } : {}),
            ...(params.shippingAddress
              ? { shipping_address: params.shippingAddress }
              : {}),
          }
        : null,
    status: "payment_pending",
    payment_group_id: groupId ?? null,
    order_ref: orderRef,
    tx_hash: null,
    platform_order_id: null,
    platform_order_name: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };

  // 8. Pre-create PENDING order on platform (so merchant sees it immediately)
  if (merchant) {
    try {
      const orderResult = await merchant.createOrder(sessionBase, {
        financialStatus: "PENDING",
      });
      platformOrderId = orderResult.platformOrderId;
      platformOrderName = orderResult.platformOrderName;
      console.error(
        `[Checkout] Pre-created platform order ${platformOrderName} (PENDING) for session ${sessionId}`,
      );
    } catch (err) {
      console.error(
        `[Checkout] Failed to pre-create platform order (non-fatal):`,
        err,
      );
    }
  }

  const session: CheckoutSession = {
    ...sessionBase,
    platform_order_id: platformOrderId,
    platform_order_name: platformOrderName,
  };

  await createSession(session);

  return { session, checkout_url: checkoutUrl };
}

// ---------------------------------------------------------------------------
// Get Checkout Status
// ---------------------------------------------------------------------------

export async function getCheckoutStatus(
  sessionId: string,
): Promise<CheckoutSession | null> {
  return getSession(sessionId);
}
