#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Cross-compile the `acc` CLI into standalone binaries for every supported
// platform. One binary per target → `dist/acc-<os>-<arch>` → GitHub Actions
// bundles each into a `.tar.gz` and uploads to the release.
//
// Usage:
//   bun run scripts/build-binary.ts                  # all targets
//   bun run scripts/build-binary.ts darwin-arm64     # one target
//
// We compile from the CLI's entry (packages/cli/src/acc.ts) which imports
// @acc/connector at runtime — Bun bundles both workspace packages into a
// single self-contained binary. bun:sqlite is statically linked; no native
// `.node` files need to ship.
// ---------------------------------------------------------------------------

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

interface Target {
  readonly id: string;
  readonly bunTarget: string;
  readonly binaryName: string;
}

const TARGETS: readonly Target[] = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", binaryName: "acc" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64", binaryName: "acc" },
  { id: "linux-x64", bunTarget: "bun-linux-x64", binaryName: "acc" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", binaryName: "acc" },
];

// Bun exposes `import.meta.dir` as the script's directory. This file lives at
// <repo>/scripts/build-binary.ts, so the repo root is one level up.
const REPO_ROOT = dirname(import.meta.dir);
const ENTRY = join(REPO_ROOT, "packages", "cli", "src", "acc.ts");
const OUT_DIR = join(REPO_ROOT, "dist", "binaries");

async function main(): Promise<void> {
  const requested = process.argv[2];
  const targets = requested
    ? TARGETS.filter((t) => t.id === requested)
    : TARGETS;

  if (targets.length === 0) {
    console.error(`Unknown target: ${requested}`);
    console.error(`Known: ${TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  if (!existsSync(ENTRY)) {
    console.error(`Entry not found: ${ENTRY}`);
    process.exit(1);
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const target of targets) {
    const outFile = join(OUT_DIR, `acc-${target.id}`);
    console.log(`→ Building ${target.id}  (${target.bunTarget})`);
    // `better-sqlite3` is the Node fallback driver — it's only loaded when
    // the runtime isn't Bun. Marking it external avoids bundling a native
    // `.node` addon that would never run inside the compiled Bun binary.
    //
    // `pg` CANNOT be external: it's statically imported at module top level
    // in services/db/pool.ts, so a compiled binary needs it bundled — there
    // is no node_modules at runtime to resolve it from. Bun bundles the
    // pure-JS driver fine; its optional native libpq extension stays off.
    await $`bun build ${ENTRY} --compile --target=${target.bunTarget} --outfile=${outFile} --minify --external=better-sqlite3`;
    console.log(`  ✓ ${outFile}`);
  }

  console.log(`\nBuilt ${targets.length} binary(ies) under ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
