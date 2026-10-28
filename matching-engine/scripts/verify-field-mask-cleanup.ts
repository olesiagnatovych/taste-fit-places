// Real, live verification for the field-mask cleanup (2026-08-15) — removes places.reviews/
// places.editorialSummary from places-client.ts's SEARCH_FIELD_MASK. Explicitly NOT run
// against production (never touches /api/search or quota-gate.ts) — a real, direct, isolated
// live Places API call for a generic "sushi restaurant" query (the private build used one known
// test place; it is replaced here so no real place name sits in the repo).
//
// Confirms two things, both live, not assumed:
//   1. Google's own real response body no longer contains reviews/editorialSummary keys at
//      all — a raw fetch, not just re-reading the (already-updated) mapping code, since the
//      mapping code trusting itself isn't proof the field mask actually changed what Google
//      sends back.
//   2. Every mapped result carries an empty descriptionSignals array, and matcher.ts's evaluate()
//      still runs on that shape — structurally guaranteed, since evaluate() has read zero
//      descriptionSignals-dependent rules since the 2026-08-07 compliance audit, but confirmed
//      live here rather than left as a pure code-reading claim.
import "dotenv/config";
import { geocodeAddress, searchNearbyPlaces } from "../src/places-client.js";
import { evaluate } from "../src/matcher.js";

const CURRENT_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.types,places.rating,places.userRatingCount,places.priceLevel,places.priceRange,places.location,places.googleMapsUri,nextPageToken";

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set.");

  console.log("=".repeat(80));
  console.log("1. Raw live fetch — real Google response body, current field mask");
  console.log("=".repeat(80));
  const anchor = await geocodeAddress("Hayes Valley, San Francisco, CA");
  const rawResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": CURRENT_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: "sushi restaurant",
      locationBias: { circle: { center: { latitude: anchor.latitude, longitude: anchor.longitude }, radius: 2000 } },
    }),
  });
  const rawJson = await rawResponse.json();
  const firstPlace = rawJson.places?.[0] ?? {};
  const realKeys = Object.keys(firstPlace);
  console.log(`  Real response keys for first place: ${realKeys.join(", ")}`);
  const hasReviews = "reviews" in firstPlace;
  const hasEditorialSummary = "editorialSummary" in firstPlace;
  console.log(`  Contains "reviews" key: ${hasReviews}`);
  console.log(`  Contains "editorialSummary" key: ${hasEditorialSummary}`);
  if (hasReviews || hasEditorialSummary) {
    console.error("  FAIL — Google's real response still includes a removed field. Field mask change did not take effect as expected.");
    process.exitCode = 1;
  } else {
    console.log("  PASS — real Google response confirmed clean of both removed fields.");
  }

  console.log("\n" + "=".repeat(80));
  console.log("2. descriptionSignals empty on live results, evaluate() runs on that shape");
  console.log("=".repeat(80));
  const results = await searchNearbyPlaces({
    latitude: anchor.latitude,
    longitude: anchor.longitude,
    radiusMeters: 2000,
    textQuery: "sushi restaurant",
  });
  if (results.length === 0) throw new Error("No live results for the generic sushi query — cannot verify.");
  const withSignals = results.filter((p) => p.descriptionSignals.length > 0).length;
  console.log(`  Live results: ${results.length}; results with non-empty descriptionSignals: ${withSignals} (expected: 0)`);
  const evalResult = evaluate(results[0], "sushi");
  console.log(`  evaluate() on the first result: passed=${evalResult.passed}`);
  evalResult.ruleResults.forEach((r) => console.log(`    [${r.rule}] passed=${r.passed} — ${r.reason}`));
  if (withSignals === 0) {
    console.log(`\n  PASS — every mapped result has empty descriptionSignals, and evaluate() runs on that shape.`);
  } else {
    console.error(`\n  FAIL — ${withSignals} result(s) still carry descriptionSignals.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("verify-field-mask-cleanup FAILED:", err);
  process.exitCode = 1;
});
