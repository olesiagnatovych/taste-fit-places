// Real free-text query parser (DECISIONS.md, 2026-08-16 — "keyword/pattern matching, no
// separate LLM call, no separate location-parsing step"). Grounded in real Perplexity research
// (cost/latency/reliability compared across regex, a dedicated small LLM call, and embedding
// classifiers, per that same entry): regex wins because the real 3-category taxonomy (coffee/
// wine/art) is small, fixed, and lexically unambiguous. No location NER — Google Places API
// (New) already resolves fuzzy location text itself (confirmed throughout this project's real
// pipeline scripts), so re-parsing location on our end is redundant work for zero accuracy gain.
//
// Real, deliberate scope: this module answers exactly one question — "does this free-text
// query name exactly one of our 3 real categories, and what's left over after removing it?" —
// nothing more. Zero matches or more-than-one-category matches both fall through to the fuzzy
// fallback / "none" result (a real, honest "couldn't tell," never a guessed exact match) — see
// the caller (app/api/search-query/route.ts) for what happens next.
//
// FUZZY FALLBACK, added 2026-08-16 (DECISIONS.md, "Zero-match search fallback DECIDED"):
// backend piece only, decoupled from the real chip-picker UI (parked — the private development log, same
// date). When exact matching finds nothing, a cheap Levenshtein check against every known
// synonym can surface a `suggestedCategory` — real typo-correction ("expresso" -> coffee), not
// a second network call, not an LLM classification step, consistent with the original
// cost/latency reasoning.
import leven from "leven";
import type { PublicCategorySlug } from "./category-config.js";

export interface ParsedQuery {
  category: PublicCategorySlug;
  location: string;
}

/**
 * Real, discriminated result — a deliberate change from a plain `ParsedQuery | null` return.
 * The original spec described the fuzzy-fallback case as "category: null, location: null, plus
 * a suggestedCategory" — real, functionally faithful to that, but shaped as its own real
 * `kind: "matched" | "suggestion" | "none"` union instead: a caller doing `if (result)` on an
 * object where `category`/`location` are merely `null` would still see a truthy, non-null
 * value and could mistake a suggestion for a real match. A discriminated union makes that
 * mistake a real compile error instead of a real runtime bug — same real information either
 * way, safer shape.
 */
export type QueryParseResult =
  | { kind: "matched"; category: PublicCategorySlug; location: string }
  | { kind: "suggestion"; suggestedCategory: PublicCategorySlug }
  | { kind: "none" };

/**
 * Real synonym lists, matching the 3 real categories in category-config.ts. Multi-word
 * phrases ("tasting room", "coffee shop") are listed alongside their single-word roots
 * ("wine", "coffee") — both get stripped independently below, so overlapping matches (e.g. a
 * query containing both "wine" and "wine bar") are harmless, not double-counted.
 */
const CATEGORY_SYNONYMS: Record<PublicCategorySlug, string[]> = {
  coffee: ["coffee", "cafe", "espresso", "latte", "coffee shop", "coffee shops"],
  wine: [
    "wine",
    "vineyard",
    "vineyards",
    "tasting room",
    "tasting rooms",
    "winery",
    "wineries",
    "wine bar",
    "wine bars",
  ],
  art: ["art", "gallery", "galleries", "museum", "museums", "exhibit", "exhibits", "exhibition", "exhibitions"],
  // Real, checked before adding (2026-09-25) — a standalone collision script ran every one of
  // these tokens through this exact file's own thresholdForLength()/leven() logic against
  // every existing synonym across all 3 other categories: zero collisions found. Also checked
  // against a real, common-English-word stress test (the same class of risk "art" vs. "are"
  // was — none of these tokens are that close to any genuine English word).
  sushi: ["sushi", "sashimi", "omakase", "sushi restaurant", "sushi restaurants"],
  // Real, checked before adding (2026-10-20), same method as sushi above: every new token was run
  // through this file's own thresholdForLength()/leven() tiers against every existing synonym in the
  // other 4 categories (both directions): zero collisions. Also run against the system English
  // dictionary: the one word that fuzzy-matches a new token is "piazza" (distance 1 from "pizza"),
  // which for a query with no exact category match can only produce a "did you mean pizza"
  // suggestion (never a silent match); 131 dictionary words already do the same for existing synonyms.
  pizza: ["pizza", "pizzeria", "pizzerias", "pizza restaurant", "pizza restaurants"],
};

/**
 * Real filler words stripped after the category token(s) — connective words and generic
 * category-adjacent nouns that carry no real location information. Matches the task's own
 * given examples ("near", "in", "bars", "shops") plus a few obvious siblings.
 */
// "experiences" added 2026-10-20: the /alt homepage's "art experiences" suggestion otherwise left the
// word behind as part of the location ("experiences <neighborhood>, ...").
const FILLER_WORDS = ["near", "in", "at", "around", "bars", "bar", "shops", "shop", "houses", "house", "places", "spots", "experiences"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAll(text: string, terms: string[]): string {
  let result = text;
  for (const term of terms) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"), " ");
  }
  return result;
}

