// ---------------------------------------------------------------------------
// SQLite driver abstraction.
//
// Under Bun (the distribution target — `bun build --compile` produces our
// shipped binary) we use the built-in `bun:sqlite`, which is statically
// linked and needs no native-module bundling. Under Node (dev, tests, legacy
// `node build/server.js`) we fall back to `better-sqlite3`.
//
// The surface here covers exactly what the installation store and the CLI
// `step7-sqlite` consume: open a file, pragma, exec DDL, prepare statements
// with positional (?) or named (@key) parameters, run/get/all, close.
// Keeping the shim small avoids growing a second SQL abstraction; if a caller
// needs something more exotic it can import from the underlying driver
// directly under a runtime guard.
// ---------------------------------------------------------------------------

export interface SqliteStatement {
  run(params?: unknown): void;
  get(params?: unknown): unknown;
  all(params?: unknown): unknown[];
}

export interface SqliteDatabase {
  readonly open: boolean;
  pragma(stmt: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const isBun =
  typeof process !== "undefined" &&
  typeof (process as unknown as { versions?: Record<string, string> }).versions?.bun === "string";

export async function openSqlite(path: string): Promise<SqliteDatabase> {
  return isBun ? await openBun(path) : await openNode(path);
}

// ── Bun backend ─────────────────────────────────────────────────────────────

async function openBun(path: string): Promise<SqliteDatabase> {
  const mod = (await import("bun:sqlite")) as {
    Database: new (path: string) => BunDb;
  };
  const db = new mod.Database(path);
  let closed = false;
  return {
    get open() {
      return !closed;
    },
    pragma(stmt) {
      return db.query(`PRAGMA ${stmt}`).all();
    },
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const q = db.query(sql);
      return {
        run(params) {
          if (params === undefined) q.run();
          else q.run(params as never);
        },
        get(params) {
          return params === undefined ? q.get() : q.get(params as never);
        },
        all(params) {
          return params === undefined ? q.all() : q.all(params as never);
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

interface BunDb {
  exec(sql: string): void;
  query(sql: string): BunQuery;
  close(): void;
}

interface BunQuery {
  run(params?: unknown): void;
  get(params?: unknown): unknown;
  all(params?: unknown): unknown[];
}

// ── Node backend ────────────────────────────────────────────────────────────

async function openNode(path: string): Promise<SqliteDatabase> {
  const { default: Database } = (await import("better-sqlite3")) as {
    default: new (path: string) => BetterSqliteDb;
  };
  const db = new Database(path);
  return {
    get open() {
      return db.open;
    },
    pragma(stmt) {
      return db.pragma(stmt);
    },
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(params) {
          if (params === undefined) stmt.run();
          else stmt.run(params as never);
        },
        get(params) {
          return params === undefined ? stmt.get() : stmt.get(params as never);
        },
        all(params) {
          return params === undefined ? stmt.all() : stmt.all(params as never);
        },
      };
    },
    close() {
      if (db.open) db.close();
    },
  };
}

interface BetterSqliteDb {
  readonly open: boolean;
  pragma(stmt: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    run(params?: unknown): void;
    get(params?: unknown): unknown;
    all(params?: unknown): unknown[];
  };
  close(): void;
}
