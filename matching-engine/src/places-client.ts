// Real Places API (New) wiring — replaces the hand-built CandidatePlace fixtures with
// actual live search results. Feeds into the SAME matcher.ts / scoreCandidate.ts layers
// already validated against known real POCs — this module's only job is to fetch real
// data and shape it into the same CandidatePlace interface, nothing else changes downstream.
// (CORRECTED 2026-08-13, Task 68's audit — this comment named the old, dead semantic-scorer.ts
// as the real scoring layer; scoreCandidate.ts, the real current one since the retrieval/
// filter/score pivot, was never updated in here.)

import type { CandidatePlace } from "./types.js";

const PLACES_API_BASE = "https://places.googleapis.com/v1";

interface PlacesSearchNearbyRequest {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /** e.g. ["restaurant"], ["wine_bar"] — Places API (New) "includedTypes", PLURAL array. searchNearby ONLY — confirmed live (2026-08-07) that searchText rejects this field name with a 400 ("Unknown name \"includedTypes\": Cannot find field"). Use `includedType` (singular) below for a textQuery request instead. */
  includedTypes?: string[];
  /** Free-text query, e.g. "natural wine bar" — used instead of / alongside includedTypes when a text search fits better (mirrors the anchor+radius decision in the private development log, NOT neighborhood-name search). */
  textQuery?: string;
  /**
   * Places API (New) searchText's real type-filter field — SINGULAR string, e.g. "wine_bar".
   * Confirmed live (2026-08-07, strict-type-filtering-field-check.ts) as the correct field
   * name for searchText; the plural `includedTypes` above is searchNearby-only and 400s on
   * searchText. Only meaningful together with `textQuery`.
   */
  includedType?: string;
  /**
   * Places API (New)'s real strict-type-filtering toggle (searchText only). `false` (the
   * default) treats `includedType` as a soft signal; `true` makes it a hard filter. Added
   * 2026-08-07 for the Step-1-query-narrowing test — per Perplexity's confirmed research
   * (private development log, 2026-08-06), `textQuery` genuinely affects ranking at our real
   * access tier, but Google does not confirm it weighs review text specifically — a
   * recall-biasing signal, not a verified classifier.
   */
  strictTypeFiltering?: boolean;
  maxResultCount?: number;
  /**
   * Fetch additional pages of results (2026-08-05, candidate-recall fix — the private development log same date).
   * Only valid with `textQuery` (searchText supports pagination up to 3 pages / 60 results
   * total; searchNearby does NOT support pagination at all — confirmed via Google's own
   * documentation, the private development log 2026-08-01). Requesting maxPages > 1 without
   * textQuery throws, rather than silently returning only page 1. Default 1 (unchanged
   * behavior for every existing caller). Real, verified fix for the dense-market truncation
   * diagnosed in diagnostic-west10west-type.ts: searchNearby's hard 20-result cap was
   * crowding out real, correctly-typed, in-radius candidates (6 places) in
   * West Village. Paginated searchText recovered all 7 of the previously-missing places in
   * a real re-test (fix-test-paginated-searchtext-westvillage.ts) — including a wine bar
   * whose real Places type never included `wine_bar` at all, because searchText's free-text
   * query isn't filtered by `includedTypes`.
   *
   * Real cost note: each additional page is a separate, separately-billed Places API call
   * (confirmed via a real 400 error on the first pagination attempt: a page request must
   * repeat every parameter from the initial request, not send `pageToken` alone — this is
   * still 3 distinct requests, not 1 request with 3 pages bundled). `maxPages: 3` therefore
   * costs up to 3x a single-page search-tier call at Places API (New)'s existing documented
   * rate (see the private development log's Tool & Cost Disclosure Table) — worth defaulting to 1
   * and opting a category into more pages deliberately, not turning this on globally.
   */
  maxPages?: number;
  /**
   * Places API (New) searchText's real `minRating` request parameter — added 2026-08-15
   * (private development log, same date). searchText ONLY — confirmed live against Google's
   * current docs (google-maps-compliance-pivot/29-content-definition-deep-dive.md, Sub-
   * Question 3); not a real searchNearby parameter. "Restricts results to only those whose
   * average user rating is greater than or equal to this limit" — Google's own server does
   * this filtering natively, before the response is ever returned, replacing what
   * `matcher.ts`'s now-removed `ratingFloorRule` used to do client-side. Requesting this
   * without `textQuery` throws — same pattern as `maxPages` above.
   */
  minRating?: number;
  /**
   * Places API (New) searchText's real `priceLevels` request parameter — same date/reasoning
   * as `minRating` above. searchText ONLY. A coarse enum
   * (`PRICE_LEVEL_INEXPENSIVE`/`PRICE_LEVEL_MODERATE`/`PRICE_LEVEL_EXPENSIVE`/
   * `PRICE_LEVEL_VERY_EXPENSIVE`), NOT the real numeric `priceRange` — replaces what
   * `matcher.ts`'s now-removed `priceCeiling100Rule` used to do client-side (by omitting
   * `PRICE_LEVEL_VERY_EXPENSIVE` from the list), but cannot replicate `sushiBudgetFloorCheck`'s
   * real numeric $25 floor — that check stays client-side, deliberately, see its own comment
   * in matcher.ts. Requesting this without `textQuery` throws — same pattern as `maxPages`.
   */
  priceLevels?: string[];
}

