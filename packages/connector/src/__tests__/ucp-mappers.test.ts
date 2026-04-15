import { describe, it, expect } from "vitest";
import type { CommerceProduct } from "../types/commerce.js";
import type { CheckoutSession } from "../types.js";
import {
  commerceProductToUcp,
  checkoutSessionToUcp,
  buildDiscoveryEnvelope,
  moneyToUcp,
} from "../ucp/mappers.js";
import {
  UCP_VERSION,
  UcpProduct,
  UcpCheckoutSession,
  UcpDiscoveryResponse,
} from "../ucp/types.js";

const SAMPLE_PRODUCT: CommerceProduct = {
  id: "gid://shopify/Product/1",
  handle: "test-board",
  title: "Test Board",
  description: "A test product",
  images: [{ url: "https://cdn.example.com/a.jpg", altText: "Front" }],
  variants: [
    {
      id: "gid://shopify/ProductVariant/10",
      title: "Default",
      price: { amount: "99.00", currencyCode: "SGD" },
      availableForSale: true,
      selectedOptions: [{ name: "Size", value: "M" }],
    },
  ],
  priceRange: {
    min: { amount: "99.00", currencyCode: "SGD" },
    max: { amount: "99.00", currencyCode: "SGD" },
  },
};

const SAMPLE_SESSION: CheckoutSession = {
  id: "cs_abc",
  merchant_did: "did:nexus:test",
  store_url: "https://test.example.com",
  line_items: [
    {
      variant_id: "gid://shopify/ProductVariant/10",
      title: "Default",
      quantity: 2,
      unit_price: { amount: "99.00", currency: "SGD" },
      line_total: { amount: "198.00", currency: "SGD" },
    },
  ],
  currency: "SGD",
  subtotal: "198.00",
  token_amount: "198.00",
  rate: "1.000000",
  rate_locked_at: "2026-04-15T10:00:00.000Z",
  rate_expires_at: "2026-04-15T10:15:00.000Z",
  buyer: { email: "buyer@example.com" },
  status: "payment_pending",
  payment_group_id: "pg_xyz",
  order_ref: "SHP-12345",
  tx_hash: null,
  platform_order_id: "101",
  platform_order_name: "#1001",
  completed_at: null,
  created_at: "2026-04-15T10:00:00.000Z",
  updated_at: "2026-04-15T10:00:00.000Z",
};

describe("ucp/mappers", () => {
  it("maps CommerceProduct to UCP product passing schema validation", () => {
    const ucp = commerceProductToUcp(SAMPLE_PRODUCT);
    const parsed = UcpProduct.safeParse(ucp);
    expect(parsed.success).toBe(true);
    expect(ucp.handle).toBe("test-board");
    expect(ucp.price_range.min.currency_code).toBe("SGD");
    expect(ucp.variants[0]?.options).toEqual([{ name: "Size", value: "M" }]);
  });

  it("maps CheckoutSession to UCP checkout-session, mapping status", () => {
    const ucp = checkoutSessionToUcp(SAMPLE_SESSION);
    expect(UcpCheckoutSession.safeParse(ucp).success).toBe(true);
    expect(ucp.status).toBe("ready"); // payment_pending → ready
    expect(ucp.line_items).toHaveLength(1);
    expect(ucp.line_items[0]?.quantity).toBe(2);
    expect(ucp.subtotal?.amount).toBe("198.00");
    expect(ucp.subtotal?.currency_code).toBe("SGD");
  });

  it("builds discovery envelope that validates against schema", () => {
    const envelope = buildDiscoveryEnvelope(
      {
        endpointBase: "https://api.example.com/ucp/v1",
        paymentHandlers: [
          {
            id: "com.nexus.nups",
            version: UCP_VERSION,
            available_instruments: [{ type: "crypto" }],
            config: { protocol: "NUPS/1.5" },
          },
        ],
      },
      {
        name: "Test Store",
        currencyCode: "sgd",
        primaryDomainUrl: "https://test.example.com",
      },
    );

    expect(envelope.ucp.version).toBe(UCP_VERSION);
    expect(envelope.store.currency_code).toBe("SGD"); // uppercased
    expect(envelope.ucp.capabilities).toHaveProperty(
      "dev.ucp.shopping.checkout",
    );
    expect(envelope.ucp.payment_handlers).toHaveProperty("com.nexus");
    expect(UcpDiscoveryResponse.safeParse(envelope).success).toBe(true);
  });

  it("moneyToUcp uppercases currency", () => {
    expect(moneyToUcp("1.00", "usd")).toEqual({
      amount: "1.00",
      currency_code: "USD",
    });
  });
});
