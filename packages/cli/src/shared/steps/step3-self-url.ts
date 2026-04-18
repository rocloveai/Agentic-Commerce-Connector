import { upsertEnv } from "../env-writer.js";
import type { StepContext, StepOutcome } from "./context.js";

const URL_RE = /^https:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/;
const LOCALHOST_RE = /^https?:\/\/localhost(?::\d+)?(?:\/[^\s]*)?$/;

export async function stepSelfUrl(ctx: StepContext): Promise<StepOutcome> {
  const seeded = ctx.seed?.selfUrl;
  if (seeded) {
    validateOrThrow(seeded);
    const trimmed = seeded.replace(/\/+$/, "");
    upsertEnv(ctx.layout.envPath, { SELF_URL: trimmed });
    ctx.config.selfUrl = trimmed;
    return { applied: true, summary: `SELF_URL=${trimmed}` };
  }

  // Explain what this URL is — merchants typing their myshopify.com store
  // URL here is a common misunderstanding. The selfUrl is where THIS
  // connector lives, not the downstream storefront.
  process.stdout.write(
    "  This is the public URL where *this connector* will be reachable —\n" +
      "  NOT your Shopify storefront. Shopify's OAuth callback, AI agent\n" +
      "  discovery, and the marketplace skill.md all point here.\n" +
      "  Production example:   https://acc.example.com\n" +
      "  Local smoke test:     http://localhost:10000\n",
  );

  const value = await ctx.prompter.ask(
    "Public URL for this connector",
    {
      default: "https://acc.example.com",
      validate: (v) => {
        if (URL_RE.test(v) || LOCALHOST_RE.test(v)) return null;
        return "must be https:// (or http://localhost:<port> for local testing), no trailing slash";
      },
    },
  );

  const trimmed = value.replace(/\/+$/, "");
  upsertEnv(ctx.layout.envPath, { SELF_URL: trimmed });
  ctx.config.selfUrl = trimmed;
  return { applied: true, summary: `SELF_URL=${trimmed}` };
}

function validateOrThrow(v: string): string {
  if (!URL_RE.test(v) && !LOCALHOST_RE.test(v)) {
    throw new Error(`invalid selfUrl seed: ${v}`);
  }
  return v;
}
