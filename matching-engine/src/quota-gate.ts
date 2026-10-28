// Real quota-gate logic (private development log GO LIVE item #2 2026-08-14
// entry). Inline in the search request itself — no scheduled job, no separate cron/worker,
// per the real, already-researched architecture decision (private development log, 2026-08-12
// hosting/database entry): check quota -> deny or proceed -> call Gemini/Places -> persist
// real usage -> return results. This module provides the check and the persist; the caller
// (eventually the private development log item #3's /api/search route, not yet built) is responsible for
// the "deny or proceed" branch and the actual Gemini/Places calls in between.
//
// REAL COST MODEL, four genuinely separate components, not one flat rate (Architecture-
// Specs.md, 2026-08-12 cost-research entry; component 4 added 2026-08-19):
//   1. Gemini token cost — always billed, free-tier-independent. Computed by the CALLER
//      (Step 1's inline cost math, Step 3's scoreCandidate.ts `result.cost` — both already
//      use the same real, verified PRICING_STANDARD rate, ai.google.dev/gemini-api/docs/
//      pricing) and passed in here as `geminiTokenCostUsd`. Not recomputed in this file —
//      recomputing it a further, Nth duplicate time would risk the rate drifting out of
//      sync with the already-established real source of truth.
//   2. Gemini Grounding-with-Google-Maps overage — $14 per 1,000 grounded prompts, but only
//      on the calls that exceed a real 5,000-free-prompts/month cap. Computed HERE, because
//      it depends on this month's cumulative real usage, not any single search in isolation.
//   3. Places API (New) overage — $25 per 1,000 requests, only on the calls that exceed a
//      real 1,000-free-requests/month cap. Same reasoning as #2.
//   4. Geocoding API overage — $5 per 1,000 requests, only on the calls that exceed a real
//      10,000-free-requests/month cap. Added 2026-08-19, closing a real, confirmed gap
//      (private development log): geocodeAddress()/reverseGeocode() had zero cost tracking here
//      despite being real, billed calls since this project's earliest live tests. Real,
//      live-verified pricing, 2026-08-19 (developers.google.com/maps/billing-and-pricing/
//      pricing, fetched directly, not assumed from training data or an older comment):
//      10,000 free calls/month, then a real 5-tier structure — $5.00/1000 (10,001-100,000),
//      $4.00/1000 (100,001-500,000), $3.00/1000 (500,001-1,000,000), $1.50/1000
//      (1,000,001-5,000,000), $0.38/1000 (5,000,000+). **Real, deliberate scope decision:**
//      only the first paid tier ($5.00/1000) is implemented — this project's real usage
//      volume (dozens to low hundreds of geocoding calls per session, per every logged
//      figure this whole project) will never plausibly approach even the 10,000/month free
//      cap, let alone the 100,000 boundary where the rate would change. Implementing the
//      full 5-tier structure for a scenario with genuinely $0 real risk would be real,
//      unnecessary complexity — flagged as a considered choice, not an oversight. Same
//      Geocoding SKU covers both forward (`address=`) and reverse (`latlng=`) requests —
//      confirmed via Google's own pricing page showing one undifferentiated "Geocoding" row
//      for both request shapes, consistent with both hitting the identical real endpoint
//      (`maps.googleapis.com/maps/api/geocode/json`) in `places-client.ts`.
//
// MARGINAL, NOT AVERAGE (the real cost lever the product owner named directly): a search's calls can
// straddle the free/paid boundary — e.g. the month's 4,998th and 5,002nd grounded calls in
// the same search. computeSurcharge() below prices only the calls that actually fall past
// the cap, using this month's real cumulative count *before* this search, not a flat assumed
// per-search average (the ~$0.326/search figure in the 2026-08-12 research entry was
// explicitly a conservative planning estimate, never meant to be the real per-search ledger
// entry once actual tracking existed).
import { getPool } from "./db.js";
import { getMonthlyQuotaThresholdUsd } from "./settings.js";
import { monthStartSql, defaultGateDb, gateTable, type GateDb } from "./spend-gate.js";

