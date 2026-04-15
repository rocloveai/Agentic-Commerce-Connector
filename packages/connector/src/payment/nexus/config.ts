// ---------------------------------------------------------------------------
// Nexus PaymentProvider configuration
// ---------------------------------------------------------------------------

export interface NexusPaymentConfig {
  readonly nexusCoreUrl: string;
  readonly signerPrivateKey: string;
  readonly paymentAddress: string;
  readonly checkoutBaseUrl: string;
  readonly webhookSecret: string;
  readonly paymentCurrency: string;
  readonly chainId: number;
}

export function loadNexusPaymentConfig(
  env: Record<string, string | undefined>,
): NexusPaymentConfig {
  const signerPrivateKey = env.MERCHANT_SIGNER_PRIVATE_KEY;
  if (!signerPrivateKey) {
    throw new Error(
      "[NexusPayment] MERCHANT_SIGNER_PRIVATE_KEY is required",
    );
  }
  const paymentAddress = env.MERCHANT_PAYMENT_ADDRESS;
  if (!paymentAddress) {
    throw new Error("[NexusPayment] MERCHANT_PAYMENT_ADDRESS is required");
  }

  return {
    nexusCoreUrl:
      env.NEXUS_CORE_URL || "https://api.nexus.platon.network",
    signerPrivateKey,
    paymentAddress,
    checkoutBaseUrl:
      env.CHECKOUT_BASE_URL || "https://nexus.platon.network",
    webhookSecret: env.NEXUS_WEBHOOK_SECRET ?? env.WEBHOOK_SECRET ?? "",
    paymentCurrency: env.PAYMENT_CURRENCY ?? "XSGD",
    chainId: parseInt(env.NEXUS_CHAIN_ID ?? "20250407", 10),
  };
}
