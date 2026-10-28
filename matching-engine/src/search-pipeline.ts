// Real, generalized Step 1->2->3 pipeline (private development log GO LIVE item #3) — the same real
// shape as every validated `retrieval-filter-score-*.ts` script (Wine/Coffee/Art), generalized
// via category-config.ts instead of duplicated per category a further time. Returns both the
// real scored results AND the real call-count/cost tallies quota-gate.ts's recordUsage() needs
// — this module doesn't call quota-gate.ts itself (that's the API route's job, so the route can
// check quota BEFORE calling this and record usage AFTER, per the locked flow).
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { geocodeAddress, searchNearbyPlaces, dedupeByPlaceId } from "./places-client.js";
import { evaluate, RATING_FLOOR, NON_FOOD_EXPERIENCE_CATEGORIES } from "./matcher.js";
import { scoreCandidate, mapWithConcurrency, STEP3_CONCURRENCY_DEFAULT } from "./scoreCandidate.js";
import type { ScoreCandidateResult, ScoreCandidateHooks } from "./scoreCandidate.js";
import { callWithTimeout, type Timers } from "./call-timeout.js";
import { PLACES_CALL_TIMEOUT_MS, GEOCODE_CALL_TIMEOUT_MS, GEMINI_CALL_TIMEOUT_MS } from "./time-limits.js";
import type { CandidatePlace } from "./types.js";
import { CATEGORY_CONFIG, type PublicCategorySlug } from "./category-config.js";
import type { Deadline } from "./deadline.js";

/** Real Haversine distance, meters — 2026-08-17 addition, direct follow-up to the 2026-08-17
 * "Step 2's radius is a soft bias" the private development log entry. Identical formula to the one
 * already live-verified in `verify-squalo-vino-step2.ts` (and originally `diagnostic-mill-
 * valley-distance.ts`) — same real math, not reimplemented differently, now wired into
 * production rather than living only in one-off diagnostic scripts. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const GEMINI_MODEL = "gemini-3.6-flash";
/** Real, verified rate — ai.google.dev/gemini-api/docs/pricing, 2026-08-09 (Task 34). Same source scoreCandidate.ts's PRICING_STANDARD uses; duplicated here only for Step 1's own inline cost math, same pattern as every retrieval-filter-score-*.ts script. */
export const GEMINI_INPUT_COST_PER_1M = 1.5;
export const GEMINI_OUTPUT_COST_PER_1M = 7.5;

export interface ScoredPlace {
  place: CandidatePlace;
  result: ScoreCandidateResult;
}

export interface SearchPipelineResult {
  anchor: { latitude: number; longitude: number };
  /** Real, Google-returned formatted address for the resolved anchor — added 2026-09-26,
   * closing a real, confirmed bug (a bare, ambiguous neighborhood name silently resolving
   * to a same-named region in another state, with nothing anywhere surfacing that it happened).
   * Threaded through unmodified so the UI can show exactly what Google resolved, not a
   * re-derived or invented string. */
  anchorFormattedAddress: string;
  step1CandidateCount: number;
  step2SurvivorCount: number;
  scored: ScoredPlace[];
  /** Real totals, for quota-gate.ts's recordUsage() — geminiCalls = 1 (Step 1) + scored.length (Step 3, one per Step 2 survivor). placesCalls = step1CandidateCount (one Places lookup per Step 1 candidate, regardless of Step 2 survival — matches every validated pipeline script's real behavior). */
  geminiCalls: number;
  placesCalls: number;
  /** Real count of geocodeAddress() calls this run made — always 1 (the single anchor resolution below). Added 2026-08-19, closing a real, confirmed gap: Google's Geocoding API had zero cost tracking in quota-gate.ts (private development log, found during the reverse-geocoding build). Kept as its own real field rather than folded into placesCalls — it's a genuinely different SKU/rate, not the same Places API (New) search calls placesCalls counts. */
  geocodingCalls: number;
  geminiTokenCostUsd: number;
  /** True when the request deadline passed and the pipeline stopped starting new paid calls, so `scored` may be partial (added 2026-10-20). */
  timedOut?: boolean;
}

/** Most places Step 1 may hand to Step 2 and Step 3. The prompt asks for "up to 10", but a prompt is a request, not a limit, so the parsed list is cut here too (added 2026-10-20, spend protection). */
export const MAX_STEP1_PLACES = 10;

