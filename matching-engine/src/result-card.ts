// Builds one result card (the fields the results list renders) from a scored place. Copied from the
// per-result mapping inside search-request-handler.ts's handleSearchRequest(), so the streaming
// endpoint returns the same fields as /api/search. It is a copy, not a shared import, because
// /api/search's code path was deliberately left untouched when streaming was added.
import type { CandidatePlace } from "./types.js";
import type { ScoreCandidateResult } from "./scoreCandidate.js";
import type { StreamCard } from "./stream-events.js";

export function buildMapsLink(place: CandidatePlace): string {
  const query = encodeURIComponent(place.address ? `${place.name}, ${place.address}` : place.name);
  const placeIdParam = place.placeId ? `&query_place_id=${place.placeId}` : "";
  return `https://www.google.com/maps/search/?api=1&query=${query}${placeIdParam}`;
}

function heartCountFor(verdict: "strong_match" | "possible_match" | null): 3 | 2 | null {
  if (verdict === "strong_match") return 3;
  if (verdict === "possible_match") return 2;
  return null;
}

/** Same rule as handleSearchRequest(): an unverified place is shown; otherwise "not_a_match" is hidden. */
export function isShownResult(result: ScoreCandidateResult): boolean {
  return result.unverified || result.verdict !== "not_a_match";
}

export function buildResultCard(place: CandidatePlace, result: ScoreCandidateResult): StreamCard {
  const verdict = result.unverified ? null : (result.verdict as "strong_match" | "possible_match" | null);
  const distanceMiles = place.distanceMeters !== undefined ? Number((place.distanceMeters / 1609.344).toFixed(1)) : null;
  return {
    name: place.name,
    address: place.address ?? null,
    neighborhood: place.neighborhood ?? null,
    locality: place.locality ?? null,
    typeDisplayName: place.typeDisplayName ?? null,
    distanceMiles,
    rating: place.rating,
    priceRange: place.priceRange ?? null,
    mapsLink: buildMapsLink(place),
    verdict,
    heartCount: heartCountFor(verdict),
    unverified: result.unverified,
    confidence: result.confidence ?? null,
    evidence: result.evidence,
    caveat: result.caveat ?? null,
  };
}
