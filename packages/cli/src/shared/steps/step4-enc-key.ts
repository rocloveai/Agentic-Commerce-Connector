import { existsSync, readFileSync } from "node:fs";
import { generateEncKey, writeEncKey } from "../keys.js";
import { upsertEnv } from "../env-writer.js";
import type { StepContext, StepOutcome } from "./context.js";

export async function stepEncKey(ctx: StepContext): Promise<StepOutcome> {
  let key: string;
  if (existsSync(ctx.layout.encKeyFile)) {
    key = readFileSync(ctx.layout.encKeyFile, "utf-8").trim();
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error(
        `existing ${ctx.layout.encKeyFile} is not a 64-hex AES-256 key — delete it or fix manually`,
      );
    }
    upsertEnv(ctx.layout.envPath, { ACC_ENCRYPTION_KEY: key });
    ctx.ui.ok("Encryption key", "AES-256 (preserved)");
    return { applied: false, summary: "enc.key preserved (already present)" };
  }
  key = generateEncKey();
  writeEncKey(ctx.layout.encKeyFile, key);
  upsertEnv(ctx.layout.envPath, { ACC_ENCRYPTION_KEY: key });
  ctx.ui.ok("Encryption key", "AES-256");
  return { applied: true, summary: "generated enc.key (0600) + ACC_ENCRYPTION_KEY" };
}
