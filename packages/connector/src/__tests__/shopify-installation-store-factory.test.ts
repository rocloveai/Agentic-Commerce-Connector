/**
 * Tests for the backend-selection logic. Concrete-store behaviour is covered
 * by the sqlite + postgres suites; here we only care that the right one is
 * picked under which env shape, and that sensitive URL fragments are not
 * logged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { selectInstallationStore } from "../adapters/shopify/oauth/installation-store-factory.js";

const KEY = "a".repeat(64);
const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "acc-data-"));
  cleanupDirs.push(d);
  return d;
}

describe("selectInstallationStore — backend selection", () => {
  it("falls back to SQLite when DATABASE_URL is empty", async () => {
    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "",
      dataDir: tmpDataDir(),
    });
    expect(sel.backend).toBe("sqlite");
    expect(sel.describe).toMatch(/SQLite/);
  });

  it("creates the db/ subdirectory under the data dir on demand", async () => {
    const data = tmpDataDir();
    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "",
      dataDir: data,
    });
    expect(sel.describe).toContain(`${data}/db/acc.sqlite`);
  });

  it("picks Postgres when DATABASE_URL starts with postgres://", async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const fakePool: Pool = {
      async query(sql: string, params?: readonly unknown[]) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 } as unknown as Awaited<
          ReturnType<Pool["query"]>
        >;
      },
    } as unknown as Pool;

    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "postgres://u:p@localhost/test",
      dataDir: tmpDataDir(),
      createPool: () => fakePool,
    });
    expect(sel.backend).toBe("postgres");
    expect(queries.some((q) => /CREATE TABLE/i.test(q.sql))).toBe(true);
  });

  it("also accepts postgresql:// URLs", async () => {
    const fakePool = { async query() { return { rows: [] }; } } as unknown as Pool;
    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "postgresql://u:p@localhost/test",
      dataDir: tmpDataDir(),
      createPool: () => fakePool,
    });
    expect(sel.backend).toBe("postgres");
  });

  it("does not pick Postgres for unrelated URLs (falls back to SQLite)", async () => {
    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "mysql://u:p@localhost/test",
      dataDir: tmpDataDir(),
    });
    expect(sel.backend).toBe("sqlite");
  });

  it("redacts the password in the describe string", async () => {
    const fakePool = { async query() { return { rows: [] }; } } as unknown as Pool;
    const sel = await selectInstallationStore({
      encryptionKey: KEY,
      databaseUrl: "postgres://alice:super-secret@db.example.com/acc",
      dataDir: tmpDataDir(),
      createPool: () => fakePool,
    });
    expect(sel.describe).toContain("alice");
    expect(sel.describe).not.toContain("super-secret");
    expect(sel.describe).toContain("***");
  });

  it("bubbles up encryption-key validation errors on SQLite", async () => {
    await expect(
      selectInstallationStore({
        encryptionKey: "",
        databaseUrl: "",
        dataDir: tmpDataDir(),
      }),
    ).rejects.toThrow(/encryptionKey is required/);
  });
});
