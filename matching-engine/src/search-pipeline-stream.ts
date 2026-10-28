// Streaming variant of the search pipeline, for /api/search-stream. The live pipeline in
// search-pipeline.ts is left as it is (it serves /api/search); this file reuses its exported helpers
// and repeats its Step 1 call and Step 2 filters VERBATIM. Do not change one without the other —
// scripts/verify-search-stream.ts checks that the Step 1 prompt text is identical in both files.
//
// Difference from the live pipeline: Step 2 and Step 3 overlap. Each Places lookup that passes the
// filters goes straight into the scoring queue (3 at a time) and each place is handed to `onCard` the
// moment it is scored, so the first card can appear long before the last lookup or score finishes.
// Cost accounting is the same as the live pipeline: one Step 1 call, one lookup per Step 1 candidate,
// one geocode, and one scoring call per place sent to scoring; the caller records it once at the end.
import "dotenv/config";
import { geocodeAddress, searchNearbyPlaces } from "./places-client.js";
import { evaluate, RATING_FLOOR, NON_FOOD_EXPERIENCE_CATEGORIES } from "./matcher.js";
import { scoreCandidate, STEP3_CONCURRENCY_DEFAULT } from "./scoreCandidate.js";
import type { CandidatePlace } from "./types.js";
import { CATEGORY_CONFIG, type PublicCategorySlug } from "./category-config.js";
import { STEP2_CONCURRENCY, haversineMeters, defaultStep1, parseStep1Places, step1CostUsd, newUsageTally, resolveCallTimeouts, type ScoredPlace, type UsageTally, type PipelineDeps, type Step1Raw } from "./search-pipeline.js";
import { runPipelined } from "./pipelined-scoring.js";
import { callWithTimeout } from "./call-timeout.js";
import { isShownResult } from "./result-card.js";

export interface StreamPipelineHooks {
  /** Called once, right after the anchor is resolved. */
  onAnchor: (formattedAddress: string) => void;
  /** Called once per place that should be shown, as soon as it finishes scoring. */
  onCard: (scored: ScoredPlace) => void;
}

export interface StreamPipelineResult {
  anchorFormattedAddress: string;
  step1CandidateCount: number;
  /** Places that passed the Step 2 filters (before de-duplication by place id). */
  step2SurvivorCount: number;
  /** Places sent to scoring, and finished. */
  scoredCount: number;
  shownCount: number;
  /** Same meaning as SearchPipelineResult: 1 (Step 1) + one per place scored. */
  geminiCalls: number;
  placesCalls: number;
  geocodingCalls: number;
  geminiTokenCostUsd: number;
  /** True when the request deadline passed and the pipeline stopped starting new paid calls; cards already sent stay valid. */
  timedOut?: boolean;
}

