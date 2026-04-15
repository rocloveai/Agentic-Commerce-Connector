import pg from "pg";

let pool: pg.Pool | null = null;

export function initPool(connectionString: string): void {
  if (pool) return;
  pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (err) => {
    console.error("[DB Pool] Unexpected error:", err.message);
  });
  console.error("[DB] Pool initialized");
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("[DB] Pool not initialized. Call initPool() first.");
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.error("[DB] Pool closed");
  }
}
