// ---------------------------------------------------------------------------
// `acc shopify connect` — build the install URL + QR, then poll the local
// SQLite installation store until the shop appears (or timeout).
//
// The CLI writes nothing to the store; the connector owns writes. We query
// read-only to detect success.
// ---------------------------------------------------------------------------

import { openSqlite } from "@acc/connector/sqlite";
import { existsSync } from "node:fs";
import { resolveDataDir } from "../../shared/data-dir.js";
import { loadConfig } from "../../shared/config-store.js";
import { renderQr } from "../../shared/qr.js";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

export interface ConnectOptions {
  readonly shop: string;
  readonly printUrlOnly?: boolean;
  readonly dataDir?: string;
  /** Injectable sleep for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Override for testing (skip QR). */
  readonly skipQr?: boolean;
}

export interface ConnectResult {
  readonly installed: boolean;
  readonly installUrl: string;
}

export async function runShopifyConnect(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const shop = flags.get("shop");
  if (!shop) throw new Error("Usage: acc shopify connect --shop=<X>.myshopify.com");
  if (!SHOP_RE.test(shop)) {
    throw new Error(`invalid shop domain: ${shop} (expected <handle>.myshopify.com)`);
  }
  const result = await connect({
    shop,
    printUrlOnly: flags.has("print-url-only"),
    dataDir: flags.get("data-dir"),
  });
  if (!result.installed) {
    process.stderr.write("Timed out waiting for installation.\n");
    process.exit(1);
  }
}

export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const layout = resolveDataDir(opts.dataDir ?? "./acc-data");
  const config = loadConfig(layout.configPath);
  if (!config) {
    throw new Error(
      `No config.json found at ${layout.configPath}. Run 'acc init' first.`,
    );
  }

  const installUrl = `${config.selfUrl.replace(/\/+$/, "")}/auth/shopify/install?shop=${encodeURIComponent(opts.shop)}`;

  process.stdout.write(`\nShopify install URL for ${opts.shop}:\n  ${installUrl}\n\n`);
  if (!opts.printUrlOnly && !opts.skipQr) {
    process.stdout.write(renderQr(installUrl) + "\n");
  }

  if (opts.printUrlOnly) {
    return { installed: false, installUrl };
  }

  if (!existsSync(layout.dbFile)) {
    throw new Error(
      `SQLite DB not found at ${layout.dbFile}. Run 'acc init' first.`,
    );
  }

  const installed = await pollUntilInstalled(layout.dbFile, opts.shop, opts);
  if (installed) {
    process.stdout.write(`\n✓ ${opts.shop} is now installed.\n`);
  }
  return { installed, installUrl };
}

async function pollUntilInstalled(
  dbPath: string,
  shop: string,
  opts: ConnectOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + POLL_TIMEOUT_MS;

  process.stdout.write("Polling for installation…\n");
  while (now() < deadline) {
    const installed = await readInstalled(dbPath, shop);
    if (installed) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function readInstalled(dbPath: string, shop: string): Promise<boolean> {
  const db = await openSqlite(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT installed_at, uninstalled_at FROM shopify_installations WHERE shop_domain = ?",
      )
      .get([shop]) as { installed_at: number; uninstalled_at: number | null } | undefined;
    if (!row) return false;
    return row.uninstalled_at === null;
  } finally {
    db.close();
  }
}

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
