// ---------------------------------------------------------------------------
// `acc doctor` — environment + connectivity diagnostics.
//
// Runs a sequence of named checks, prints [OK] / [WARN] / [FAIL] per line, and
// exits non-zero if any check is FAIL. Intended as the first step when a
// merchant says "it doesn't work" — should surface the most common breakages
// (missing config, unreachable portal, encryption key drift) without asking
// the user to read a logfile.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../shared/data-dir.js";

type Level = "OK" | "WARN" | "FAIL";

interface Check {
  readonly name: string;
  readonly level: Level;
  readonly detail: string;
}

export async function runDoctor(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const dataDirArg = flags.get("data-dir") ?? defaultDataDir();
  const layout = resolveDataDir(dataDirArg);

  const checks: Check[] = [];

  checks.push(checkDataDir(layout.root));
  checks.push(checkConfig(layout.configPath));
  checks.push(checkEnv(layout.envPath));
  checks.push(checkEncKey(layout.encKeyFile));
  checks.push(checkSignerKey(layout.signerKeyFile));
  checks.push(checkSqlite(layout.dbFile));
  checks.push(checkSkill(layout.skillMd));

  const portalUrl = readPortalUrl(layout.envPath);
  if (portalUrl) checks.push(await checkPortalReachable(portalUrl));

  let failed = 0;
  for (const c of checks) {
    const glyph = c.level === "OK" ? "✓" : c.level === "WARN" ? "!" : "✗";
    process.stdout.write(`  [${glyph}] ${c.name.padEnd(24)} ${c.detail}\n`);
    if (c.level === "FAIL") failed++;
  }

  process.stdout.write(
    `\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}\n`,
  );
  if (failed > 0) process.exit(1);
}

function checkDataDir(root: string): Check {
  if (!existsSync(root)) {
    return { name: "data dir", level: "FAIL", detail: `missing: ${root}` };
  }
  const mode = statSync(root).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      name: "data dir",
      level: "WARN",
      detail: `${root} has loose perms (${mode.toString(8)}); expected 700`,
    };
  }
  return { name: "data dir", level: "OK", detail: root };
}

function checkConfig(path: string): Check {
  if (!existsSync(path))
    return { name: "config.json", level: "FAIL", detail: `missing: ${path}` };
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (!cfg || typeof cfg !== "object")
      return { name: "config.json", level: "FAIL", detail: "not an object" };
    return { name: "config.json", level: "OK", detail: path };
  } catch (err) {
    return {
      name: "config.json",
      level: "FAIL",
      detail: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkEnv(path: string): Check {
  if (!existsSync(path))
    return {
      name: ".env",
      level: "WARN",
      detail: `missing: ${path} (server will refuse to start)`,
    };
  return { name: ".env", level: "OK", detail: path };
}

function checkEncKey(path: string): Check {
  if (!existsSync(path))
    return { name: "encryption key", level: "FAIL", detail: `missing: ${path}` };
  const size = statSync(path).size;
  if (size < 32)
    return {
      name: "encryption key",
      level: "FAIL",
      detail: `${path} is ${size} bytes, expected ≥32`,
    };
  return { name: "encryption key", level: "OK", detail: `${size} bytes` };
}

function checkSignerKey(path: string): Check {
  if (!existsSync(path))
    return {
      name: "signer key",
      level: "WARN",
      detail: `missing: ${path} (required for 'acc publish')`,
    };
  return { name: "signer key", level: "OK", detail: path };
}

function checkSqlite(path: string): Check {
  if (!existsSync(path))
    return {
      name: "sqlite db",
      level: "WARN",
      detail: `missing: ${path} (will be created on first install)`,
    };
  return { name: "sqlite db", level: "OK", detail: path };
}

function checkSkill(path: string): Check {
  if (!existsSync(path))
    return {
      name: "skill template",
      level: "WARN",
      detail: `missing: ${path} (run 'acc skill init')`,
    };
  return { name: "skill template", level: "OK", detail: path };
}

async function checkPortalReachable(url: string): Promise<Check> {
  const target = url.replace(/\/+$/, "") + "/health";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(target, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok)
      return {
        name: "portal reachable",
        level: "WARN",
        detail: `${target} → ${res.status}`,
      };
    return { name: "portal reachable", level: "OK", detail: target };
  } catch (err) {
    return {
      name: "portal reachable",
      level: "WARN",
      detail: `${target} unreachable (server not running?)`,
    };
  }
}

function readPortalUrl(envPath: string): string | null {
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(SELF_URL|PORTAL_URL)\s*=\s*(.*)$/);
    if (m && m[2]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) return v;
    }
  }
  return null;
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
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const global = join(home, ".acc");
    if (existsSync(join(global, "config.json"))) return global;
  }
  return "./acc-data";
}