interface RawPlace {
  /** Real, stable place identifier — added 2026-08-12 (Task 63). Verified live (Pro SKU) before adding. */
  id?: string;
  displayName?: { text: string };
  formattedAddress?: string;
  types?: string[];
  rating?: number;
  /** Real review/rating count — added 2026-08-12 (Task 59) for Art's bucket assignment. Verified
   * live (Enterprise SKU) before adding, same $0-incremental-cost reasoning as `addressComponents`. */
  userRatingCount?: number;
  priceLevel?: string; // Places API (New) returns an enum string, e.g. "PRICE_LEVEL_MODERATE"
  /**
   * Real numeric price range (2026-08-06 addition — see the private development log, the Sushi budget-floor
   * follow-up). Confirmed live via a direct API call (price-range-field-live-check.ts) before
   * building on it: Places API (New) returns startPrice/endPrice Money objects with `units` as
   * a numeric STRING (e.g. "20"), not a number — parsed in rawPlaceToCandidatePlace below.
   * Coexists with the coarser `priceLevel` bucket; not every place returns a real range.
   */
  priceRange?: {
    startPrice?: { currencyCode?: string; units?: string };
    endPrice?: { currencyCode?: string; units?: string };
  };
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
  /** Real, human-readable primary-type label (e.g. "Coffee shop") — 2026-08-17 addition, LocalizedText shape confirmed live, same as `displayName` above. */
  primaryTypeDisplayName?: { text: string };
  // editorialSummary/reviews REMOVED from RawPlace 2026-08-15 (real, confirmed-dead Enterprise+
  // Atmosphere fields — no longer requested in SEARCH_FIELD_MASK, see that constant's own
  // comment for the full real reasoning and the real Task 66/67 caveat).
  /**
   * Real address-component breakdown, added 2026-08-12 (Task 55) for real neighborhood
   * extraction. `types` includes real Places API (New) component-type strings, e.g.
   * "neighborhood", "sublocality_level_1", "locality" — not every place returns a
   * "neighborhood"-typed component (confirmed live, see rawPlaceToCandidatePlace below and
   * the private development log, Task 55).
   */
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
}

/** Maps Places API (New) price_level enum to a rough approxPricePerPerson band. Coarse on purpose — real per-person price still needs to come from description/menu text where available, per the sushi budget-floor rule. */
function priceLevelToApprox(priceLevel?: string): number | undefined {
  switch (priceLevel) {
    case "PRICE_LEVEL_INEXPENSIVE":
      return 15;
    case "PRICE_LEVEL_MODERATE":
      return 35;
    case "PRICE_LEVEL_EXPENSIVE":
      return 60;
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return 100;
    default:
      return undefined; // no price data — must NOT be treated as a disqualifying $0, per the "no price data" UX decision already logged
  }
}

/** Parses Places API (New)'s priceRange Money-object shape into plain numbers, or undefined if
 * the field wasn't returned for this place (real, common case — not every place has it). */
function parsePriceRange(raw?: RawPlace["priceRange"]): { startPrice: number; endPrice: number } | undefined {
  const start = raw?.startPrice?.units;
  const end = raw?.endPrice?.units;
  if (start === undefined || end === undefined) return undefined;
  const startPrice = Number(start);
  const endPrice = Number(end);
  if (Number.isNaN(startPrice) || Number.isNaN(endPrice)) return undefined;
  return { startPrice, endPrice };
}

/** Extracts the real "neighborhood"-typed address component, if Google returned one for this
 * place — 2026-08-12 (Task 55). Returns undefined, not a guess or a sublocality fallback, when
 * no component carries the "neighborhood" type; a real, non-rare case, confirmed via live test
 * (private development log, Task 55) — callers must not assume this is always populated. */
