#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `acc` dispatcher — thin entry point that:
//  1. Routes argv to a handler via the pure `route()` function.
//  2. Invokes the handler with residual args.
//  3. Returns a conventional exit code (2 for usage errors, 1 for runtime).
// ---------------------------------------------------------------------------

import { route, type HandlerKey } from "./acc-route.js";
import { runHelp } from "./commands/help.js";
import { runVersion } from "./commands/version.js";
import { runPlaceholder } from "./commands/placeholder.js";
import { runInit } from "./commands/init.js";
import { runPublish } from "./commands/publish.js";
import { runStart } from "./commands/start.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runDoctor } from "./commands/doctor.js";
import { runShopifyConnect } from "./commands/shopify/connect.js";
import { runSkillInit } from "./commands/skill/init.js";
import { runSkillEdit } from "./commands/skill/edit.js";
import { runSkillValidate } from "./commands/skill/validate.js";
import { runWalletShow } from "./commands/wallet/show.js";
import { runWalletNew } from "./commands/wallet/new.js";
import { runWalletImport } from "./commands/wallet/import.js";

type Handler = (args: string[]) => Promise<void>;

const HANDLERS: Record<HandlerKey, Handler> = {
  help: (args) => runHelp(args),
  version: () => runVersion(),
  init: (args) => runInit(args),
  publish: (args) => runPublish(args),
  start: (args) => runStart(args),
  upgrade: (args) => runUpgrade(args),
  doctor: (args) => runDoctor(args),
  "shopify.connect": (args) => runShopifyConnect(args),
  "skill.init": (args) => runSkillInit(args),
  "skill.edit": (args) => runSkillEdit(args),
  "skill.validate": (args) => runSkillValidate(args),
  "wallet.show": (args) => runWalletShow(args),
  "wallet.new": (args) => runWalletNew(args),
  "wallet.import": (args) => runWalletImport(args),
  placeholder: (args) => runPlaceholder(args),
};

export async function dispatch(argv: readonly string[]): Promise<number> {
  const result = route(argv);
  if ("error" in result) {
    process.stderr.write(`acc: ${result.error}\n\n`);
    await runHelp([]);
    return 2;
  }
  try {
    await HANDLERS[result.handler]([...result.args]);
    return 0;
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await dispatch(process.argv.slice(2));
  process.exit(code);
}

// Only execute when invoked directly, not when imported by tests.
// Three invocation shapes must match:
//   1. `node build/acc.js`        → argv[1] ends with /acc.js
//   2. `npx acc` / `./acc.js`     → argv[1] ends with /acc or /acc.js
//   3. compiled binary via Bun    → argv[1] is the binary path, any name,
//      and argv[0] === argv[1] (Bun collapses them). Detect via Bun's
//      presence as the runtime discriminator.
const entry = process.argv[1] ?? "";
const isBunCompiled =
  typeof (process as unknown as { versions?: Record<string, string> }).versions?.bun === "string";
if (isBunCompiled || /(^|\/)acc(\.js)?$/.test(entry)) {
  main();
}
