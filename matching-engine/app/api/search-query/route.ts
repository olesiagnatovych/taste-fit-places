// Real free-text search entry point. CORRECTED 2026-08-19 — this comment previously said "the
// real UI direction is one free-text search bar... no chip UI" (DECISIONS.md, 2026-08-16); that's
// stale. Current real architecture (DECISIONS.md, 2026-08-19): TWO separate inputs — a category
// search bar (with Coffee/Wine/Art chips underneath it as shortcuts, not a replacement) and a
// separate location search bar. Chips are back in the primary interface, not a fallback-only
// picker.
//
// REAL, STILL OPEN as of this correction, not guessed either way (DECISIONS.md 2026-08-19,
// the private development log's same-date to-do table): whether the category search bar itself accepts free
// text needing inference (in which case it's a real, direct caller of this exact route) or is
// exact-match/chip-only (in which case category resolution never needs inference and this route
// serves some other, not-yet-specified real entry point instead). This route's own real logic —
// parse free text, infer category+location — is unchanged and still fully functional either way;
// what's undecided is which real UI surface calls it, not whether it still has a job.
//
// Genuinely separate route from /api/search rather than an optional field bolted onto it — the
// two have different, real input contracts (one free string vs. two structured fields), and
// keeping them separate means /api/search's existing behavior (already live-validated, GO LIVE
// item #3) is untouched by this addition. Both real entry points call the exact same
// src/search-request-handler.ts flow underneath — see that file's header for why "call the
// existing pipeline" had to mean the FULL quota-gated flow, not just search-pipeline.ts alone.
//
// UPDATED 2026-08-16 — real fuzzy fallback (DECISIONS.md, "Zero-match search fallback
// DECIDED"): backend piece only, decoupled from the real chip-picker UI (parked — Action-
// Items.md, same date). query-parser.ts's parseQuery() now returns a real 3-way
// QueryParseResult; a "suggestion" result still denies (422, still no results — a suggestion
// is not a resolved search) but includes `suggestedCategory` so a future UI can pre-highlight
// a chip. A "none" result keeps the exact same response shape as before this change.
import { NextRequest, NextResponse } from "next/server";
import { parseQuery } from "../../../src/query-parser.js";
import { handleSearchRequest } from "../../../src/search-request-handler.js";
import { exceedsInputLimit, INPUT_TOO_LONG_ERROR } from "../../../src/input-limits.js";

// Real, honest failure message for the genuinely-ambiguous/zero-match case — never guesses a
// category outright (a "suggestion" is offered separately, below, never silently substituted
// for a real match).
const AMBIGUOUS_QUERY_ERROR =
  "Couldn't tell what you're looking for and where from that search. Try including a category (coffee, wine, or art) and a place or neighborhood.";

// Vercel terminates a function that runs past this many seconds, and its finally blocks do not run, so the search
// pipelines stop starting new paid calls at an internal deadline well before it. The value must be a literal here;
// src/time-limits.ts holds the same number and scripts/verify-deadline.ts checks they match.
export const maxDuration = 150;

export async function POST(request: NextRequest) {
  let body: { query?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { query } = body;
  if (exceedsInputLimit(query)) {
    return NextResponse.json(INPUT_TOO_LONG_ERROR, { status: 400 });
  }
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return NextResponse.json({ error: "Missing query." }, { status: 400 });
  }

  const parsed = parseQuery(query);

  if (parsed.kind === "none") {
    return NextResponse.json({ error: AMBIGUOUS_QUERY_ERROR }, { status: 422 });
  }

  if (parsed.kind === "suggestion") {
    // Real, deliberate: still a 422, still zero results — a fuzzy suggestion is not a resolved
    // search. suggestedCategory is real, extra information for a future chip-picker UI to
    // pre-highlight, never used here to silently run a guessed search.
    return NextResponse.json(
      { error: AMBIGUOUS_QUERY_ERROR, suggestedCategory: parsed.suggestedCategory },
      { status: 422 }
    );
  }

  const outcome = await handleSearchRequest(parsed.category, parsed.location);
  return NextResponse.json(outcome.body, { status: outcome.status });
}