function extractNeighborhood(raw?: RawPlace["addressComponents"]): string | undefined {
  const match = (raw ?? []).find((c) => c.types?.includes("neighborhood"));
  return match?.longText ?? match?.shortText;
}

/** Extracts the real "locality"-typed address component (city/town, e.g. "Tiburon" vs. "Mill
 * Valley") — 2026-08-17, same real `addressComponents` array as `extractNeighborhood` above,
 * same pattern, different component type. Direct follow-up to the 2026-08-17 "Step 2's radius
 * is a soft bias" the private development log entry: `neighborhood` is the wrong granularity for
 * telling a genuinely out-of-area result apart from the intended search town. Returns undefined,
 * not a guess, when no component carries the "locality" type. */
function extractLocality(raw?: RawPlace["addressComponents"]): string | undefined {
  const match = (raw ?? []).find((c) => c.types?.includes("locality"));
  return match?.longText ?? match?.shortText;
}

function rawPlaceToCandidatePlace(raw: RawPlace): CandidatePlace {
  // REMOVED 2026-08-15: reviews/editorialSummary construction. descriptionSignals stays on the
  // real CandidatePlace type (real, wide usage across fixtures.ts and diagnostic scripts — see
  // SEARCH_FIELD_MASK's own comment for the full reasoning) but is no longer populated from
  // real Places API data — always [] from this function now. See SEARCH_FIELD_MASK's comment
  // for the real Task 66/67 caveat before ever re-running either of those two scripts.
  return {
    name: raw.displayName?.text ?? "Unknown place",
    address: raw.formattedAddress,
    placeId: raw.id,
    neighborhood: extractNeighborhood(raw.addressComponents),
    // locality/typeDisplayName/location added 2026-08-17 — real data already in the fetched
    // response (SEARCH_FIELD_MASK already requested addressComponents/location; primaryType-
    // DisplayName newly added above), previously discarded here. See types.ts's own field
    // comments for the full real reasoning.
    locality: extractLocality(raw.addressComponents),
    typeDisplayName: raw.primaryTypeDisplayName?.text,
    location: raw.location,
    googleCategories: raw.types ?? [],
    rating: raw.rating ?? 0,
    userRatingCount: raw.userRatingCount,
    priceLevel: undefined, // superseded by approxPricePerPerson below
    approxPricePerPerson: priceLevelToApprox(raw.priceLevel),
    priceRange: parsePriceRange(raw.priceRange),
    descriptionSignals: [],
    distanceMeters: undefined, // computed by search-pipeline.ts once the anchor is known — see this field's own comment on CandidatePlace (types.ts)
  };
}

/**
 * Resolves a real, human-typed address into precise coordinates using the Geocoding API —
 * added 2026-07-24 after an AI tool (Claude Code) fabricated a specific wrong address for
 * a wine bar during live debugging (see the private development log finding, same date). Hand-typing or guessing
 * lat/lng for a search anchor carries the same false-confidence risk; this removes that step
 * entirely by resolving addresses programmatically instead.
 *
 * `formattedAddress` added 2026-09-26 — real, confirmed bug: an ambiguous, city-less anchor
 * that shares its name with a far-away region silently resolves to that region instead (real,
 * live-verified, in another state from the intended neighborhood) with nothing in the response ever
 * telling the caller which real place it actually picked. Google's own response already
 * carried `formatted_address` — this function was just discarding it. Not a fix for the
 * misresolution itself (deliberately not attempted — algorithmically guessing "the right city"
 * risks being wrong in a different way for a different ambiguous input); this surfaces the
 * real resolution so a caller (ultimately the UI) can show the user what location was actually
 * searched, making a misresolution visible and correctable instead of silent.
 */
