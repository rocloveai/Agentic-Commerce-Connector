// ---------------------------------------------------------------------------
// SQLite-backed installation store.
//
// Default persistence for self-hosted single-shop deployments. Storage is
// one file on disk (e.g. ./acc-data/db/acc.sqlite). Reads/writes are
// synchronous at the driver level; we still surface async Promises so the
// InstallationStore interface is backend-agnostic.
//
// Schema is dialect-neutral — `TEXT` for strings, `INTEGER` for timestamps
// (unix ms) and key_version. Same DDL works verbatim on Postgres (with
// BIGINT as a finer type for ms), so the Pg impl can reuse most of the
// row-mapping code unchanged.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { encryptToken, decryptToken } from "../../../services/crypto/token-cipher.js";
import type { ShopInstallation } from "./types.js";
import type { InstallationStore } from "./installation-store.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shopify_installations (
  shop_domain     TEXT PRIMARY KEY,
  admin_token     TEXT NOT NULL,
  storefront_token TEXT,
  scopes          TEXT NOT NULL,
  installed_at    INTEGER NOT NULL,
  uninstalled_at  INTEGER,
  key_version     INTEGER NOT NULL DEFAULT 1
);
`;

interface Row {
  readonly shop_domain: string;
  readonly admin_token: string;
  readonly storefront_token: string | null;
  readonly scopes: string;
  readonly installed_at: number;
  readonly uninstalled_at: number | null;
  readonly key_version: number;
}

export interface SqliteInstallationStoreOptions {
  /** File path or `:memory:`. Caller is responsible for the parent dir. */
  readonly dbPath: string;
  /** 64-hex AES-256 key used for admin/storefront token encryption. */
  readonly encryptionKey: string;
  /** Injectable clock for tests (only used during uninstall). */
  readonly now?: () => number;
}

export interface SqliteInstallationStore extends InstallationStore {
  /** Close the underlying DB handle. Safe to call multiple times. */
  close(): void;
}

export function createSqliteInstallationStore(
  opts: SqliteInstallationStoreOptions,
): SqliteInstallationStore {
  if (!opts.encryptionKey) {
    throw new Error(
      "[SqliteInstallationStore] encryptionKey is required. This store never writes tokens in plaintext.",
    );
  }
  const db: SqliteDb = new Database(opts.dbPath);
  // WAL gives us concurrent readers + one writer with no extra config.
  // `:memory:` ignores WAL silently, so the pragma is safe for tests too.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const getStmt = db.prepare<[string]>(
    "SELECT * FROM shopify_installations WHERE shop_domain = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO shopify_installations
       (shop_domain, admin_token, storefront_token, scopes, installed_at, uninstalled_at, key_version)
     VALUES (@shop_domain, @admin_token, @storefront_token, @scopes, @installed_at, @uninstalled_at, @key_version)
     ON CONFLICT(shop_domain) DO UPDATE SET
       admin_token      = excluded.admin_token,
       storefront_token = excluded.storefront_token,
       scopes           = excluded.scopes,
       installed_at     = excluded.installed_at,
       uninstalled_at   = excluded.uninstalled_at,
       key_version      = excluded.key_version`,
  );
  const uninstallStmt = db.prepare<[number, string]>(
    "UPDATE shopify_installations SET uninstalled_at = ? WHERE shop_domain = ?",
  );
  const listStmt = db.prepare("SELECT * FROM shopify_installations");

  function rowToInstallation(row: Row): ShopInstallation {
    return {
      shopDomain: row.shop_domain,
      adminToken: decryptToken(row.admin_token, opts.encryptionKey),
      storefrontToken: row.storefront_token
        ? decryptToken(row.storefront_token, opts.encryptionKey)
        : null,
      scopes: row.scopes.split(",").filter((s) => s.length > 0),
      installedAt: row.installed_at,
      uninstalledAt: row.uninstalled_at,
    };
  }

  return {
    async get(shop: string): Promise<ShopInstallation | null> {
      const row = getStmt.get(shop) as Row | undefined;
      return row ? rowToInstallation(row) : null;
    },

    async save(installation: ShopInstallation): Promise<void> {
      upsertStmt.run({
        shop_domain: installation.shopDomain,
        admin_token: encryptToken(installation.adminToken, opts.encryptionKey),
        storefront_token:
          installation.storefrontToken === null
            ? null
            : encryptToken(installation.storefrontToken, opts.encryptionKey),
        scopes: installation.scopes.join(","),
        installed_at: installation.installedAt,
        uninstalled_at: installation.uninstalledAt,
        key_version: 1,
      });
    },

    async markUninstalled(shop: string, at: number): Promise<void> {
      uninstallStmt.run(at, shop);
    },

    async list(): Promise<readonly ShopInstallation[]> {
      return (listStmt.all() as Row[]).map(rowToInstallation);
    },

    close(): void {
      if (db.open) db.close();
    },
  };
}
