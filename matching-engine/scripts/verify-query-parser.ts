// Real verification for query-parser.ts. Pure logic, no API calls, no cost.
// Part 1: the exact-match cases from Task 75 — re-checked to confirm the fuzzy-fallback
// addition (Task 77) didn't change exact-match behavior at all.
// Part 2: the real fuzzy-fallback cases from Task 77 — the 3 named typos, a genuinely
// unrelated query (must get no suggestion, not a wrong guess), and the real "are" vs "art"
// false-positive collision that drove the per-length threshold design — confirmed it's
// actually prevented, not just reasoned about.
import { parseQuery } from "../src/query-parser.js";

type Expected =
  | { kind: "matched"; category: string; location: string }
  | { kind: "suggestion"; suggestedCategory: string }
  | { kind: "none" };

interface Case {
  query: string;
  expected: Expected;
  note?: string;
}

const cases: Case[] = [
  // ===== Part 1: exact-match, unchanged from Task 75 =====
  { query: "wine bars mill valley", expected: { kind: "matched", category: "wine", location: "mill valley" } },
  { query: "coffee near hayes valley", expected: { kind: "matched", category: "coffee", location: "hayes valley" } },
  { query: "art galleries soho", expected: { kind: "matched", category: "art", location: "soho" } },
  { query: "wine and coffee tasting", expected: { kind: "none" }, note: "genuinely ambiguous — 2 real categories match, not a typo situation" },
  { query: "coffee", expected: { kind: "none" }, note: "category matches, nothing real left for a location" },
  { query: "museums near the east village", expected: { kind: "matched", category: "art", location: "the east village" } },
  { query: "espresso in north beach", expected: { kind: "matched", category: "coffee", location: "north beach" }, note: "correctly spelled — exact match, not the fuzzy path" },

  // ===== Part 2: real fuzzy fallback, Task 77 =====
  { query: "expresso near union square", expected: { kind: "suggestion", suggestedCategory: "coffee" }, note: "the exact typo named in DECISIONS.md's own research example" },
  { query: "musem downtown", expected: { kind: "suggestion", suggestedCategory: "art" }, note: "real named typo — missing letter" },
  { query: "vinyard tour napa", expected: { kind: "suggestion", suggestedCategory: "wine" }, note: "real named typo — missing letter" },
  { query: "somewhere romantic for dinner", expected: { kind: "none" }, note: "genuinely unrelated — must NOT get a wrong guess" },
  { query: "best brunch spots", expected: { kind: "none" }, note: "genuinely unrelated, real words, no synonym anywhere nearby" },
  { query: "where are the good spots", expected: { kind: "none" }, note: "REAL regression check — \"are\" is Levenshtein distance 1 from \"art\"; confirms the length<=4 no-fuzzy rule actually prevents this false positive, not just reasoned about on paper" },

  // ===== Part 3: "experiences" as a filler word (2026-10-20) — the /alt homepage's third chip is "art experiences". =====
  // Before the fix, "experiences" was not a filler word, so it stayed behind as part of the location
  // ("experiences hayes valley, san francisco"), and bare "art experiences" parsed as a match whose location was "experiences".
  { query: "art experiences", expected: { kind: "none" }, note: "category matches, nothing real left for a location — same as \"art galleries\" alone" },
  { query: "art experiences near Hayes Valley, San Francisco", expected: { kind: "matched", category: "art", location: "hayes valley, san francisco" }, note: "REAL bug fix — \"experiences\" must not leak into the location" },
  // Unchanged-behaviour checks for the other two chips and for "art galleries" (bare and with a location).
  { query: "coffee shops", expected: { kind: "none" }, note: "unchanged" },
  { query: "wine bars", expected: { kind: "none" }, note: "unchanged" },
  { query: "art galleries", expected: { kind: "none" }, note: "unchanged" },
  { query: "coffee shops near Hayes Valley, San Francisco", expected: { kind: "matched", category: "coffee", location: "hayes valley, san francisco" }, note: "unchanged" },
  { query: "wine bars near Hayes Valley, San Francisco", expected: { kind: "matched", category: "wine", location: "hayes valley, san francisco" }, note: "unchanged" },
  { query: "art galleries near Hayes Valley, San Francisco", expected: { kind: "matched", category: "art", location: "hayes valley, san francisco" }, note: "unchanged" },

  // ===== Part 4: Pizza wired into the live search path (2026-10-20, the private development log Task 110) =====
  // Synonyms: pizza, pizzeria, pizzerias, pizza restaurant, pizza restaurants.
  { query: "pizza near Hayes Valley", expected: { kind: "matched", category: "pizza", location: "hayes valley" }, note: "the exact query from the task: was { kind: none } before pizza was wired" },
  { query: "pizza", expected: { kind: "none" }, note: "category matches, nothing real left for a location — same as \"coffee\" alone" },
  { query: "pizzeria", expected: { kind: "none" }, note: "synonym alone, nothing left for a location" },
  { query: "pizzeria hayes valley", expected: { kind: "matched", category: "pizza", location: "hayes valley" }, note: "singular synonym" },
  { query: "pizzerias near the mission", expected: { kind: "matched", category: "pizza", location: "the mission" }, note: "plural synonym, filler word stripped" },
  { query: "pizza restaurant near soho", expected: { kind: "matched", category: "pizza", location: "soho" }, note: "multi-word synonym" },
  { query: "pizza restaurants in the mission", expected: { kind: "matched", category: "pizza", location: "the mission" }, note: "REAL bug fix — before longest-synonym-first stripping this left \"restaurants\" in the location (\"restaurants the mission\")" },
  { query: "sushi restaurants near Hayes Valley", expected: { kind: "matched", category: "sushi", location: "hayes valley" }, note: "the same pre-existing flaw for the sushi synonym, fixed by the same change" },
  { query: "pizza and coffee in noho", expected: { kind: "none" }, note: "two real categories named — ambiguous, not a typo situation, no fuzzy check" },
  { query: "pizzza near soho", expected: { kind: "suggestion", suggestedCategory: "pizza" }, note: "typo, distance 1 from \"pizza\", token length 6 -> threshold 1" },
  { query: "gelato near piazza navona", expected: { kind: "suggestion", suggestedCategory: "pizza" }, note: "KNOWN, documented: \"piazza\" is distance 1 from \"pizza\", so a query with no exact match gets a \"did you mean pizza\" SUGGESTION (422, never a silent match)" },
  { query: "wine bars mill valley", expected: { kind: "matched", category: "wine", location: "mill valley" }, note: "longest-first stripping leaves multi-word wine synonyms unchanged" },
];