export async function geocodeAddress(address: string, signal?: AbortSignal): Promise<{ latitude: number; longitude: number; formattedAddress: string }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. Add it to matching-engine/.env (see .env.example)."
    );
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    address
  )}&key=${apiKey}`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Geocoding API request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    status: string;
    results: Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }>;
  };

  if (data.status !== "OK" || data.results.length === 0) {
    throw new Error(`Geocoding failed for "${address}": status=${data.status}`);
  }

  const best = data.results[0];
  return { latitude: best.geometry.location.lat, longitude: best.geometry.location.lng, formattedAddress: best.formatted_address };
}

/**
 * Real reverse-geocoding — the opposite direction of `geocodeAddress()` above, same Geocoding
 * API, same key, same real response shape (`results[]` with `formatted_address`). Added
 * 2026-08-19 for the real browser-geolocation "nearby" case: `runSearchPipeline()`'s
 * `anchorAddress` parameter is always a string, so a resolved lat/lng from
 * `navigator.geolocation` still needs to become a real, usable address string before it can
 * flow into the existing pipeline unchanged — this function is that real conversion, not a new
 * pipeline-side capability.
 *
 * Real, confirmed behavior, not assumed: Google's reverse-geocode response returns MULTIPLE
 * results ordered from most to least specific (a full street address first, then coarser
 * matches — locality, postal code, etc.). `results[0]` is used here, same "take the best/most
 * specific match" pattern `geocodeAddress()` already uses for the forward direction.
 *
 * Real, honest, downstream consequence, not fixed here: the returned string gets re-forward-
 * geocoded by `geocodeAddress()` the next time it's passed into `runSearchPipeline()` (which
 * always geocodes whatever `anchorAddress` string it receives) — one extra real Geocoding API
 * call versus a lat/lng-native pipeline entry point would need. Real, small, existing-
 * architecture-consistent cost, not a bug; not solved here since it would mean changing
 * `runSearchPipeline()`'s real signature, out of this task's real scope (a standalone,
 * not-yet-wired-in build).
 */
export async function reverseGeocode(latitude: number, longitude: number, signal?: AbortSignal): Promise<string> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. Add it to matching-engine/.env (see .env.example)."
    );
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey}`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reverse geocoding API request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    status: string;
    results: Array<{ formatted_address: string }>;
  };

  if (data.status !== "OK" || data.results.length === 0) {
    throw new Error(`Reverse geocoding failed for ${latitude},${longitude}: status=${data.status}`);
  }

  return data.results[0].formatted_address;
}

/**
 * Searches nearby places using Places API (New), anchored to a lat/lng point + radius —
 * NOT neighborhood-name search, per the earlier wine-bar miss fix already locked in
 * the private development log. Returns places shaped as CandidatePlace, ready to feed into
 * matcher.ts (rule layer, Step 2) and/or scoreCandidate.ts (scoring layer, Step 3) unchanged.
 */
// places.addressComponents added 2026-08-12 (Task 55) for real neighborhood extraction — real
// $0 incremental cost on this specific field mask: it's Pro SKU in isolation (confirmed live
// against Google's current docs, NOT Essentials as the private development log's 2026-07-31 note
// claimed — a real, flagged correction), but this mask already requested places.reviews
// (Enterprise+Atmosphere, the highest SKU tier that exists) at the time, and Google bills a
// request once at the single highest SKU triggered by any field in its mask, confirmed
// verbatim from Google's own docs. See the private development log, Task 55 for the real test batch and
// live-doc verification. HISTORICAL as of 2026-08-15 — places.reviews is no longer in this
// mask (see the REMOVED note below); addressComponents/userRatingCount are now real Pro/
// Enterprise-tier fields, not "free" riders on an already-Atmosphere-tier request.
// places.userRatingCount added 2026-08-12 (Task 59) for Art's bucket assignment — real $0
// incremental cost, same reasoning as places.addressComponents (Task 55): this mask already
// requested places.reviews (Enterprise+Atmosphere, the highest SKU tier) at the time, and
// Google bills once at the single highest tier triggered by any field in the mask.
// places.id added 2026-08-12 (Task 63) — real, stable place identifier for real place-ID-based
// dedup/overlap logic (fixes the class of bug Task 62 found in name-string parsing). Pro SKU,
// real $0 incremental cost, same reasoning as addressComponents/userRatingCount above.
//
// REMOVED 2026-08-15: places.editorialSummary, places.reviews.text, places.reviews.originalText.
// Real, confirmed-dead data — neither Step 2 (matcher.ts, no rule has read descriptionSignals
// since the 2026-08-07 compliance audit) nor Step 3 (scoreCandidate.ts, its own independent
// Gemini+Grounding call, never reads CandidatePlace.descriptionSignals at all) touches this in
// the live pipeline (search-pipeline.ts / app/api/search/route.ts) — confirmed via a full
// recursive grep of matching-engine/src, not assumed. Both removed fields are real Enterprise+
// Atmosphere SKU triggers (confirmed directly against Google's current Places API New docs,
// 2026-08-15) — removing them drops this mask to plain Enterprise (places.rating/priceLevel/
// priceRange/userRatingCount keep it there; none of the remaining fields sit above Enterprise).
// REAL CAVEAT, not silently dropped: task66-art-dia-steward-experiment.ts and
// task67-art-dia-steward-e2-experiment.ts (real, validated 2026-08-12 institutional-steward
// experiments, NOT dead pre-pivot code) DO read real descriptionSignals fetched live from this
// exact function, for their core "does this candidate's real review/editorial text mention a
// steward institution" analysis. If either script is ever re-run without restoring these
// fields first, it will silently return ZERO steward matches, not an error — real, deliberate
// trade-off, not an oversight: the private development log's institutional-steward work is real but
// unscheduled v1.1, not worth holding this cleanup on. Full reasoning: the private development log,
// 2026-08-15 entry. CandidatePlace.descriptionSignals stays on the type (real, wide usage
// across fixtures.ts/diagnostic scripts/task66/67 — removing the field itself would break
// compilation for no benefit) but is no longer populated from real Places API data below.
// outdoorSeating (a real, pending v1.1 idea, per Perplexity compliance research not yet done)
// is ALSO an Enterprise+Atmosphere field (confirmed same live-doc check) — adding it later
// would put this mask straight back at the top tier regardless of this cleanup.
// places.primaryTypeDisplayName added 2026-08-17 (direct follow-up to the 2026-08-17 "Step 2's
// radius is a soft bias" the private development log entry's RESOLVED addendum) — real, human-readable
// type label (e.g. "Coffee shop," "Wine bar"), confirmed live against Google's current Text
// Search (New) docs as Pro SKU, the same tier `addressComponents`/`location` already sit this
// mask at — real, confirmed $0 incremental cost, not assumed.
const SEARCH_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.types,places.primaryTypeDisplayName,places.rating,places.userRatingCount,places.priceLevel,places.priceRange,places.location,places.googleMapsUri,nextPageToken";

