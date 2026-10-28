// Reverse-geocode flow, extracted from app/api/reverse-geocode/route.ts (2026-10-20, spend protection)
// so it can be tested with a stub and no paid call. One geocoding call per request. It takes a small
// reservation (GEOCODE_RESERVATION_USD) against the monthly threshold and the daily cap, but is not
// subject to the concurrent-search cap. The reservation is released whether the call succeeds or fails.
import { reverseGeocode } from "./places-client.js";
import { recordUsage } from "./quota-gate.js";
import { defaultGateDb, reserveSpend, type GateDb } from "./spend-gate.js";
import { safeRelease } from "./usage-settle.js";
import { callWithTimeout, CallTimeoutError, type Timers } from "./call-timeout.js";
import { GEOCODE_CALL_TIMEOUT_MS } from "./time-limits.js";

/** Real, honest, generic denial — no dollar figures, no "free tier" language. */
export const GEOCODE_GENERIC_DENIAL = { error: "Location lookup is temporarily unavailable. Please try again shortly." };

export interface ReverseGeocodeDeps {
  gateDb?: GateDb;
  reverseGeocode?: typeof reverseGeocode;
  recordUsage?: typeof recordUsage;
  /** Timer source for the call timeout; tests pass a fake one. */
  timers?: Timers;
}

export async function handleReverseGeocode(
  latitude: number,
  longitude: number,
  deps: ReverseGeocodeDeps = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const gateDb = deps.gateDb ?? defaultGateDb();

  let reservation;
  try {
    reservation = await reserveSpend("geocode", gateDb);
  } catch (err) {
    console.error("reverse-geocode handler: spend gate failed — failing closed (deny):", err);
    return { status: 503, body: GEOCODE_GENERIC_DENIAL };
  }
  if (!reservation.admitted) {
    return { status: 503, body: GEOCODE_GENERIC_DENIAL };
  }

  try {
    let address: string;
    try {
      address = await callWithTimeout(GEOCODE_CALL_TIMEOUT_MS, (signal) => (deps.reverseGeocode ?? reverseGeocode)(latitude, longitude, signal), deps.timers);
    } catch (err) {
      console.error("reverse-geocode handler: reverseGeocode() failed:", err);
      if (err instanceof CallTimeoutError) {
        // The call was started and then aborted: it may still have been processed and billed, so record it as made.
        try {
          await (deps.recordUsage ?? recordUsage)({ searchId: null, geminiCalls: 0, placesCalls: 0, geocodingCalls: 1, geminiTokenCostUsd: 0 });
        } catch (recordErr) {
          console.error("reverse-geocode handler: recording the timed-out call also failed:", recordErr);
        }
      }
      return { status: 502, body: { error: "Could not resolve a real address for that location." } };
    }

    // Real usage record — searchId is null (a real cost row doesn't require a searches row).
    try {
      await (deps.recordUsage ?? recordUsage)({
        searchId: null,
        geminiCalls: 0,
        placesCalls: 0,
        geocodingCalls: 1,
        geminiTokenCostUsd: 0,
      });
    } catch (err) {
      // The call already happened; a logging failure must not turn a real lookup into a user-facing error.
      console.error("reverse-geocode handler: recordUsage() failed after a real, already-incurred call:", err);
    }
    return { status: 200, body: { address } };
  } finally {
    await safeRelease(reservation.reservationId, gateDb);
  }
}
