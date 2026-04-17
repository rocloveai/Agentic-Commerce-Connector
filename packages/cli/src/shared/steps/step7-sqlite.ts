// ---------------------------------------------------------------------------
// Run the SQLite schema migration for `shopify_installations`.
//
// SOURCE OF TRUTH: the DDL below is an exact copy of the schema used by
// packages/connector/src/adapters/shopify/oauth/installation-store-sqlite.ts.
// Both files use CREATE TABLE IF NOT EXISTS, so schema skew is detected at
// runtime via column-mismatch errors. Phase 9 `acc doctor` can add an
// automated drift check; for now, a manual keep-in-sync comment is enough.
// ---------------------------------------------------------------------------

import { openSqlite } from "@acc/connector/sqlite";
import type { StepContext, StepOutcome } from "./context.js";

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

export async function stepSqlite(ctx: StepContext): Promise<StepOutcome> {
  const db = await openSqlite(ctx.layout.dbFile);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  } finally {
    db.close();
  }
  return { applied: true, summary: `SQLite schema applied to ${ctx.layout.dbFile}` };
}
