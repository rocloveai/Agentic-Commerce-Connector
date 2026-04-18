// Minimal ambient declaration for `bun:sqlite`.
//
// The module only exists at runtime under Bun, so tsc (which compiles under
// Node) has no way to resolve it. We don't pull in `@types/bun` here because
// it would pollute the global namespace with Bun-specific APIs we don't use
// and aren't compatible with Node. Covers exactly the surface used by
// ../services/db/sqlite.ts.

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    query(sql: string): {
      run(params?: unknown): void;
      get(params?: unknown): unknown;
      all(params?: unknown): unknown[];
    };
    close(): void;
  }
}
