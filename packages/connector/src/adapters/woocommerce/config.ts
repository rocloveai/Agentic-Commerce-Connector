// ---------------------------------------------------------------------------
// WooCommerce-specific platform configuration
// ---------------------------------------------------------------------------

export interface WooCommercePlatformConfig {
  readonly baseUrl: string;         // https://store.example.com (no trailing slash)
  readonly consumerKey: string;     // ck_xxx
  readonly consumerSecret: string;  // cs_xxx
  readonly apiVersion: string;      // "wc/v3" (default)
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function validateWooConfig(
  env: Record<string, string | undefined>,
): WooCommercePlatformConfig {
  const baseUrl = env.WOO_BASE_URL;
  if (!baseUrl) {
    throw new Error("[WooConfig] WOO_BASE_URL is required");
  }
  if (!/^https:\/\//.test(baseUrl)) {
    throw new Error(
      "[WooConfig] WOO_BASE_URL must use HTTPS (HTTP Basic auth over plaintext is forbidden)",
    );
  }
  const consumerKey = env.WOO_CONSUMER_KEY;
  if (!consumerKey) {
    throw new Error("[WooConfig] WOO_CONSUMER_KEY is required");
  }
  const consumerSecret = env.WOO_CONSUMER_SECRET;
  if (!consumerSecret) {
    throw new Error("[WooConfig] WOO_CONSUMER_SECRET is required");
  }
  const timeoutRaw = env.WOO_REQUEST_TIMEOUT_MS;
  const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 15000;
  const retriesRaw = env.WOO_MAX_RETRIES;
  const retries = retriesRaw ? parseInt(retriesRaw, 10) : 3;

  return {
    baseUrl: stripTrailingSlash(baseUrl),
    consumerKey,
    consumerSecret,
    apiVersion: env.WOO_API_VERSION ?? "wc/v3",
    requestTimeoutMs:
      isNaN(timeout) || timeout < 1000 || timeout > 60000 ? 15000 : timeout,
    maxRetries: isNaN(retries) || retries < 0 || retries > 10 ? 3 : retries,
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by catalog and merchant clients
// ---------------------------------------------------------------------------

export function buildAuthHeader(cfg: WooCommercePlatformConfig): string {
  const token = Buffer.from(
    `${cfg.consumerKey}:${cfg.consumerSecret}`,
    "utf8",
  ).toString("base64");
  return `Basic ${token}`;
}

export function buildEndpoint(
  cfg: WooCommercePlatformConfig,
  path: string,
): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${cfg.baseUrl}/wp-json/${cfg.apiVersion}${p}`;
}

// ---------------------------------------------------------------------------
// Variant id encoding
//
// WooCommerce variations live under `/products/{parentId}/variations/{varId}`.
// We need both ids to fetch prices, so we encode them into a single opaque
// string that doubles as the UCP / internal variant id.
// ---------------------------------------------------------------------------

const VARIANT_ID_SEPARATOR = ":";

export function encodeVariantId(
  parentId: number,
  variationId: number | null,
): string {
  if (variationId === null) {
    // Simple (non-variable) product — only parent id
    return `woo${VARIANT_ID_SEPARATOR}${parentId}`;
  }
  return `woo${VARIANT_ID_SEPARATOR}${parentId}${VARIANT_ID_SEPARATOR}${variationId}`;
}

export interface DecodedVariantId {
  readonly parentId: number;
  readonly variationId: number | null;
}

export function decodeVariantId(encoded: string): DecodedVariantId | null {
  const parts = encoded.split(VARIANT_ID_SEPARATOR);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "woo") return null;
  const parentId = parseInt(parts[1], 10);
  if (isNaN(parentId)) return null;
  if (parts.length === 2) return { parentId, variationId: null };
  const variationId = parseInt(parts[2], 10);
  if (isNaN(variationId)) return null;
  return { parentId, variationId };
}

// ---------------------------------------------------------------------------
// Pagination cursor encoding (UCP cursor ↔ Woo page number)
// ---------------------------------------------------------------------------

export function encodePageCursor(page: number): string {
  return Buffer.from(JSON.stringify({ p: page }), "utf8").toString(
    "base64url",
  );
}

export function decodePageCursor(cursor: string | null | undefined): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (typeof parsed?.p === "number" && parsed.p >= 1) return parsed.p;
  } catch {
    // fall through
  }
  return 1;
}
