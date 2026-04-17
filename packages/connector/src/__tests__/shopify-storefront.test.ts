/**
 * `createStorefrontToken` — Admin GraphQL mutation that mints a Storefront
 * API token after OAuth install.
 */
import { describe, it, expect } from "vitest";
import { createStorefrontToken } from "../adapters/shopify/oauth/storefront.js";

const SHOP = "foo.myshopify.com";
const ADMIN_TOKEN = "shpat_admin";
const API_VERSION = "2025-07";

function fakeFetch(response: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response), { status })) as typeof fetch;
}

describe("createStorefrontToken", () => {
  it("returns the minted access token on success", async () => {
    const result = await createStorefrontToken({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      fetchImpl: fakeFetch({
        data: {
          storefrontAccessTokenCreate: {
            storefrontAccessToken: {
              accessToken: "shpsf_token",
              title: "ACC Connector",
            },
            userErrors: [],
          },
        },
      }),
    });
    expect(result.accessToken).toBe("shpsf_token");
    expect(result.userErrors).toHaveLength(0);
  });

  it("surfaces userErrors without throwing (allows caller to fall back)", async () => {
    const result = await createStorefrontToken({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      fetchImpl: fakeFetch({
        data: {
          storefrontAccessTokenCreate: {
            storefrontAccessToken: null,
            userErrors: [
              { field: ["input", "title"], message: "Title is invalid" },
            ],
          },
        },
      }),
    });
    expect(result.accessToken).toBeNull();
    expect(result.userErrors).toHaveLength(1);
    expect(result.userErrors[0].message).toMatch(/Title is invalid/);
  });

  it("returns nulls when GraphQL emits top-level errors", async () => {
    const result = await createStorefrontToken({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      fetchImpl: fakeFetch({
        errors: [{ message: "Access denied for app" }],
      }),
    });
    expect(result.accessToken).toBeNull();
    expect(result.userErrors.map((u) => u.message)).toContain(
      "Access denied for app",
    );
  });

  it("sends the admin token in the correct header", async () => {
    const seen: { headers?: HeadersInit } = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.headers = init?.headers;
      return new Response(
        JSON.stringify({
          data: {
            storefrontAccessTokenCreate: {
              storefrontAccessToken: { accessToken: "t", title: "t" },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await createStorefrontToken({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      fetchImpl,
    });
    const headers = seen.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe(ADMIN_TOKEN);
  });

  it("throws when the admin API returns non-2xx", async () => {
    await expect(
      createStorefrontToken({
        shopDomain: SHOP,
        adminToken: ADMIN_TOKEN,
        apiVersion: API_VERSION,
        fetchImpl: fakeFetch({ error: "oops" }, 500),
      }),
    ).rejects.toThrow(/500/);
  });
});
