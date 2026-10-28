// Shared helper for verification scripts that need the gate tables without touching live rows: creates a
// temporary schema inside the live database (copies of api_usage, usage_reservations and app_settings made
// with CREATE TABLE ... LIKE), and reports live row counts so a script can prove nothing was left behind.
// Also blocks fetch for the whole process, so no script that uses it can make a paid call.
import { getPool } from "../../src/db.js";
import { gateTable, type GateDb } from "../../src/spend-gate.js";

export interface TempGateSchema {
  db: GateDb;
  /** Runs a query inside the temporary schema, e.g. q(`insert into ${T("api_usage")} ...`). */
  T: (table: string) => string;
  clear: () => Promise<void>;
  drop: () => Promise<void>;
  liveCounts: () => Promise<{ api_usage: number; usage_reservations: number; searches: number; app_settings: number }>;
  fetchCalls: () => number;
}

export async function createTempGateSchema(prefix: string, lockKey: number): Promise<TempGateSchema> {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("temp-gate-schema: network is blocked in this script");
  }) as typeof fetch;

  const pool = getPool();
  const schema = `${prefix}_${Date.now().toString(36)}`;
  if (!/^zz_[a-z0-9_]+$/.test(schema)) throw new Error("temp-gate-schema: unexpected schema name");
  const db: GateDb = { pool, schema, lockKey };
  const T = (table: string) => gateTable(db, table);
  await pool.query(`create schema "${schema}"`);
  for (const t of ["api_usage", "usage_reservations", "app_settings"]) await pool.query(`create table ${T(t)} (like ${t} including all)`);

  return {
    db,
    T,
    clear: async () => {
      await pool.query(`truncate ${T("api_usage")}, ${T("usage_reservations")}, ${T("app_settings")}`);
    },
    drop: async () => {
      await pool.query(`drop schema "${schema}" cascade`);
    },
    liveCounts: async () => {
      const r = await pool.query<{ a: number; u: number; s: number; k: number }>(
        `select (select count(*) from api_usage)::int a, (select count(*) from usage_reservations)::int u, (select count(*) from searches)::int s, (select count(*) from app_settings)::int k`
      );
      return { api_usage: r.rows[0].a, usage_reservations: r.rows[0].u, searches: r.rows[0].s, app_settings: r.rows[0].k };
    },
    fetchCalls: () => fetchCalls,
  };
}
