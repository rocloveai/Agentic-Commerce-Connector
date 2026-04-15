import type { Address, Hex } from "viem";

export type Sha256Hex = `sha256:${string}`;

export interface SkillManifest {
  spec_version: "acc-skill/1.0";
  merchant_address: Address;
  platform: string;
  ucp_version: string;
  endpoint: string;
  payment_handlers: string[];
  capabilities: string[];
  content_hash: Sha256Hex;
  published_at: string;
  version: string;
}

export interface SkillSignature {
  signer: Address;
  signature: Hex;
  signed_at: string;
}

export interface SkillProfile {
  display_name: string;
  description?: string;
  logo_url?: string;
  category?: string;
  tags?: string[];
  screenshots?: string[];
  social_links?: Record<string, string>;
}

export interface SignedSkillPackage {
  manifest: SkillManifest;
  openapi: unknown;
  tools: unknown[];
  signature: SkillSignature;
  profile?: SkillProfile;
}
