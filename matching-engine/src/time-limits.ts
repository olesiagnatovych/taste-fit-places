// Time limits for the paid routes (2026-10-20, spend protection). One place for the numbers.
//
// Why they exist: production is Vercel Hobby. A function that runs past its maximum duration is
// terminated (504) and its `finally` blocks do not run, so a search that overran would have spent
// money that was never recorded and left its reservation open. So each paid route declares a
// maxDuration, the search pipelines stop starting NEW paid calls at an internal deadline, and every
// paid call has its own timeout, so nothing can still be running when the route limit arrives:
// deadline 100 s + longest call timeout 30 s = 130 s, under the 150 s route limit.
//
// Do NOT enable request cancellation (supportsCancellation) and do NOT add a vercel.json for it:
// cancelling on client disconnect would stop the `finally` blocks that record usage and release the
// reservation. scripts/verify-deadline.ts checks neither exists.
//
// Next.js reads `export const maxDuration` from each route file at build time and requires a plain
// numeric literal there (an imported constant is not accepted), so the route files repeat these two
// numbers as literals. scripts/verify-deadline.ts fails if a route's literal differs from this file.
export const SEARCH_ROUTE_MAX_DURATION_SECONDS = 150;
export const REVERSE_GEOCODE_ROUTE_MAX_DURATION_SECONDS = 30;

/** Seconds after request start at which a search stops starting new paid calls. */
export const PIPELINE_DEADLINE_SECONDS = 100;
export const PIPELINE_DEADLINE_MS = PIPELINE_DEADLINE_SECONDS * 1000;

// Per-call timeouts (src/call-timeout.ts): a call that has started is aborted, and the request stops waiting
// for it, after this long. Every scoring retry attempt gets its own timeout, and no attempt starts after the
// request deadline, so the worst case is the deadline plus the longest call timeout.
export const PLACES_CALL_TIMEOUT_MS = 15_000;
export const GEOCODE_CALL_TIMEOUT_MS = 15_000;
export const GEMINI_CALL_TIMEOUT_MS = 30_000;
export const LONGEST_CALL_TIMEOUT_MS = Math.max(PLACES_CALL_TIMEOUT_MS, GEOCODE_CALL_TIMEOUT_MS, GEMINI_CALL_TIMEOUT_MS);
/** Latest a search should finish calling Google: deadline + longest call timeout (130 s), leaving the rest of the route limit for recording usage. */
export const WORST_CASE_PIPELINE_END_SECONDS = PIPELINE_DEADLINE_SECONDS + LONGEST_CALL_TIMEOUT_MS / 1000;
