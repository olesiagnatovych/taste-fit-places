// Relaxation-tier tables, transcribed directly from the private development log (2026-07-27
// Lever 1 rating-floor design, per-category hard-no relaxation table).
//
// SCOPE NOTE (Pizza-only extraction, 2026-07-31): this file is a deliberately trimmed
// version of the full relaxation-tiers.ts built on feature/wire-taste-profiles-into-matcher.
// That branch's version also includes Coffee/Wine/Sushi/Art entries in
// HARD_NO_RELAXATION_TABLE, plus Playgrounds' own 6-tier table and the Nearby-mode radius/
// rating/filter sequence — all left out here on purpose. Playgrounds' safety hard-no data
// source and Nearby-mode's live radius re-query are both still unresolved open design
// questions (see CLAUDE.md, the private development log); Wine's vocabulary-hard-gate revert and the
// new Coffee rules are separately extractable, already-decided work that just hasn't had
// this same clean-extraction treatment yet (see the private development log). None of the three are
// needed for Pizza to function, so none of them are here.

/**
 * General "Lever 1" rating-floor relaxation — applies to planning-mode search for every
 * category. Threshold is measured POST-taste-fit-scoring, not on raw candidate count — a
 * place must still pass taste-fit to appear at any tier; relaxation only widens the pool
 * taste-fit draws from.
 */
export const LEVER1_RATING_FLOOR_TIERS = [
  { tier: 1, condition: "normal search", ratingFloor: 4.0 },
  { tier: 2, condition: "fewer than 10 results after taste-fit scoring", ratingFloor: 3.8 },
  {
    tier: 3,
    condition: "still fewer than 10 results, AND user manually triggers \"load more\"",
    ratingFloor: 3.6,
  },
] as const;

export interface HardNoRelaxationTier {
  tier: 1 | 2 | 3;
  condition: string;
  filtersDropped: string[]; // rule names dropped at this tier (matcher.ts rule names, where applicable)
  filtersNeverRelax: string[]; // rule names that stay active at every tier
  ratingFloorOverride?: number;
  resultCap?: number;
  note?: string;
}

/**
 * Per-category hard-no relaxation, triggered on ZERO results (a stricter trigger than Lever 1's
 * <10). Pizza-only on this branch — see scope note above.
 *
 * CLEANED UP 2026-08-12 (Task 57, Pizza's Step 3 build) — this table's `filtersDropped`/
 * `filtersNeverRelax` entries used to name real Step 2 (matcher.ts) rules: `no_deep_dish`,
 * `no_processed_ketchup_sauce`, `thin_crust_not_thick_dough`. The 2026-08-07 compliance audit
 * removed all three from `pizzaRules()` (Step 2 can only read structured Google fields now, not
 * review text) — `pizzaRules()` has returned `[]` for every Pizza candidate since, so every one
 * of those rule-name references had already gone stale/no-op, silently (confirmed live: `npm run
 * test:orchestrator`'s Scenario 4/5 were already failing before this cleanup — `npm test` never
 * runs orchestrator-test.ts, so this went uncaught). the private development log's 2026-08-12 decisions
 * make clear these three now live entirely in Step 3, outside this table's real scope: deep dish
 * and processed/ketchup-style sauce are PERMANENT hard-nos with NO relaxation at any tier, ever
 * (the product owner's direct call) — the opposite of what this table's old tier-2/3 entries modeled: thick
 * dough is a real, region-dependent Step 3 ambiguity signal (Europe/US hard no, small
 * town/ambiguous medium fit, Asia genuine positive), not a Step 2 rule to drop at all.
 * `filtersDropped`/`filtersNeverRelax` are cleared to `[]` below — there is nothing left in Step
 * 2's real rule output for this table to reference. The tier-3 entry's `ratingFloorOverride: 4.5`
 * / `resultCap: 10` stay: a real, generic, category-agnostic final-fallback mechanism (CLAUDE.md's
 * locked Tier-4 rating-floor principle), independent of which specific rules (if any) a category
 * happens to drop at that tier.
 */
export const HARD_NO_RELAXATION_TABLE: Record<"pizza", HardNoRelaxationTier[]> = {
  pizza: [
    {
      tier: 1,
      condition: "normal search",
      filtersDropped: [],
      filtersNeverRelax: [],
    },
    {
      tier: 2,
      condition: "zero results (hunger corner case)",
      filtersDropped: [],
      filtersNeverRelax: [],
      note: "No Step 2 (matcher.ts) rules exist for Pizza to drop here — deep dish and processed/ketchup-style sauce are permanent Step 3 hard-nos with no relaxation at any tier; thick dough is a Step 3 region-dependent signal, not a Step 2 rule.",
    },
    {
      tier: 3,
      condition: "still zero results",
      filtersDropped: [],
      filtersNeverRelax: [],
      ratingFloorOverride: 4.5,
      resultCap: 10,
    },
  ],
};
