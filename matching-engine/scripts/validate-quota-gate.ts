// SUPERSEDED 2026-10-20 by scripts/verify-quota-gate.ts. DO NOT RUN THIS FILE: it inserts synthetic rows
// into the LIVE api_usage table and, in its check 4, pushes live month-to-date spend over the live
// threshold for a moment (which would briefly deny real searches); a crash leaves rows behind.
// verify-quota-gate.ts runs the same four checks (plus a geocoding free-cap check) in a temporary schema
// that is dropped afterwards. Kept only as the record of the original Task 71 validation.

// Real, live validation of quota-gate.ts against the real Neon database (Task 71,
// the private development log GO LIVE item #2). Every row this script inserts is deleted again before
// it exits — a synthetic test row left sitting in the real api_usage table would corrupt the
// real monthly-spend ledger the quota gate actually enforces, which defeats the entire point
// of the check. Confirms, in order: (1) checkQuota() reflects real current state; (2) a
// normal small recordUsage() call is priced correctly (no surcharge — real usage is nowhere
// near either free cap); (3) the marginal free-cap-crossing surcharge math is correct, not
// just the common no-surcharge case; (4) the deny path actually fires once real month-to-date
// spend crosses the real, live threshold (read from app_settings, not hardcoded — the
// threshold is a mutable, admin-raisable value as of the quota-gate follow-on build), and
// un-fires once that synthetic spend is removed.
import { checkQuota, recordUsage } from "../src/quota-gate.js";
import { getPool, closePool } from "../src/db.js";

const insertedIds: string[] = [];

async function insertRaw(row: {
  gemini_calls: number;
  places_calls: number;
  gemini_token_cost_usd: number;
  gemini_grounding_surcharge_usd: number;
  places_surcharge_usd: number;
}): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `insert into api_usage (search_id, gemini_calls, places_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd)
     values (null, $1, $2, $3, $4, $5) returning id`,
    [row.gemini_calls, row.places_calls, row.gemini_token_cost_usd, row.gemini_grounding_surcharge_usd, row.places_surcharge_usd]
  );
  const id = result.rows[0].id;
  insertedIds.push(id);
  return id;
}

