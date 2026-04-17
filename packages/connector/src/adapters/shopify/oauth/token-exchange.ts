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
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
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

  return { accessToken: body.access_token, scope };
}
