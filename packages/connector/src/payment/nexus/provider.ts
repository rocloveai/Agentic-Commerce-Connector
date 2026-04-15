// ---------------------------------------------------------------------------
// NexusPaymentProvider — adapts the Nexus-specific quote / submit / settle /
// verify code into the generic PaymentProvider interface so the UCP façade
// and future providers can be swapped via config.
// ---------------------------------------------------------------------------

import type {
  PaymentProvider,
  PaymentQuote,
  QuoteParams,
  SubmitResult,
  VerifyResult,
} from "../types.js";
import { buildQuote } from "../../services/quote-builder.js";
import { verifyWebhookSignature } from "../../services/webhook-handler.js";
import {
  submitToNexusCore,
  requestNexusSettlement,
} from "./submit.js";
import type { NexusPaymentConfig } from "./config.js";
import type { UcpPaymentHandlerT } from "../../ucp/types.js";
import { UCP_VERSION } from "../../ucp/types.js";

export interface NexusProvider extends PaymentProvider {
  readonly describe: () => UcpPaymentHandlerT;
}

export function createNexusPaymentProvider(
  cfg: NexusPaymentConfig,
  merchantDid: string,
): NexusProvider {
  return {
    async buildQuote(params: QuoteParams): Promise<PaymentQuote> {
      return buildQuote({
        merchantDid: params.merchantDid,
        orderRef: params.orderRef,
        stablecoinAmount: params.stablecoinAmount,
        currency: params.currency,
        summary: params.summary,
        lineItems: [...params.lineItems],
        payerWallet: params.payerWallet,
        signerPrivateKey: cfg.signerPrivateKey,
        originalAmount: params.originalAmount,
      });
    },

    async submitToPaymentNetwork(
      quote: PaymentQuote,
      payerWallet?: string,
    ): Promise<SubmitResult> {
      return submitToNexusCore({
        quote,
        nexusCoreUrl: cfg.nexusCoreUrl,
        checkoutBaseUrl: cfg.checkoutBaseUrl,
        payerWallet,
      });
    },

    async confirmFulfillment(paymentId: string): Promise<void> {
      await requestNexusSettlement(cfg.nexusCoreUrl, paymentId, merchantDid);
    },

    verifyWebhook(
      rawBody: string,
      signature: string | undefined,
      timestamp: string | undefined,
    ): VerifyResult {
      return verifyWebhookSignature(
        cfg.webhookSecret,
        rawBody,
        signature,
        timestamp,
      );
    },

    describe(): UcpPaymentHandlerT {
      return {
        id: "com.nexus.nups",
        version: UCP_VERSION,
        spec: "https://nexus.platon.network/specs/nups-1.5",
        available_instruments: [{ type: "crypto" }],
        config: {
          protocol: "NUPS/1.5",
          chain_id: cfg.chainId,
          currencies: [cfg.paymentCurrency],
          checkout_base_url: cfg.checkoutBaseUrl,
        },
      };
    },
  };
}
