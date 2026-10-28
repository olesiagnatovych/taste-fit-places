// Settling a paid request (2026-10-20, spend protection): release its reservation and, when the
// pipeline threw after paid calls, record what was actually spent. Shared by the live handler, the
// stream handler and the reverse-geocode handler.
import { releaseReservation, type GateDb } from "./spend-gate.js";
import type { UsageTally } from "./search-pipeline.js";
import type { RecordUsageInput } from "./quota-gate.js";

/** Releases a reservation; a failure to release is logged, never thrown (it must not mask the request's own outcome). A reservation that is never released stops counting after 10 minutes. */
export async function safeRelease(reservationId: string, db: GateDb): Promise<void> {
  try {
    await releaseReservation(reservationId, db);
  } catch (err) {
    console.error("usage-settle: could not release reservation (it expires on its own after 10 minutes):", err);
  }
}

/**
 * Records the paid calls a failed search had already started, once. Skipped when nothing was started.
 * Calls are counted when they start; Gemini token cost is whatever completed calls reported, so a call
 * that failed before returning its token counts adds to the call count but not to the cost. Never throws.
 */
export async function recordFailedUsage(tally: UsageTally, record: (input: RecordUsageInput) => Promise<unknown>): Promise<boolean> {
  if (tally.geminiCalls === 0 && tally.placesCalls === 0 && tally.geocodingCalls === 0) return false;
  try {
    await record({
      searchId: null,
      geminiCalls: tally.geminiCalls,
      placesCalls: tally.placesCalls,
      geocodingCalls: tally.geocodingCalls,
      geminiTokenCostUsd: tally.geminiTokenCostUsd,
    });
    return true;
  } catch (err) {
    console.error("usage-settle: recording usage for a failed search also failed — real cost was incurred and is NOT in api_usage:", err);
    return false;
  }
}
