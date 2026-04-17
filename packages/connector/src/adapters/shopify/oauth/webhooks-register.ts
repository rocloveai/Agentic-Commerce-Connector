// ---------------------------------------------------------------------------
// Register webhooks with Shopify at install time.
//
// We register:
//   - APP_UNINSTALLED              — so we can null out tokens when the
//                                    merchant uninstalls the app.
//   - CUSTOMERS_DATA_REQUEST       — GDPR mandatory for App Store readiness.
//   - CUSTOMERS_REDACT             — GDPR mandatory.
//   - SHOP_REDACT                  — GDPR mandatory.
//
// Only APP_UNINSTALLED has a route implementation today (Phase 5). The three
// GDPR topics get the same callback URLs so App Store submission (future
// Shape C) can light them up without another registration round-trip. Until
// then, those endpoints return 200 with a no-op body to satisfy Shopify's
// compliance probes.
//
// Failure per-topic is non-fatal — we return a report so the caller can
// log + continue. The merchant can "Re-register webhooks" from
// /admin/shopify later (Phase 6).
// ---------------------------------------------------------------------------

import { adminGraphql } from "./admin-graphql.js";

export const WEBHOOK_TOPICS = [
  "APP_UNINSTALLED",
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export const WEBHOOK_TOPIC_PATH: Record<WebhookTopic, string> = {
  APP_UNINSTALLED: "/webhooks/shopify/app-uninstalled",
  CUSTOMERS_DATA_REQUEST: "/webhooks/shopify/customers-data-request",
  CUSTOMERS_REDACT: "/webhooks/shopify/customers-redact",
  SHOP_REDACT: "/webhooks/shopify/shop-redact",
};

const MUTATION = `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

interface MutationData {
  readonly webhookSubscriptionCreate: {
    readonly webhookSubscription: { readonly id: string } | null;
    readonly userErrors: ReadonlyArray<{
      readonly field: readonly string[] | null;
      readonly message: string;
    }>;
  };
}

export interface RegisterWebhooksOptions {
  readonly shopDomain: string;
  readonly adminToken: string;
  readonly apiVersion: string;
  /** Public URL that Shopify will POST webhooks to. Must be HTTPS. */
  readonly selfUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RegisteredWebhook {
  readonly topic: WebhookTopic;
  readonly ok: boolean;
  readonly subscriptionId?: string;
  readonly error?: string;
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

export async function registerWebhooks(
  opts: RegisterWebhooksOptions,
): Promise<readonly RegisteredWebhook[]> {
  const base = stripTrailingSlashes(opts.selfUrl);
  const results: RegisteredWebhook[] = [];

  for (const topic of WEBHOOK_TOPICS) {
    const callbackUrl = `${base}${WEBHOOK_TOPIC_PATH[topic]}`;
    try {
      const res = await adminGraphql<MutationData>({
        shopDomain: opts.shopDomain,
        apiVersion: opts.apiVersion,
        adminToken: opts.adminToken,
        query: MUTATION,
        variables: {
          topic,
          subscription: { callbackUrl, format: "JSON" },
        },
        fetchImpl: opts.fetchImpl,
      });

      const payload = res.data?.webhookSubscriptionCreate;
      if (!payload) {
        results.push({
          topic,
          ok: false,
          error:
            (res.errors ?? []).map((e) => e.message).join("; ") ||
            "no data returned",
        });
        continue;
      }
      if (payload.userErrors.length > 0) {
        // A second install of the same topic returns "Address for this topic
        // has already been taken" — that's effectively success from our POV.
        const alreadyTaken = payload.userErrors.every((e) =>
          /already been taken|already registered/i.test(e.message),
        );
        if (alreadyTaken) {
          results.push({ topic, ok: true });
          continue;
        }
        results.push({
          topic,
          ok: false,
          error: payload.userErrors.map((e) => e.message).join("; "),
        });
        continue;
      }

      results.push({
        topic,
        ok: true,
        subscriptionId: payload.webhookSubscription?.id,
      });
    } catch (err) {
      results.push({
        topic,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
