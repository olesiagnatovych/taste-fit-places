// SUPERSEDED 2026-10-20 by scripts/verify-settings.ts. DO NOT RUN THIS FILE: it raises the LIVE monthly
// threshold and writes the old value back, which briefly changes real quota behaviour and leaves the
// raised value in place if the script dies in between. verify-settings.ts runs the same checks (plus
// default seeding and the alert-flag reset) in a temporary schema that is dropped afterwards.
// Kept only as the record of the original validation.

// Real, live validation of settings.ts against the real Neon database (quota-gate follow-on
// build, the private development log 2026-08-14 entry). Restores the real threshold to whatever it
// was before this script ran — raising it for real as a side effect of a test run would
// change real production quota-gate behavior, which defeats the point of a validation script.
import {
  getMonthlyQuotaThresholdUsd,
  raiseMonthlyQuotaThreshold,
  nextThresholdInLadder,
  DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD,
} from "../src/settings.js";
import { getPool, closePool } from "../src/db.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  PASS: ${message}`);
}

async function main() {
  console.log("=".repeat(80));
  console.log("1. Ladder function — pure, no DB needed");
  console.log("=".repeat(80));
  assert(nextThresholdInLadder(35) === 50, "35 -> 50");
  assert(nextThresholdInLadder(50) === 65, "50 -> 65");
  assert(nextThresholdInLadder(65) === 80, "65 -> 80 (+15 begins)");
  assert(nextThresholdInLadder(80) === 95, "80 -> 95 (+15 continues)");
  assert(nextThresholdInLadder(140) === 155, "140 -> 155 (+15, no ceiling)");

  console.log("\n" + "=".repeat(80));
  console.log("2. getMonthlyQuotaThresholdUsd() reflects real current persisted state");
  console.log("=".repeat(80));
  const original = await getMonthlyQuotaThresholdUsd();
  console.log(`  Real current threshold: $${original}`);
  assert(original === DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD || original >= DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD, "real threshold is the default or a real, previously-raised value — never below the default");

  console.log("\n" + "=".repeat(80));
  console.log("3. raiseMonthlyQuotaThreshold() persists the real next ladder value");
  console.log("=".repeat(80));
  const expectedNext = nextThresholdInLadder(original);
  const raised = await raiseMonthlyQuotaThreshold();
  console.log(`  Raised from $${original} to $${raised}`);
  assert(raised === expectedNext, `raise moved from $${original} to the correct real next ladder value $${expectedNext}`);

  const reread = await getMonthlyQuotaThresholdUsd();
  assert(reread === raised, "a fresh read reflects the just-raised real persisted value, not a stale cache");

  console.log("\n" + "=".repeat(80));
  console.log("4. Cleanup — restore real threshold to its pre-test value");
  console.log("=".repeat(80));
  const pool = getPool();
  await pool.query(
    `update app_settings set value = $1, updated_at = now() where key = 'monthly_quota_threshold_usd'`,
    [String(original)]
  );
  const restored = await getMonthlyQuotaThresholdUsd();
  assert(restored === original, `real threshold restored to its exact pre-test value ($${original})`);

  console.log("\n" + "=".repeat(80));
  console.log("ALL REAL VALIDATION CHECKS PASSED. Real threshold restored, no residue.");
  console.log("=".repeat(80));
}

main()
  .catch((err) => {
    console.error("validate-settings FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