async function cleanup() {
  if (insertedIds.length === 0) return;
  const pool = getPool();
  await pool.query(`delete from api_usage where id = any($1::uuid[])`, [insertedIds]);
  console.log(`\nCleanup: deleted ${insertedIds.length} synthetic test row(s) from the real api_usage table.`);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  PASS: ${message}`);
}

// recordUsage() doesn't return an id (real, intentional API design — a real caller doesn't
// need it). This test wrapper queries it back and records it for cleanup — critically, called
// IMMEDIATELY after every recordUsage() call, before any assertion that could throw. A real
// bug this script itself found in an earlier version: capturing the id AFTER assertions meant
// a failed assertion skipped cleanup entirely, leaving synthetic rows in the real api_usage
// table across runs (confirmed: found and manually deleted 2 leftover $0.5x rows from earlier
// failed runs of this exact script before this fix).
async function recordUsageAndTrack(input: Parameters<typeof recordUsage>[0]) {
  const result = await recordUsage(input);
  const pool = getPool();
  const idRow = await pool.query<{ id: string }>(
    `select id from api_usage where gemini_calls = $1 and places_calls = $2 and gemini_token_cost_usd = $3 order by created_at desc limit 1`,
    [input.geminiCalls, input.placesCalls, input.geminiTokenCostUsd]
  );
  if (idRow.rows[0]) insertedIds.push(idRow.rows[0].id);
  return result;
}

async function main() {
  console.log("=".repeat(80));
  console.log("1. checkQuota() reflects real current state");
  console.log("=".repeat(80));
  const before = await checkQuota();
  console.log(`  Real current month-to-date spend: $${before.currentMonthSpendUsd.toFixed(6)} (threshold $${before.thresholdUsd})`);
  assert(before.thresholdUsd > 0, "threshold is a real, positive, DB-backed value (app_settings, not a hardcoded constant)");

  console.log("\n" + "=".repeat(80));
  console.log("2. recordUsage() for a normal small search — real usage nowhere near either free cap, so surcharges should be $0");
  console.log("=".repeat(80));
  const normal = await recordUsageAndTrack({
    searchId: null,
    geminiCalls: 9,
    placesCalls: 8,
    geminiTokenCostUsd: 0.073884, // real, previously-measured figure (private development log, tonight's Pizza task pattern) — reused here as a realistic test value, not fabricated
  });
  console.log(`  Recorded: grounding surcharge $${normal.geminiGroundingSurchargeUsd}, places surcharge $${normal.placesSurchargeUsd}, total $${normal.totalCostUsd}`);
  assert(normal.geminiGroundingSurchargeUsd === 0, "no grounding surcharge — real month-to-date usage is far below the 5,000 free cap");
  assert(normal.placesSurchargeUsd === 0, "no Places surcharge — real month-to-date usage is far below the 1,000 free cap");
  assert(Math.abs(normal.totalCostUsd - 0.073884) < 1e-9, "total cost equals the real Gemini token cost alone, no surcharge added");

  console.log("\n" + "=".repeat(80));
  console.log("3. Marginal free-cap-crossing surcharge math — synthetic row pushing cumulative calls past both real free caps");
  console.log("=".repeat(80));
  // Simulate prior month-to-date usage landing exactly at gemini_calls=4990, places_calls=995
  // TOTAL (including step 2's already-recorded 9/8) — so this raw row itself only adds
  // 4990-9=4981 / 995-8=987, the remainder needed to reach that boundary.
  await insertRaw({
    gemini_calls: 4981,
    places_calls: 987,
    gemini_token_cost_usd: 0,
    gemini_grounding_surcharge_usd: 0,
    places_surcharge_usd: 0,
  });
  const straddling = await recordUsageAndTrack({
    searchId: null,
    geminiCalls: 20, // month-to-date will be 4990+20=5010 -> 10 calls billable at $14/1000
    placesCalls: 10, // month-to-date will be 995+10=1005 -> 5 calls billable at $25/1000
    geminiTokenCostUsd: 0.01,
  });
  const expectedGroundingSurcharge = (10 / 1000) * 14; // 0.14
  const expectedPlacesSurcharge = (5 / 1000) * 25; // 0.125
  console.log(`  Expected grounding surcharge: $${expectedGroundingSurcharge}, got: $${straddling.geminiGroundingSurchargeUsd}`);
  console.log(`  Expected Places surcharge: $${expectedPlacesSurcharge}, got: $${straddling.placesSurchargeUsd}`);
  assert(Math.abs(straddling.geminiGroundingSurchargeUsd - expectedGroundingSurcharge) < 1e-9, "grounding surcharge prices only the 10 calls past the real 5,000 free cap, not all 20");
  assert(Math.abs(straddling.placesSurchargeUsd - expectedPlacesSurcharge) < 1e-9, "Places surcharge prices only the 5 calls past the real 1,000 free cap, not all 10");

  console.log("\n" + "=".repeat(80));
  console.log(`4. Deny path — real month-to-date spend crossing the real, live $${before.thresholdUsd} threshold`);
  console.log("=".repeat(80));
  const overageAmount = before.thresholdUsd + 5; // clearly over whatever the real live threshold is, not hardcoded
  await insertRaw({
    gemini_calls: 0,
    places_calls: 0,
    gemini_token_cost_usd: overageAmount, // synthetic, clearly over threshold — deleted immediately after this check
    gemini_grounding_surcharge_usd: 0,
    places_surcharge_usd: 0,
  });
  const overThreshold = await checkQuota();
  console.log(`  Real month-to-date spend with synthetic $${overageAmount} row: $${overThreshold.currentMonthSpendUsd.toFixed(6)}`);
  assert(overThreshold.allowed === false, `checkQuota() denies once real month-to-date spend >= $${before.thresholdUsd}`);

  await cleanup();

  const after = await checkQuota();
  console.log(`\nReal month-to-date spend after cleanup: $${after.currentMonthSpendUsd.toFixed(6)}`);
  assert(after.allowed === true, "checkQuota() allows again once synthetic test rows are removed");
  assert(Math.abs(after.currentMonthSpendUsd - before.currentMonthSpendUsd) < 1e-9, "real month-to-date spend returned to exactly its pre-test value — no residue left in the real table");

  console.log("\n" + "=".repeat(80));
  console.log("ALL REAL VALIDATION CHECKS PASSED. No test rows remain in api_usage.");
  console.log("=".repeat(80));
}

main()
  .catch(async (err) => {
    console.error("validate-quota-gate FAILED:", err);
    await cleanup(); // best-effort cleanup even on failure
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
