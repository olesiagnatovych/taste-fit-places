// Real, generalized explore-mode orchestrator (2026-08-19) — direct build from the real v1
// search-flow spec (DECISIONS.md, 2026-08-18 "Real v1 search-flow spec" entry) and this same
// session's own prior effort-estimate audit. Runs when category is missing on a real search
// submission — location can be typed or empty ("nearby"), same real mechanism either way; the
// only difference is where the anchor string comes from (see the header note on `runExploreMode`
// below). Shows 3 real places per category (Coffee, Wine, Art), one category's real Step 1->3
// run at a time, results reported back progressively as each finishes — never all at once.
//
// REAL, DELIBERATE: this calls the EXISTING, already-live-validated `/api/search` route three
// times, sequentially — no new backend orchestration route, per the prior audit's own finding.
// Sequential, not parallel/Promise.all, for a real, confirmed reason: `quota-gate.ts`'s
// `recordUsage()` does a real read-then-write (`getMonthToDateCallCounts()` then an insert, no
// transaction lock) — concurrent calls could race and undercount the real marginal overage it's
// built to price precisely. A plain `for...of` loop with `await` inside it means each category's
// real search fully completes (and its real usage row is fully written) before the next one
// starts, which structurally cannot race. Confirmed in code before this file was written, not
// assumed.
//
// REAL, DELIBERATE: framework-agnostic, not a React component or hook. Zero consumer UI code
// exists anywhere in this codebase today (confirmed directly, only a server-rendered admin login
// page exists) — per this project's already-locked "prototype against real/mock data first, wire
// in the AI layer second" sequencing (private development log, 2026-07-29), this module is the real
// AI-layer piece, built and independently live-tested (verify-explore-mode.ts) ahead of whatever
// UI eventually calls it — not bolted onto a UI shell that doesn't exist yet.
//
// REAL, DELIBERATE SCOPE BOUNDARY, not an oversight: geolocation (resolving a real anchor string
// when location is typed empty — the true "nearby" case) is explicitly NOT built here, per
// direct instruction ("don't block this task on it"). This module always requires a real,
// already-resolved anchor string as input; the caller (a future UI, or geolocation once it's
// built) is responsible for supplying it, whether from typed text or from a resolved real
// coordinate. Confirmed via direct audit before this file was written: zero geolocation/reverse-
// geocode mechanism exists anywhere in this codebase (src/ or app/) as of this build.
//
// REAL, DELIBERATE: the "exactly 3 real places per category" slice happens HERE, client-side,
// after the real `/api/search` response — NOT inside `search-request-handler.ts`. That shared
// handler also serves a normal, single-category search (via the same route, and via
// `/api/search-query`), which must keep returning every real passing result, unsliced, exactly
// as already live-validated — capping it there would silently change that established behavior
// for every caller, not just explore mode. This is a real, deliberate correction to my own
// earlier stated plan (I originally said "server-side, one-line addition") — flagged explicitly
// as a reversal, not silently changed, per this project's own standing discipline on reversals.
import type { PublicCategorySlug } from "./category-config.js";
import { CATEGORY_CONFIG } from "./category-config.js";

const RESULTS_PER_CATEGORY = 3;

export interface ExploreCategoryOutcome {
  category: PublicCategorySlug;
  status: number;
  /** Real, already-sliced to RESULTS_PER_CATEGORY (or fewer, if the real search returned less than 3 passing results — never padded, never fabricated). Empty when the real search itself failed (non-200 status) or was denied by quota-gate. */
  results: Array<Record<string, unknown>>;
  /** The real, unmodified /api/search response body — kept alongside `results` so a caller can inspect the real denial message on a non-200 status without this module re-shaping error responses. */
  rawBody: Record<string, unknown>;
}

/**
 * Real, sequential, 3-category explore-mode orchestrator. Calls the existing, unmodified
 * `/api/search` route once per real category (Coffee, then Wine, then Art — the real, fixed
 * order `CATEGORY_CONFIG` declares its keys in), always fully awaiting one call before starting
 * the next — the real mechanism that keeps this safe against `quota-gate.ts`'s race condition
 * and satisfies the spec's "one category's Step 1->3 run at a time" requirement, structurally,
 * not by convention.
 *
 * @param anchor Real, already-resolved anchor string — typed location text, or a real resolved
 *   address/coordinate string once geolocation exists for the "nearby" case. This function does
 *   not resolve it itself.
 * @param onCategoryResult Real, progressive callback — fires immediately after each category's
 *   real search completes, before the next category's search starts. This is what "presented
 *   progressively as each finishes, not all at once" actually means at the code level.
 * @param baseUrl Real request origin — empty string (relative fetch, e.g. `/api/search`) for
 *   real in-browser use once a UI calls this; an absolute `http://localhost:PORT` for a real
 *   Node-side live test against a running dev server (see verify-explore-mode.ts).
 */
export async function runExploreMode(
  anchor: string,
  onCategoryResult: (outcome: ExploreCategoryOutcome) => void,
  baseUrl: string = ""
): Promise<ExploreCategoryOutcome[]> {
  const categories = Object.keys(CATEGORY_CONFIG) as PublicCategorySlug[];
  const outcomes: ExploreCategoryOutcome[] = [];

  for (const category of categories) {
    const response = await fetch(`${baseUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, anchor }),
    });
    const rawBody = (await response.json()) as Record<string, unknown>;
    const realResults = Array.isArray(rawBody.results) ? (rawBody.results as Array<Record<string, unknown>>) : [];
    const outcome: ExploreCategoryOutcome = {
      category,
      status: response.status,
      results: realResults.slice(0, RESULTS_PER_CATEGORY),
      rawBody,
    };
    outcomes.push(outcome);
    onCategoryResult(outcome);
  }

  return outcomes;
}
