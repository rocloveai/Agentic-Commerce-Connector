// ---------------------------------------------------------------------------
// `acc init` — merchant onboarding wizard.
//
// Visual model:
//   - Background / infra steps (preflight, data dir, enc key, sqlite,
//     skill template) render as single `✓ label value` rows. No step
//     numbers — users shouldn't feel like they're doing 8 things when
//     they're really doing 2-3.
//   - User-facing steps (signer, payout, Shopify connect) print a
//     section header (`┃ Title`) + prompt + result line.
//
// Behaviour controls:
//   --advanced    expose every customisation point (full-fat old flow)
//   --force       skip re-entrance prompt, back up existing config
//   --data-dir    override data directory
//
// Steps live in src/shared/steps/ so this file stays a thin orchestrator.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, renameSync } from "node:fs";
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
import { createUi, type Ui } from "../shared/ui.js";
import { stepPreflight } from "../shared/steps/step1-preflight.js";
import { stepDataDir } from "../shared/steps/step2-data-dir.js";
import { stepSelfUrl } from "../shared/steps/step3-self-url.js";
import { stepEncKey } from "../shared/steps/step4-enc-key.js";
import { stepSigner } from "../shared/steps/step5-signer.js";
import { stepPayout } from "../shared/steps/step5b-payout.js";
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
  /** Inject a Ui (tests may want color-off + captured stream). */
  readonly ui?: Ui;
}

const DEFAULT_REGISTRY = "https://api.siliconretail.com";
const DEFAULT_CHAIN_ID = 1;

export async function runInit(
  args: string[],
  opts: RunInitOptions = {},
): Promise<void> {
  const flags = parseFlags(args);
  const force = flags.has("force");
  const advanced = flags.has("advanced");
  const dataDirArg = flags.get("data-dir") ?? defaultDataDir();

  const io = opts.io ?? defaultPromptIO();
  const prompter = createPrompter(io);
  const seed = opts.seed ?? nonInteractiveSeedFromEnv();
  const ui = opts.ui ?? createUi();

  try {
    printBanner(ui);

    const layout = ensureDataDir(dataDirArg);
    const existing = loadConfig(layout.configPath);

    const action = await resolveReentrantAction(
      layout,
      existing,
      prompter,
      force,
    );
    if (action === "cancel" || action === "keep") {
      ui.line(`\n  No changes written. (${action})\n`);
      return;
    }
    if (action === "reset") {
      const backup = backupConfig(layout.configPath);
      if (backup) ui.line(`  ${ui.s.dim(`↺ backed up previous config to ${backup}`)}`);
      // "Start over" should really start over — including signer identity.
      // We rename the key file so step5 sees a fresh slate and prompts for
      // generation again. The old key is preserved as a timestamped .bak
      // so the merchant can recover their previous marketplace identity if
      // they change their mind. The encryption key is deliberately NOT
      // rotated here because it would render existing shopify_installations
      // rows unreadable.
      if (existsSync(layout.signerKeyFile)) {
        const signerBak = `${layout.signerKeyFile}.bak.${Date.now()}`;
        renameSync(layout.signerKeyFile, signerBak);
        ui.line(`  ${ui.s.dim(`↺ backed up previous signer to ${signerBak}`)}`);
      }
    }

    const ctx: StepContext = {
      layout,
      prompter,
      flags,
      force,
      advanced,
      ui,
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

    // Step order — each `run` is responsible for its own rendering. The
    // orchestrator no longer prints "N/8 Title" headers; background steps
    // emit a single `✓` row, interactive steps emit their own sections.
    const runs: Array<(c: StepContext) => Promise<unknown>> =
      action === "shopify-only"
        ? [stepShopify]
        : [
            stepPreflight,
            stepDataDir,
            stepSelfUrl,
            stepEncKey,
            stepSigner,
            stepPayout,
            stepSqlite,
            stepSkill,
            stepShopify,
          ];

    for (const step of runs) {
      await step(ctx);
    }

    const final = finaliseConfig(ctx.config, layout);
    saveConfig(layout.configPath, final);

    printFinaleSummary(ui, final, layout);
  } finally {
    prompter.close();
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

function printBanner(ui: Ui): void {
  ui.line(
    `\n  ${ui.s.magenta("▲")}  ${ui.s.bold("Agentic Commerce Connector")}  ${ui.s.dim("— merchant setup")}\n`,
  );
}

function printFinaleSummary(
  ui: Ui,
  cfg: AccConfig,
  layout: DataDirLayout,
): void {
  ui.separator();
  ui.line(`  ${ui.s.green("✨")}  ${ui.s.bold("Setup complete.")}`);
  ui.line("");
  ui.line(`     ${ui.s.dim("data dir ")} ${layout.root}`);
  ui.line(`     ${ui.s.dim("skill   ")} ${cfg.skillMdPath}`);
  ui.line(
    `     ${ui.s.dim("wallet  ")} ${cfg.wallet?.address ?? ui.s.yellow("(not configured)")}`,
  );
  ui.line("");
  ui.line(
    `     Next: run ${ui.s.bold(ui.s.green("acc start"))} to boot the connector.`,
  );
  ui.line(
    `     More:  ${ui.s.dim("acc doctor")}  ${ui.s.dim("·")}  ${ui.s.dim("acc publish")}`,
  );
  ui.separator();
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
      { key: "b", label: "update Shopify connection only" },
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
    selfUrl: partial.selfUrl ?? "http://localhost:10000",
    skillMdPath: partial.skillMdPath ?? layout.skillMd,
  };
  if (partial.wallet) {
    return { ...base, wallet: partial.wallet };
  }
  return base;
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
