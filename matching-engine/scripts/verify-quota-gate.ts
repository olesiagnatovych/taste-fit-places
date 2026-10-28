// Port of scripts/validate-quota-gate.ts (Task 71) to a temporary schema, 2026-10-20. The original inserted
// synthetic rows into the LIVE api_usage table (and, in its deny-path check, pushed live month-to-date spend
// over the live threshold for a moment). This version runs the same four checks against a temporary schema
// inside the live database, which is dropped at the end, with fetch blocked. Live row counts are read before
// and after and must be equal.
//   1. checkQuota() reflects real state, with a DB-backed (not hardcoded) threshold
//   2. recordUsage() for a normal small search adds no surcharge
//   3. marginal free-cap-crossing surcharge math (Gemini grounding, Places, and now geocoding)
//   4. the deny path fires over the threshold and un-fires once the spend is removed
import "dotenv/config";
import { closePool } from "../src/db.js";
import { checkQuota, recordUsage } from "../src/quota-gate.js";
import { createTempGateSchema } from "./lib/temp-gate-schema.js";
import { getPool } from "../src/db.js";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  const tmp = await createTempGateSchema("zz_quotagate", 9900000002);
  const { db, T } = tmp;
  const pool = getPool();
  const before = await tmp.liveCounts();
  const insertRaw = async (r: { gemini_calls?: number; places_calls?: number; geocoding_calls?: number; cost?: number }) => {
    const res = await pool.query<{ id: string }>(
      `insert into ${T("api_usage")} (search_id, gemini_calls, places_calls, geocoding_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd)
       values (null, $1, $2, $3, $4, 0, 0) returning id`,
      [r.gemini_calls ?? 0, r.places_calls ?? 0, r.geocoding_calls ?? 0, r.cost ?? 0]
    );
    return res.rows[0].id;
  };
  try {
    // 1. checkQuota reflects state; threshold is read from the database
    const first = await checkQuota(db);
    check("1. no threshold row yet: checkQuota() uses the default $35, spend $0, allowed", first.thresholdUsd === 35 && first.currentMonthSpendUsd === 0 && first.allowed === true, JSON.stringify(first));
    const seeded = await pool.query<{ value: string }>(`select value from ${T("app_settings")} where key = 'monthly_quota_threshold_usd'`);
    check("1. the default was persisted as a real row", seeded.rows.length === 1 && seeded.rows[0].value === "35");
    await pool.query(`update ${T("app_settings")} set value = '50' where key = 'monthly_quota_threshold_usd'`);
    const changed = await checkQuota(db);
    check("1. the threshold is DB-backed, not a constant: changing the row changes checkQuota()", changed.thresholdUsd === 50, `threshold ${changed.thresholdUsd}`);
    await pool.query(`update ${T("app_settings")} set value = '35' where key = 'monthly_quota_threshold_usd'`);

    // 2. normal small search: no surcharge
    const normal = await recordUsage({ searchId: null, geminiCalls: 9, placesCalls: 8, geocodingCalls: 0, geminiTokenCostUsd: 0.073884 }, db);
    check("2. normal search: no grounding surcharge", normal.geminiGroundingSurchargeUsd === 0);
    check("2. normal search: no Places surcharge", normal.placesSurchargeUsd === 0);
    check("2. normal search: total equals the Gemini token cost alone", Math.abs(normal.totalCostUsd - 0.073884) < 1e-9, `total ${normal.totalCostUsd}`);

    // 3. straddling the free caps: month-to-date lands at 4,990 Gemini and 995 Places calls, then a search adds 20 and 10
    await insertRaw({ gemini_calls: 4981, places_calls: 987 });
    const straddle = await recordUsage({ searchId: null, geminiCalls: 20, placesCalls: 10, geocodingCalls: 0, geminiTokenCostUsd: 0.01 }, db);
    check("3. grounding surcharge prices only the 10 calls past the 5,000 cap ($0.14)", Math.abs(straddle.geminiGroundingSurchargeUsd - 0.14) < 1e-9, `got ${straddle.geminiGroundingSurchargeUsd}`);
    check("3. Places surcharge prices only the 5 calls past the 1,000 cap ($0.125)", Math.abs(straddle.placesSurchargeUsd - 0.125) < 1e-9, `got ${straddle.placesSurchargeUsd}`);
    await insertRaw({ geocoding_calls: 9995 });
    const geo = await recordUsage({ searchId: null, geminiCalls: 0, placesCalls: 0, geocodingCalls: 10, geminiTokenCostUsd: 0 }, db);
    check("3. (added) geocoding surcharge prices only the 5 calls past the 10,000 cap ($0.025)", Math.abs(geo.geocodingSurchargeUsd - 0.025) < 1e-9, `got ${geo.geocodingSurchargeUsd}`);

    // 4. deny path
    const beforeOver = await checkQuota(db);
    const overId = await insertRaw({ cost: beforeOver.thresholdUsd + 5 });
    const over = await checkQuota(db);
    check("4. checkQuota() denies once month-to-date spend reaches the threshold", over.allowed === false, `spend ${over.currentMonthSpendUsd.toFixed(2)} of ${over.thresholdUsd}`);
    await pool.query(`delete from ${T("api_usage")} where id = $1`, [overId]);
    const after = await checkQuota(db);
    check("4. and allows again once that spend is removed", after.allowed === true);
    check("4. month-to-date spend returns to exactly its earlier value", Math.abs(after.currentMonthSpendUsd - beforeOver.currentMonthSpendUsd) < 1e-9, `${after.currentMonthSpendUsd} vs ${beforeOver.currentMonthSpendUsd}`);
  } finally {
    await tmp.drop();
    const after = await tmp.liveCounts();
    check("live api_usage, usage_reservations, searches and app_settings row counts unchanged", JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)}`);
    check("no network call", tmp.fetchCalls() === 0);
    await closePool();
  }
  console.log(`\n${passed} of ${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}
main().catch(async (err) => {
  console.error("verify-quota-gate crashed:", err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
