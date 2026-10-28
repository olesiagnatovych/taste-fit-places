// Retry orchestrator for the tiered rating-floor / hard-no relaxation sequences specified
// in the private development log (Lever 1 rating tiers, per-category hard-no relaxation table —
// see relaxation-tiers.ts for the source data).
//
// SCOPE NOTE (Pizza-only extraction, 2026-07-31): this file is a deliberately trimmed
// version of the full search-orchestrator.ts built on feature/wire-taste-profiles-into-
// matcher. That branch's version also includes runPlaygroundsSearch/buildPlaygroundsSteps
// and runNearbyModeSearch/continueNearbyModeAfterRadiusExpansion — left out here on
// purpose, since Playgrounds' safety hard-no data source and Nearby-mode's live radius
// re-query are both still unresolved open design questions (see CLAUDE.md, Action-
// Items.md). The generic engine below (runTierLadder, evaluateAtTier,
// buildPlanningModeSteps) contains no Playgrounds- or Nearby-mode-specific logic itself —
// it's the same category-agnostic plumbing those functions also called — so nothing about
// Pizza's behavior here depends on the excluded pieces.
//
// Built 2026-07-27 after the user CONFIRMED (not guessed) that "fewer than 10 results" is
// the single, consistent trigger threshold shared by all of the above — the "zero results"
// wording used when the hard-no relaxation table was first drafted was colloquial, not a
// literal separate threshold.
//
// DESIGN CHOICE, stated explicitly so it's easy to correct: the Lever 1 spec says the <10
// threshold is "measured post-taste-fit-scoring, not on raw candidate count" — i.e. a place
// must pass the scoring layer (scoreCandidate.ts, Step 3), not just the rule layer (matcher.ts,
// Step 2), to count toward the threshold. This orchestrator does NOT call scoreCandidate.ts
// itself (matching the existing split in this codebase: matcher.ts is pure/sync,
// scoreCandidate.ts is async/API, and each category's own retrieval-filter-score-*.ts
// pipeline script is what wires the two together for a given run — CORRECTED 2026-08-13, Task
// 68's audit: this comment previously named the old, dead semantic-scorer.ts and a
// since-removed script, live-retest.ts). Instead, the caller supplies an
// `isQualifying(place, matchResult)` predicate — a
// caller who has already run semantic scoring can fold fit-score into what "counts"; a
// caller who hasn't can pass a rule-layer-only predicate (the default). This is a real
// judgment call, not literally specified anywhere, but it's a narrow, easily-swapped
// implementation detail (a predicate function), not a structural blocker like the two
// excluded items above.

import { evaluate } from "./matcher.js";
import type { CandidatePlace, SearchCategory, MatchResult } from "./types.js";
import { LEVER1_RATING_FLOOR_TIERS, HARD_NO_RELAXATION_TABLE } from "./relaxation-tiers.js";

/** "Fewer than 10 results" — the single confirmed trigger threshold (2026-07-27), shared by every tiering system in this file. */
const RESULT_THRESHOLD = 10;

export type IsQualifying = (place: CandidatePlace, matchResult: MatchResult) => boolean;

/** Default: a place qualifies if the rule layer alone passes it. See file header re: semantic-layer integration being the caller's responsibility. */
export const ruleLayerOnly: IsQualifying = (_place, matchResult) => matchResult.passed;

export interface TierStep {
  tierLabel: string;
  ratingFloor: number;
  /** matcher.ts rule names (e.g. "no_processed_ketchup_sauce") to treat as auto-passed at this tier — everything in filtersNeverRelax (hard safety/structural rules) is never included here. */
  droppedRuleNames: string[];
  requiresManualTrigger: boolean;
  /** "Top N" cap per the category's final fallback tier — applied by rating desc after filtering. */
  resultCap?: number;
}

export interface TierAttemptResult {
  step: TierStep;
  ran: boolean; // false only when skipped because requiresManualTrigger was true and no trigger was provided
  qualifyingCount: number;
  qualifyingPlaces: CandidatePlace[];
}

export interface OrchestrationResult {
  category: SearchCategory;
  attempts: TierAttemptResult[];
  finalQualifyingPlaces: CandidatePlace[];
  stoppedReason: "met_threshold" | "exhausted_tiers" | "awaiting_manual_trigger";
}

/** Pizza-only on this branch — see scope note above. Returns undefined for every other category (no hard-no relaxation table entry exists for them here). */
function hardNoKeyForCategory(category: SearchCategory): keyof typeof HARD_NO_RELAXATION_TABLE | undefined {
  return category === "pizza" ? "pizza" : undefined;
}

