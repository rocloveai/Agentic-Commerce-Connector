/**
 * `registerWebhooks` — registers APP_UNINSTALLED + the three GDPR topics.
 * Per-topic failure is non-fatal; the function returns a report.
 */
import { describe, it, expect } from "vitest";
import {
  registerWebhooks,
  WEBHOOK_TOPICS,
} from "../adapters/shopify/oauth/webhooks-register.js";

const SHOP = "foo.myshopify.com";
const ADMIN_TOKEN = "shpat_admin";
const API_VERSION = "2025-07";
const SELF_URL = "https://acc.example.com";

type MutationCall = { topic?: string; callbackUrl?: string };

function makeFetch(
  respForCall: (index: number, call: MutationCall) => Response,
): { fetchImpl: typeof fetch; calls: MutationCall[] } {
  const calls: MutationCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const call: MutationCall = {
      topic: body.variables?.topic,
      callbackUrl: body.variables?.subscription?.callbackUrl,
    };
    calls.push(call);
    return respForCall(calls.length - 1, call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function okResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: { id },
          userErrors: [],
        },
      },
    }),
    { status: 200 },
  );
}

describe("registerWebhooks", () => {
  it("registers all four topics with the correct callback paths", async () => {
    const { fetchImpl, calls } = makeFetch((i) => okResponse(`gid://${i}`));
    const results = await registerWebhooks({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      selfUrl: SELF_URL,
      fetchImpl,
    });
    expect(results).toHaveLength(WEBHOOK_TOPICS.length);
    expect(results.every((r) => r.ok)).toBe(true);

    const topicsSeen = calls.map((c) => c.topic).sort();
    expect(topicsSeen).toEqual([...WEBHOOK_TOPICS].sort());

    const urls = calls.map((c) => c.callbackUrl);
    expect(urls).toContain(`${SELF_URL}/webhooks/shopify/app-uninstalled`);
    expect(urls).toContain(
      `${SELF_URL}/webhooks/shopify/customers-data-request`,
    );
    expect(urls).toContain(`${SELF_URL}/webhooks/shopify/customers-redact`);
    expect(urls).toContain(`${SELF_URL}/webhooks/shopify/shop-redact`);
  });

  it("treats 'already been taken' userErrors as success (idempotent re-install)", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [
                  {
                    field: ["callbackUrl"],
                    message:
                      "Address for this topic has already been taken",
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    const results = await registerWebhooks({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      selfUrl: SELF_URL,
      fetchImpl,
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("records per-topic failures without throwing", async () => {
    const { fetchImpl } = makeFetch((i) => {
      if (i === 0) {
        return new Response(
          JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [{ field: null, message: "Some real error" }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return okResponse(`gid://${i}`);
    });
    const results = await registerWebhooks({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      selfUrl: SELF_URL,
      fetchImpl,
    });
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/Some real error/);
    expect(results.filter((r) => r.ok)).toHaveLength(WEBHOOK_TOPICS.length - 1);
  });

  it("surfaces network failures per-topic (fetch throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const results = await registerWebhooks({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      selfUrl: SELF_URL,
      fetchImpl,
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => /ECONNRESET/.test(r.error ?? ""))).toBe(true);
  });

  it("strips trailing slashes from selfUrl to avoid '//webhooks/…'", async () => {
    const { fetchImpl, calls } = makeFetch((i) => okResponse(`gid://${i}`));
    await registerWebhooks({
      shopDomain: SHOP,
      adminToken: ADMIN_TOKEN,
      apiVersion: API_VERSION,
      selfUrl: `${SELF_URL}///`,
      fetchImpl,
    });
    for (const call of calls) {
      expect(call.callbackUrl).not.toMatch(/\/\/webhooks\//);
    }
  });
});
