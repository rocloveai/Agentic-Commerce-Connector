import { existsSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  generateSignerKey,
  writeSignerKey,
  encryptSignerKey,
  isWrappedSigner,
} from "../keys.js";
import { upsertEnv } from "../env-writer.js";
import { shortHex } from "../ui.js";
import type { StepContext, StepOutcome } from "./context.js";

// ---------------------------------------------------------------------------
// Step 5 — Signer wallet (identity).
//
// The signer key signs your marketplace skill.md so AI agents can verify
// the listing hasn't been tampered with. It is NOT where customer
// payments land (see step5b-payout). It lives encrypted on this server;
// if compromised, the worst an attacker can do is forge skill updates,
// which you can recover from by minting a new signer.
//
// Default flow:
//   Auto-generate a new key. Interactive users with an existing identity
//   can choose "paste existing". Non-crypto merchants never see --advanced
//   details (passphrase encryption etc.); those are opt-in.
// ---------------------------------------------------------------------------

const HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export async function stepSigner(ctx: StepContext): Promise<StepOutcome> {
  // Preserve an existing signer across re-init runs.
  if (existsSync(ctx.layout.signerKeyFile)) {
    const contents = readFileSync(ctx.layout.signerKeyFile, "utf-8").trim();
    const encrypted = isWrappedSigner(contents);
    const address = encrypted
      ? "0x0000000000000000000000000000000000000000"
      : deriveAddress(contents);
    ctx.config.wallet = { address, encrypted };
    if (!encrypted) {
      upsertEnv(ctx.layout.envPath, { MERCHANT_SIGNER_PRIVATE_KEY: contents });
    }
    ctx.ui.ok(
      "Signer wallet",
      encrypted ? "encrypted (preserved)" : "preserved",
    );
    if (!encrypted) {
      ctx.ui.line(`     ${ctx.ui.s.dim("address    ")} ${address}`);
      ctx.ui.line(
        `     ${ctx.ui.s.dim("key file   ")} ${ctx.layout.signerKeyFile}`,
      );
    }
    return { applied: false, summary: `signer.key preserved (encrypted=${encrypted})` };
  }

  const mode = await pickMode(ctx);
  if (mode === "skip") {
    ctx.ui.warn("Signer wallet", "skipped — configure before publishing");
    return { applied: false, summary: "signer skipped" };
  }

  const privateKey = mode === "generate" ? generateSignerKey().privateKey : (mode as Hex);
  const address = privateKeyToAccount(privateKey).address;

  const passphrase = ctx.seed?.signerPassphrase;
  const toWrite = passphrase ? encryptSignerKey(privateKey, passphrase) : privateKey;

  writeSignerKey(ctx.layout.signerKeyFile, toWrite);
  ctx.config.wallet = { address, encrypted: Boolean(passphrase) };

  if (!passphrase) {
    upsertEnv(ctx.layout.envPath, { MERCHANT_SIGNER_PRIVATE_KEY: privateKey });
  }

  ctx.ui.ok("Signer wallet", "generated");
  // Show the full address + key file path + back-up nudge. Users can't
  // recover a marketplace identity without the private key file; if we
  // only print a truncated address, they have no idea what to back up.
  ctx.ui.line(`     ${ctx.ui.s.dim("address    ")} ${address}`);
  ctx.ui.line(
    `     ${ctx.ui.s.dim("key file   ")} ${ctx.layout.signerKeyFile}  ${ctx.ui.s.dim("(mode 0600)")}`,
  );
  if (!passphrase) {
    ctx.ui.line(
      `     ${ctx.ui.s.yellow("⚠")}  ${ctx.ui.s.dim("Back this file up off-server (1Password / paper) before going live.")}`,
    );
  }
  return {
    applied: true,
    summary: `signer.key written (${passphrase ? "encrypted" : "plaintext 0600"}) — address ${address}`,
  };
}

async function pickMode(ctx: StepContext): Promise<"generate" | "skip" | Hex> {
  if (ctx.seed?.signer) {
    const seeded = ctx.seed.signer;
    if (seeded === "generate" || seeded === "skip") return seeded;
    if (HEX_RE.test(seeded)) return seeded as Hex;
    throw new Error(`invalid signer seed: ${seeded}`);
  }

  // Default mode: two choices. --advanced gets a third "skip" escape.
  ctx.ui.section("Signer wallet");
  ctx.ui.line(
    `  ${ctx.ui.s.dim("Signs your marketplace skill. Identity only, not money.")}`,
  );
  const choices = ctx.advanced
    ? [
        { key: "g", label: "auto-generate (recommended)" },
        { key: "i", label: "paste an existing 0x hex key" },
        { key: "s", label: "skip — configure later" },
      ]
    : [
        { key: "g", label: "auto-generate (recommended)" },
        { key: "i", label: "paste an existing 0x hex key" },
      ];
  const choice = await ctx.prompter.askChoice("How do you want the signer set up?", choices);
  if (choice === "s") return "skip";
  if (choice === "g") return "generate";
  const hex = await ctx.prompter.askSecret("Paste private key (0x + 64 hex)");
  if (!HEX_RE.test(hex)) {
    throw new Error("invalid private key format (expected 0x + 64 hex chars)");
  }
  return hex as Hex;
}

function deriveAddress(privateKey: string): `0x${string}` {
  return privateKeyToAccount(privateKey as Hex).address;
}