/** Evaluates one candidate at a given tier: applies the tier's rating floor, and treats any rule named in droppedRuleNames as auto-passed rather than actually run. */
function evaluateAtTier(place: CandidatePlace, category: SearchCategory, step: TierStep): MatchResult {
  const base = evaluate(place, category, { ratingFloor: step.ratingFloor });
  if (step.droppedRuleNames.length === 0) return base;
  const ruleResults = base.ruleResults.map((r) =>
    step.droppedRuleNames.includes(r.rule)
      ? { ...r, passed: true, reason: `${r.reason} [relaxed at ${step.tierLabel}]` }
      : r
  );
  return { ...base, passed: ruleResults.every((r) => r.passed), ruleResults };
}

function runTierLadder(
  candidates: CandidatePlace[],
  category: SearchCategory,
  steps: TierStep[],
  isQualifying: IsQualifying,
  manualTriggerProvided: boolean
): OrchestrationResult {
  const attempts: TierAttemptResult[] = [];
  let finalQualifying: CandidatePlace[] = [];
  let stoppedReason: OrchestrationResult["stoppedReason"] = "exhausted_tiers";

  for (const step of steps) {
    if (step.requiresManualTrigger && !manualTriggerProvided) {
      attempts.push({ step, ran: false, qualifyingCount: 0, qualifyingPlaces: [] });
      stoppedReason = "awaiting_manual_trigger";
      break;
    }

    let qualifying = candidates.filter((place) => isQualifying(place, evaluateAtTier(place, category, step)));
    if (step.resultCap !== undefined) {
      qualifying = [...qualifying].sort((a, b) => b.rating - a.rating).slice(0, step.resultCap);
    }

    attempts.push({ step, ran: true, qualifyingCount: qualifying.length, qualifyingPlaces: qualifying });
    finalQualifying = qualifying;

    if (qualifying.length >= RESULT_THRESHOLD) {
      stoppedReason = "met_threshold";
      break;
    }
  }

  return { category, attempts, finalQualifyingPlaces: finalQualifying, stoppedReason };
}

/**
 * Planning-mode ladder (typed address/landmark, no travel-time constraint): tier 1 normal
 * -> tier 2 rating 3.8 -> tier 3 rating 3.6 (manual "load more" trigger required, per Lever
 * 1) -> tier 4, the category's hard-no relaxation table's final fallback (drop its
 * preference filter[s], override rating to 4.5, cap to top 10). Tier 4 only runs if tier 3
 * ran (i.e. only reachable once the manual trigger has already been used) — reaching a
 * BIGGER relaxation automatically while a SMALLER one stays gated behind a manual click
 * would undercut the point of gating tier 3 at all.
 */
export function buildPlanningModeSteps(category: SearchCategory): TierStep[] {
  const hardNoKey = hardNoKeyForCategory(category);
  const finalTierSpec = hardNoKey ? HARD_NO_RELAXATION_TABLE[hardNoKey][2] : undefined;

  const steps: TierStep[] = [
    {
      tierLabel: "tier1_normal",
      ratingFloor: LEVER1_RATING_FLOOR_TIERS[0].ratingFloor,
      droppedRuleNames: [],
      requiresManualTrigger: false,
    },
    {
      tierLabel: "tier2_rating_3.8",
      ratingFloor: LEVER1_RATING_FLOOR_TIERS[1].ratingFloor,
      droppedRuleNames: [],
      requiresManualTrigger: false,
    },
    {
      tierLabel: "tier3_rating_3.6_manual_trigger",
      ratingFloor: LEVER1_RATING_FLOOR_TIERS[2].ratingFloor,
      droppedRuleNames: [],
      requiresManualTrigger: true,
    },
  ];

  if (finalTierSpec) {
    steps.push({
      tierLabel: "tier4_drop_preference_filters_top10",
      ratingFloor: finalTierSpec.ratingFloorOverride ?? LEVER1_RATING_FLOOR_TIERS[2].ratingFloor,
      droppedRuleNames: finalTierSpec.filtersDropped,
      requiresManualTrigger: false, // gated indirectly: only reached if tier 3 already ran, see doc comment
      resultCap: finalTierSpec.resultCap,
    });
  }

  return steps;
}

export function runPlanningModeSearch(
  candidates: CandidatePlace[],
  category: SearchCategory,
  options?: { manualTriggerProvided?: boolean; isQualifying?: IsQualifying }
): OrchestrationResult {
  return runTierLadder(
    candidates,
    category,
    buildPlanningModeSteps(category),
    options?.isQualifying ?? ruleLayerOnly,
    options?.manualTriggerProvided ?? false
  );
}
