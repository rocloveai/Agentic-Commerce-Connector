#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runSign } from "./commands/sign.js";
import { runPublish } from "./commands/publish.js";
import { runVerify } from "./commands/verify.js";

const [, , command, ...rest] = process.argv;

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  init: runInit,
  sign: runSign,
  publish: runPublish,
  verify: runVerify,
};

async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`acc-skill: unknown command "${command}"`);
    printHelp();
    process.exit(2);
  }
  await handler(rest);
}

function printHelp(): void {
  console.log(`acc-skill — generate, sign, publish, and verify ACC skill packages

Usage:
  acc-skill init [--from <connector-url>] [--out <dir>]
      Interactively build a skill package from a connector's /skill/export.

  acc-skill sign --in <dir> --key <private-key> --chain-id <id>
      EIP-712 sign the manifest; writes signature.json.

  acc-skill publish --in <dir> --marketplace <url>
      POST the signed package to a marketplace.

  acc-skill verify --in <dir> [--chain-id <id>]
      Validate schemas, content_hash, and signature locally.
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
