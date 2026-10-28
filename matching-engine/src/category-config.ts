// Real, generalized per-category pipeline config — the private development log GO LIVE item #3
// (/api/search route). Every `retrieval-filter-score-*.ts` script this project has built
// (Wine/Coffee/Art, real, tested, working) shares the exact same Step 1/2/3 shape; the only
// real per-category differences are the retrieval query's noun phrase, the Step 3
// locationDescription's noun phrase, the real matcher.ts SearchCategory value, the taste
// profile, and the real search radius already used in each category's own validated script.
// This file is the single, real source of truth for those differences — search-pipeline.ts
// reads it, no category-specific branching lives in the pipeline code itself.
//
// V1 LAUNCH SCOPE: Coffee, Wine, Art, Sushi, Pizza. Coffee/Wine/Art were the product owner's explicit
// launch call (private development log GO LIVE section), the "complex, layered" categories. Sushi
// wired in 2026-09-25 (direct follow-up to that day's real audit, which found the original
// "just add a map entry" framing here understated three real gaps — this repo's own
// PublicCategorySlug/CATEGORY_SYNONYMS coupling, and search-orchestrator.ts's dead
// rating-floor relaxation ladder, checked directly and confirmed NOT reachable by Sushi's
// wiring — see query-parser.ts/search-orchestrator.ts's own comments). Sushi's real
// taste-fit mechanism (SUSHI_TASTE_PROFILE, sushiRules()'s sushiBudgetFloorCheck, the Step
// 1→2→3 shape below) is unchanged from Task 33's original 2026-08-07 validated pipeline —
// retrievalNounPhrase/locationNounPhrase/radiusMeters below are copied verbatim from that
// script's own real, already-tested prompt strings, not re-derived.
//
// PIZZA is wired as of 2026-10-20 (private development log Task 110). retrievalNounPhrase ("pizzerias"),
// locationNounPhrase ("pizzeria") and radiusMeters (2000) are copied verbatim from
// retrieval-filter-score-hayes-valley-pizza.ts (Task 57, validated; Task 58 re-verified the
// profile). PIZZA_TASTE_PROFILE is the version Task 58 left: its text is byte-identical to the one
// committed in e8c3d0e. Pizza's three original disqualifiers (deep dish, processed/ketchup sauce,
// thick dough) live entirely in that Step 3 profile, since pizzaRules() in matcher.ts has returned
// [] since the 2026-08-07 compliance audit; Step 2 is the same generic server-side filtering as
// Sushi/Coffee (minRating 4.0, no VERY_EXPENSIVE).
// The dead relaxation ladder was checked directly on 2026-10-20 and is NOT reachable by the live
// path: the only importer of search-orchestrator.ts is orchestrator-test.ts, and none of the three
// search routes, both handlers, both pipelines, matcher.ts, scoreCandidate.ts, this file or
// query-parser.ts imports search-orchestrator.ts or relaxation-tiers.ts (which are left untouched).
// Pizza has no homepage chip, same as Sushi: free-text and structured search only.
//
// WINE, REAL RESOLUTION (private development log, 2026-08-14 "Wine subtype question resolved"):
// a generic Wine search uses a single SearchCategory value. `wine_full_food` is the one
// chosen — arbitrary, since `wineLightBitesRules()`/`wineFullFoodRules()` both already
// return [] (real no-ops since the 2026-08-07 compliance audit), so the two subtypes are
// functionally identical at the rule layer. WINE_TASTE_PROFILE (Step 3) already handles
// light-bites-vs-full-food as a secondary, non-blocking note within the single profile.
// Compound wine+food search is a real, understood future feature, explicitly parked for
// v2/v3 — not built here.
import { WINE_TASTE_PROFILE, COFFEE_TASTE_PROFILE, ART_TASTE_PROFILE, SUSHI_TASTE_PROFILE, PIZZA_TASTE_PROFILE } from "./taste-profiles.js";
import type { SearchCategory } from "./types.js";

export type PublicCategorySlug = "coffee" | "wine" | "art" | "sushi" | "pizza";

export interface CategoryConfig {
  searchCategory: SearchCategory;
  tasteProfile: string;
  /** Fills "Find real {retrievalNounPhrase} near {anchor}..." — Step 1's real query template, unchanged from every validated pipeline script. */
  retrievalNounPhrase: string;
  /** Fills "{place.name}, a real {locationNounPhrase} near {anchor}" — Step 3's real locationDescription template. */
  locationNounPhrase: string;
  /** Real search radius, meters — reused exactly from each category's own already-validated script (Wine/Coffee 2000m, Art 3000m — Art's own real radius choice, not changed here). */
  radiusMeters: number;
}

export const CATEGORY_CONFIG: Record<PublicCategorySlug, CategoryConfig> = {
  coffee: {
    searchCategory: "coffee",
    tasteProfile: COFFEE_TASTE_PROFILE,
    retrievalNounPhrase: "coffee shops",
    locationNounPhrase: "coffee shop",
    radiusMeters: 2000,
  },
  wine: {
    searchCategory: "wine_full_food",
    tasteProfile: WINE_TASTE_PROFILE,
    retrievalNounPhrase: "wine bars",
    locationNounPhrase: "wine bar",
    radiusMeters: 2000,
  },
  art: {
    searchCategory: "art",
    tasteProfile: ART_TASTE_PROFILE,
    retrievalNounPhrase: "art museums, art galleries, and sculpture/art gardens",
    locationNounPhrase: "art venue",
    radiusMeters: 3000,
  },
  // Real values copied verbatim from retrieval-filter-score-hayes-valley-sushi.ts (Task 33,
  // 2026-08-07, validated) — same 2000m radius already used for Coffee/Wine, same "sushi
  // restaurants"/"sushi restaurant" noun phrases that script's own real Step 1/Step 3 prompts
  // used, confirmed byte-identical to search-pipeline.ts's own template strings before
  // reusing them here (not re-derived, not guessed).
  sushi: {
    searchCategory: "sushi",
    tasteProfile: SUSHI_TASTE_PROFILE,
    retrievalNounPhrase: "sushi restaurants",
    locationNounPhrase: "sushi restaurant",
    radiusMeters: 2000,
  },
  // Real values copied verbatim from retrieval-filter-score-hayes-valley-pizza.ts (Task 57,
  // 2026-08-12, validated; profile re-verified in Task 58): the Step 1 prompt there is "Find real
  // pizzerias near ...", the Step 3 description is "..., a real pizzeria near ...", and its Step 2
  // radiusMeters is 2000. Not re-derived.
  pizza: {
    searchCategory: "pizza",
    tasteProfile: PIZZA_TASTE_PROFILE,
    retrievalNounPhrase: "pizzerias",
    locationNounPhrase: "pizzeria",
    radiusMeters: 2000,
  },
};

export function isPublicCategorySlug(value: string): value is PublicCategorySlug {
  return value === "coffee" || value === "wine" || value === "art" || value === "sushi" || value === "pizza";
}
