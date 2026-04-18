// ---------------------------------------------------------------------------
// `acc start` — boot the connector in-process.
//
// Loads acc-data/.env into process.env (overriding nothing that's already
// exported), sets TRANSPORT=http so the UCP/REST/MCP surfaces come up, then
// calls the exported startServer() — no subprocess, one PID.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDataDir } from "../shared/data-dir.js";

export async function runStart(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const dataDirArg = flags.get("data-dir") ?? defaultDataDir();
  const layout = resolveDataDir(dataDirArg);

  if (!layout.alreadyInitialised) {
    process.stderr.write(
      `acc: no config at ${layout.configPath}\n` +
        `     run 'acc init --data-dir=${dataDirArg}' first.\n`,
    );
    process.exit(2);
  }

  loadEnvFile(layout.envPath);

  // Default: HTTP transport unless caller explicitly picked stdio.
  if (!process.env.TRANSPORT) process.env.TRANSPORT = "http";
  // Point the OAuth installation store at the data dir.
  if (!process.env.ACC_DATA_DIR) process.env.ACC_DATA_DIR = layout.root;

  const { startServer } = await import("@acc/connector/server");
  await startServer();

  // Block until SIGINT/SIGTERM. Under Node, `createServer().listen()`
  // holds the event loop open via its listening socket, so this wouldn't
  // be needed — but Bun's compiled runtime drains the loop and exits once
  // the top-level async chain completes, even while an HTTP server is
  // actively listening. Hanging on a never-resolving Promise keeps the
  // process alive until a signal arrives.
  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      process.stderr.write(`\n[acc] ${sig} received, shutting down.\n`);
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=", 2);
    if (k) map.set(k, v ?? "true");
  }
  return map;
}

function defaultDataDir(): string {
  // Prefer ~/.acc (OpenCode convention for single-user installs); fall back to
  // ./acc-data if the user is running from a checked-out repo.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const global = join(home, ".acc");
    if (existsSync(join(global, "config.json"))) return global;
  }
  return resolve("./acc-data");
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (!key || process.env[key] !== undefined) continue;
    let value = rawValue ?? "";
    // Strip wrapping quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
