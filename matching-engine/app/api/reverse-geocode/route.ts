// Real, minimal reverse-geocoding route (2026-08-19) — the ONLY correct way for a real browser
// geolocation hook to turn coordinates into an address string. `GOOGLE_PLACES_API_KEY` is a real
// server secret and must never reach the browser — already locked, already stated directly
// elsewhere in this codebase's own real architecture decisions (private development log, 2026-08-12
// hosting entry: "Secrets... live only in server-side environment variables, never reach the
// browser"). A client component cannot import `places-client.ts`'s `reverseGeocode()` directly
// (that would either break the client bundle or, worse, silently inline the key) — it must POST
// real coordinates here instead, and this route is the only place that ever touches the key for
// this purpose.
//
// REAL QUOTA-GATE WIRING, added 2026-08-19 — closes a real, confirmed gap (private development log):
// this route previously had zero cost tracking and zero quota protection, unlike every other
// real call site in this app. Same fail-closed pattern as search-request-handler.ts: checkQuota()
// before the real call, deny on any error (not just over-threshold); recordUsage() after, so
// this route's real cost folds into the same monthly total checkQuota() already sums across
// every api_usage row — no separate threshold, no separate system.
//
// REAL, DELIBERATE SCOPE DECISION, not an oversight: unlike search-request-handler.ts, this
// route does NOT duplicate the quota-alert email logic. Geocoding's real cost is a rounding
// error in practice (10,000 free calls/month, this route sees a handful per session at most —
// see quota-gate.ts's own real pricing comment) — genuinely unlikely to ever be the call that
// pushes month-to-date spend across the threshold on its own. If real reverse-geocode volume
// ever becomes non-trivial, add the alert path then, not speculatively now.
import { NextRequest, NextResponse } from "next/server";
import { handleReverseGeocode } from "../../../src/reverse-geocode-handler.js";

// The spend gate, the real call, usage recording and the generic denial now live in
// src/reverse-geocode-handler.ts (2026-10-20), so they can be tested with a stub. This route only
// validates the request body and shapes the HTTP response.
// Literal on purpose (Next requires it); src/time-limits.ts holds the same number, checked by scripts/verify-deadline.ts.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  let body: { latitude?: number; longitude?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { latitude, longitude } = body;
  if (typeof latitude !== "number" || typeof longitude !== "number" || Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return NextResponse.json({ error: "Missing or invalid latitude/longitude." }, { status: 400 });
  }

  const outcome = await handleReverseGeocode(latitude, longitude);
  return NextResponse.json(outcome.body, { status: outcome.status });
}
