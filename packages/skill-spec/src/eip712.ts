import type { Address, Hex } from "viem";
import { recoverTypedDataAddress } from "viem";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "./constants.js";
import type { SkillManifest } from "./types.js";

export const SKILL_EIP712_TYPES = {
  Skill: [
    { name: "merchant_address", type: "address" },
    { name: "platform", type: "string" },
    { name: "ucp_version", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "content_hash", type: "string" },
    { name: "version", type: "string" },
    { name: "published_at", type: "string" },
  ],
} as const;

export interface SkillTypedData {
  domain: {
    name: typeof EIP712_DOMAIN_NAME;
    version: typeof EIP712_DOMAIN_VERSION;
    chainId: number;
  };
  types: typeof SKILL_EIP712_TYPES;
  primaryType: "Skill";
  message: {
    merchant_address: Address;
    platform: string;
    ucp_version: string;
    endpoint: string;
    content_hash: string;
    version: string;
    published_at: string;
  };
}

export function buildSkillTypedData(
  manifest: SkillManifest,
  chainId: number,
): SkillTypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
    },
    types: SKILL_EIP712_TYPES,
    primaryType: "Skill",
    message: {
      merchant_address: manifest.merchant_address,
      platform: manifest.platform,
      ucp_version: manifest.ucp_version,
      endpoint: manifest.endpoint,
      content_hash: manifest.content_hash,
      version: manifest.version,
      published_at: manifest.published_at,
    },
  };
}

export async function recoverSkillSigner(
  manifest: SkillManifest,
  chainId: number,
  signature: Hex,
): Promise<Address> {
  const typedData = buildSkillTypedData(manifest, chainId);
  return recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature,
  });
}
