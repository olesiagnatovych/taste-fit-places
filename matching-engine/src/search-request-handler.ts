// Real, shared search-request logic — extracted 2026-08-16 from app/api/search/route.ts so
// the new free-text entry point (app/api/search-query/route.ts) can reuse the EXACT same real
// flow, not a second, driftable copy of it.
//
// REAL, DELIBERATE REASON THIS EXISTS, not just a refactor for its own sake: the free-text
// route's task description said to have it "call the existing pipeline internally" — read
// literally, that could mean calling runSearchPipeline() (search-pipeline.ts) alone, which
// would silently BYPASS quota-gate.ts entirely — a free-text search could spend real Gemini/
// Places money with zero quota protection, zero recorded usage, zero threshold-crossing alert.
// That's a real, serious regression, not a hypothetical — caught before it shipped. This
// module is the fix: it's the FULL real flow (check quota -> deny or proceed -> call Gemini/
// Places -> record real cost -> return results, per the locked flow, the private development log
// 2026-08-12), not just the Step 1->2->3 pipeline — both real entry points call this one real
// function, so there is exactly one place this logic can ever drift out of sync.
//
// REAL USER-FACING SPLIT (unchanged from the original route): every denial gets the same
// generic message, no dollar figures, no "free tier" language, ever, regardless of which
// entry point (structured category+anchor, or free-text query) the caller used.
//
// FAIL CLOSED, explicitly, not left to try/catch defaults — unchanged from the original route:
//   - checkQuota() throwing (a real DB error, not just "over threshold") -> deny.
//   - the alert email failing to send on the exact search that just crossed the threshold ->
//     the response to THIS caller is still denied, generic message, real failure logged loudly
//     server-side. The pipeline's real Gemini/Places calls already happened by this point
//     (recordUsage() runs after the pipeline, so real cost is already incurred) — "fail closed"
//     here can't undo that spend, but it does mean the app never quietly keeps operating past a
//     threshold the owner was never actually notified crossed.
import { recordUsage } from "./quota-gate.js";
import { sendQuotaAlertEmail } from "./alerts.js";
import { runSearchPipeline, newUsageTally, type SearchPipelineResult, type UsageTally } from "./search-pipeline.js";
import { getPool } from "./db.js";
import { defaultGateDb, reserveSpend, sendThresholdAlertOnce, type GateDb } from "./spend-gate.js";
import { recordFailedUsage, safeRelease } from "./usage-settle.js";
import { makeDeadline, RAN_OUT_OF_TIME_MESSAGE, type Deadline } from "./deadline.js";
import { PIPELINE_DEADLINE_MS } from "./time-limits.js";
import type { PublicCategorySlug } from "./category-config.js";
import type { CandidatePlace } from "./types.js";

export const GENERIC_DENIAL = { error: "Search is temporarily unavailable. Please try again shortly." };

export interface SearchRequestOutcome {
  status: number;
  body: Record<string, unknown>;
}

function buildMapsLink(place: CandidatePlace): string {
  const query = encodeURIComponent(place.address ? `${place.name}, ${place.address}` : place.name);
  const placeIdParam = place.placeId ? `&query_place_id=${place.placeId}` : "";
  return `https://www.google.com/maps/search/?api=1&query=${query}${placeIdParam}`;
}

/** Replaceable pieces, so tests can run the whole flow with stubs and no paid call. Every field defaults to the real thing. */
export interface SearchRequestDeps {
  gateDb?: GateDb;
  runPipeline?: (category: PublicCategorySlug, anchor: string, tally: UsageTally, deadline: Deadline) => Promise<SearchPipelineResult>;
  /** Clock for the request deadline; tests pass a fake one. */
  now?: () => number;
  insertSearchRow?: (category: PublicCategorySlug, anchor: string) => Promise<string>;
  recordUsage?: typeof recordUsage;
  sendQuotaAlertEmail?: typeof sendQuotaAlertEmail;
}

async function defaultInsertSearchRow(category: PublicCategorySlug, anchor: string): Promise<string> {
  const searchRow = await getPool().query<{ id: string }>(`insert into searches (query_params) values ($1) returning id`, [
    JSON.stringify({ category, anchor }),
  ]);
  return searchRow.rows[0].id;
}

