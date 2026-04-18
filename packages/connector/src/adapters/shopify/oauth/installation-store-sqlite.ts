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
//
// Driver selection lives in ../../../services/db/sqlite.ts: bun:sqlite under
// the shipped binary, better-sqlite3 under Node for dev/tests.
// ---------------------------------------------------------------------------

import { openSqlite, type SqliteDatabase } from "../../../services/db/sqlite.js";
import {
  encryptToken,
  decryptToken,
} from "../../../services/crypto/token-cipher.js";
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
  key_version     INTEGER NOT NULL DEFAULT 1,
  token_expires_at INTEGER,
  refresh_token   TEXT
);
`;

/**
 * Idempotent column add for databases created by v0.4.x schema. Runs once
 * at store open; harmless on fresh DBs that already have the columns from
 * SCHEMA_SQL above.
 */
async function ensureSchemaV2(db: SqliteDatabase): Promise<void> {
  const cols = db.prepare("PRAGMA table_info(shopify_installations)").all() as Array<{
    readonly name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("token_expires_at")) {
    db.exec("ALTER TABLE shopify_installations ADD COLUMN token_expires_at INTEGER");
  }
  if (!names.has("refresh_token")) {
    db.exec("ALTER TABLE shopify_installations ADD COLUMN refresh_token TEXT");
  }
}

interface Row {
  readonly shop_domain: string;
  readonly admin_token: string;
  readonly storefront_token: string | null;
  readonly scopes: string;
  readonly installed_at: number;
  readonly uninstalled_at: number | null;
  readonly key_version: number;
  readonly token_expires_at: number | null;
  readonly refresh_token: string | null;
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

export async function createSqliteInstallationStore(
  opts: SqliteInstallationStoreOptions,
): Promise<SqliteInstallationStore> {
  if (!opts.encryptionKey) {
    throw new Error(
      "[SqliteInstallationStore] encryptionKey is required. This store never writes tokens in plaintext.",
    );
  }
  const db: SqliteDatabase = await openSqlite(opts.dbPath);
  // WAL gives us concurrent readers + one writer with no extra config.
  // `:memory:` ignores WAL silently, so the pragma is safe for tests too.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  await ensureSchemaV2(db);

  const getStmt = db.prepare(
    "SELECT * FROM shopify_installations WHERE shop_domain = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO shopify_installations
       (shop_domain, admin_token, storefront_token, scopes, installed_at, uninstalled_at, key_version, token_expires_at, refresh_token)
     VALUES (@shop_domain, @admin_token, @storefront_token, @scopes, @installed_at, @uninstalled_at, @key_version, @token_expires_at, @refresh_token)
     ON CONFLICT(shop_domain) DO UPDATE SET
       admin_token       = excluded.admin_token,
       storefront_token  = excluded.storefront_token,
       scopes            = excluded.scopes,
       installed_at      = excluded.installed_at,
       uninstalled_at    = excluded.uninstalled_at,
       key_version       = excluded.key_version,
       token_expires_at  = excluded.token_expires_at,
       refresh_token     = excluded.refresh_token`,
  );
  const uninstallStmt = db.prepare(
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
      tokenExpiresAt: row.token_expires_at,
      refreshToken: row.refresh_token
        ? decryptToken(row.refresh_token, opts.encryptionKey)
        : null,
    };
  }

  return {
    async get(shop: string): Promise<ShopInstallation | null> {
      const row = getStmt.get([shop]) as Row | undefined;
      return row ? rowToInstallation(row) : null;
    },

    async save(installation: ShopInstallation): Promise<void> {
      // Use loose equality so callers may pass either `null` (explicitly
      // absent) or omit the field entirely (undefined) — both map to NULL
      // in SQLite. Same for storefront_token; matters for test fixtures and
      // migrations from v0.4.x rows that lack the new columns.
      upsertStmt.run({
        shop_domain: installation.shopDomain,
        admin_token: encryptToken(installation.adminToken, opts.encryptionKey),
        storefront_token:
          installation.storefrontToken == null
            ? null
            : encryptToken(installation.storefrontToken, opts.encryptionKey),
        scopes: installation.scopes.join(","),
        installed_at: installation.installedAt,
        uninstalled_at: installation.uninstalledAt ?? null,
        key_version: 1,
        token_expires_at: installation.tokenExpiresAt ?? null,
        refresh_token:
          installation.refreshToken == null
            ? null
            : encryptToken(installation.refreshToken, opts.encryptionKey),
      });
    },

    async markUninstalled(shop: string, at: number): Promise<void> {
      uninstallStmt.run([at, shop]);
    },

    async list(): Promise<readonly ShopInstallation[]> {
      return (listStmt.all() as Row[]).map(rowToInstallation);
    },

    close(): void {
      if (db.open) db.close();
    },
  };
}