/** Real, published free-tier caps and overage rates — the private development log, 2026-08-12 cost-research entry (Perplexity, current as of that research). */
export const GEMINI_GROUNDING_FREE_CAP_PER_MONTH = 5000;
export const GEMINI_GROUNDING_OVERAGE_USD_PER_1000 = 14;
export const PLACES_FREE_CAP_PER_MONTH = 1000;
export const PLACES_OVERAGE_USD_PER_1000 = 25;
/** Real, live-verified 2026-08-19 (developers.google.com/maps/billing-and-pricing/pricing) — see file header for the full real pricing table and the deliberate single-tier scope decision. */
export const GEOCODING_FREE_CAP_PER_MONTH = 10000;
export const GEOCODING_OVERAGE_USD_PER_1000 = 5;

// REAL CHANGE, 2026-08-14 (quota-gate follow-on build): the threshold used to be a hardcoded
// `MONTHLY_QUOTA_THRESHOLD_USD` constant here. It's now a real, mutable, persisted value in
// `app_settings` (settings.ts) — the admin page's Raise-threshold action needs to move it up
// the locked $35->50->65->+15 ladder without a code deploy. See settings.ts for the real
// default/seed value and ladder logic; this file only consumes it.

export interface QuotaCheckResult {
  allowed: boolean;
  currentMonthSpendUsd: number;
  thresholdUsd: number;
}

/** Real current-calendar-month spend, computed live from api_usage.total_cost_usd — never a stored/staged running counter that could drift from the real rows. Threshold is read live from app_settings, not a hardcoded constant, so a just-raised threshold takes effect on the very next check. */
export async function checkQuota(db: GateDb = defaultGateDb()): Promise<QuotaCheckResult> {
  const pool = db.pool;
  const [result, thresholdUsd] = await Promise.all([
    pool.query<{ sum: string | null }>(
      `select sum(total_cost_usd) as sum from ${gateTable(db, "api_usage")}
       where created_at >= ${monthStartSql()}`
    ),
    getMonthlyQuotaThresholdUsd(db),
  ]);
  const currentMonthSpendUsd = Number(result.rows[0]?.sum ?? 0);
  return {
    allowed: currentMonthSpendUsd < thresholdUsd,
    currentMonthSpendUsd,
    thresholdUsd,
  };
}

interface MonthToDateCallCounts {
  geminiCalls: number;
  placesCalls: number;
  geocodingCalls: number;
}

async function getMonthToDateCallCounts(db: GateDb): Promise<MonthToDateCallCounts> {
  const pool = db.pool;
  const result = await pool.query<{ gemini_calls: string | null; places_calls: string | null; geocoding_calls: string | null }>(
    `select sum(gemini_calls) as gemini_calls, sum(places_calls) as places_calls, sum(geocoding_calls) as geocoding_calls from ${gateTable(db, "api_usage")}
     where created_at >= ${monthStartSql()}`
  );
  return {
    geminiCalls: Number(result.rows[0]?.gemini_calls ?? 0),
    placesCalls: Number(result.rows[0]?.places_calls ?? 0),
    geocodingCalls: Number(result.rows[0]?.geocoding_calls ?? 0),
  };
}

/** Prices only the portion of `thisSearchCalls` that falls past the real free cap, given how many calls this month already used before this search. Never prices calls that are still genuinely inside the free cap. */
function computeSurcharge(
  callsBeforeThisSearch: number,
  thisSearchCalls: number,
  freeCapPerMonth: number,
  overageUsdPer1000: number
): number {
  const callsAfterThisSearch = callsBeforeThisSearch + thisSearchCalls;
  const freeRemainingBefore = Math.max(0, freeCapPerMonth - callsBeforeThisSearch);
  const billableCalls = Math.max(0, thisSearchCalls - freeRemainingBefore);
  // Sanity-consistent either way: billableCalls also equals max(0, callsAfterThisSearch - freeCapPerMonth) - max(0, callsBeforeThisSearch - freeCapPerMonth).
  void callsAfterThisSearch;
  return (billableCalls / 1000) * overageUsdPer1000;
}