export async function handleSearchRequest(categorySlug: PublicCategorySlug, anchor: string, deps: SearchRequestDeps = {}): Promise<SearchRequestOutcome> {
  const gateDb = deps.gateDb ?? defaultGateDb();
  const record = deps.recordUsage ?? recordUsage;
  // The request deadline starts here, at the start of the request: past it the pipeline starts no new paid call.
  const now = deps.now ?? Date.now;
  const deadline = makeDeadline(now(), PIPELINE_DEADLINE_MS, now);

  // ===== Spend gate, BEFORE the first paid call: one atomic decision against the monthly threshold,
  // the daily cap and the concurrent-search cap, counting spend that is reserved but not yet recorded.
  // Fail closed on ANY error, not just on a refusal. =====
  let reservation;
  try {
    reservation = await reserveSpend("search", gateDb);
  } catch (err) {
    console.error("search-request-handler: spend gate failed — failing closed (deny):", err);
    return { status: 503, body: GENERIC_DENIAL };
  }
  if (!reservation.admitted) {
    return { status: 503, body: GENERIC_DENIAL };
  }

  // Calls are counted here as they start, so a failure part-way still records what was spent.
  const tally = newUsageTally();
  let recorded = false;
  try {
    // ===== Real pipeline — Gemini/Places calls happen here, real cost from this point on =====
    const pipelineResult = await (deps.runPipeline ?? ((c, a, t, d) => runSearchPipeline(c, a, t, { deadline: d })))(categorySlug, anchor, tally, deadline);

    // Real searches row, so this search's real usage has somewhere real to point.
    const searchId = await (deps.insertSearchRow ?? defaultInsertSearchRow)(categorySlug, anchor);

    await record({
      searchId,
      geminiCalls: pipelineResult.geminiCalls,
      placesCalls: pipelineResult.placesCalls,
      geocodingCalls: pipelineResult.geocodingCalls,
      geminiTokenCostUsd: pipelineResult.geminiTokenCostUsd,
    });
    recorded = true;

    // ===== Threshold alert, sent once: only the request that wins the atomic claim sends it. =====
    try {
      await sendThresholdAlertOnce({
        sendEmail: deps.sendQuotaAlertEmail ?? sendQuotaAlertEmail,
        searchCountThisMonth: pipelineResult.step1CandidateCount > 0 ? 1 : 0,
        db: gateDb,
      });
    } catch (err) {
      console.error("search-request-handler: quota-alert email failed to send on the threshold-crossing search — failing closed (deny), real cost was already incurred:", err);
      return { status: 503, body: GENERIC_DENIAL };
    }

    // ===== Real results — heart-tier mapping (private development log, 2026-08-14 "Heart-tier
    // mapping definitively resolved" through its follow-up entries): hearts come directly and
    // only from scoreCandidate.ts's real `verdict` field, no app-computed third tier. Sorted by
    // fit tier per CLAUDE.md rule 15 (3-heart first, 2-heart next, unverified last). =====
    function heartCountFor(verdict: "strong_match" | "possible_match" | null): 3 | 2 | null {
      if (verdict === "strong_match") return 3;
      if (verdict === "possible_match") return 2;
      return null;
    }
    const results = pipelineResult.scored
      .filter(({ result }) => result.unverified || result.verdict !== "not_a_match")
      .map(({ place, result }) => {
        const verdict = result.unverified ? null : (result.verdict as "strong_match" | "possible_match" | null);
        // Real, 2026-08-17 addition, direct follow-up to the 2026-08-17 "Step 2's radius is a
        // soft bias" the private development log entry — locality/distanceMiles/typeDisplayName, all
        // real data already being fetched at zero incremental cost (see that entry's RESOLVED
        // addendum for the full audit). distanceMiles is left as a raw number (not a pre-formatted
        // "X.X mi" string) — deliberate: every other numeric field in this response (rating,
        // priceRange) is raw data with formatting left to the UI layer, and CLAUDE.md rule 14
        // means display formatting for the actual card hasn't been agreed yet; toFixed(1) here
        // only controls precision, not display format. Null, not 0 or omitted, when Google didn't
        // return a location for this place (a real, if uncommon, case) — consistent with every
        // other optional field in this response shape.
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
      })
      .sort((a, b) => (b.heartCount ?? 0) - (a.heartCount ?? 0));

    return {
      status: 200,
      body: {
        searchId,
        category: categorySlug,
        anchor,
        // Real, Google-resolved formatted address for this exact search's anchor — added
        // 2026-09-26, closing a real, confirmed bug: a bare/ambiguous anchor (e.g. a neighborhood name alone)
        // can silently geocode to a wrong, distant real place with nothing anywhere surfacing
        // that it happened. Passed through exactly as Google returned it, not re-derived.
        resolvedAnchor: pipelineResult.anchorFormattedAddress,
        results,
        // Present only when the request ran out of time: `results` is then what was found so far.
        ...(pipelineResult.timedOut ? { timedOut: true, note: RAN_OUT_OF_TIME_MESSAGE } : {}),
      },
    };
  } catch (err) {
    // The pipeline (or the recording) threw. If usage was not recorded, record what was started.
    if (!recorded) await recordFailedUsage(tally, record);
    throw err;
  } finally {
    await safeRelease(reservation.reservationId, gateDb);
  }
}
