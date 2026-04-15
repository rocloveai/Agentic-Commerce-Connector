import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createNexusPaymentProvider,
  loadNexusPaymentConfig,
} from "../payment/nexus/index.js";
import { UCP_VERSION, UcpPaymentHandler } from "../ucp/types.js";

const BASE_ENV: Record<string, string> = {
  MERCHANT_SIGNER_PRIVATE_KEY: "0x" + "a".repeat(64),
  MERCHANT_PAYMENT_ADDRESS: "0x" + "b".repeat(40),
  NEXUS_CORE_URL: "https://api.nexus.test",
  CHECKOUT_BASE_URL: "https://checkout.nexus.test",
  WEBHOOK_SECRET: "w".repeat(32),
  PAYMENT_CURRENCY: "XSGD",
  NEXUS_CHAIN_ID: "20250407",
};

describe("NexusPaymentProvider", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("loads config from env, requiring private key and address", () => {
    expect(() => loadNexusPaymentConfig({})).toThrow(
      /MERCHANT_SIGNER_PRIVATE_KEY/,
    );
    expect(() =>
      loadNexusPaymentConfig({
        MERCHANT_SIGNER_PRIVATE_KEY: "0x" + "a".repeat(64),
      }),
    ).toThrow(/MERCHANT_PAYMENT_ADDRESS/);
    expect(() => loadNexusPaymentConfig(BASE_ENV)).not.toThrow();
  });

  it("describe() returns a UCP-valid payment handler", () => {
    const cfg = loadNexusPaymentConfig(BASE_ENV);
    const provider = createNexusPaymentProvider(cfg, "did:nexus:test");
    const handler = provider.describe();

    const parsed = UcpPaymentHandler.safeParse(handler);
    expect(parsed.success).toBe(true);
    expect(handler.id).toBe("com.nexus.nups");
    expect(handler.version).toBe(UCP_VERSION);
    expect(handler.available_instruments?.[0]?.type).toBe("crypto");
    expect(handler.config?.protocol).toBe("NUPS/1.5");
    expect(handler.config?.chain_id).toBe(20250407);
  });

  it("submitToPaymentNetwork POSTs to orchestrate and returns group_id+url", async () => {
    const cfg = loadNexusPaymentConfig(BASE_ENV);
    const provider = createNexusPaymentProvider(cfg, "did:nexus:test");

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.nexus.test/api/orchestrate");
      return new Response(
        JSON.stringify({
          group_id: "pg_abc",
          checkout_url: "https://checkout.nexus.test/checkout/pg_abc",
        }),
        { status: 402 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.submitToPaymentNetwork(
      {
        merchant_did: "did:nexus:test",
        merchant_order_ref: "SHP-1",
        amount: "1000000",
        currency: "XSGD",
        chain_id: 20250407,
        expiry: Math.floor(Date.now() / 1000) + 1800,
        context: { summary: "x", line_items: [] },
        signature: "0x00",
      },
      "0x1234",
    );
    expect(result.paymentGroupId).toBe("pg_abc");
    expect(result.checkoutUrl).toContain("/checkout/pg_abc");
  });

  it("submitToPaymentNetwork throws on non-200/402 response", async () => {
    const cfg = loadNexusPaymentConfig(BASE_ENV);
    const provider = createNexusPaymentProvider(cfg, "did:nexus:test");

    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(
      provider.submitToPaymentNetwork(
        {
          merchant_did: "did:nexus:test",
          merchant_order_ref: "SHP-1",
          amount: "1",
          currency: "XSGD",
          chain_id: 20250407,
          expiry: 0,
          context: { summary: "x", line_items: [] },
          signature: "0x00",
        },
      ),
    ).rejects.toThrow(/orchestrate failed/);
  });

  it("verifyWebhook rejects missing headers", () => {
    const cfg = loadNexusPaymentConfig(BASE_ENV);
    const provider = createNexusPaymentProvider(cfg, "did:nexus:test");
    expect(provider.verifyWebhook("{}", undefined, undefined).valid).toBe(
      false,
    );
  });

  it("buildQuote returns a signed NUPS payload", async () => {
    const cfg = loadNexusPaymentConfig(BASE_ENV);
    const provider = createNexusPaymentProvider(cfg, "did:nexus:test");
    const quote = await provider.buildQuote({
      merchantDid: "did:nexus:test",
      orderRef: "SHP-1",
      stablecoinAmount: "1.00",
      currency: "XSGD",
      summary: "Test",
      lineItems: [{ name: "Item", qty: 1, amount: "1.00" }],
    });
    expect(quote.merchant_did).toBe("did:nexus:test");
    expect(quote.amount).toBe("1000000"); // 6 decimals
    expect(quote.signature.startsWith("0x")).toBe(true);
    expect(quote.signature.length).toBeGreaterThan(130);
  });
});
