import { upsertEnv } from "../env-writer.js";
import { shortHex } from "../ui.js";
import type { StepContext, StepOutcome } from "./context.js";

// ---------------------------------------------------------------------------
// Step 5b — Payout address.
//
// Where customer payments (stablecoin from AI-agent orders) actually land.
// Deliberately separate from the signer key:
//   - signer key lives encrypted on this server; low-value, identity-only
//   - payout can (and should) be a wallet this server never touches
//
// Default UI offers three choices:
//   1. Same as signer      — fine for testing & low volume
//   2. Paste a separate    — recommended for real revenue
//   3. Configure later     — leaves it unset; doctor warns
// ---------------------------------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function stepPayout(ctx: StepContext): Promise<StepOutcome> {
  const signerAddress = ctx.config.wallet?.address;

  // Seed path (tests, non-interactive): honour paymentAddress if given,
  // otherwise fall back to signer.
  const seeded = ctx.seed?.paymentAddress;
  if (seeded) {
    if (!ADDR_RE.test(seeded)) {
      throw new Error(`invalid paymentAddress seed: ${seeded}`);
    }
    upsertEnv(ctx.layout.envPath, { MERCHANT_PAYMENT_ADDRESS: seeded });
    ctx.ui.ok("Payout address", shortHex(seeded));
    return { applied: true, summary: `payout set to ${seeded}` };
  }
  if (ctx.seed && !seeded && signerAddress) {
    // Seed without explicit payment address → use signer (test convenience).
    upsertEnv(ctx.layout.envPath, { MERCHANT_PAYMENT_ADDRESS: signerAddress });
    ctx.ui.ok("Payout address", `${shortHex(signerAddress)} ${ctx.ui.s.dim("(= signer)")}`);
    return { applied: true, summary: `payout = signer ${signerAddress}` };
  }

  // If no signer exists (user skipped it) and we're interactive, require
  // an explicit address — otherwise the connector has no way to settle.
  if (!signerAddress && !ctx.seed) {
    ctx.ui.section("Payout address");
    ctx.ui.line(
      `  ${ctx.ui.s.dim("Where stablecoin earnings land. Signer was skipped so you must paste one.")}`,
    );
    const entered = await promptForAddress(ctx);
    upsertEnv(ctx.layout.envPath, { MERCHANT_PAYMENT_ADDRESS: entered });
    ctx.ui.ok("Payout address", shortHex(entered));
    return { applied: true, summary: `payout set to ${entered}` };
  }

  ctx.ui.section("Payout address");
  ctx.ui.line(
    `  ${ctx.ui.s.dim("Where stablecoin earnings from AI-agent orders will land.")}`,
  );

  const choice = await ctx.prompter.askChoice("Payout address", [
    { key: "s", label: `same as signer (${shortHex(signerAddress!)})` },
    { key: "p", label: "paste a separate address" },
    { key: "l", label: "configure later" },
  ]);

  if (choice === "l") {
    ctx.ui.warn("Payout address", "not set — run `acc wallet set-payout <0x…>` before publishing");
    return { applied: false, summary: "payout deferred" };
  }

  const address =
    choice === "s" ? signerAddress! : await promptForAddress(ctx);

  upsertEnv(ctx.layout.envPath, { MERCHANT_PAYMENT_ADDRESS: address });
  const note = choice === "s" ? ctx.ui.s.dim(" (= signer)") : "";
  ctx.ui.ok("Payout address", `${shortHex(address)}${note}`);
  return { applied: true, summary: `payout set to ${address}` };
}

async function promptForAddress(ctx: StepContext): Promise<string> {
  const entered = await ctx.prompter.ask("Payout address (0x…)", {
    validate: (v) => (ADDR_RE.test(v.trim()) ? null : "must be 0x + 40 hex chars"),
  });
  return entered.trim();
}
