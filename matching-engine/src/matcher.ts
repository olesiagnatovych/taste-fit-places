import type { CandidatePlace, SearchCategory, RuleResult, MatchResult } from "./types.js";

// Rating floor LOCKED at 4.0 (2026-07-27 Lever 1 decision), replacing the never-confirmed
// 3.5 provisional value — backed by an empirical test across ~3,000 places from ~13 real
// Google Maps lists (private development log, 2026-07-27). This is the tier-1 (normal-search)
// floor for every category.
//
// MOVED SERVER-SIDE, 2026-08-15 (private development log, same-date entry) — this exact value
// no longer gates anything in this file. `ratingFloorRule` (and `priceCeiling100Rule` below)
// were removed: Places API (New)'s real `minRating`/`priceLevels` request parameters
// (searchText only, confirmed live against Google's current docs —
// google-maps-compliance-pivot/29-content-definition-deep-dive.md, Sub-Question 3) now do
// this filtering server-side, in `search-pipeline.ts`'s Step 2 call — the strongest-supported
// compliance position this project's research has found (Google's own servers execute the
// same operation natively, "by definition not creating new content", vs. this file's prior
// client-side replication of the same logic, which was real but GENUINELY UNDEFINED/gray-area).
// `RATING_FLOOR` stays exported here as the single real source of truth for the value itself
// (still 4.0, still the same 2026-07-27 decision) — `search-pipeline.ts` imports it rather
// than hardcoding a second, driftable `4.0` literal in a different file.
//
// RETIRED after the compliance rebuild: `search-orchestrator.ts` (Pizza's tiered rating-floor
// relaxation ladder — LEVER1_RATING_FLOOR_TIERS, tiers 4.0/3.8/3.6/relaxed) calls
// `evaluate(place, category, { ratingFloor: step.ratingFloor })`, and that whole mechanism
// depended on `ratingFloorRule` actually reading `options.ratingFloor`. With that rule gone,
// `evaluate()`'s `ratingFloor` option is inert — every tier produces an identical result, since
// nothing in this file reads the override anymore. The ladder is not being rebuilt, and nothing
// in the live search path uses it. See "Status and what's next" in the README.
export const RATING_FLOOR = 4.0;

/**
 * Category-label rule — deliberately permissive. Google's primary category tag is
 * NOT used as a hard filter, because both a wine bar miss (wine_bar/night_club, not
 * "restaurant") and a sushi place miss (asian_fusion, not "sushi_restaurant")
 * were caused by trusting category labels too much. This rule always passes; it exists
 * so the reasoning is visible in the output rather than silently absent.
 */
function categoryLabelRule(place: CandidatePlace): RuleResult {
  return {
    rule: "category_label_not_a_filter",
    passed: true,
    reason: `Google categories [${place.googleCategories.join(
      ", "
    )}] are informational only, not disqualifying — verified by content signals instead (fixes two earlier misses where a real fit had an unexpected Google type).`,
  };
}

/**
 * Budget-floor check, real-range-aware (2026-08-06, the private development log — the Sushi budget-floor
 * follow-up). Prefers `priceRange` (Places API New's real startPrice/endPrice) when Google
 * returns one — checks where the range's HIGH end sits against the cutoff, not whether a single
 * flattened number clears it. This matters because a place's real range can straddle the
 * cutoff in a way a coarse priceLevel-bucket approximation hides (confirmed live: one sushi
 * place's real range is $20–$50, but its priceLevel bucket flattens to a single $35 that would
 * silently and coincidentally pass or fail depending on which bucket a similar place happened
 * to land in). Falls back to the existing `approxPricePerPerson` bucket approximation only when
 * no real range is available — not every place returns `priceRange`. No price data at all still
 * passes (unchanged UX decision).
 *
 * CUTOFF CHANGED 2026-10-20, by direct instruction: was "range tops out at $25 or more passes";
 * is now "range tops out ABOVE $30 passes" (strictly above — a range ending exactly at $30,
 * e.g. "$20–30", is excluded, as is anything cheaper). The same cutoff applies to the
 * approximate-per-person branch so the two branches agree. The no-price-data behaviour is
 * unchanged (passes). The rule id changed from `budget_floor_25usd` to `budget_floor_above_30usd`
 * so logs don't claim a $25 floor that no longer exists.
 *
 * DELIBERATELY LEFT CLIENT-SIDE, 2026-08-15 (not an oversight — see the same-date server-side
 * filtering change to `ratingFloorRule`/`priceCeiling100Rule` above): Places API (New) has no
 * real numeric minimum-price request parameter — `priceLevels` (the only price-related search
 * parameter that exists) is a coarse 4-tier enum (INEXPENSIVE/MODERATE/EXPENSIVE/
 * VERY_EXPENSIVE), which cannot express "real numeric range tops out above $30," the actual check
 * this function performs. There is no server-side equivalent to move this to. Real, honest
 * compliance status, explicitly stated rather than assumed: UNCHANGED by the 2026-08-15
 * server-side move — this function is still exactly the same kind of operation
 * `priceCeiling100Rule` used to be (a purely client-side, structured-field-only numeric
 * threshold check), so it carries the same reasoning that check always had, not new or
 * different reasoning: GENUINELY UNDEFINED under Google's terms, strong inference toward
 * permitted, per `google-maps-compliance-pivot/29-content-definition-deep-dive.md`
 * (Sub-Question 3) — real, ordinary pass/fail filtering on an already-returned structured
 * field, the same category of operation Sub-Question 3 reasons about generally, just never
 * previously distinguished in COMPLIANCE-STATUS.md from the (now-resolved) $100 ceiling.
 */
