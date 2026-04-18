import { upsertEnv } from "../env-writer.js";
import type { StepContext, StepOutcome } from "./context.js";

const URL_RE = /^https:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/;
const LOCALHOST_RE = /^https?:\/\/localhost(?::\d+)?(?:\/[^\s]*)?$/;

const DEFAULT_SELF_URL = "http://localhost:10000";

// ---------------------------------------------------------------------------
// Step 3 — Public URL (aka SELF_URL).
//
// Most merchants running `acc init` on their laptop don't yet know which
// domain this ACC instance will live on; they're just trying it out. Asking
// for "https://acc.example.com" up front is a footgun — users often type
// their Shopify store URL by mistake (it's the URL most top-of-mind at
// that moment).
//
// So in the default path we silently write `http://localhost:10000` and move
// on. `acc doctor` and the skill-publish workflow nudge users to set a real
// public URL once they're ready to go live. --advanced users still get the
// explanatory prompt.
// ---------------------------------------------------------------------------

export async function stepSelfUrl(ctx: StepContext): Promise<StepOutcome> {
  const seeded = ctx.seed?.selfUrl;
  if (seeded) {
    validateOrThrow(seeded);
    const trimmed = seeded.replace(/\/+$/, "");
    upsertEnv(ctx.layout.envPath, { SELF_URL: trimmed });
    ctx.config.selfUrl = trimmed;
    ctx.ui.ok("Public URL", trimmed);
    return { applied: true, summary: `SELF_URL=${trimmed}` };
  }

  // `install-server.sh` sets ACC_PUBLIC_HOSTNAME when the merchant is
  // bootstrapping a production server; read it as a soft pre-fill so the
  // wizard skips the selfUrl prompt but still runs every other step
  // interactively. (A full `seed` would skip signer / payout / Shopify
  // too, which we don't want for server bootstrap.)
  const envHostname = process.env.ACC_PUBLIC_HOSTNAME?.trim();
  if (envHostname) {
    const raw = /^https?:\/\//.test(envHostname)
      ? envHostname
      : `https://${envHostname}`;
    const trimmed = raw.replace(/\/+$/, "");
    validateOrThrow(trimmed);
    upsertEnv(ctx.layout.envPath, { SELF_URL: trimmed });
    ctx.config.selfUrl = trimmed;
    ctx.ui.ok("Public URL", `${trimmed} ${ctx.ui.s.dim("(from ACC_PUBLIC_HOSTNAME)")}`);
    return { applied: true, summary: `SELF_URL=${trimmed}` };
  }

  if (!ctx.advanced) {
    upsertEnv(ctx.layout.envPath, { SELF_URL: DEFAULT_SELF_URL });
    ctx.config.selfUrl = DEFAULT_SELF_URL;
    ctx.ui.ok(
      "Public URL",
      `${DEFAULT_SELF_URL} ${ctx.ui.s.dim("(change with `acc init --advanced` before going live)")}`,
    );
    return { applied: true, summary: `SELF_URL=${DEFAULT_SELF_URL}` };
  }

  ctx.ui.section("Public URL");
  ctx.ui.line(
    `  ${ctx.ui.s.dim("Where this connector will be reachable — NOT your Shopify storefront.")}`,
  );

  const value = await ctx.prompter.ask("Public URL for this connector", {
    default: DEFAULT_SELF_URL,
    validate: (v) => {
      if (URL_RE.test(v) || LOCALHOST_RE.test(v)) return null;
      return "must be https:// (or http://localhost:<port>), no trailing slash";
    },
  });

  const trimmed = value.replace(/\/+$/, "");
  upsertEnv(ctx.layout.envPath, { SELF_URL: trimmed });
  ctx.config.selfUrl = trimmed;
  ctx.ui.ok("Public URL", trimmed);
  return { applied: true, summary: `SELF_URL=${trimmed}` };
}

function validateOrThrow(v: string): string {
  if (!URL_RE.test(v) && !LOCALHOST_RE.test(v)) {
    throw new Error(`invalid selfUrl seed: ${v}`);
  }
  return v;
}
