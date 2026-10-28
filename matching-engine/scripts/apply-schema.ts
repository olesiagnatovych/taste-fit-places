// Applies schema/schema.sql to the real Neon database (private development log GO LIVE item #1,
// done 2026-08-14; extended same day for item #2's api_usage table).
//
// UPDATED 2026-08-14: schema.sql now also defines api_usage (the quota-gate table) —
// added to EXPECTED_TABLES below. schema.sql's own statements are all `if not exists` as
// of this same change, so re-running this script against a database that already has
// geo_areas/searches/search_results is safe — it only adds what's missing.
//
// Standing rule respected: reads DATABASE_URL from matching-engine/.env via `pg`'s own
// connection-string handling — never logs, prints, or otherwise surfaces the value itself.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'schema.sql');

// The real, current table names schema.sql actually defines — kept here explicitly so the
// verification step checks against a known list, not an assumption re-derived at run time.
const EXPECTED_TABLES = ['geo_areas', 'searches', 'search_results', 'api_usage', 'app_settings', 'admin_login_attempts'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('apply-schema: DATABASE_URL is not set in matching-engine/.env — aborting.');
    process.exit(1);
  }

  const schemaSql = readFileSync(SCHEMA_PATH, 'utf-8');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log('Applying schema/schema.sql to the real Neon database...');
    await client.query(schemaSql);
    console.log('Schema applied.');

    console.log('');
    console.log('Verifying real tables landed (information_schema.tables)...');
    const result = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])
       order by table_name`,
      [EXPECTED_TABLES]
    );
    const found = result.rows.map((r) => r.table_name);
    const missing = EXPECTED_TABLES.filter((t) => !found.includes(t));

    for (const t of EXPECTED_TABLES) {
      console.log(`  ${found.includes(t) ? 'PASS' : 'MISSING'}  ${t}`);
    }

    if (missing.length > 0) {
      console.error('');
      console.error(`apply-schema: ${missing.length} expected table(s) missing after apply: ${missing.join(', ')}`);
      process.exit(1);
    }

    console.log('');
    console.log('All real expected tables confirmed present. schema_applied_to_db can be set true.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('apply-schema: failed —', err.message);
  process.exit(1);
});