function matchingCategories(lowerQuery: string): PublicCategorySlug[] {
  const matched: PublicCategorySlug[] = [];
  for (const category of Object.keys(CATEGORY_SYNONYMS) as PublicCategorySlug[]) {
    const hasMatch = CATEGORY_SYNONYMS[category].some((syn) =>
      new RegExp(`\\b${escapeRegExp(syn)}\\b`).test(lowerQuery)
    );
    if (hasMatch) matched.push(category);
  }
  return matched;
}

/**
 * Real, per-token-length Levenshtein threshold — a flat threshold everywhere (e.g. the "≤2"
 * given in the original spec) is genuinely unsafe for short synonyms. Concrete, checked
 * example that drove this: "art" (3 letters) is Levenshtein distance 1 from "are" — a
 * completely ordinary English word ("where ARE the good coffee shops") — so a flat ≤1 (let
 * alone ≤2) threshold would misfire on real, unrelated queries, not just typos. Real, tiered
 * design instead, keyed on the query TOKEN's own length (not the synonym's):
 *   - length <= 4: NO fuzzy matching at all (exact only). Covers "art"(3)/"wine"(4)/"cafe"(4)
 *     — too small a Levenshtein neighborhood to be safe (also checked: "wine" vs "dine"/"wire"
 *     is distance 1, both plausible unrelated words in a travel/food query).
 *   - length 5-6: threshold 1. Covers the real "musem"(5) -> "museum" example exactly at the
 *     boundary, not loosely.
 *   - length >= 7: threshold 2. Covers "vinyard"(7)->"vineyard" and "expresso"(8)->"espresso",
 *     both real distance-1 typos, with real headroom for a genuine 2-edit typo too.
 * None of the 3 given real test typos are length <= 4, so this real safety tightening costs
 * nothing against the actual required cases.
 */
function thresholdForLength(len: number): number {
  if (len <= 4) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** Real fuzzy check — every query token against every known synonym across all 3 categories, per the tiered threshold above. Returns the single best-matching category, or null if nothing real clears its own threshold. Multi-word synonyms ("tasting room") are included in the comparison set but will practically never be close enough to a single token to match — expected, not a gap this fallback needs to cover (the exact-match path already handles multi-word phrases). */
function fuzzyMatchCategory(lowerQuery: string): PublicCategorySlug | null {
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);
  let best: { category: PublicCategorySlug; distance: number } | null = null;

  for (const token of tokens) {
    const threshold = thresholdForLength(token.length);
    if (threshold === 0) continue; // too short to fuzzy-match safely at all

    for (const category of Object.keys(CATEGORY_SYNONYMS) as PublicCategorySlug[]) {
      for (const syn of CATEGORY_SYNONYMS[category]) {
        const distance = leven(token, syn);
        if (distance <= threshold && (best === null || distance < best.distance)) {
          best = { category, distance };
        }
      }
    }
  }

  return best?.category ?? null;
}

/**
 * Real, honest parse. Exact match first (unchanged from before this task): a query naming
 * exactly one real category returns `{ kind: "matched" }`. Zero categories matched now falls
 * through to the real fuzzy fallback — a typo close enough to exactly one category's synonyms
 * returns `{ kind: "suggestion" }` (never a resolved category/location — a suggestion, not a
 * match). Genuinely ambiguous exact matches (more than one real category named — a real
 * "wine and coffee tasting" case, not a typo) do NOT get fuzzy-checked — that's not what fuzzy
 * matching is for, and correctly-spelled multi-category ambiguity isn't a "did you mean"
 * situation. Everything else, including a fuzzy check that finds nothing, is `{ kind: "none" }`.
 */
export function parseQuery(rawQuery: string): QueryParseResult {
  const lowerQuery = rawQuery.toLowerCase();
  const matched = matchingCategories(lowerQuery);

  if (matched.length === 1) {
    const category = matched[0];
    // Longest synonyms first (2026-10-20): otherwise "pizza" is stripped before "pizza restaurants" and
    // "restaurants" is left behind in the location ("sushi restaurants" had the same flaw).
    const withoutCategory = stripAll(lowerQuery, [...CATEGORY_SYNONYMS[category]].sort((a, b) => b.length - a.length));
    const withoutFiller = stripAll(withoutCategory, FILLER_WORDS);
    const location = withoutFiller.replace(/\s+/g, " ").trim();
    if (!location) return { kind: "none" };
    return { kind: "matched", category, location };
  }

  if (matched.length === 0) {
    const suggestedCategory = fuzzyMatchCategory(lowerQuery);
    if (suggestedCategory) return { kind: "suggestion", suggestedCategory };
  }

  return { kind: "none" };
}
