import type { Fixture } from "./types.js";

// SYNTHETIC FIXTURES. Every place below is invented: names, ratings, prices, categories and
// signals are made up to exercise the rules in matcher.ts. None of it is Google Places content.
// (The private build's fixtures were drawn from real places in logged POCs; they are replaced
// here so this repo stores no Places API data.)
//
// Step 2 (matcher.ts) now reads structured fields only: category tag and price. Rating and the
// $100 ceiling are enforced server-side on the Places API request (minRating/priceLevels), and
// all taste judgments (food menu, natural wine, sauce, omakase) are Step 3's job (Gemini with
// Grounding, using taste-profiles.ts). The comment blocks at the end of this file record which
// fixtures were removed when rules moved out of Step 2, and why.

export const fixtures: Fixture[] = [
  {
    category: "wine_full_food",
    expectedPass: true,
    groundTruthNote:
      "Synthetic wine bar with a full kitchen. Google lists it as wine_bar/night_club, not restaurant. Validates that categoryLabelRule stays permissive despite an odd category tag (a real miss of this shape motivated the rule). Must pass.",
    place: {
      name: "Fake Wine Bar A (synthetic)",
      googleCategories: ["wine_bar", "night_club"],
      rating: 4.2,
      approxPricePerPerson: 45,
      descriptionSignals: [],
    },
  },
  {
    category: "sushi",
    expectedPass: true,
    groundTruthNote:
      "Synthetic sushi place that Google lists as asian_fusion/fusion before sushi_restaurant. Validates that categoryLabelRule stays permissive, and that an approximate price of $40 clears the sushi price cutoff (\"tops out ABOVE $30\", rule budget_floor_above_30usd). Must pass.",
    place: {
      name: "Fake Sushi Place B (synthetic)",
      googleCategories: ["asian_fusion_restaurant", "fusion_restaurant", "sushi_restaurant"],
      rating: 4.4,
      approxPricePerPerson: 40,
      distanceMeters: 500,
      descriptionSignals: [],
    },
  },
  {
    category: "pizza",
    expectedPass: true,
    groundTruthNote:
      "Fake Pizza Place C (synthetic) — REWRITTEN 2026-08-07 (compliance audit). Originally tested all three Pizza content disqualifiers (deep dish / processed sauce / thick dough) — all removed, now Step 3's job. `pizzaRules()` returns an empty array for every Pizza candidate now; this fixture documents that a thin-crust pizza fixture still passes on the generic rule alone (permissive category label). UPDATED 2026-08-15: no longer validates a local rating/price check — ratingFloorRule/priceCeiling100Rule are removed from matcher.ts entirely (moved server-side). Rating and price would now be enforced by Google's own server, not locally. Kept as the one representative Pizza fixture rather than removed, since Pizza currently has zero content-level fixtures otherwise.",
    place: {
      name: "Fake Pizza Place C (synthetic)",
      googleCategories: ["pizza_restaurant"],
      rating: 4.3,
      approxPricePerPerson: 22,
      descriptionSignals: ["wood-fired oven", "thin crust", "natural tomato sauce", "burrata", "quattro formaggi"],
    },
  },
  {
    category: "sushi",
    expectedPass: false,
    groundTruthNote:
      "Control — at or below the sushi price cutoff. UPDATED 2026-10-20: the cutoff is now \"tops out ABOVE $30\" (was a $25 floor); this fixture's approximate $18 fails under both. Budget heuristic: cheap usually signals compromised fish quality/quantity, regardless of rating. UNCHANGED 2026-08-07: budget_floor_25usd (sushiBudgetFloorCheck) reads only approxPricePerPerson/priceRange, structured fields — kept as-is by the compliance audit, unaffected. UNCHANGED 2026-08-15: this check stays client-side by design — Places API has no real numeric minimum-price request parameter, only a coarse priceLevels enum that can't replicate a $25 overlap check. See matcher.ts's own comment on sushiBudgetFloorCheck for the full real reasoning.",
    place: {
      name: "Control: Cheap Poke Counter",
      googleCategories: ["sushi_restaurant"],
      rating: 4.0,
      approxPricePerPerson: 18,
      descriptionSignals: ["fast casual", "poke bowl"],
    },
  },

  // ===== Sushi price cutoff, 2026-10-20: a place passes only if its price tops out ABOVE $30. =====
  // Synthetic, structured-fields-only fixtures (no real place is implied) covering the priceRange
  // branch, the approximate-per-person branch (must agree with it), and no-price-data.
  {
    category: "sushi",
    expectedPass: false,
    groundTruthNote: "Price cutoff — priceRange $20–$30 tops out AT $30, not above it: excluded (it passed under the old $25 floor).",
    place: { name: "Control: Sushi Range $20-30", googleCategories: ["sushi_restaurant"], rating: 4.4, priceRange: { startPrice: 20, endPrice: 30 }, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: true,
    groundTruthNote: "Price cutoff — priceRange $30–$50 tops out above $30: passes.",
    place: { name: "Control: Sushi Range $30-50", googleCategories: ["sushi_restaurant"], rating: 4.4, priceRange: { startPrice: 30, endPrice: 50 }, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: false,
    groundTruthNote: "Price cutoff — priceRange $10–$20 tops out well below $30: excluded (it was also excluded under the old $25 floor).",
    place: { name: "Control: Sushi Range $10-20", googleCategories: ["sushi_restaurant"], rating: 4.4, priceRange: { startPrice: 10, endPrice: 20 }, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: false,
    groundTruthNote: "Price cutoff, the band the change actually flips — priceRange $25–$30 passed under the old $25 floor and is now excluded.",
    place: { name: "Control: Sushi Range $25-30", googleCategories: ["sushi_restaurant"], rating: 4.4, priceRange: { startPrice: 25, endPrice: 30 }, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: true,
    groundTruthNote: "Price cutoff — a range that straddles the cutoff but tops out above it ($28–$32) passes; the rule reads the high end.",
    place: { name: "Control: Sushi Range $28-32", googleCategories: ["sushi_restaurant"], rating: 4.4, priceRange: { startPrice: 28, endPrice: 32 }, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: false,
    groundTruthNote: "Price cutoff, approximate branch — no priceRange, approxPricePerPerson exactly $30 is at the cutoff, not above it: excluded, agreeing with the priceRange branch.",
    place: { name: "Control: Sushi Approx $30, No Real Range", googleCategories: ["sushi_restaurant"], rating: 4.4, approxPricePerPerson: 30, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: true,
    groundTruthNote: "Price cutoff, approximate branch — no priceRange, approxPricePerPerson $35 (the real MODERATE bucket value) is above $30: passes.",
    place: { name: "Control: Sushi Approx $35, No Real Range", googleCategories: ["sushi_restaurant"], rating: 4.4, approxPricePerPerson: 35, descriptionSignals: [] },
  },
  {
    category: "sushi",
    expectedPass: true,
    groundTruthNote: "Price cutoff — NO price data at all (no priceRange, no approximation) behaves exactly as before: passes, since there is nothing to disqualify on.",
    place: { name: "Control: Sushi No Price Data", googleCategories: ["sushi_restaurant"], rating: 4.4, descriptionSignals: [] },
  },
];

// ============================================================================
// REMOVED 2026-08-07 (compliance audit, the private development log same date) — fixtures below
// this line no longer exist. Listed here, not silently deleted, so the removal is traceable:
//
// - "Fake Light-Bites Wine Bar" (wine_light_bites, expectedPass: true) — tested light-bites food-signal
//   matching and natural-wine vocabulary, both removed (naturalWineVocabularyRule, and the
//   inline light_bites_not_full_kitchen check). With those gone, this fixture no longer
//   exercised anything wineLightBitesRules() still does (nothing — it returns []); it was
//   fully redundant with the wine bar fixture's category-label test once its distinguishing rules were gone.
//
// - "Control: Red Pét-Nat Funky Bar" (wine_light_bites, expectedPass: true) — existed
//   specifically to validate that "fault" vocabulary (mousy, barnyard, sewage) reads as
//   POSITIVE for this taste profile, not disqualifying. That was naturalWineVocabularyRule's
//   entire purpose; the rule is removed, so this fixture tested nothing left in Step 2. This
//   vocabulary-as-positive-signal knowledge isn't lost — it lives in WINE_TASTE_PROFILE
//   (taste-profiles.ts) for Step 3 to apply.
//
// - "Control: Great Wine, Canned Food Only" (wine_light_bites, expectedPass: false) — tested
//   cannedOnlyFoodRule, a real locked disqualifier (2026-07-24) but one that reads review
//   text. Removed. Under the new code this fixture would now PASS (nothing left
//   to fail it on) — leaving expectedPass: false as-is would have made the suite wrong, not
//   just incomplete. The canned-only-food disqualifier itself is not abandoned — it's real,
//   locked criteria that Step 3 needs to apply going forward, just no longer Step 2's job.
//
// - "Control: Sauce-Drowned Roll House" (sushi, expectedPass: false) — tested
//   sauce_proportionate_not_dominant. Removed; same reasoning as canned-food above — the
//   fixture's outcome would now flip to PASS, which would be wrong to leave stated as
//   expectedPass: false.
//
// - "Control: Omakase-Gated Counter" (sushi, expectedPass: false) — tested
//   omakase_not_required, the exact bias fix this rule existed for. Removed. Also worth
//   noting for the record: this fixture's approxPricePerPerson (220) was hand-set above any
//   real priceLevel bucket value, so it was never actually exercising price_ceiling_100usd's
//   bucket fallback either (that fallback only fires on exactly 100) — its ENTIRE reason for
//   existing was the now-removed omakase rule.
//
// - "Control: Chicago Deep Dish House" (pizza, expectedPass: false) — tested no_deep_dish.
//   Removed; same reasoning as the other content-disqualifier controls above.
//
// - "Control: Ketchup-Sauce Slice Shop" (pizza, expectedPass: false) — tested
//   no_processed_ketchup_sauce. Removed; same reasoning.
//
// None of the underlying taste-profile knowledge these fixtures encoded is lost — it all
// still lives in taste-profiles.ts (WINE_TASTE_PROFILE, SUSHI_TASTE_PROFILE,
// PIZZA_TASTE_PROFILE) for Step 3 (Gemini+Grounding scoring) to apply. This file only
// documents what Step 2 (deterministic, structured-field-only filtering) is responsible for
// now. Step 3 (Gemini with Grounding) runs for all five categories.
// ============================================================================

// ============================================================================
// REMOVED 2026-08-15 (server-side rating/price filtering, the private development log same date) —
// fixtures below no longer exist. Listed here, not silently deleted:
//
// - "Control: Low-Rated Bistro" (wine_full_food, rating 3.2, expectedPass: false) — tested
//   ratingFloorRule directly. Removed — ratingFloorRule no longer exists in matcher.ts at
//   all (moved server-side, minRating on the real Places API searchText request). Under the
//   new code this fixture would now PASS locally (nothing left in matcher.ts to
//   fail it on) — in the real pipeline it would never reach evaluate() at all, since Google's
//   own server excludes sub-4.0-rated places before returning a response. Leaving
//   expectedPass: false as-is would have made the suite wrong, not just incomplete. The real
//   4.0 floor itself is not abandoned — it's enforced by Google's server now, via
//   `RATING_FLOOR` (exported from matcher.ts, imported into search-pipeline.ts) — same real
//   value, same 2026-07-27 decision, different enforcement point.
//
// - "Control: Very-Expensive Omakase, range fully $100+" (sushi, priceRange 110-180,
//   expectedPass: false) — tested priceCeiling100Rule's real-priceRange path directly.
//   Removed; same reasoning as Low-Rated Bistro above — priceCeiling100Rule no longer exists,
//   this fixture would now PASS locally, the real $100 ceiling is enforced
//   server-side now instead (priceLevels omitting PRICE_LEVEL_VERY_EXPENSIVE, on the real
//   Places API searchText request).
//
// - "Control: Range Touches $100 At High End Only" (sushi, priceRange 50-100,
//   expectedPass: true) — existed specifically to validate priceCeiling100Rule's low-end-only
//   boundary logic (a range merely touching $100 at its top, but starting well below, must
//   still pass). That rule no longer exists — this fixture's outcome doesn't flip (it
//   still passes, since sushiBudgetFloorCheck's price cutoff (tops out above $30) is also satisfied), but it no
//   longer exercises anything Step 2 actually does — fully redundant with "Control: Cheap
//   Poke Counter"'s price-cutoff test (now budget_floor_above_30usd) once its one distinguishing rule is gone.
//   Same reasoning the light-bites wine fixture was removed for in 2026-08-07.
//
// - "Control: VERY_EXPENSIVE Bucket, No Real Range" (sushi, approxPricePerPerson 100,
//   expectedPass: false) — tested priceCeiling100Rule's bucket-fallback path (no real
//   priceRange, only the coarse VERY_EXPENSIVE approximation). Removed; same reasoning as
//   the other two priceCeiling100Rule fixtures above — this fixture would now
//   PASS locally, since the rule that disqualified it no longer exists. Real, honest note:
//   this specific fallback path (bucket-only, no real priceRange) has no clean server-side
//   equivalent test — the real Places API priceLevels parameter is itself the bucket, so a
//   place Google returns after priceLevels filtering will simply never carry a
//   VERY_EXPENSIVE-only signal in the first place. Not a gap; the fallback logic in
//   priceLevelToApprox (places-client.ts) is unaffected and still real/correct for whatever
//   coarse bucket data Google does return.
//
// None of the underlying rating/price criteria these fixtures encoded is lost or weakened —
// the real 4.0 rating floor and the real $100 price ceiling are both still enforced, just by
// Google's own server (Places API's minRating/priceLevels parameters) rather than by this
// file's rule engine. See search-pipeline.ts and matcher.ts for the real, current enforcement
// point, and the private development log's 2026-08-15 entry for the full compliance reasoning.
// ============================================================================
