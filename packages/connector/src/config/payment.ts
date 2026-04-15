// ---------------------------------------------------------------------------
// Payment provider configuration (discriminated union).
//
// The active provider is chosen by `PAYMENT_PROVIDER`. Each provider owns its
// own env-var surface, colocated in `src/payment/<provider>/config.ts`. This
// module only handles dispatch + surfaces the resolved fields the legacy
// checkout-session pipeline still reads directly.
// ---------------------------------------------------------------------------

export type PaymentProviderType = "nexus";

export interface NexusPaymentEnv {
  readonly provider: "nexus";
  readonly nexusCoreUrl: string;
  readonly signerPrivateKey: string;
  readonly paymentAddress: string;
  readonly checkoutBaseUrl: string;
  readonly webhookSecret: string;
  readonly chainId: number;
}

export type PaymentEnv = NexusPaymentEnv;

function loadNexusEnv(
  env: Record<string, string | undefined>,
): NexusPaymentEnv {
  const signerPrivateKey = env.MERCHANT_SIGNER_PRIVATE_KEY;
  if (!signerPrivateKey) {
    throw new Error(
      "[Config/Nexus] MERCHANT_SIGNER_PRIVATE_KEY is required. Get it from: the 0x-hex-encoded private key of the wallet that signs NUPS quotes (never the payout wallet).",
    );
  }
  const paymentAddress = env.MERCHANT_PAYMENT_ADDRESS;
  if (!paymentAddress) {
    throw new Error(
      "[Config/Nexus] MERCHANT_PAYMENT_ADDRESS is required. Get it from: the on-chain address that receives settled stablecoin funds.",
    );
  }

  return {
    provider: "nexus",
    nexusCoreUrl: env.NEXUS_CORE_URL || "https://api.nexus.platon.network",
    signerPrivateKey,
    paymentAddress,
    checkoutBaseUrl:
      env.CHECKOUT_BASE_URL || "https://nexus.platon.network",
    webhookSecret: env.NEXUS_WEBHOOK_SECRET ?? env.WEBHOOK_SECRET ?? "",
    chainId: parseInt(env.NEXUS_CHAIN_ID ?? "20250407", 10),
  };
}

export function loadPaymentEnv(
  env: Record<string, string | undefined>,
): PaymentEnv {
  const provider = (env.PAYMENT_PROVIDER ?? "nexus") as PaymentProviderType;
  switch (provider) {
    case "nexus":
      return loadNexusEnv(env);
    default:
      throw new Error(
        `[Config] Unsupported PAYMENT_PROVIDER: "${provider}". Expected "nexus".`,
      );
  }
}
