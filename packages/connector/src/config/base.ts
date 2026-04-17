// ---------------------------------------------------------------------------
// Base configuration — platform- and payment-provider-agnostic settings.
//
// These are the infra-level knobs every instance needs regardless of which
// e-commerce backend or which payment protocol is in use.
// ---------------------------------------------------------------------------

export interface BaseConfig {
  /** DID-style merchant identifier surfaced to payment handlers and webhooks. */
  readonly merchantDid: string;

  /** HTTP port the portal (UCP + MCP + legacy) listens on. */
  readonly portalPort: number;

  /** Postgres connection string. Optional — in-memory store is used if absent. */
  readonly databaseUrl: string;

  /** Publicly reachable URL of this service, used to advertise UCP endpoints. */
  readonly selfUrl: string;

  /** Admin portal token for dashboard / reconciler callbacks. Optional. */
  readonly portalToken: string;

  /** Currency the store prices in (advertised via UCP discovery). */
  readonly paymentCurrency: string;

  /** Fiat→stablecoin fixed rate (MVP — dynamic pricing later). */
  readonly fixedRate: number;

  /** How long a quote's rate stays locked before requiring a refresh. */
  readonly rateLockMinutes: number;

  /** Store URL used by the active adapter (mirrored here for logging). */
  readonly storeUrl: string;

  /**
   * AES-256-GCM hex-encoded key (64 chars = 32 bytes) used to encrypt Shopify
   * admin/storefront tokens at rest. Required only in Shopify OAuth mode;
   * manual-token mode leaves this empty. Cross-validation lives in loadConfig.
   */
  readonly accEncryptionKey: string;

  /**
   * Filesystem path to the skill markdown file the connector self-hosts at
   * `/.well-known/acc-skill.md`. Defaults to `<ACC_DATA_DIR>/skill/acc-skill.md`,
   * matching the `acc init` wizard layout. If the file doesn't exist, the
   * route returns 404; nothing else cares.
   */
  readonly accSkillMdPath: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  if (isNaN(n) || n < 1 || n > 65535) {
    console.error(`[Config] Invalid port "${raw}", using ${fallback}`);
    return fallback;
  }
  return n;
}

export function loadBaseConfig(
  env: Record<string, string | undefined>,
  storeUrl: string,
): BaseConfig {
  return {
    merchantDid: env.MERCHANT_DID ?? "did:example:unknown-merchant",
    portalPort: parsePort(env.PORTAL_PORT, 10000),
    databaseUrl: env.DATABASE_URL ?? "",
    selfUrl: env.SELF_URL || "http://commerce-agent:10000",
    portalToken: env.PORTAL_TOKEN ?? "",
    paymentCurrency: env.PAYMENT_CURRENCY ?? "XSGD",
    fixedRate: parseFloat(env.CHECKOUT_FIXED_RATE ?? "1.00"),
    rateLockMinutes: parseInt(env.CHECKOUT_RATE_LOCK_MINUTES ?? "5", 10),
    storeUrl,
    accEncryptionKey: env.ACC_ENCRYPTION_KEY ?? "",
    accSkillMdPath:
      env.ACC_SKILL_MD_PATH ??
      `${env.ACC_DATA_DIR ?? "./acc-data"}/skill/acc-skill.md`,
  };
}
