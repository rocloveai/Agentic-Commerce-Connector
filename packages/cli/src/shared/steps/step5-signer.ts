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
import type { StepContext, StepOutcome } from "./context.js";

const HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function stepSigner(ctx: StepContext): Promise<StepOutcome> {
  if (existsSync(ctx.layout.signerKeyFile)) {
    const contents = readFileSync(ctx.layout.signerKeyFile, "utf-8").trim();
    const encrypted = isWrappedSigner(contents);
    const address = encrypted ? "[encrypted]" : deriveAddress(contents);
    ctx.config.wallet = {
      address: encrypted ? "0x0000000000000000000000000000000000000000" : address,
      encrypted,
    };
    // Preserve key file but make sure the .env matches — plaintext keys
    // get re-exposed as MERCHANT_SIGNER_PRIVATE_KEY so `acc start` can
    // actually read them. Encrypted keys can't be auto-exported; user has
    // to set the env var themselves from their passphrase.
    if (!encrypted) {
      const payoutAddress = await askPaymentAddress(ctx, address);
      upsertEnv(ctx.layout.envPath, {
        MERCHANT_SIGNER_PRIVATE_KEY: contents,
        MERCHANT_PAYMENT_ADDRESS: payoutAddress,
      });
    }
    return { applied: false, summary: `signer.key preserved (encrypted=${encrypted})` };
  }

  const mode = await pickMode(ctx);
  if (mode === "skip") {
    return { applied: false, summary: "signer skipped (you'll need to add one before publishing)" };
  }

  const privateKey = mode === "generate" ? generateSignerKey().privateKey : (mode as Hex);
  const address = privateKeyToAccount(privateKey).address;

  const passphrase = ctx.seed?.signerPassphrase;
  const toWrite = passphrase ? encryptSignerKey(privateKey, passphrase) : privateKey;

  writeSignerKey(ctx.layout.signerKeyFile, toWrite);
  ctx.config.wallet = { address, encrypted: Boolean(passphrase) };

  // Export the key + payout address to .env so the server's config
  // loader (packages/connector/src/config/payment.ts) finds them. Without
  // this, `acc start` fails with "MERCHANT_SIGNER_PRIVATE_KEY is
  // required". We only export plaintext keys — if the operator chose a
  // passphrase we keep signer.key encrypted on disk and leave the env
  // var to be set at deploy time.
  if (!passphrase) {
    const payoutAddress = await askPaymentAddress(ctx, address);
    upsertEnv(ctx.layout.envPath, {
      MERCHANT_SIGNER_PRIVATE_KEY: privateKey,
      MERCHANT_PAYMENT_ADDRESS: payoutAddress,
    });
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
  const choice = await ctx.prompter.askChoice("Marketplace signer key", [
    { key: "g", label: "generate a new one" },
    { key: "i", label: "import an existing 0x hex key" },
    { key: "s", label: "skip (configure later)" },
  ]);
  if (choice === "s") return "skip";
  if (choice === "g") return "generate";
  const hex = await ctx.prompter.askSecret("Paste 0x-prefixed 32-byte hex private key");
  if (!HEX_RE.test(hex)) {
    throw new Error("invalid private key format (expected 0x + 64 hex chars)");
  }
  return hex as Hex;
}

async function askPaymentAddress(
  ctx: StepContext,
  signerAddress: string,
): Promise<string> {
  const seeded = ctx.seed?.paymentAddress;
  if (seeded) {
    if (!ADDR_RE.test(seeded)) {
      throw new Error(`invalid paymentAddress seed: ${seeded}`);
    }
    return seeded;
  }
  // Payout address = where settled stablecoin lands. Production deploys
  // should use a cold wallet, not the signer, but for dev/smoke-test
  // defaulting to the signer address is fine.
  const entered = await ctx.prompter.ask(
    "Payout wallet address (receives stablecoin)",
    {
      default: signerAddress,
      validate: (v) => (ADDR_RE.test(v) ? null : "must be 0x + 40 hex chars"),
    },
  );
  return entered;
}

function deriveAddress(privateKey: string): `0x${string}` {
  return privateKeyToAccount(privateKey as Hex).address;
}
