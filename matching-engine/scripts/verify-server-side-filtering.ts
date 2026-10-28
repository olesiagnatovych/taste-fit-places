// Real, live verification for the server-side rating/price filtering change (2026-08-15,
// the private development log same-date entry) — matching-engine/src/places-client.ts's new
// minRating/priceLevels request parameters. Confirms, live, not assumed: (1) Google's real
// response no longer includes sub-4.0-rated or VERY_EXPENSIVE places; (2) matcher.ts's
// evaluate() still produces the correct, unchanged real result for surviving candidates
// (categoryLabelRule + any category-specific rules — no rating/price rule runs anymore,
// since it's gone from matcher.ts entirely).
import "dotenv/config";
import { geocodeAddress, searchNearbyPlaces } from "../src/places-client.js";
import { evaluate } from "../src/matcher.js";

async function main() {
  console.log("=".repeat(80));
  console.log("Real live call — Coffee, Hayes Valley/Panhandle, San Francisco (known anchor)");
  console.log("minRating: 4.0, priceLevels: [INEXPENSIVE, MODERATE, EXPENSIVE] (VERY_EXPENSIVE omitted)");
  console.log("=".repeat(80));

  const anchor = await geocodeAddress("Hayes Valley, San Francisco, CA");
  const results = await searchNearbyPlaces({
    latitude: anchor.latitude,
    longitude: anchor.longitude,
    radiusMeters: 2000,
    textQuery: "coffee shops near Hayes Valley, San Francisco, CA",
    minRating: 4.0,
    priceLevels: ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE"],
  });

  console.log(`\nReal results returned: ${results.length}`);
  let anyBelow4 = false;
  let anyVeryExpensive = false;

  for (const place of results) {
    const priceNote = place.priceRange
      ? `$${place.priceRange.startPrice}-$${place.priceRange.endPrice}`
      : place.approxPricePerPerson === 100
        ? "VERY_EXPENSIVE bucket (approx)"
        : `approx $${place.approxPricePerPerson ?? "?"}`;
    console.log(`  ${place.name} — rating ${place.rating}, price ${priceNote}`);
    if (place.rating < 4.0) anyBelow4 = true;
    if (place.approxPricePerPerson === 100 && !place.priceRange) anyVeryExpensive = true;
    if (place.priceRange && place.priceRange.startPrice >= 100) anyVeryExpensive = true;
  }

  console.log("\n" + "=".repeat(80));
  console.log("1. Real Google response — rating/price check");
  console.log("=".repeat(80));
  if (anyBelow4) {
    console.error("  FAIL — a sub-4.0-rated place was returned. Server-side minRating did not take effect as expected.");
    process.exitCode = 1;
  } else {
    console.log(`  PASS — all ${results.length} real returned places have rating >= 4.0.`);
  }
  if (anyVeryExpensive) {
    console.error("  FAIL — a VERY_EXPENSIVE-tier place was returned. Server-side priceLevels did not take effect as expected.");
    process.exitCode = 1;
  } else {
    console.log(`  PASS — none of the ${results.length} real returned places are VERY_EXPENSIVE tier.`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("2. evaluate() on real surviving candidates — should only run categoryLabelRule (coffee has no category-specific rules)");
  console.log("=".repeat(80));
  let allPassed = true;
  for (const place of results) {
    const result = evaluate(place, "coffee");
    const ruleNames = result.ruleResults.map((r) => r.rule).join(", ");
    console.log(`  ${place.name} — passed=${result.passed}, rules run: [${ruleNames}]`);
    if (!result.passed) {
      console.error(`    FAIL — a real place that already cleared server-side rating/price filtering was rejected by evaluate(). Real rule results: ${JSON.stringify(result.ruleResults)}`);
      allPassed = false;
    }
    if (ruleNames !== "category_label_not_a_filter") {
      console.error(`    FAIL — unexpected rule set. Expected only category_label_not_a_filter (rating_floor/price_ceiling_100usd should no longer exist in matcher.ts at all).`);
      allPassed = false;
    }
  }
  if (allPassed) {
    console.log("\n  PASS — every real surviving candidate passed evaluate() correctly, with only category_label_not_a_filter running (no dead/removed rules present).");
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("verify-server-side-filtering FAILED:", err);
  process.exitCode = 1;
});
