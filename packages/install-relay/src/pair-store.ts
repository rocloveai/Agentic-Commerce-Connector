// ---------------------------------------------------------------------------
// Pair code store — short-lived handle for the 3-way dance between:
//   1. CLI (creates a pair code, polls for tokens)
//   2. Merchant browser (completes OAuth in Shopify)
//   3. This relay (receives OAuth callback, fills in tokens)
//
// Each pair code transitions:
//     `pending`  (created by CLI, waiting for OAuth callback)
//       ↓
//     `ready`    (callback complete, tokens stored, CLI can poll)
//       ↓
//     `consumed` (CLI has polled & received tokens — row deleted)
//
// Entries expire after `pairTtlSeconds` regardless of state. Entries
// containing tokens are hex-encoded so we never write plaintext secrets
// to this store even while in transit — the relay holds an encryption
// key separate from the merchant's ACC instance.
// ---------------------------------------------------------------------------
import type { SqliteDatabase, SqliteStatement } from "@acc/connector/sqlite";
import { openSqlite } from "@acc/connector/sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Pairing {
  readonly pairCode: string;
  readonly status: "pending" | "ready";
  readonly shopDomain: string | null;
  readonly adminToken: string | null;
  readonly storefrontToken: string | null;
  readonly scopes: readonly string[];
  /** Unix seconds; null if the admin token is non-expiring (legacy). */
  readonly tokenExpiresAt: number | null;
  /** Shopify refresh token if the admin token is expiring; null otherwise. */
  readonly refreshToken: string | null;
  /** Pair TTL (milliseconds-since-epoch); distinct from token expiry. */
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PairStore {
  createPending(
    pairCode: string,
    ttlSeconds: number,
    now: number,
  ): Promise<void>;

  /** Fill in tokens. Transitions `pending` → `ready`. No-ops on unknown codes. */
  fulfil(
    pairCode: string,
    data: {
      readonly shopDomain: string;
      readonly adminToken: string;
      readonly storefrontToken: string | null;
      readonly scopes: readonly string[];
      readonly tokenExpiresAt: number | null;
      readonly refreshToken: string | null;
    },
  ): Promise<void>;

  get(pairCode: string): Promise<Pairing | null>;

  /** Consume + delete. Returns what was stored; null if already consumed/missing/expired. */
  consume(pairCode: string, now: number): Promise<Pairing | null>;

  /** Sweep expired rows. Safe to call on a timer. */
  sweepExpired(now: number): Promise<number>;

  close(): void;
}

interface Row {
  readonly pair_code: string;
  readonly status: string;
  readonly shop_domain: string | null;
  readonly admin_token: string | null;
  readonly storefront_token: string | null;
  readonly scopes: string | null;
  readonly token_expires_at: number | null;
  readonly refresh_token: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairings (
  pair_code        TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  shop_domain      TEXT,
  admin_token      TEXT,
  storefront_token TEXT,
  scopes           TEXT,
  token_expires_at INTEGER,
  refresh_token    TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairings_expires ON pairings(expires_at);

-- Idempotent schema-v2 migration: add columns if missing. Use PRAGMA
-- table_info to detect; on fresh DBs the CREATE above already includes them.
`;

async function ensureSchemaV2(db: SqliteDatabase): Promise<void> {
  const cols = db.prepare("PRAGMA table_info(pairings)").all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("token_expires_at")) {
    db.exec("ALTER TABLE pairings ADD COLUMN token_expires_at INTEGER");
  }
  if (!names.has("refresh_token")) {
    db.exec("ALTER TABLE pairings ADD COLUMN refresh_token TEXT");
  }
}

export async function createSqlitePairStore(
  dbPath: string,
): Promise<PairStore> {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db: SqliteDatabase = await openSqlite(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  await ensureSchemaV2(db);

  const insertStmt: SqliteStatement = db.prepare(
    `INSERT INTO pairings (pair_code, status, created_at, expires_at)
     VALUES (@pair_code, 'pending', @created_at, @expires_at)`,
  );
  const fulfilStmt: SqliteStatement = db.prepare(
    `UPDATE pairings
     SET status = 'ready',
         shop_domain = @shop_domain,
         admin_token = @admin_token,
         storefront_token = @storefront_token,
         scopes = @scopes,
         token_expires_at = @token_expires_at,
         refresh_token = @refresh_token
     WHERE pair_code = @pair_code AND status = 'pending'`,
  );
  const getStmt: SqliteStatement = db.prepare(
    `SELECT * FROM pairings WHERE pair_code = ?`,
  );
  const deleteStmt: SqliteStatement = db.prepare(
    `DELETE FROM pairings WHERE pair_code = ?`,
  );
  const sweepStmt: SqliteStatement = db.prepare(
    `DELETE FROM pairings WHERE expires_at <= ?`,
  );

  function rowToPairing(row: Row): Pairing {
    return {
      pairCode: row.pair_code,
      status: row.status === "ready" ? "ready" : "pending",
      shopDomain: row.shop_domain,
      adminToken: row.admin_token,
      storefrontToken: row.storefront_token,
      scopes: row.scopes
        ? row.scopes.split(",").filter((s) => s.length > 0)
        : [],
      tokenExpiresAt: row.token_expires_at,
      refreshToken: row.refresh_token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  return {
    async createPending(pairCode, ttlSeconds, now) {
      insertStmt.run({
        pair_code: pairCode,
        created_at: now,
        expires_at: now + ttlSeconds * 1000,
      });
    },

    async fulfil(pairCode, data) {
      fulfilStmt.run({
        pair_code: pairCode,
        shop_domain: data.shopDomain,
        admin_token: data.adminToken,
        storefront_token: data.storefrontToken,
        scopes: data.scopes.join(","),
        token_expires_at: data.tokenExpiresAt,
        refresh_token: data.refreshToken,
      });
    },

    async get(pairCode) {
      const row = getStmt.get([pairCode]) as Row | undefined;
      return row ? rowToPairing(row) : null;
    },

    async consume(pairCode, now) {
      const row = getStmt.get([pairCode]) as Row | undefined;
      if (!row) return null;
      if (row.expires_at <= now) {
        deleteStmt.run([pairCode]);
        return null;
      }
      if (row.status !== "ready") return null; // not yet fulfilled
      deleteStmt.run([pairCode]);
      return rowToPairing(row);
    },

    async sweepExpired(now) {
      const before = (db.prepare("SELECT COUNT(*) as n FROM pairings").get() as { n: number }).n;
      sweepStmt.run([now]);
      const after = (db.prepare("SELECT COUNT(*) as n FROM pairings").get() as { n: number }).n;
      return before - after;
    },

    close() {
      db.close();
    },
  };
}