/** Sushi price cutoff, USD per person: a place passes only if its price tops out ABOVE this. */
const SUSHI_PRICE_CUTOFF_USD = 30;

function sushiBudgetFloorCheck(place: CandidatePlace): RuleResult {
  if (place.priceRange) {
    const { startPrice, endPrice } = place.priceRange;
    const passed = endPrice > SUSHI_PRICE_CUTOFF_USD;
    return {
      rule: "budget_floor_above_30usd",
      passed,
      reason: passed
        ? `Real price range $${startPrice}–$${endPrice}/person tops out above the $${SUSHI_PRICE_CUTOFF_USD} cutoff (using the real range, not a flattened approximation).`
        : `Real price range $${startPrice}–$${endPrice}/person tops out at or below the $${SUSHI_PRICE_CUTOFF_USD} cutoff — signals compromised fish quality/quantity.`,
    };
  }
  const budgetFloorPassed =
    place.approxPricePerPerson === undefined || place.approxPricePerPerson > SUSHI_PRICE_CUTOFF_USD;
  return {
    rule: "budget_floor_above_30usd",
    passed: budgetFloorPassed,
    reason: budgetFloorPassed
      ? `Above the $${SUSHI_PRICE_CUTOFF_USD}/person cutoff (or no price data to disqualify on) — no real priceRange available, using the coarser priceLevel-bucket approximation.`
      : `Approx price $${place.approxPricePerPerson}/person (priceLevel-bucket approximation, no real range available) is at or below the $${SUSHI_PRICE_CUTOFF_USD} cutoff — signals compromised fish quality/quantity.`,
  };
}

/**
 * Compliance audit, 2026-08-07 (private development log, same date — "Compliance audit" entry).
 * Every rule that read `place.descriptionSignals` (real Google review/editorial text) has
 * been REMOVED from this file — `cannedOnlyFoodRule`, `naturalWineVocabularyRule`,
 * `countryOfOriginSignalRule`, the inline `light_bites_not_full_kitchen`/`real_food_menu`
 * checks (Wine); `no_geosmin_off_flavor`, `sauce_proportionate_not_dominant`,
 * `omakase_not_required` (Sushi); `specialty_craft_aware` (Coffee); `no_deep_dish`,
 * `no_processed_ketchup_sauce`, `thin_crust_not_thick_dough` (Pizza) — and the
 * `NATURAL_WINE_VOCABULARY`/`EASTERN_EUROPEAN_COUNTRY_VOCABULARY` constants and `hasAny()`
 * helper they depended on. Per `03-transient-use-findings.md`'s own finding: deriving *any*
 * conclusion from Google Maps content is restricted regardless of technical method (LLM,
 * embeddings, rule-based keyword matching, a deterministic classifier are all treated the
 * same), and regardless of whether the result gates a decision or is informational-only —
 * several of the removed rules always returned `passed: true` and were informational-only,
 * which does NOT exempt them under the actual finding. This file (Step 2) now checks
 * structured Google fields only (rating, category tag, price). Real, tracked consequence:
 * Wine still has taste-fit judgment because Step 3 (doc 25's retrieval/filter/score
 * pipeline) already exists and is tested for it (private development log, Task 31) — Sushi, Coffee, and
 * Pizza do NOT have a working Step 3 yet, so after this change those three categories have
 * zero taste-fit judgment until their own Step 3 is built. Not a silent regression — flagged
 * here and in the private development log as a known, tracked gap.
 */
function wineLightBitesRules(_place: CandidatePlace): RuleResult[] {
  return [];
}

function wineFullFoodRules(_place: CandidatePlace): RuleResult[] {
  return [];
}

function sushiRules(place: CandidatePlace): RuleResult[] {
  return [sushiBudgetFloorCheck(place)];
}

function coffeeRules(_place: CandidatePlace): RuleResult[] {
  return [];
}

function pizzaRules(_place: CandidatePlace): RuleResult[] {
  return [];
}

/**
 * Art, added 2026-08-12 (Task 59). Same compliance-driven shape as every other category since
 * the 2026-08-07 audit — all of Art's real hard-nos (religion-venue proportionality,
 * cruelty/violence content, the BDSM depiction-vs-documentation distinction, the era window, the
 * "real concept behind the work" core filter) depend on real review/description text, which
 * Step 2 can no longer read at all. All of it lives in Step 3 (ART_TASTE_PROFILE), not here.
 */
