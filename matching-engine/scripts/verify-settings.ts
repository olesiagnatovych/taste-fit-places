// Port of scripts/validate-settings.ts to a temporary schema, 2026-10-20. The original raised the LIVE
// threshold and then wrote the old value back (a real change to live quota behaviour for a moment, and a
// leftover if the script died in between). This version runs the same checks against a temporary schema
// inside the live database, dropped at the end, with fetch blocked. The live threshold row is read before
// and after and must be identical.
//   1. the ladder (pure): 35 -> 50 -> 65 -> 80 -> 95, +15 with no ceiling
//   2. getMonthlyQuotaThresholdUsd() reflects persisted state (and seeds the default on first read)
//   3. raiseMonthlyQuotaThreshold() persists the next ladder value, and (added 2026-10-20) clears the alert flag
import "dotenv/config";
import { closePool, getPool } from "../src/db.js";
import { getMonthlyQuotaThresholdUsd, raiseMonthlyQuotaThreshold, nextThresholdInLadder, DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD } from "../src/settings.js";
import { SETTING_KEYS } from "../src/spend-gate.js";
import { createTempGateSchema } from "./lib/temp-gate-schema.js";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  const tmp = await createTempGateSchema("zz_settings", 9900000003);
  const { db, T } = tmp;
  const pool = getPool();
  const liveThreshold = async () => (await pool.query<{ value: string }>(`select value from app_settings where key = $1`, [SETTING_KEYS.monthlyThreshold])).rows[0]?.value ?? null;
  const liveBefore = await liveThreshold();
  const before = await tmp.liveCounts();
  try {
    // 1. ladder
    check("1. 35 -> 50", nextThresholdInLadder(35) === 50);
    check("1. 50 -> 65", nextThresholdInLadder(50) === 65);
    check("1. 65 -> 80 (+15 begins)", nextThresholdInLadder(65) === 80);
    check("1. 80 -> 95", nextThresholdInLadder(80) === 95);
    check("1. 140 -> 155 (no ceiling)", nextThresholdInLadder(140) === 155);

    // 2. persisted state
    const first = await getMonthlyQuotaThresholdUsd(db);
    check("2. first read with no row returns the default", first === DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD, `${first}`);
    const rows = await pool.query<{ value: string }>(`select value from ${T("app_settings")} where key = $1`, [SETTING_KEYS.monthlyThreshold]);
    check("2. the default was persisted as a row", rows.rows.length === 1 && rows.rows[0].value === "35");
    await pool.query(`update ${T("app_settings")} set value = '65' where key = $1`, [SETTING_KEYS.monthlyThreshold]);
    check("2. a previously raised persisted value ($65) is read back, never below the default", (await getMonthlyQuotaThresholdUsd(db)) === 65);
    await pool.query(`update ${T("app_settings")} set value = '35' where key = $1`, [SETTING_KEYS.monthlyThreshold]);

    // 3. raise
    const original = await getMonthlyQuotaThresholdUsd(db);
    await pool.query(`insert into ${T("app_settings")} (key, value) values ($1, $2)`, [SETTING_KEYS.alertSentForThreshold, String(original)]);
    const raised = await raiseMonthlyQuotaThreshold(db);
    check("3. raise moves $35 to the next ladder value $50", raised === nextThresholdInLadder(original) && raised === 50, `raised to ${raised}`);
    check("3. a fresh read reflects the raised value", (await getMonthlyQuotaThresholdUsd(db)) === raised);
    const flag = await pool.query(`select 1 from ${T("app_settings")} where key = $1`, [SETTING_KEYS.alertSentForThreshold]);
    check("3. (added) raising clears the 'alert already sent' flag", flag.rowCount === 0);
    check("3. a second raise goes $50 -> $65", (await raiseMonthlyQuotaThreshold(db)) === 65);
  } finally {
    await tmp.drop();
    const after = await tmp.liveCounts();
    check("live threshold row is identical before and after", (await liveThreshold()) === liveBefore, `value ${liveBefore}`);
    check("live api_usage, usage_reservations, searches and app_settings row counts unchanged", JSON.stringify(before) === JSON.stringify(after));
    check("no network call", tmp.fetchCalls() === 0);
    await closePool();
  }
  console.log(`\n${passed} of ${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}
main().catch(async (err) => {
  console.error("verify-settings crashed:", err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
