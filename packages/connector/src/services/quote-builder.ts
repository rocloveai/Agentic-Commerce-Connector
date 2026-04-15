import type { LineItem, NexusQuotePayload } from "../types.js";
import { type Address, type Hex, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface BuildQuoteParams {
  readonly merchantDid: string;
  readonly orderRef: string;
  readonly stablecoinAmount: string;
  readonly currency: string;
  readonly summary: string;
  readonly lineItems: readonly LineItem[];
  readonly payerWallet?: string;
  readonly signerPrivateKey: string;
  readonly originalAmount?: string;
}

const USDC_DECIMALS = 6;
const QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const VERIFYING_CONTRACT =
  "0x0000000000000000000000000000000000000000" as Address;

const NEXUS_DOMAIN = {
  name: "NexusPay",
  version: "1",
  chainId: 20250407,
  verifyingContract: VERIFYING_CONTRACT,
} as const;

const NEXUS_QUOTE_TYPES = {
  NexusQuote: [
    { name: "merchant_did", type: "string" },
    { name: "merchant_order_ref", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "currency", type: "string" },
    { name: "chain_id", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "context_hash", type: "bytes32" },
  ],
} as const;

// Cache the signing account
let cachedAccount: ReturnType<typeof privateKeyToAccount> | null = null;
let cachedKeyHex: string | null = null;

export function toUint256(
  amount: string,
  decimals: number = USDC_DECIMALS,
): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid amount string for toUint256: "${amount}"`);
  }
  const parts = amount.split(".");
  const integerPart = parts[0] ?? "0";
  const fractionalPart = (parts[1] ?? "")
    .padEnd(decimals, "0")
    .slice(0, decimals);
  const raw = integerPart + fractionalPart;
  return raw.replace(/^0+/, "") || "0";
}

export async function buildQuote(
  params: BuildQuoteParams,
): Promise<NexusQuotePayload> {
  const amountUint256 = toUint256(params.stablecoinAmount);
  const lineItemsUint256 = params.lineItems.map((item) => ({
    ...item,
    amount: toUint256(item.amount),
  }));

  const context = {
    summary: params.summary,
    line_items: lineItemsUint256,
    ...(params.originalAmount
      ? { original_amount: toUint256(params.originalAmount) }
      : {}),
    ...(params.payerWallet ? { payer_wallet: params.payerWallet } : {}),
  };

  const contextHash = keccak256(toHex(JSON.stringify(context)));
  const expiry = Math.floor((Date.now() + QUOTE_TTL_MS) / 1000);

  // Reuse cached account
  if (!cachedAccount || cachedKeyHex !== params.signerPrivateKey) {
    cachedAccount = privateKeyToAccount(params.signerPrivateKey as Hex);
    cachedKeyHex = params.signerPrivateKey;
  }

  // Sign with ACTUAL amount (not hardcoded demo amount like flight-agent)
  const signature = await cachedAccount.signTypedData({
    domain: NEXUS_DOMAIN,
    types: NEXUS_QUOTE_TYPES,
    primaryType: "NexusQuote",
    message: {
      merchant_did: params.merchantDid,
      merchant_order_ref: params.orderRef,
      amount: BigInt(amountUint256),
      currency: params.currency,
      chain_id: BigInt(20250407),
      expiry: BigInt(expiry),
      context_hash: contextHash,
    },
  });

  return {
    merchant_did: params.merchantDid,
    merchant_order_ref: params.orderRef,
    amount: amountUint256,
    currency: params.currency,
    chain_id: 20250407,
    expiry,
    context,
    signature,
  };
}
