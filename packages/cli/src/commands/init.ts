// ---------------------------------------------------------------------------
// `acc init` — 8-step interactive wizard.
//
// Steps live in src/shared/steps/ so this file stays a thin orchestrator.
// See docs/plans/2026-04-16-phase-8-cli-wizard-structure.md §E for the
// step-by-step intent.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, type DataDirLayout } from "../shared/data-dir.js";
import {
  createPrompter,
  defaultPromptIO,
  type Prompter,
  type PromptIO,
} from "../shared/prompts.js";
import {
  loadConfig,
  saveConfig,
  backupConfig,
  type AccConfig,
} from "../shared/config-store.js";
import { stepPreflight } from "../shared/steps/step1-preflight.js";
import { stepDataDir } from "../shared/steps/step2-data-dir.js";
import { stepSelfUrl } from "../shared/steps/step3-self-url.js";
import { stepEncKey } from "../shared/steps/step4-enc-key.js";
import { stepSigner } from "../shared/steps/step5-signer.js";
import { stepShopify } from "../shared/steps/step6-shopify.js";
import { stepSqlite } from "../shared/steps/step7-sqlite.js";
import { stepSkill } from "../shared/steps/step8-skill.js";
import type {
  StepContext,
  NonInteractiveSeed,
} from "../shared/steps/context.js";

export interface RunInitOptions {
  /** Inject a custom PromptIO (tests). Defaults to readline-backed stdin/stdout. */
  readonly io?: PromptIO;
  /** Seed for non-interactive mode. Supplied via env or tests. */
  readonly seed?: Partial<NonInteractiveSeed>;
}

const DEFAULT_REGISTRY = "https://api.siliconretail.com";
const DEFAULT_CHAIN_ID = 1;

export async function runInit(
  args: string[],
  opts: RunInitOptions = {},
): Promise<void> {
  const flags = parseFlags(args);
  const force = flags.has("force");
  const dataDirArg = flags.get("data-dir") ?? defaultDataDir();

  const io = opts.io ?? defaultPromptIO();
  const prompter = createPrompter(io);
  const seed = opts.seed ?? nonInteractiveSeedFromEnv();

  try {
    const layout = ensureDataDir(dataDirArg);
    const existing = loadConfig(layout.configPath);

    const action = await resolveReentrantAction(
      layout,
      existing,
      prompter,
      force,
    );
    if (action === "cancel" || action === "keep") {
      process.stdout.write(`\nNo changes written. (action=${action})\n`);
      return;
    }
    if (action === "reset") {
      const backup = backupConfig(layout.configPath);
      if (backup) process.stdout.write(`Backed up old config to ${backup}\n`);
    }

    const ctx: StepContext = {
      layout,
      prompter,
      flags,
      force,
      config: existing
        ? { ...existing }
        : {
            dataVersion: 1,
            registry: seed?.registry ?? DEFAULT_REGISTRY,
            chainId: seed?.chainId ?? DEFAULT_CHAIN_ID,
            skillMdPath: layout.skillMd,
          },
      seed,
    };

    const steps: Array<
      readonly [string, (c: StepContext) => Promise<{ summary: string }>]
    > =
      action === "shopify-only"
        ? [["6/8 Shopify Partners creds", stepShopify]]
        : [
            ["1/8 Preflight", stepPreflight],
            ["2/8 Data directory", stepDataDir],
            ["3/8 Public URL", stepSelfUrl],
            ["4/8 Encryption key", stepEncKey],
            ["5/8 Marketplace signer", stepSigner],
            ["6/8 Shopify Partners creds", stepShopify],
            ["7/8 SQLite migration", stepSqlite],
            ["8/8 Skill template", stepSkill],
          ];

    for (const [label, step] of steps) {
      process.stdout.write(`\n${label}\n`);
      const out = await step(ctx);
      process.stdout.write(`  → ${out.summary}\n`);
    }

    const final = finaliseConfig(ctx.config, layout);
    saveConfig(layout.configPath, final);

    printFinaleSummary(final, layout);
  } finally {
    prompter.close();
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function parseFlags(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=", 2);
    if (!k) continue;
    map.set(k, v ?? "true");
  }
  return map;
}

async function resolveReentrantAction(
  layout: DataDirLayout,
  existing: AccConfig | null,
  prompter: Prompter,
  force: boolean,
): Promise<"fresh" | "reset" | "shopify-only" | "keep" | "cancel"> {
  if (!existing) return "fresh";
  if (force) return "reset";
  const choice = await prompter.askChoice(
    `Found existing config at ${layout.configPath}. What next?`,
    [
      { key: "a", label: "keep as-is (exit)" },
      { key: "b", label: "update Shopify credentials only" },
      { key: "c", label: "start over (backs up current)" },
      { key: "d", label: "cancel" },
    ],
  );
  return (
    {
      a: "keep" as const,
      b: "shopify-only" as const,
      c: "reset" as const,
      d: "cancel" as const,
    }[choice] ?? "cancel"
  );
}

function finaliseConfig(
  partial: Partial<AccConfig>,
  layout: DataDirLayout,
): AccConfig {
  const base: AccConfig = {
    dataVersion: 1,
    registry: partial.registry ?? DEFAULT_REGISTRY,
    chainId: partial.chainId ?? DEFAULT_CHAIN_ID,
    selfUrl: partial.selfUrl ?? "https://acc.example.com",
    skillMdPath: partial.skillMdPath ?? layout.skillMd,
  };
  if (partial.wallet) {
    return { ...base, wallet: partial.wallet };
  }
  return base;
}

function printFinaleSummary(cfg: AccConfig, layout: DataDirLayout): void {
  process.stdout.write(
    `\n✓ acc init complete\n` +
      `  data dir : ${layout.root}\n` +
      `  registry : ${cfg.registry}\n` +
      `  selfUrl  : ${cfg.selfUrl}\n` +
      `  wallet   : ${cfg.wallet?.address ?? "(not configured)"}\n` +
      `  skill    : ${cfg.skillMdPath}\n` +
      `\nNext: acc start   (or: acc doctor to verify setup)\n`,
  );
}

// When the CLI is installed globally (cwd is not a checked-out ACC repo), we
// default the data dir to ~/.acc — single-user home-managed install, matching
// OpenCode / brew / cargo conventions. Inside a repo checkout (package.json
// at cwd declares @acc/cli or @acc/connector) we keep the legacy ./acc-data
// so contributor workflows stay untouched.
function defaultDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return "./acc-data";

  const cwdPkg = join(process.cwd(), "package.json");
  if (existsSync(cwdPkg)) {
    try {
      const name = JSON.parse(readFileSync(cwdPkg, "utf8"))?.name ?? "";
      if (
        typeof name === "string" &&
        (name.startsWith("@acc/") || name === "agentic-commerce-connector")
      ) {
        return "./acc-data";
      }
    } catch {
      // fall through to home default
    }
  }
  return join(home, ".acc");
}

function nonInteractiveSeedFromEnv(): Partial<NonInteractiveSeed> | undefined {
  const raw = process.env.ACC_INIT_CONFIG;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Partial<NonInteractiveSeed>;
  } catch {
    throw new Error("ACC_INIT_CONFIG is set but contains invalid JSON");
  }
}
