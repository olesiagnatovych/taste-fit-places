// Verification that Pizza is wired into the live search path (Task 110). Stubs only: no network,
// no database, no paid call. Checks (1) the config entry, (2) the category slug helpers, and (3) both
// pipelines, run for "pizza" with stubbed Step 1, Step 2 and Step 3: that the Step 1 prompt, the Step 2
// radius and filters, and the Step 3 description and taste profile are the expected ones.
// (The private build also compares these values against the experiment script they were copied from;
// that script holds real place data, so it is not in this repo and that check is removed here.)
import { CATEGORY_CONFIG, isPublicCategorySlug } from "../src/category-config.js";
import { PIZZA_TASTE_PROFILE } from "../src/taste-profiles.js";
import { runSearchPipeline, newUsageTally, type PipelineDeps } from "../src/search-pipeline.js";
import { runSearchPipelineStreaming } from "../src/search-pipeline-stream.js";
import { evaluate } from "../src/matcher.js";
import type { CandidatePlace } from "../src/types.js";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}

// ===== 1. config entry =====
const cfg = CATEGORY_CONFIG.pizza;
check("CATEGORY_CONFIG has exactly coffee, wine, art, sushi, pizza", JSON.stringify(Object.keys(CATEGORY_CONFIG).sort()) === JSON.stringify(["art", "coffee", "pizza", "sushi", "wine"]));
check("pizza entry: searchCategory 'pizza', Step 1 phrase 'pizzerias', Step 3 phrase 'pizzeria', radius 2000", cfg.searchCategory === "pizza" && cfg.retrievalNounPhrase === "pizzerias" && cfg.locationNounPhrase === "pizzeria" && cfg.radiusMeters === 2000, JSON.stringify({ ...cfg, tasteProfile: "…" }));
check("pizza entry uses PIZZA_TASTE_PROFILE (same string)", cfg.tasteProfile === PIZZA_TASTE_PROFILE && cfg.tasteProfile.length > 1000, `${cfg.tasteProfile.length} chars`);
check("isPublicCategorySlug: true for all five categories, false for unknown names", ["coffee", "wine", "art", "sushi", "pizza"].every(isPublicCategorySlug) && !isPublicCategorySlug("pasta") && !isPublicCategorySlug("") && !isPublicCategorySlug("pizzeria"));


async function main() {
  // ===== 4. both pipelines, stubbed =====
  const place = (key: string, rating = 4.5): CandidatePlace =>
    ({ name: `Stub Pizzeria ${key}`, address: `${key} Fake St`, placeId: `stub-pizza-${key}`, rating, googleCategories: ["pizza_restaurant"], descriptionSignals: [], location: { latitude: 1, longitude: 2 } }) as unknown as CandidatePlace;
  const score = (verdict: string, cost = 0.004) => ({ place: "x", verdict, confidence: "high", evidence: ["e"], caveat: "", rawText: "", parsedOk: true, unverified: false, cost, latencyMs: 1, attemptsUsed: 1, lastStatus: "completed" }) as never;
  const ANCHOR = "Hayes Valley, San Francisco, CA";
  for (const which of ["live", "stream"] as const) {
    const seen = { step1Prompt: "", radius: [] as number[], minRating: [] as unknown[], priceLevels: [] as unknown[], descriptions: [] as string[], profiles: [] as string[] };
    const verdicts: Record<string, string> = { A: "strong_match", B: "possible_match", C: "not_a_match" };
    const deps: PipelineDeps = {
      geocode: (async () => ({ latitude: 1, longitude: 2, formattedAddress: "Stub Address" })) as never,
      step1: async (prompt) => { seen.step1Prompt = prompt; return { text: ["A", "B", "C"].map((k) => `Stub Pizzeria ${k} — ${k} Fake St`).join("\n"), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 }; },
      searchPlaces: (async (req: { radiusMeters: number; textQuery?: string; minRating?: number; priceLevels?: string[] }) => {
        seen.radius.push(req.radiusMeters); seen.minRating.push(req.minRating); seen.priceLevels.push(req.priceLevels);
        return [place(/Stub Pizzeria (\w)/.exec(req.textQuery ?? "")?.[1] ?? "A")];
      }) as never,
      score: (async (input: { place: CandidatePlace; tasteProfile: string; locationDescription: string }) => {
        seen.descriptions.push(input.locationDescription); seen.profiles.push(input.tasteProfile);
        return score(verdicts[/Stub Pizzeria (\w)/.exec(input.place.name)?.[1] ?? "A"]);
      }) as never,
    };
    const tally = newUsageTally();
    let shown: string[] = [];
    let scoredCount = 0;
    if (which === "live") {
      const r = await runSearchPipeline("pizza", ANCHOR, tally, deps);
      scoredCount = r.scored.length;
      shown = r.scored.filter((s) => s.result.verdict !== "not_a_match").map((s) => s.place.name);
    } else {
      const cards: string[] = [];
      const r = await runSearchPipelineStreaming("pizza", ANCHOR, { onAnchor: () => {}, onCard: ({ place: p }) => cards.push(p.name) }, tally, deps);
      scoredCount = r.scoredCount;
      shown = cards;
    }
    check(`${which} pipeline, Step 1 prompt starts "Find real pizzerias near ${ANCHOR}."`, seen.step1Prompt.startsWith(`Find real pizzerias near ${ANCHOR}.`), seen.step1Prompt.slice(0, 70));
    check(`${which} pipeline, Step 2: 3 lookups, radius 2000 m, server-side minRating 4 and priceLevels (VERY_EXPENSIVE left out)`, seen.radius.length === 3 && seen.radius.every((r) => r === 2000) && seen.minRating.every((m) => m === 4) && seen.priceLevels.every((p) => Array.isArray(p) && p.length === 3 && !p.includes("PRICE_LEVEL_VERY_EXPENSIVE")));
    check(`${which} pipeline, Step 3: 3 places scored with PIZZA_TASTE_PROFILE and "<name>, a real pizzeria near ${ANCHOR}"`, scoredCount === 3 && seen.profiles.length === 3 && seen.profiles.every((p) => p === PIZZA_TASTE_PROFILE) && seen.descriptions.every((d) => /^Stub Pizzeria \w, a real pizzeria near Hayes Valley, San Francisco, CA$/.test(d)), seen.descriptions[0]);
    check(`${which} pipeline: not_a_match is not shown; the strong and possible places are`, shown.length === 2 && shown.some((n) => n.endsWith("A")) && shown.some((n) => n.endsWith("B")) && !shown.some((n) => n.endsWith("C")), shown.join(", "));
    check(`${which} pipeline: usage tally = geocode 1, Gemini 4 (Step 1 + 3 scoring), Places 3`, tally.geocodingCalls === 1 && tally.geminiCalls === 4 && tally.placesCalls === 3, JSON.stringify(tally));
  }
  check("Step 2 generic rules accept a pizza place (evaluate 'pizza' passes; pizzaRules() adds nothing)", evaluate(place("Z"), "pizza").passed === true);


}
main().then(() => {
  console.log(`\n${passed} of ${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error("verify-pizza-wiring crashed:", err);
  process.exit(1);
});