async function fetchOnePage(
  req: PlacesSearchNearbyRequest,
  apiKey: string,
  pageToken?: string,
  signal?: AbortSignal
): Promise<{ places: RawPlace[]; nextPageToken?: string }> {
  const circleConstraint = {
    circle: {
      center: { latitude: req.latitude, longitude: req.longitude },
      radius: req.radiusMeters,
    },
  };

  // searchText uses locationBias (soft preference) for a circle; searchNearby uses
  // locationRestriction (hard boundary) instead — these are genuinely different fields
  // in Places API (New), not interchangeable, which caused a 400 INVALID_ARGUMENT here originally.
  const body: Record<string, unknown> = {
    ...(req.textQuery ? { locationBias: circleConstraint } : { locationRestriction: circleConstraint }),
    maxResultCount: req.maxResultCount ?? 10,
  };
  // includedTypes (plural) is searchNearby-only; includedType (singular) is searchText-only —
  // confirmed live, not interchangeable (see PlacesSearchNearbyRequest's field comments above).
  if (req.textQuery) {
    body.textQuery = req.textQuery;
    if (req.includedType) body.includedType = req.includedType;
    if (req.strictTypeFiltering !== undefined) body.strictTypeFiltering = req.strictTypeFiltering;
    // Real, server-side rating/price filtering (2026-08-15) — searchText only, guarded in
    // searchNearbyPlaces() below the same way maxPages is guarded.
    if (req.minRating !== undefined) body.minRating = req.minRating;
    if (req.priceLevels) body.priceLevels = req.priceLevels;
  } else if (req.includedTypes) {
    body.includedTypes = req.includedTypes;
  }
  // Confirmed via a real 400 error (2026-08-05, fix-test-paginated-searchtext-westvillage.ts):
  // a page request must repeat every parameter from the initial request, not send pageToken
  // alone — "Request parameters for paging requests must match the initial SearchText request."
  if (pageToken) body.pageToken = pageToken;

  // Places API (New) has separate endpoints for nearby-type search vs. text search;
  // pick based on which inputs were given, since a text query needs :searchText not :searchNearby.
  const endpoint = req.textQuery ? "places:searchText" : "places:searchNearby";

  // Real 400 caught by places-pagination-test.ts's regression test (2026-08-05): `nextPageToken`
  // is a valid field-mask path on :searchText only — "Cannot find matching fields for path
  // 'nextPageToken'" on :searchNearby. Only ask for it on the endpoint that can return it.
  const fieldMask = req.textQuery ? SEARCH_FIELD_MASK : SEARCH_FIELD_MASK.replace(",nextPageToken", "");

  const response = await fetch(`${PLACES_API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      // Field mask is REQUIRED by Places API (New) — without it, the response is empty.
      // Keep this in sync with what rawPlaceToCandidatePlace actually reads.
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Places API request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { places?: RawPlace[]; nextPageToken?: string };
  return { places: data.places ?? [], nextPageToken: data.nextPageToken };
}

export async function searchNearbyPlaces(
  req: PlacesSearchNearbyRequest,
  signal?: AbortSignal
): Promise<CandidatePlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. Add it to matching-engine/.env (see .env.example)."
    );
  }

  const maxPages = req.maxPages ?? 1;
  if (maxPages > 1 && !req.textQuery) {
    // searchNearby does not support pagination at all (private development log, 2026-08-01,
    // confirmed via Google's own documentation) — fail loudly rather than silently
    // returning only the first page and letting a caller believe it asked for more.
    throw new Error(
      "maxPages > 1 requires textQuery — searchNearby (includedTypes-only) does not support pagination."
    );
  }
  if ((req.minRating !== undefined || req.priceLevels) && !req.textQuery) {
    // Same real pattern as maxPages above — minRating/priceLevels are real searchText-only
    // request parameters (2026-08-15, the private development log), confirmed live against Google's
    // current docs. Fail loudly rather than silently dropping them and letting a caller
    // believe server-side filtering happened when it didn't.
    throw new Error(
      "minRating/priceLevels require textQuery — searchNearby (includedTypes-only) does not support these request parameters."
    );
  }

  const allPlaces: RawPlace[] = [];
  let pageToken: string | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const { places, nextPageToken } = await fetchOnePage(req, apiKey, pageToken, signal);
    allPlaces.push(...places);
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }

  return allPlaces.map(rawPlaceToCandidatePlace);
}

/**
 * Dedup rule (user decision, 2026-07-26, following a café-plus-bakery double-listing finding):
 * two listings sharing the same real address are the SAME physical place — e.g. a
 * business with separate "coffee shop" and "bakery" Google listings acting as two
 * entry points to one location. Different addresses (e.g. a genuinely different
 * neighborhood location of the same chain, like one café chain's SoHo location vs. its
 * East Village one) are NOT deduped — they're real, distinct places.
 *
 * When two entries share an address, the one with more reviews (rating_count proxy —
 * here approximated by keeping whichever entry appears first, since rating_count isn't
 * currently in CandidatePlace) is kept. The "merge descriptionSignals from both instead of
 * discarding one" refinement this comment originally floated is now moot as of 2026-08-15 —
 * descriptionSignals is no longer populated from real Places API data at all (see
 * SEARCH_FIELD_MASK's comment above), so there's nothing real left to merge.
 */
export function dedupeByAddress(places: CandidatePlace[]): CandidatePlace[] {
  const seen = new Map<string, CandidatePlace>();
  for (const place of places) {
    const key = place.address?.trim().toLowerCase();
    if (!key) {
      // No address at all — can't dedupe safely, keep as-is under a unique fallback key.
      seen.set(`no-address:${place.name}`, place);
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, place);
    }
  }
  return Array.from(seen.values());
}

/**
 * Real bug fix, 2026-08-16 — confirmed live: Step 1 (Gemini free-text retrieval) can mention
 * the same real place twice with slightly different phrasing (e.g. "Example Wine Bar" vs. a
 * near-duplicate variant); Step 1's own dedup is by NAME only (search-pipeline.ts's
 * `seenNames` check), which doesn't catch this. Step 2 then resolves each mention to a real
 * Google `place_id` independently via `searchNearbyPlaces()` — two different Step 1 name
 * strings can resolve to the identical real `place_id`, and nothing checked for that before
 * this fix, so the same real place got scored (and billed) twice in Step 3. Same real dedup
 * shape as `dedupeByAddress()` above, keyed on `placeId` instead of `address` — first
 * occurrence kept, rest dropped. Places with no real `placeId` at all can't be deduped this
 * way (Google didn't return one) — kept as-is under a unique fallback key, same reasoning as
 * `dedupeByAddress()`'s own "no address" case, never falsely treated as duplicates of each
 * other just because both lack an ID.
 */
export function dedupeByPlaceId(places: CandidatePlace[]): CandidatePlace[] {
  const seen = new Map<string, CandidatePlace>();
  for (const place of places) {
    const key = place.placeId;
    if (!key) {
      seen.set(`no-place-id:${place.name}:${place.address ?? ""}`, place);
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, place);
    }
  }
  return Array.from(seen.values());
}