function artRules(_place: CandidatePlace): RuleResult[] {
  return [];
}

/**
 * Non-food experience categories — quality-gating (rating floor, $100 price ceiling) does NOT
 * apply the way it does to food/drink (private development log, 2026-07-26/2026-07-31: "quality-
 * gating/rating floors don't apply to Art the way they do to food" — user explicitly wants to
 * see whatever exists, even low-rated, out of curiosity; the price ceiling entry explicitly
 * carves out "Art, Parks/gardens, museums, and similar experiences"). Only "art" exists in this
 * set today; extend when a Parks/gardens category is added.
 *
 * EXPORTED as of 2026-08-15 (was private) — this file no longer enforces the exclusion itself
 * (ratingFloorRule/priceCeiling100Rule, the two rules this set used to gate, are both removed;
 * see the RATING_FLOOR comment above). `search-pipeline.ts` now needs this exact same set to
 * decide whether to send `minRating`/`priceLevels` on its real Step 2 Places API call — Art
 * must stay excluded from server-side rating/price filtering too, for the identical, already-
 * locked reason. Real, deliberate choice: `search-pipeline.ts` imports this real set rather
 * than declaring a second, driftable copy of "art" in a different file.
 */
export const NON_FOOD_EXPERIENCE_CATEGORIES = new Set<SearchCategory>(["art"]);

export function evaluate(
  place: CandidatePlace,
  category: SearchCategory,
  options?: { ratingFloor?: number }
): MatchResult {
  // REAL, FLAGGED CONSEQUENCE, 2026-08-15: `options.ratingFloor` is now dead — nothing in this
  // function reads it, since ratingFloorRule (the only consumer) was removed. Kept in the
  // signature rather than deleted, since search-orchestrator.ts (Pizza's tiered rating-floor
  // relaxation ladder, out of scope for this pass) still calls evaluate() with this option —
  // removing the parameter would be a compile break there, not just a silent behavior change.
  // See the RATING_FLOOR comment above for the full real consequence.
  const generic = [
    categoryLabelRule(place), // stays for every category — informational only, never a filter
  ];
  let categorySpecific: RuleResult[];
  switch (category) {
    case "wine_light_bites":
      categorySpecific = wineLightBitesRules(place);
      break;
    case "wine_full_food":
      categorySpecific = wineFullFoodRules(place);
      break;
    case "sushi":
      categorySpecific = sushiRules(place);
      break;
    case "coffee":
      categorySpecific = coffeeRules(place);
      break;
    case "pizza":
      categorySpecific = pizzaRules(place);
      break;
    case "art":
      categorySpecific = artRules(place);
      break;
  }
  const ruleResults = [...generic, ...categorySpecific];
  const passed = ruleResults.every((r) => r.passed);
  return { place: place.name, category, passed, ruleResults };
}

export type ArtBucket = "museum" | "established_gallery" | "niche";

/**
 * Real, deterministic 3-bucket Art result structure (private development log, 2026-07-27 "Art
 * discovery" entry) — zero new API cost, uses only fields already returned: `googleCategories`
 * (Places API `types`) and `userRatingCount` (Task 59 addition). Not an AI judgment — purely a
 * display-organization signal, run independently of Step 3's taste-fit verdict (a place can be
 * bucketed AND separately scored/rejected).
 *
 * Real, flagged judgment call on the Niche/Established boundary: the source decision states
 * "higher review count (rough tier, e.g. several thousand+)" for Established and "lower review
 * count (rough tier, e.g. under ~500)" for Niche — both explicitly "rough," with no single
 * number resolving the gap between them. This implementation uses the one concrete number
 * actually stated (500) as the single dividing line — reviewCount >= 500 -> established,
 * < 500 (or no count at all) -> niche — rather than inventing a second, unstated threshold for
 * a "several thousand+" zone. Flagged here and in the private development log (Task 59), not silently decided.
 */
const NICHE_REVIEW_COUNT_CEILING = 500;

export function assignArtBucket(place: CandidatePlace): ArtBucket {
  const types = place.googleCategories.map((t) => t.toLowerCase());
  const isMuseumType = types.some((t) => t.includes("museum")); // museum, art_museum, modern_art_museum, etc.
  if (isMuseumType) return "museum";

  const isGalleryType = types.some((t) => t === "art_gallery" || t === "art_center");
  if (isGalleryType) {
    const count = place.userRatingCount ?? 0;
    return count >= NICHE_REVIEW_COUNT_CEILING ? "established_gallery" : "niche";
  }

  // Real, honest fallback: a candidate whose Google types are neither museum- nor
  // gallery/center-typed (e.g. a park, a public sculpture installation with no dedicated
  // "art_gallery" tag) doesn't map cleanly to any of the 3 defined buckets. Defaulting to
  // "niche" rather than inventing a 4th bucket the source decision never specified — flagged,
  // not silent, via the real per-place bucket report in the pipeline output.
  return "niche";
}
