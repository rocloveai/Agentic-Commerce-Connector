// ---------------------------------------------------------------------------
// Postgres-backed installation store.
//
// Opt-in backend for hosted / multi-tenant deployments. The schema mirrors
// the SQLite version (same column names, same encrypted payload format) so
// a deployment can migrate between backends with a single `COPY`.
//
// The PG pool is injected, not acquired from services/db/pool — this keeps
// the OAuth module testable without touching the global pool.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import { encryptToken, decryptToken } from "../../../services/crypto/token-cipher.js";
import type { ShopInstallation } from "./types.js";
import type { InstallationStore } from "./installation-store.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shopify_installations (
  shop_domain     TEXT PRIMARY KEY,
  admin_token     TEXT NOT NULL,
  storefront_token TEXT,
  scopes          TEXT NOT NULL,
  installed_at    BIGINT NOT NULL,
  uninstalled_at  BIGINT,
  key_version     INTEGER NOT NULL DEFAULT 1
);
`;

interface Row {
  readonly shop_domain: string;
  readonly admin_token: string;
  readonly storefront_token: string | null;
  readonly scopes: string;
  readonly installed_at: string | number;
  readonly uninstalled_at: string | number | null;
  readonly key_version: number;
}

export interface PostgresInstallationStoreOptions {
  readonly pool: Pool;
  readonly encryptionKey: string;
}

export async function createPostgresInstallationStore(
  opts: PostgresInstallationStoreOptions,
): Promise<InstallationStore> {
  if (!opts.encryptionKey) {
    throw new Error(
      "[PostgresInstallationStore] encryptionKey is required. This store never writes tokens in plaintext.",
    );
  }
  await opts.pool.query(SCHEMA_SQL);

  function rowToInstallation(row: Row): ShopInstallation {
    return {
      shopDomain: row.shop_domain,
      adminToken: decryptToken(row.admin_token, opts.encryptionKey),
      storefrontToken: row.storefront_token
        ? decryptToken(row.storefront_token, opts.encryptionKey)
        : null,
      scopes: row.scopes.split(",").filter((s) => s.length > 0),
      installedAt: Number(row.installed_at),
      uninstalledAt:
        row.uninstalled_at === null ? null : Number(row.uninstalled_at),
    };
  }

  return {
    async get(shop: string): Promise<ShopInstallation | null> {
      const res = await opts.pool.query<Row>(
        "SELECT * FROM shopify_installations WHERE shop_domain = $1",
        [shop],
      );
      return res.rows[0] ? rowToInstallation(res.rows[0]) : null;
    },

    async save(installation: ShopInstallation): Promise<void> {
      await opts.pool.query(
        `INSERT INTO shopify_installations
           (shop_domain, admin_token, storefront_token, scopes, installed_at, uninstalled_at, key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (shop_domain) DO UPDATE SET
           admin_token      = excluded.admin_token,
           storefront_token = excluded.storefront_token,
           scopes           = excluded.scopes,
           installed_at     = excluded.installed_at,
           uninstalled_at   = excluded.uninstalled_at,
           key_version      = excluded.key_version`,
        [
          installation.shopDomain,
          encryptToken(installation.adminToken, opts.encryptionKey),
          installation.storefrontToken === null
            ? null
            : encryptToken(installation.storefrontToken, opts.encryptionKey),
          installation.scopes.join(","),
          installation.installedAt,
          installation.uninstalledAt,
          1,
        ],
      );
    },

    async markUninstalled(shop: string, at: number): Promise<void> {
      await opts.pool.query(
        "UPDATE shopify_installations SET uninstalled_at = $1 WHERE shop_domain = $2",
        [at, shop],
      );
    },

    async list(): Promise<readonly ShopInstallation[]> {
      const res = await opts.pool.query<Row>(
        "SELECT * FROM shopify_installations",
      );
      return res.rows.map(rowToInstallation);
    },
  };
}