let allPassed = true;
for (const c of cases) {
  const result = parseQuery(c.query);
  const resultStr =
    result.kind === "matched"
      ? `{matched, category: "${result.category}", location: "${result.location}"}`
      : result.kind === "suggestion"
        ? `{suggestion, suggestedCategory: "${result.suggestedCategory}"}`
        : "{none}";
  const expectedStr =
    c.expected.kind === "matched"
      ? `{matched, category: "${c.expected.category}", location: "${c.expected.location}"}`
      : c.expected.kind === "suggestion"
        ? `{suggestion, suggestedCategory: "${c.expected.suggestedCategory}"}`
        : "{none}";

  const matches =
    result.kind === c.expected.kind &&
    (result.kind !== "matched" ||
      (c.expected.kind === "matched" && result.category === c.expected.category && result.location === c.expected.location)) &&
    (result.kind !== "suggestion" || (c.expected.kind === "suggestion" && result.suggestedCategory === c.expected.suggestedCategory));

  console.log(`${matches ? "✅" : "❌"} "${c.query}" -> ${resultStr}${matches ? "" : ` (expected ${expectedStr})`}${c.note ? `  [${c.note}]` : ""}`);
  if (!matches) allPassed = false;
}

console.log("\n" + "=".repeat(60));
console.log(allPassed ? "ALL CASES PASSED" : "SOME CASES FAILED — see ❌ above");
console.log("=".repeat(60));
if (!allPassed) process.exitCode = 1;