export async function runSearchPipelineStreaming(
  categorySlug: PublicCategorySlug,
  anchorAddress: string,
  hooks: StreamPipelineHooks,
  tally: UsageTally = newUsageTally(),
  deps: PipelineDeps = {}
): Promise<StreamPipelineResult> {
  const config = CATEGORY_CONFIG[categorySlug];
  const totalStart = Date.now();
  const callTimeouts = resolveCallTimeouts(deps);
  tally.geocodingCalls += 1; // counted when the call starts, so a failure (or a timeout) still records it
  const anchor = await callWithTimeout(callTimeouts.geocode, (signal) => (deps.geocode ?? geocodeAddress)(anchorAddress, signal), deps.timers);
  const geocodeMs = Date.now() - totalStart;
  hooks.onAnchor(anchor.formattedAddress);

  // ===== STEP 1: broad retrieval, free-form text, plain query, no filtering (same as the live pipeline) =====
  const step1Prompt = `Find real ${config.retrievalNounPhrase} near ${anchorAddress}. List up to 10 real places, one per line, each with its real name and real street address, in exactly this format: Name — Address. No descriptions, no other text.`;

  const step1Start = Date.now();
  let step1Skipped = false;
  let step1Raw: Step1Raw = { text: "", inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  if (deps.deadline?.expired()) {
    step1Skipped = true; // out of time before Step 1 could start: nothing more is started
  } else {
    tally.geminiCalls += 1;
    step1Raw = await callWithTimeout(callTimeouts.gemini, (signal) => (deps.step1 ?? defaultStep1)(step1Prompt, anchor, signal), deps.timers);
  }
  const step1Cost = step1CostUsd(step1Raw);
  tally.geminiTokenCostUsd += step1Cost;
  const distinctPlaces = parseStep1Places(step1Raw.text);
  const step1Ms = Date.now() - step1Start;

  // ===== STEP 2 + STEP 3, overlapped =====
  // Art must not get the server-side rating/price filters (same reasoning as the live pipeline).
  const isNonFoodExperience = NON_FOOD_EXPERIENCE_CATEGORIES.has(config.searchCategory);
  const step2Start = Date.now();
  let shownCount = 0;
  let firstCardMs: number | null = null;
  let lastCardMs: number | null = null;

  const pipelined = await runPipelined<{ name: string; address: string }, CandidatePlace, ScoredPlace["result"]>({
    candidates: distinctPlaces,
    lookupConcurrency: STEP2_CONCURRENCY,
    scoreConcurrency: STEP3_CONCURRENCY_DEFAULT,
    canStart: () => !deps.deadline?.expired(),
    lookup: async ({ name, address }) => {
      tally.placesCalls += 1;
      const results = await callWithTimeout(callTimeouts.places, (signal) => (deps.searchPlaces ?? searchNearbyPlaces)({
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        radiusMeters: config.radiusMeters,
        textQuery: `${name}, ${address}`,
        ...(isNonFoodExperience
          ? {}
          : {
              minRating: RATING_FLOOR,
              priceLevels: ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE"],
            }),
      }, signal), deps.timers);
      const place = results[0];
      if (!place) return null;
      if (place.location) {
        place.distanceMeters = haversineMeters(anchor.latitude, anchor.longitude, place.location.latitude, place.location.longitude);
      }
      const result = evaluate(place, config.searchCategory);
      return result.passed ? place : null;
    },
    // Same key as the live pipeline's dedupeByPlaceId: the place id, or name + address when Google returned no id.
    keyOf: (place) => place.placeId ?? `no-place-id:${place.name}:${place.address ?? ""}`,
    score: (place) => {
      tally.geminiCalls += 1;
      return (deps.score ?? scoreCandidate)({
        place,
        tasteProfile: config.tasteProfile,
        locationDescription: `${place.name}, a real ${config.locationNounPhrase} near ${anchorAddress}`,
        anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
        deadline: deps.deadline,
        hooks: deps.scoreHooks,
      });
    },
    onScored: (place, result) => {
      tally.geminiTokenCostUsd += result.cost;
      tally.geminiCalls += Math.max(0, (result.attemptsUsed ?? 1) - 1); // each retry attempt was a separate paid call
      if (!isShownResult(result)) return; // "not_a_match" is never sent
      const elapsed = Date.now() - totalStart;
      if (firstCardMs === null) firstCardMs = elapsed;
      lastCardMs = elapsed;
      shownCount++;
      hooks.onCard({ place, result });
    },
  });

  const timedOut = step1Skipped || pipelined.skippedLookups > 0 || pipelined.skippedScores > 0;
  const totalMs = Date.now() - totalStart;
  const sec = (ms: number | null) => (ms === null ? "n/a" : (ms / 1000).toFixed(2) + "s");
  const step2Ms = pipelined.lookupsDoneAt - step2Start;
  const step3Ms =
    pipelined.firstScoreStartAt !== null && pipelined.lastScoreEndAt !== null ? pipelined.lastScoreEndAt - pipelined.firstScoreStartAt : null;
  // One log line per search. Step 2 and Step 3 overlap here, so step2 + step3 can exceed their combined
  // wall-clock: step2 = start of lookups to the last lookup done; step3 = first scoring call started to
  // last one finished. first_card / last_card are measured from the start of the pipeline (they include
  // geocode and Step 1, and exclude the quota check before it).
  console.log(
    `search-pipeline timing (stream): category=${categorySlug} total=${sec(totalMs)} geocode=${sec(geocodeMs)} ` +
      `step1=${sec(step1Ms)} step2=${sec(step2Ms)} step3=${sec(step3Ms)} first_card=${sec(firstCardMs)} last_card=${sec(lastCardMs)} ` +
      `step1_places=${distinctPlaces.length} step2_lookups=${tally.placesCalls} step3_scored=${pipelined.scored} shown=${shownCount} timed_out=${timedOut}`
  );

  return {
    anchorFormattedAddress: anchor.formattedAddress,
    step1CandidateCount: distinctPlaces.length,
    step2SurvivorCount: pipelined.survivors,
    scoredCount: pipelined.scored,
    shownCount,
    geminiCalls: tally.geminiCalls, // Step 1 plus the scoring calls actually started
    placesCalls: tally.placesCalls, // lookups actually started
    geocodingCalls: 1,
    geminiTokenCostUsd: tally.geminiTokenCostUsd,
    ...(timedOut ? { timedOut: true } : {}),
  };
}