/** Paid calls a search has actually started, kept up to date as the pipeline runs so a failure part-way can still record what was spent. */
export interface UsageTally {
  geminiCalls: number;
  placesCalls: number;
  geocodingCalls: number;
  geminiTokenCostUsd: number;
}
export function newUsageTally(): UsageTally {
  return { geminiCalls: 0, placesCalls: 0, geocodingCalls: 0, geminiTokenCostUsd: 0 };
}

export interface Step1Raw {
  text: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

/** Replaceable network calls, so tests can run the real pipeline code with stubs and no paid call. Every field defaults to the real call. */
export interface PipelineDeps {
  geocode?: typeof geocodeAddress;
  step1?: (prompt: string, anchor: { latitude: number; longitude: number }, signal?: AbortSignal) => Promise<Step1Raw>;
  searchPlaces?: typeof searchNearbyPlaces;
  score?: typeof scoreCandidate;
  /** Once expired, no new paid call is started (Step 1, Places lookups, scoring, scoring retries). Calls already in flight finish or time out. */
  deadline?: Deadline;
  /** Timer source for the per-call timeouts; tests pass a fake one. */
  timers?: Timers;
  /** Per-call timeout overrides in ms (defaults: src/time-limits.ts). Infinity disables a timeout (negative control in tests). */
  callTimeoutMs?: { geocode?: number; places?: number; gemini?: number };
  /** Hooks passed through to scoreCandidate (stub Gemini call, fake sleep and timers) in tests. */
  scoreHooks?: ScoreCandidateHooks;
}

export function resolveCallTimeouts(deps: PipelineDeps) {
  return {
    geocode: deps.callTimeoutMs?.geocode ?? GEOCODE_CALL_TIMEOUT_MS,
    places: deps.callTimeoutMs?.places ?? PLACES_CALL_TIMEOUT_MS,
    gemini: deps.callTimeoutMs?.gemini ?? GEMINI_CALL_TIMEOUT_MS,
  };
}

/** The real Step 1 call: Gemini with Google Maps grounding, plain text out. Shared by the live and streaming pipelines. */
export async function defaultStep1(prompt: string, anchor: { latitude: number; longitude: number }, signal?: AbortSignal): Promise<Step1Raw> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("search-pipeline.ts: GEMINI_API_KEY is not set.");
  const ai = new GoogleGenAI({ apiKey });
  const interaction = await ai.interactions.create({
    model: GEMINI_MODEL,
    input: prompt,
    tools: [{ type: "google_maps", latitude: anchor.latitude, longitude: anchor.longitude }],
    generation_config: { thinking_level: "low", max_output_tokens: 4000 } as never,
  }, { signal }); // only our signal: the SDK's own `timeout` option alone does not bound a call (it retries internally; see scoreCandidate.ts)
  let text = "";
  for (const step of interaction.steps) {
    if (step.type === "model_output") {
      for (const block of step.content ?? []) {
        if (block.type === "text") text += block.text;
      }
    }
  }
  const usage = interaction.usage;
  return {
    text,
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: usage?.total_output_tokens ?? 0,
    thoughtTokens: usage?.total_thought_tokens ?? 0,
  };
}

export function step1CostUsd(raw: Step1Raw): number {
  return (raw.inputTokens / 1_000_000) * GEMINI_INPUT_COST_PER_1M + ((raw.outputTokens + raw.thoughtTokens) / 1_000_000) * GEMINI_OUTPUT_COST_PER_1M;
}

/** Parses Step 1's "Name — Address" lines, drops repeated names (first kept), and keeps at most MAX_STEP1_PLACES. Same parsing as before; the cut is new. */
export function parseStep1Places(text: string): Array<{ name: string; address: string }> {
  const step1Places: Array<{ name: string; address: string }> = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
    if (match) {
      const [, name, address] = match;
      if (name && address) step1Places.push({ name: name.trim(), address: address.trim() });
    }
  }
  const seenNames = new Set<string>();
  const distinctPlaces: Array<{ name: string; address: string }> = [];
  for (const p of step1Places) {
    if (p.name && !seenNames.has(p.name)) {
      seenNames.add(p.name);
      distinctPlaces.push(p);
    }
  }
  return distinctPlaces.slice(0, MAX_STEP1_PLACES);
}

/** How many Step 2 Places lookups run at once. Chosen 2026-10-20. Google's docs state the Places API (New) rate limit is per method per project but publish no number for Text Search (New), so 5 is a judgment, not a documented-safe value: one search issues at most ~10 lookups, so 5 at a time is a small burst. */
export const STEP2_CONCURRENCY = 5;

