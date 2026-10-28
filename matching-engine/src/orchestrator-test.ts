import { runPlanningModeSearch } from "./search-orchestrator.js";
import type { CandidatePlace } from "./types.js";

// SCOPE NOTE (Pizza-only extraction, 2026-07-31): this is a trimmed, Pizza-focused version
// of the orchestrator-test.ts built on feature/wire-taste-profiles-into-matcher. That
// version's generic tier-mechanics scenarios (clean stop at tier 1, tier exhaustion, the
// tier-4 rating-override trade-off, manual-trigger gating) used "coffee" as a stand-in
// category, since which category you use for testing GENERIC tier machinery shouldn't
// matter. It does here: main's existing coffeeRules() (unchanged on this branch, per the
// 2026-07-31 decision to exclude the wine-vocabulary revert and new coffeeRules() from this
// extraction) requires a specialty/craft signal to pass at all — the original scenarios use
// places with empty descriptionSignals, which would fail every coffee tier regardless of
// rating, breaking the test's actual premise. Reworked onto "pizza" instead, since
// pizzaRules() has no such required-signal gate (only absence-based hard-nos), making it a
// cleaner category for testing generic mechanics that have nothing to do with pizza
// specifically. The one genuinely pizza-specific scenario (deep dish never relaxes) is kept
// verbatim from the original. Playgrounds/Nearby-mode scenarios are excluded entirely, since
// those functions don't exist on this branch (see search-orchestrator.ts scope note).

let allPassed = true;

function check(label: string, condition: boolean, detail: string) {
  allPassed = allPassed && condition;
  console.log(`${condition ? "✅" : "❌"} ${label} — ${detail}`);
}

function place(name: string, rating: number, signals: string[] = []): CandidatePlace {
  return { name, googleCategories: [], rating, descriptionSignals: signals };
}

console.log("=== Search Orchestrator — Retry-Tier Validation (Pizza-only extraction) ===\n");

// Scenario 1: plenty of great candidates -> should stop at tier 1, single attempt.
{
  const candidates = Array.from({ length: 15 }, (_, i) => place(`Good Pizza ${i}`, 4.5, []));
  const result = runPlanningModeSearch(candidates, "pizza");
  check(
    "Scenario 1: 15 clean candidates stop at tier 1",
    result.attempts.length === 1 && result.stoppedReason === "met_threshold",
    `attempts=${result.attempts.length}, stoppedReason=${result.stoppedReason}, qualifying=${result.finalQualifyingPlaces.length}`
  );
}

// Scenario 2a: only 3 candidates total, all well above every tier's floor (isolates "not
// enough candidates exist" from the tier-4 floor-override effect, which Scenario 2b covers).
{
  const candidates = [place("A", 4.9, []), place("B", 4.8, []), place("C", 4.7, [])];
  const result = runPlanningModeSearch(candidates, "pizza", { manualTriggerProvided: true });
  check(
    "Scenario 2a: only 3 real candidates exhausts all 4 tiers, all 3 survive throughout",
    result.attempts.length === 4 && result.stoppedReason === "exhausted_tiers" && result.finalQualifyingPlaces.length === 3,
    `attempts=${result.attempts.length}, stoppedReason=${result.stoppedReason}, final=${result.finalQualifyingPlaces.length}`
  );
}

// Scenario 2b: tier 4's rating override (4.5) is a real compensating trade-off, not a
// no-op — a candidate that was qualifying at tiers 1-3 can legitimately drop out at tier 4
// if it falls between the relaxed floor (3.6) and the compensating floor (4.5).
{
  const candidates = [place("A", 4.5, []), place("B", 4.2, []), place("C", 4.1, [])];
  const result = runPlanningModeSearch(candidates, "pizza", { manualTriggerProvided: true });
  const tier4 = result.attempts[3];
  check(
    "Scenario 2b: tier 4's 4.5 override drops B and C, keeps only A",
    tier4.step.tierLabel === "tier4_drop_preference_filters_top10" && tier4.qualifyingCount === 1 && tier4.qualifyingPlaces[0]?.name === "A",
    `tier4Qualifying=${tier4.qualifyingCount}, names=${tier4.qualifyingPlaces.map((p) => p.name).join(",")}`
  );
}

// Scenario 3: manual-trigger gate — tier 3 (3.6) must NOT run without explicit opt-in.
{
  const candidates = Array.from({ length: 4 }, (_, i) => place(`Mid ${i}`, 3.85, []));
  const withoutTrigger = runPlanningModeSearch(candidates, "pizza", { manualTriggerProvided: false });
  const withTrigger = runPlanningModeSearch(candidates, "pizza", { manualTriggerProvided: true });
  check(
    "Scenario 3a: without manual trigger, stops awaiting it after tier 2",
    withoutTrigger.stoppedReason === "awaiting_manual_trigger" && withoutTrigger.attempts.length === 3 && withoutTrigger.attempts[2].ran === false,
    `stoppedReason=${withoutTrigger.stoppedReason}, attempts=${withoutTrigger.attempts.length}, tier3Ran=${withoutTrigger.attempts[2]?.ran}`
  );
  check(
    "Scenario 3b: with manual trigger, tier 3 (3.6 floor) actually runs",
    withTrigger.attempts[2].ran === true,
    `tier3Ran=${withTrigger.attempts[2]?.ran}`
  );
}

// Scenario 4/5 (deep dish never relaxes; sauce/dough relax at tier 4 but deep dish doesn't) —
// REMOVED 2026-08-12 (Task 57, Pizza's Step 3 build). Both tested Step 2 (matcher.ts) rule-
// relaxation behavior for `no_deep_dish`/`no_processed_ketchup_sauce`/`thin_crust_not_thick_
// dough` — all three were removed from `pizzaRules()` in the 2026-08-07 compliance audit
// (Step 2 can only read structured Google fields now, not review text), so these scenarios had
// already gone stale/silently broken (confirmed live before this cleanup: both were failing —
// `deepDishEverIncluded=true`, since nothing in Step 2 excludes it anymore — and `npm test`
// never runs this file, so it went uncaught). the private development log's 2026-08-12 decisions
// moved all three rules to Step 3 permanently: deep dish and processed/ketchup-style sauce are
// now PERMANENT hard-nos with NO relaxation at any tier, ever (the literal opposite of what
// these scenarios modeled); thick dough is a real, region-dependent Step 3 ambiguity signal, not
// a Step 2 rule. There is no longer any Pizza-specific Step 2 rule-relaxation behavior for this
// orchestrator to test — real taste-fit judgment (including these hard-nos) is Step 3's job,
// covered by scoreCandidate.ts's own tests/POC runs (private development log, Task 57), not this file, which
// only ever exercised Step 2's generic tier-ladder plumbing. Scenario 2b above already covers
// the one thing that's still real and generic here: tier 4's rating-floor override is a genuine
// compensating trade-off, independent of which (if any) rules a category drops there.

console.log("\n" + "=".repeat(80));
if (allPassed) {
  console.log("All orchestrator scenarios matched expected behavior.");
} else {
  console.log("Some orchestrator scenarios did NOT match expected behavior — see ❌ lines above.");
  process.exitCode = 1;
}
