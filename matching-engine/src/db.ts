// Shared real Neon database connection (private development log GO LIVE item #2's own real need —
// quota-gate.ts is the first module in this codebase that talks to the database at request
// time, not via a one-shot script like apply-schema.ts). A lazily-created `pg.Pool`, not a
// single long-lived Client — a Pool is the correct primitive for something that will
// eventually be called per-request from a real server route (private development log item #3, not
// yet built), reusing/recycling real connections rather than opening one per call.
//
// Standing rule respected: reads DATABASE_URL from matching-engine/.env via `pg`'s own
// connection-string handling — this module never logs, prints, or otherwise surfaces the
// value itself.
import "dotenv/config";
import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("db.ts: DATABASE_URL is not set in matching-engine/.env.");
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

/** For scripts/tests that need a clean shutdown rather than leaving the pool open until process exit. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
