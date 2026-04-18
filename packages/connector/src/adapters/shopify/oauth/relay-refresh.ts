// ---------------------------------------------------------------------------
// Refresh admin tokens via the shared install-relay.
//
// Context: When ACC is installed via the shared Shopify Partners app
// (v0.7+), the app's `client_secret` lives only on the relay at
// `install.xagenpay.com`, not on the merchant's server. So the merchant
// connector can't call Shopify's refresh_token grant directly — the
// relay does it on behalf of the merchant, via POST /pair/refresh.
//
// If the merchant has chosen Custom-App mode (their own Partners app
// with client_secret in their own .env), this module is NOT used;
// instead the connector's token-exchange.ts::refreshAccessToken() is
// called directly against Shopify.
// ---------------------------------------------------------------------------

export interface RelayRefreshOptions {
  readonly relayUrl: string;        // e.g. https://install.xagenpay.com
  readonly shopDomain: string;      // e.g. xxx.myshopify.com
  readonly refreshToken: string;    // current shprt_...
  readonly fetchImpl?: typeof fetch;
}

export interface RelayRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null; // unix seconds
  readonly scopes: readonly string[] | null; // null if relay omitted (unchanged)
}

export class RelayRefreshRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRefreshRejected";
  }
}

/**
 * Call install.xagenpay.com/pair/refresh with the current refresh token.
 * Returns the new access_token + rotated refresh_token + new expires_at.
 *
 * Throws `RelayRefreshRejected` on HTTP 401 (refresh-token dead, merchant
 * must reinstall). Throws generic Error on network/upstream failures.
 */
export async function refreshViaRelay(
  opts: RelayRefreshOptions,
): Promise<RelayRefreshResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "[RelayRefresh] global fetch not available; pass fetchImpl.",
    );
  }
  const endpoint = `${opts.relayUrl.replace(/\/+$/, "")}/pair/refresh`;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      shop: opts.shopDomain,
      refresh_token: opts.refreshToken,
    }),
  });
  const rawText = await res.text().catch(() => "");
  if (res.status === 401) {
    throw new RelayRefreshRejected(
      `[RelayRefresh] refresh rejected: ${rawText.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[RelayRefresh] relay returned ${res.status}: ${rawText.slice(0, 300)}`,
    );
  }
  let body: {
    admin_token?: string;
    refresh_token?: string | null;
    expires_at?: number | null;
    scopes?: readonly string[];
  };
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`[RelayRefresh] non-JSON body: ${rawText.slice(0, 200)}`);
  }
  if (!body.admin_token) {
    throw new Error("[RelayRefresh] response missing admin_token");
  }
  return {
    accessToken: body.admin_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: typeof body.expires_at === "number" ? body.expires_at : null,
    scopes: body.scopes && body.scopes.length > 0 ? body.scopes : null,
  };
}
