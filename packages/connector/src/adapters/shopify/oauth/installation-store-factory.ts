// ---------------------------------------------------------------------------
// Storage backend selector.
//
// Picks one of three concrete InstallationStore implementations at boot:
//
//   1. `DATABASE_URL` starts with `postgres://` → PostgresInstallationStore
//      (hosted / multi-tenant path).
//   2. Otherwise, write to SQLite at `<dataDir>/db/acc.sqlite`. Default data
//      dir is `./acc-data`; override with `ACC_DATA_DIR`. This is the
//      self-host-first default that matches the `acc init` wizard layout.
//   3. Tests can bypass the env sniffing entirely by calling the concrete
//      factory directly.
//
// The selector is purely about provisioning — once constructed, every caller
// interacts through the InstallationStore interface.
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import type { Pool } from "pg";
import type { InstallationStore } from "./installation-store.js";
import { createSqliteInstallationStore } from "./installation-store-sqlite.js";
import { createPostgresInstallationStore } from "./installation-store-postgres.js";

export type StorageBackendKind = "sqlite" | "postgres";

export interface StorageSelection {
  readonly backend: StorageBackendKind;
  readonly store: InstallationStore;
  /**
   * Human-readable description of where the data lives. Printed on boot so
   * operators can tell at a glance whether they're on the default SQLite
   * file or the opt-in Postgres backend.
   */
  readonly describe: string;
}

export interface SelectInstallationStoreOptions {
  readonly encryptionKey: string;
  readonly databaseUrl: string;
  readonly dataDir: string;
  /** Dependency-injected pool factory — tests stub this. */
  readonly createPool?: (url: string) => Promise<Pool> | Pool;
}

async function defaultCreatePool(url: string): Promise<Pool> {
  // Dynamic import keeps `pg` off the hot path when SQLite is chosen and
  // avoids pulling the driver into test bundles that only exercise SQLite.
  const pg = await import("pg");
  return new pg.default.Pool({ connectionString: url, max: 5 });
}

export async function selectInstallationStore(
  opts: SelectInstallationStoreOptions,
): Promise<StorageSelection> {
  if (opts.databaseUrl && /^postgres(?:ql)?:\/\//i.test(opts.databaseUrl)) {
    const createPool = opts.createPool ?? defaultCreatePool;
    const pool = await createPool(opts.databaseUrl);
    const store = await createPostgresInstallationStore({
      pool,
      encryptionKey: opts.encryptionKey,
    });
    return {
      backend: "postgres",
      store,
      describe: `Postgres (${redactUrl(opts.databaseUrl)})`,
    };
  }

  const resolvedDataDir = isAbsolute(opts.dataDir)
    ? opts.dataDir
    : resolve(process.cwd(), opts.dataDir);
  const dbPath = `${resolvedDataDir}/db/acc.sqlite`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = createSqliteInstallationStore({
    dbPath,
    encryptionKey: opts.encryptionKey,
  });
  return {
    backend: "sqlite",
    store,
    describe: `SQLite (${dbPath})`,
  };
}

function redactUrl(url: string): string {
  // Hide password fragment before logging — otherwise `postgres://user:pw@host`
  // ends up in console.error.
  return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}