export interface RecordUsageInput {
  /** Real searches.id, once the private development log item #3's /api/search route exists and creates that row. Null until then — quota-gate.ts records real usage independently of that not-yet-built piece. */
  searchId: string | null;
  /** Real total grounded Gemini calls this search made — Step 1 (always 1) + Step 3 (one per Step 2 survivor actually scored). */
  geminiCalls: number;
  /** Real total Places API calls this search made — one per Step 1 candidate looked up, regardless of whether it survived Step 2. */
  placesCalls: number;
  /** Real total Geocoding API calls this search made — added 2026-08-19. Always 1 for a real search-pipeline run (the single anchor resolution); the standalone /api/reverse-geocode route also passes 1 for its own single reverseGeocode() call. */
  geocodingCalls: number;
  /** Real, already-computed Gemini token cost for this search's calls (input+output+thought, both steps combined) — see file header re: not recomputed here. */
  geminiTokenCostUsd: number;
}

export interface RecordUsageResult {
  geminiGroundingSurchargeUsd: number;
  placesSurchargeUsd: number;
  geocodingSurchargeUsd: number;
  totalCostUsd: number;
}

export interface AdminQuotaStatus extends QuotaCheckResult {
  /** Real count of api_usage rows this month — one row per real search that actually ran, so this is a real "searches covered" count, not an estimate. */
  searchCountThisMonth: number;
  /** Real calendar day-of-month, server clock (Vercel runs UTC) — admin-page display only, not used in any quota math. */
  daysIntoMonth: number;
}

/** Real, live status for the admin page — the private development log "Quota-gate follow-on" entry: "current spend, days into the month, real search count covered." */
export async function getAdminQuotaStatus(): Promise<AdminQuotaStatus> {
  const pool = getPool();
  const [quota, countResult] = await Promise.all([
    checkQuota(),
    pool.query<{ count: string }>(
      `select count(*) as count from api_usage where created_at >= ${monthStartSql()}`
    ),
  ]);
  return {
    ...quota,
    searchCountThisMonth: Number(countResult.rows[0]?.count ?? 0),
    daysIntoMonth: new Date().getDate(),
  };
}

/** Persists one real api_usage row for a search that actually ran (called Gemini/Places) — never called for a search the quota gate denied. */
export async function recordUsage(input: RecordUsageInput, db: GateDb = defaultGateDb()): Promise<RecordUsageResult> {
  const pool = db.pool;
  const before = await getMonthToDateCallCounts(db);

  const geminiGroundingSurchargeUsd = computeSurcharge(
    before.geminiCalls,
    input.geminiCalls,
    GEMINI_GROUNDING_FREE_CAP_PER_MONTH,
    GEMINI_GROUNDING_OVERAGE_USD_PER_1000
  );
  const placesSurchargeUsd = computeSurcharge(
    before.placesCalls,
    input.placesCalls,
    PLACES_FREE_CAP_PER_MONTH,
    PLACES_OVERAGE_USD_PER_1000
  );
  const geocodingSurchargeUsd = computeSurcharge(
    before.geocodingCalls,
    input.geocodingCalls,
    GEOCODING_FREE_CAP_PER_MONTH,
    GEOCODING_OVERAGE_USD_PER_1000
  );

  const result = await pool.query<{ total_cost_usd: string }>(
    `insert into ${gateTable(db, "api_usage")}
       (search_id, gemini_calls, places_calls, geocoding_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd, geocoding_surcharge_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning total_cost_usd`,
    [
      input.searchId,
      input.geminiCalls,
      input.placesCalls,
      input.geocodingCalls,
      input.geminiTokenCostUsd,
      geminiGroundingSurchargeUsd,
      placesSurchargeUsd,
      geocodingSurchargeUsd,
    ]
  );

  return {
    geminiGroundingSurchargeUsd,
    placesSurchargeUsd,
    geocodingSurchargeUsd,
    totalCostUsd: Number(result.rows[0].total_cost_usd),
  };
}
