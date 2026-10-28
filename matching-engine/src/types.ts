// Core types for the taste-matching engine.
// This layer is deliberately DETERMINISTIC (no Claude API calls) — it encodes the
// disqualifier/floor rules we've already validated through manual POCs (two wine bars
// and a sushi place). Semantic/free-text taste-fit scoring (via Claude API)
// plugs in on top of this later, once these rules are proven not to reject known-good places.

export type SearchCategory =
  | "wine_light_bites" // Type A: extensive wine list, no full kitchen
  | "wine_full_food" // Type B: smaller wine list, real food menu
  | "sushi"
  | "coffee"
  | "pizza"
  | "art"; // added 2026-08-12 (Task 59) — was never in this type at all until now

export interface CandidatePlace {
  name: string;
  /** Real street address, used for dedup-by-address (two listings sharing an address are the same physical place). Undefined only if Places API didn't return one. */
  address?: string;
  /**
   * Real, stable Places API (New) place identifier (`places.id`) — 2026-08-12 addition (Task 63),
   * for the retrieval-framing experiment's real place-ID-based dedup/overlap logic (Task 62 found
   * a real bug in name-string-based overlap detection — an internal hyphen in a place's own name
   * caused a false negative). Pro SKU tier (verified live against Google's current docs before
   * adding); real $0 incremental cost on this pipeline's calls, same reasoning as `neighborhood`
   * (Task 55) and `userRatingCount` (Task 59) — this mask already sits at Enterprise+Atmosphere via
   * `places.reviews`. Previously a known, disclosed gap (noted in every prior JSON capture this
   * project — Task 52/56/60's `mapsLink` notes) — first wired in this task. Undefined only if
   * Google didn't return one (not expected in practice, but not assumed either).
   */
  placeId?: string;
  /**
   * Real neighborhood name, from Places API (New)'s `addressComponents` field, type
   * "neighborhood" — 2026-08-12 addition (Task 55). Undefined when Google doesn't return a
   * neighborhood-type component for this place (a real, non-rare case — confirmed via live
   * test, see the private development log same date). NOT free/Essentials-tier despite the private development log's
   * 2026-07-31 "Field priority order" note claiming so — confirmed live against Google's
   * current docs that addressComponents is Pro SKU; real $0 incremental cost here specifically
   * because this pipeline's calls already request places.reviews (Enterprise+Atmosphere, the
   * highest tier), and Google bills once at the single highest SKU triggered by any requested
   * field.
   */
  neighborhood?: string;
  /**
   * Real city/town-level address component, from the same `addressComponents` array as
   * `neighborhood` above but the "locality" type instead of "neighborhood" — 2026-08-17
   * addition, direct follow-up to the private development log 2026-08-17 "Step 2's radius is a
   * soft bias" entry: `neighborhood` alone can't distinguish a real out-of-area result (e.g.
   * Tiburon) from the intended search town (e.g. Mill Valley), since it's the wrong component
   * type for that. Already Pro SKU (same tier as `neighborhood`, `addressComponents` was
   * already being fetched) — real $0 incremental cost, confirmed live before adding, not
   * assumed. Undefined when Google doesn't return a locality-typed component.
   */
  locality?: string;
  /**
   * Real, human-readable primary-type label from Places API (New)'s `primaryTypeDisplayName`
   * field (e.g. "Coffee shop," "Wine bar") — 2026-08-17 addition, same origin as `locality`
   * above. Confirmed live against Google's current Text Search (New) docs: Pro SKU, same tier
   * this pipeline's calls already sit at via `addressComponents`/`location` — real $0
   * incremental cost, not assumed. Distinct from `googleCategories` below, which stays the raw
   * snake_case `types` array (e.g. "wine_bar") — this field is Google's own display string, not
   * derived from it locally. Undefined when Google doesn't return one for a place.
   */
  typeDisplayName?: string;
  /**
   * Real place coordinates from Places API (New)'s `location` field — 2026-08-17 addition, same
   * origin as `locality`/`typeDisplayName` above. Already fetched (`places.location` was already
   * in `SEARCH_FIELD_MASK` before this change) but previously discarded during mapping; now
   * passed through so `search-pipeline.ts` can compute real distance-from-anchor
   * (`distanceMeters` below) with zero new API calls. Undefined only if Google didn't return one
   * (not expected in practice, but not assumed).
   */
  location?: { latitude: number; longitude: number };
  /** Google's own place-type tags, in the order Google returns them (primary type first). */
  googleCategories: string[];
  rating: number;
  /**
   * Real review/rating count from Places API (New)'s `userRatingCount` field — 2026-08-12
   * addition (Task 59), for Art's museum/established-gallery/niche bucket assignment
   * (private development log, 2026-07-27: gallery-vs-niche split uses review count as an
   * already-available, free proxy). Enterprise SKU tier (verified live against Google's current
   * docs before adding) — real $0 incremental cost on this pipeline's calls specifically, since
   * they already request `places.reviews` (Enterprise+Atmosphere, the highest tier that exists),
   * same reasoning as `neighborhood`'s own Task 55 addition. Undefined when Google doesn't
   * return a count.
   */
  userRatingCount?: number;
  /** Google Places price_level, 1-4. Undefined = no price data available (common for tasting rooms). */
  priceLevel?: number;
  /** Approximate per-person price in USD, when known more precisely than price_level allows (e.g. sushi budget checks). */
  approxPricePerPerson?: number;
  /**
   * Real numeric price range from Places API (New)'s `priceRange` field (startPrice/endPrice
   * in USD), when Google returns one — 2026-08-06 addition, see the private development log's Sushi budget-
   * floor follow-up. Not every place has this; falls back to `approxPricePerPerson`'s coarser
   * priceLevel-bucket approximation when undefined. Distinct from `approxPricePerPerson`
   * because a real range (e.g. $20–$50) can straddle a floor that a single flattened number
   * would hide either side of.
   */
  priceRange?: { startPrice: number; endPrice: number };
  /** Free-text signals pulled from menu/description/reviews — stand-in for real review-text scanning until that's wired to Claude API. */
  descriptionSignals: string[];
  /**
   * Real Haversine distance from the search anchor, in meters — computed by `search-pipeline.ts`
   * from `location` above once both the place's real coordinates and the anchor's are in hand
   * (2026-08-17, same origin as `location`/`locality`/`typeDisplayName`). Left undefined by
   * `places-client.ts` itself, since it depends on the anchor, which that module doesn't know
   * about — computed by the caller, per this field's original 2026-08-05-era comment, now
   * actually wired up rather than perpetually unused.
   */
  distanceMeters?: number;
}

export interface RuleResult {
  rule: string;
  passed: boolean;
  reason: string;
}

export interface MatchResult {
  place: string;
  category: SearchCategory;
  passed: boolean;
  ruleResults: RuleResult[];
}

export interface Fixture {
  place: CandidatePlace;
  category: SearchCategory;
  /** What we already know the right answer is, from real POCs — the test checks the engine agrees. */
  expectedPass: boolean;
  /** Why we know this — cites the real POC/decision this fixture is drawn from. */
  groundTruthNote: string;
}