/**
 * Runs the Step 2 lookups concurrently and returns the passing places IN THE ORDER OF THE INPUT
 * (Step 1's order), however the lookups finish. `mapWithConcurrency` writes each result into its
 * own input index, so a slow early lookup can never be overtaken in the output by a fast later one.
 * That order matters downstream: `dedupeByPlaceId` keeps the FIRST match, so the order decides which
 * duplicate survives. `lookupOne` returns the place if it passed the filters, otherwise null.
 */
export async function runStep2Lookups<T>(
  items: T[],
  lookupOne: (item: T) => Promise<CandidatePlace | null>,
  concurrency: number = STEP2_CONCURRENCY
): Promise<CandidatePlace[]> {
  const results = await mapWithConcurrency(items, concurrency, (item) => lookupOne(item));
  return results.filter((p): p is CandidatePlace => p !== null);
}

/**
 * Runs the real, full Step 1->2->3 pipeline for one category + anchor. Mirrors
 * retrieval-filter-score-two-bridges-wine.ts's real logic exactly (the most recently
 * validated of the three real pipeline scripts this generalizes), just parameterized via
 * CATEGORY_CONFIG instead of hardcoded per-category constants.
 */
export async function runSearchPipeline(
  categorySlug: PublicCategorySlug,
  anchorAddress: string,
  tally: UsageTally = newUsageTally(),
  deps: PipelineDeps = {}
): Promise<SearchPipelineResult> {
  const config = CATEGORY_CONFIG[categorySlug];
  const totalStart = Date.now();
  const callTimeouts = resolveCallTimeouts(deps);
  tally.geocodingCalls += 1; // counted when the call starts, so a failure (or a timeout) still records it
  const anchor = await callWithTimeout(callTimeouts.geocode, (signal) => (deps.geocode ?? geocodeAddress)(anchorAddress, signal), deps.timers);
  const geocodeMs = Date.now() - totalStart;

  // ===== STEP 1: broad retrieval, free-form text, plain query, no filtering =====
  const step1Prompt = `Find real ${config.retrievalNounPhrase} near ${anchorAddress}. List up to 10 real places, one per line, each with its real name and real street address, in exactly this format: Name — Address. No descriptions, no other text.`;

  const step1Start = Date.now();
  let timedOut = false;
  let step1Raw: Step1Raw = { text: "", inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  if (deps.deadline?.expired()) {
    timedOut = true; // out of time before Step 1 could start: nothing more is started
  } else {
    tally.geminiCalls += 1;
    step1Raw = await callWithTimeout(callTimeouts.gemini, (signal) => (deps.step1 ?? defaultStep1)(step1Prompt, anchor, signal), deps.timers);
  }
  const step1Cost = step1CostUsd(step1Raw);
  tally.geminiTokenCostUsd += step1Cost;
  const distinctPlaces = parseStep1Places(step1Raw.text);

  const step1Ms = Date.now() - step1Start;

  // ===== STEP 2: server-side rating/price filtering (Places API) + real matcher.ts evaluate() =====
  // REAL, MOVED SERVER-SIDE, 2026-08-15 (private development log, same-date entry): minRating/
  // priceLevels are real Places API (New) searchText request parameters — Google's own server
  // now excludes sub-4.0-rated and VERY_EXPENSIVE places before the response is ever returned,
  // replacing matcher.ts's now-removed client-side ratingFloorRule/priceCeiling100Rule.
  //
  // REAL, NECESSARY EXCLUSION, not present in the original request that prompted this change:
  // Art must NOT get this filtering — the private development log, 2026-07-26/2026-07-31, "quality-
  // gating/rating floors don't apply to Art the way they do to food," already locked and
  // already enforced client-side via matcher.ts's NON_FOOD_EXPERIENCE_CATEGORIES. Applying
  // minRating/priceLevels unconditionally here (as a first, literal read of the request would)
  // would have silently regressed that decision — Art candidates below 4.0 or VERY_EXPENSIVE
  // would never even reach evaluate() to be exempted, since Google's own server would already
  // have excluded them from the response. Reuses the exact same real set matcher.ts's
  // evaluate() already uses, rather than a second, driftable copy of "art" in this file.
  const isNonFoodExperience = NON_FOOD_EXPERIENCE_CATEGORIES.has(config.searchCategory);

  const step2Start = Date.now();
  // Lookups run STEP2_CONCURRENCY at a time (was one after another until 2026-10-20). Every
  // candidate still gets exactly one lookup, so the call count is unchanged; the filters, the
  // evaluate() rules and the output order are unchanged.
  const survivors = await runStep2Lookups(distinctPlaces, async ({ name, address }) => {
    if (deps.deadline?.expired()) {
      timedOut = true; // out of time: do not start this lookup
      return null;
    }
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
            // Omits PRICE_LEVEL_VERY_EXPENSIVE — the real, request-side equivalent of the
            // former client-side $100 ceiling (priceCeiling100Rule, removed 2026-08-15).
            priceLevels: ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE"],
          }),
    }, signal), deps.timers);
    const place = results[0];
    if (!place) return null;
    // Real distance-from-anchor, 2026-08-17 — zero new API calls: place.location was already
    // being fetched (SEARCH_FIELD_MASK), just discarded until this change; the anchor's real
    // coordinates are already in hand from geocodeAddress() above. See the 2026-08-17 "Step 2's
    // radius is a soft bias" the private development log entry for why this matters: Step 2's real
    // locationBias is soft, so a survivor can genuinely be far from the anchor with nothing in
    // the response saying so until this field existed.
    if (place.location) {
      place.distanceMeters = haversineMeters(anchor.latitude, anchor.longitude, place.location.latitude, place.location.longitude);
    }
    const result = evaluate(place, config.searchCategory);
    return result.passed ? place : null;
  });

  // REAL BUG FIX, 2026-08-16 — confirmed live: Step 1 can mention the same real place twice
  // with slightly different phrasing (Step 1's own dedup above is by NAME only); Step 2 then
  // resolves each mention to a real Google place_id independently, so two survivors could be
  // the identical real place under two different names — Step 3 would score (and bill) the
  // same place twice. Dedupe on the real, stable place_id here, after Step 2 has assigned it,
  // before Step 3 spends anything on it — keeps the first occurrence, drops the rest. See
  // places-client.ts's dedupeByPlaceId() for the full real reasoning. Real, direct consequence:
  // this can only reduce Step 3's real Gemini cost (fewer survivors reach scoreCandidate()) —
  // Step 2's own Places API cost (placesCalls above) is already spent by this point and
  // unaffected, since the duplicate calls already happened before dedup could catch them.
  const placesCalls = tally.placesCalls; // lookups actually started (every candidate, unless the deadline cut Step 2 short)
  const dedupedSurvivors = dedupeByPlaceId(survivors);
  const step2Ms = Date.now() - step2Start;

  // ===== STEP 3: per-candidate scoring =====
  const step3Start = Date.now();
  const scoredOrSkipped = await mapWithConcurrency(dedupedSurvivors, STEP3_CONCURRENCY_DEFAULT, async (place): Promise<ScoredPlace | null> => {
    if (deps.deadline?.expired()) {
      timedOut = true; // out of time: do not start this scoring call
      return null;
    }
    tally.geminiCalls += 1;
    const result = await (deps.score ?? scoreCandidate)({
      place,
      tasteProfile: config.tasteProfile,
      locationDescription: `${place.name}, a real ${config.locationNounPhrase} near ${anchorAddress}`,
      anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
      deadline: deps.deadline,
      hooks: deps.scoreHooks,
    });
    tally.geminiTokenCostUsd += result.cost;
    tally.geminiCalls += Math.max(0, (result.attemptsUsed ?? 1) - 1); // each retry attempt was a separate paid call
    return { place, result };
  });
  const scored = scoredOrSkipped.filter((x): x is ScoredPlace => x !== null);

  const step3Ms = Date.now() - step3Start;
  const totalMs = Date.now() - totalStart;
  // One log line per search (no database change): per-stage wall-clock seconds. geocode is the
  // anchor lookup before Step 1; the stages plus geocode add up to total within a few ms.
  console.log(
    `search-pipeline timing: category=${categorySlug} total=${(totalMs / 1000).toFixed(2)}s geocode=${(geocodeMs / 1000).toFixed(2)}s ` +
      `step1=${(step1Ms / 1000).toFixed(2)}s step2=${(step2Ms / 1000).toFixed(2)}s step3=${(step3Ms / 1000).toFixed(2)}s ` +
      `step1_places=${distinctPlaces.length} step2_lookups=${placesCalls} step3_scored=${scored.length} timed_out=${timedOut}`
  );

  return {
    anchor,
    anchorFormattedAddress: anchor.formattedAddress,
    step1CandidateCount: distinctPlaces.length,
    step2SurvivorCount: survivors.length,
    scored,
    geminiCalls: tally.geminiCalls, // Step 1 plus the scoring calls actually started
    placesCalls,
    geocodingCalls: 1, // the single geocodeAddress(anchorAddress) call above — real, fixed at 1 per real run
    geminiTokenCostUsd: tally.geminiTokenCostUsd,
    ...(timedOut ? { timedOut: true } : {}),
  };
}
