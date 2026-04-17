// ---------------------------------------------------------------------------
// Generic Shopify Admin GraphQL caller.
//
// Post a single mutation/query against `https://{shop}/admin/api/{ver}/graphql.json`
// authenticated with the per-shop Admin access token minted at OAuth install.
// This module is stateless — it takes the shop domain + admin token per call
// so it's trivial to use from both the install-time callback path and any
// future per-shop operations.
//
// Separate file from the old `admin-client.ts` because that one is keyed to
// the env-based manual-mode token; OAuth mode's tokens live in the
// installation store and get passed in explicitly per request.
// ---------------------------------------------------------------------------

export interface AdminGraphqlOptions<TVars> {
  readonly shopDomain: string;
  readonly apiVersion: string;
  readonly adminToken: string;
  readonly query: string;
  readonly variables?: TVars;
  readonly fetchImpl?: typeof fetch;
}

export interface AdminGraphqlResponse<TData> {
  readonly data?: TData;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

export async function adminGraphql<TData, TVars = Record<string, unknown>>(
  opts: AdminGraphqlOptions<TVars>,
): Promise<AdminGraphqlResponse<TData>> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "[Shopify/AdminGraphQL] global fetch not available and no fetchImpl provided.",
    );
  }
  if (!opts.adminToken) {
    throw new Error(
      "[Shopify/AdminGraphQL] adminToken is required — cannot call Admin API without one.",
    );
  }

  const url = `https://${opts.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": opts.adminToken,
    },
    body: JSON.stringify({
      query: opts.query,
      variables: opts.variables ?? {},
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[Shopify/AdminGraphQL] ${url} → ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  return (await res.json()) as AdminGraphqlResponse<TData>;
}
