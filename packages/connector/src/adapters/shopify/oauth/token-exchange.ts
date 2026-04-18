// ---------------------------------------------------------------------------
// Shopify token exchange — swap the one-time `code` returned on the callback
// for an offline Admin API access token.
//
// Pure function w/ injectable fetch so integration tests can stub Shopify's
// response without a real network.
// ---------------------------------------------------------------------------

export interface TokenExchangeResponse {
  readonly accessToken: string;
  readonly scope: readonly string[];
  /**
   * Absolute unix-seconds timestamp at which `accessToken` expires. `null`
   * for non-expiring offline tokens (legacy apps). Expiring offline tokens
   * set by Shopify for new apps typically ship with `expires_in` around
   * 86400s; `expires_at = now + expires_in` is the persisted form.
   */
  readonly expiresAt: number | null;
  /**
   * Refresh token returned alongside an expiring offline token. Used with
   * `urn:ietf:params:oauth:grant-type:refresh_token` at
   * `/admin/oauth/access_token` to mint a fresh access token without a user
   * re-authorizing. `null` for non-expiring tokens.
   */
  readonly refreshToken: string | null;
}

export interface TokenExchangeOptions {
  readonly shopDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly fetchImpl?: typeof fetch;
}

export async function exchangeCodeForToken(
  opts: TokenExchangeOptions,
): Promise<TokenExchangeResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "[Shopify/OAuth] global fetch not available and no fetchImpl provided.",
    );
  }

  const endpoint = `https://${opts.shopDomain}/admin/oauth/access_token`;
  // Shopify's December 2025 policy: offline access tokens must be expiring
  // (expires_in + refresh_token) to be accepted by the Admin API. We must
  // explicitly opt in with `expiring=1` in the code-exchange POST body;
  // omitting it returns a deprecated non-expiring token that Admin API
  // rejects with 403.
  // Shopify also expects application/x-www-form-urlencoded here (JSON is
  // tolerated but their docs recommend form).
  const reqBody = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    expiring: "1",
  });
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: reqBody.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[Shopify/OAuth] token exchange failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  const body = (await res.json()) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!body.access_token || typeof body.access_token !== "string") {
    throw new Error(
      "[Shopify/OAuth] token exchange response missing access_token",
    );
  }

  const scope = (body.scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? nowSec + body.expires_in
      : null;
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : null;

  // One-shot diagnostic. Helps operators see whether Shopify returned an
  // expiring offline token (new app policy) or a non-expiring one (legacy).
  // Token values themselves are never logged.
  console.error(
    `[Shopify/OAuth] token exchange ok for ${opts.shopDomain}: scopes=${scope.length}, expires_in=${body.expires_in ?? "none"}, refresh_token=${refreshToken ? "present" : "absent"}`,
  );

  return { accessToken: body.access_token, scope, expiresAt, refreshToken };
}

/**
 * Refresh an expiring offline access token. Returns a fresh access token
 * (and a new refresh token, per Shopify's semantics — the old refresh
 * token is single-use). The caller is responsible for persisting the new
 * values atomically alongside the old installation row.
 */
export async function refreshAccessToken(opts: {
  readonly shopDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<TokenExchangeResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "[Shopify/OAuth] global fetch not available and no fetchImpl provided.",
    );
  }
  const endpoint = `https://${opts.shopDomain}/admin/oauth/access_token`;
  const reqBody = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: reqBody.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[Shopify/OAuth] refresh failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!body.access_token) {
    throw new Error("[Shopify/OAuth] refresh response missing access_token");
  }
  const scope = (body.scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    accessToken: body.access_token,
    scope,
    expiresAt:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? nowSec + body.expires_in
        : null,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
  };
}
