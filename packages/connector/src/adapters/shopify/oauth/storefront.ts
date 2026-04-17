// ---------------------------------------------------------------------------
// Storefront access token provisioning.
//
// The OAuth install only gives us an Admin API token. The Storefront API
// needs its own token — we mint one via Admin GraphQL right after install
// and persist it alongside the admin token.
//
// Failure is non-fatal: if the app wasn't configured with
// `unauthenticated_read_product_listings`, this call returns userErrors.
// We surface the error so the caller (callback handler) can log + continue
// without the storefront token; the catalog adapter can fall back to Admin
// API reads in that case (documented in design doc §6.3).
// ---------------------------------------------------------------------------

import { adminGraphql } from "./admin-graphql.js";

const MUTATION = `mutation StorefrontAccessTokenCreate($input: StorefrontAccessTokenInput!) {
  storefrontAccessTokenCreate(input: $input) {
    storefrontAccessToken {
      accessToken
      title
    }
    userErrors {
      field
      message
    }
  }
}`;

interface MutationData {
  readonly storefrontAccessTokenCreate: {
    readonly storefrontAccessToken: {
      readonly accessToken: string;
      readonly title: string;
    } | null;
    readonly userErrors: ReadonlyArray<{
      readonly field: readonly string[] | null;
      readonly message: string;
    }>;
  };
}

export interface CreateStorefrontTokenOptions {
  readonly shopDomain: string;
  readonly adminToken: string;
  readonly apiVersion: string;
  /** Appears in Shopify admin → Apps → Storefront API access tokens. */
  readonly title?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface CreateStorefrontTokenResult {
  readonly accessToken: string | null;
  readonly userErrors: ReadonlyArray<{
    readonly field: readonly string[] | null;
    readonly message: string;
  }>;
}

export async function createStorefrontToken(
  opts: CreateStorefrontTokenOptions,
): Promise<CreateStorefrontTokenResult> {
  const res = await adminGraphql<MutationData>({
    shopDomain: opts.shopDomain,
    apiVersion: opts.apiVersion,
    adminToken: opts.adminToken,
    query: MUTATION,
    variables: {
      input: { title: opts.title ?? "ACC Connector" },
    },
    fetchImpl: opts.fetchImpl,
  });

  const payload = res.data?.storefrontAccessTokenCreate;
  if (!payload) {
    return {
      accessToken: null,
      userErrors: (res.errors ?? []).map((e) => ({
        field: null,
        message: e.message,
      })),
    };
  }

  return {
    accessToken: payload.storefrontAccessToken?.accessToken ?? null,
    userErrors: payload.userErrors,
  };
}
