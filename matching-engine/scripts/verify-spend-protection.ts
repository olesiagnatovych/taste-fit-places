// Verification for spend-protection phase 1 (2026-10-20). NO paid call is possible in this script:
//   - globalThis.fetch is replaced at the top with a function that counts the call and throws, so any
//     Google/Gemini/Resend request would fail loudly (and is asserted to be 0 at the end);
//   - every pipeline, scorer, geocoder, email sender and usage recorder is a stub.
// What is real: the gate SQL (reservations, advisory lock, daily/monthly caps), the handlers
// (handleSearchRequest, openSearchStream, handleReverseGeocode), the pipelines' own code (with stubbed
// network calls), the alert claim, the boundary SQL, and the route handlers for input caps.
//
// Database: the gate runs against a TEMPORARY SCHEMA created inside the live database (copies of
// api_usage, usage_reservations and app_settings made with CREATE TABLE ... LIKE), with its own
// advisory-lock key. The schema is dropped at the end. Row counts of the live api_usage,
// usage_reservations, searches and app_settings are read before and after and must be equal.
import "dotenv/config";
import { NextRequest } from "next/server";
import { getPool, closePool } from "../src/db.js";
import {
  reserveSpend, releaseReservation, getOpenReservations, getMonthToDateSpendUsd, getTodaySpendUsd, sendThresholdAlertOnce,
  monthStartSql, dayStartSql, gateTable, SETTING_KEYS, type GateDb,
} from "../src/spend-gate.js";
import { raiseMonthlyQuotaThreshold } from "../src/settings.js";
import { handleSearchRequest } from "../src/search-request-handler.js";
import { openSearchStream } from "../src/search-stream-handler.js";
import { handleReverseGeocode } from "../src/reverse-geocode-handler.js";
import { runSearchPipeline, parseStep1Places, newUsageTally, MAX_STEP1_PLACES, type PipelineDeps, type SearchPipelineResult, type UsageTally } from "../src/search-pipeline.js";
import { runSearchPipelineStreaming, type StreamPipelineResult } from "../src/search-pipeline-stream.js";
import { exceedsInputLimit, MAX_INPUT_CHARS } from "../src/input-limits.js";
import { parseNdjsonStream } from "../src/stream-events.js";
import type { RecordUsageInput } from "../src/quota-gate.js";
import type { CandidatePlace } from "../src/types.js";
import { POST as searchPost } from "../app/api/search/route.js";
import { POST as searchQueryPost } from "../app/api/search-query/route.js";
import { POST as searchStreamPost } from "../app/api/search-stream/route.js";

// ===== no network, at all =====
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("verify-spend-protection: network is blocked in this test");
}) as typeof fetch;

const results: Array<{ area: string; label: string; ok: boolean; detail: string }> = [];
let area = "";
function check(label: string, ok: boolean, detail = "") {
  results.push({ area, label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${label}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = getPool();
const schema = `zz_spendtest_${Date.now().toString(36)}`;
const db: GateDb = { pool, schema, lockKey: 9900000001 };
const T = (name: string) => gateTable(db, name);

async function liveCounts() {
  const r = await pool.query<{ a: number; u: number; s: number; k: number }>(
    `select (select count(*) from api_usage)::int a, (select count(*) from usage_reservations)::int u, (select count(*) from searches)::int s, (select count(*) from app_settings)::int k`
  );
  return r.rows[0];
}
async function clearAll() {
  await pool.query(`truncate ${T("api_usage")}, ${T("usage_reservations")}, ${T("app_settings")}`);
}
async function setSetting(key: string, value: string | number) {
  await pool.query(`insert into ${T("app_settings")} (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [key, String(value)]);
}
async function seedSpend(usd: number, whenSql = "now()") {
  await pool.query(
    `insert into ${T("api_usage")} (gemini_calls, places_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd, created_at) values (0, 0, $1, 0, 0, ${whenSql})`,
    [usd]
  );
}
async function seedReservation(amount: number, ageMinutes: number, released = false) {
  await pool.query(
    `insert into ${T("usage_reservations")} (amount_usd, created_at, released_at) values ($1, now() - make_interval(mins => $2), ${released ? "now()" : "null"})`,
    [amount, ageMinutes]
  );
}
async function openReservationCount(): Promise<number> {
  const r = await pool.query<{ n: number }>(`select count(*)::int n from ${T("usage_reservations")} where released_at is null`);
  return r.rows[0].n;
}
async function reservationRows(): Promise<number> {
  const r = await pool.query<{ n: number }>(`select count(*)::int n from ${T("usage_reservations")}`);
  return r.rows[0].n;
}
async function waitUntil(cond: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(25);
  }
  return false;
}

// ===== stubs =====
function makeRecorder(fixedCostUsd?: number) {
  const calls: RecordUsageInput[] = [];
  const fn = async (input: RecordUsageInput) => {
    calls.push(input);
    const cost = fixedCostUsd ?? input.geminiTokenCostUsd;
    await pool.query(
      `insert into ${T("api_usage")} (gemini_calls, places_calls, geocoding_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd) values ($1, $2, $3, $4, 0, 0)`,
      [input.geminiCalls, input.placesCalls, input.geocodingCalls, cost]
    );
    return { geminiGroundingSurchargeUsd: 0, placesSurchargeUsd: 0, geocodingSurchargeUsd: 0, totalCostUsd: cost };
  };
  return { calls, fn };
}
function stubPipelineResult(over: Partial<SearchPipelineResult> = {}): SearchPipelineResult {
  return {
    anchor: { latitude: 37.76, longitude: -122.47 }, anchorFormattedAddress: "Stub Address", step1CandidateCount: 3, step2SurvivorCount: 0, scored: [],
    geminiCalls: 1, placesCalls: 3, geocodingCalls: 1, geminiTokenCostUsd: 0.01, ...over,
  } as SearchPipelineResult;
}
/** Opens once `total` requests have been decided (refused, or admitted and waiting inside the pipeline). Keeps admitted searches in flight until every request has had its turn at the gate. */
function makeLatch(total: number) {
  let decided = 0;
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, mark: () => { decided++; if (decided >= total) open(); } };
}
function holdingPipeline(gauge: { cur: number; max: number }, latch: ReturnType<typeof makeLatch>) {
  return async (_c: unknown, _a: string, tally: UsageTally) => {
    gauge.cur++;
    gauge.max = Math.max(gauge.max, gauge.cur);
    tally.geocodingCalls = 1;
    tally.geminiCalls = 1;
    tally.placesCalls = 3;
    latch.mark();
    await latch.promise; // everyone has been decided; now the searches may finish
    await sleep(50);
    gauge.cur--;
    return stubPipelineResult();
  };
}
const fakePlace = (key: string, i = 0): CandidatePlace =>
  ({
    name: `Stub Place ${key}`, address: `${key} Fake St`, placeId: `stub-id-${key}-${i}`, rating: 4.5, googleCategories: ["sushi_restaurant"],
    priceRange: { startPrice: 30, endPrice: 50 }, descriptionSignals: [], location: { latitude: 37.76, longitude: -122.47 },
  }) as unknown as CandidatePlace;
const stubScoreResult = (cost = 0.004) =>
  ({ place: "x", verdict: "strong_match", confidence: "high", evidence: ["e"], caveat: "", rawText: "", parsedOk: true, unverified: false, cost, latencyMs: 1, attemptsUsed: 1, lastStatus: "completed" }) as never;
const step1Lines = (n: number) => Array.from({ length: n }, (_, i) => `Stub Place ${i + 1} — ${i + 1} Fake St`).join("\n");

async function runConcurrent(n: number, makeDeps: (latch: ReturnType<typeof makeLatch>) => Parameters<typeof handleSearchRequest>[2]) {
  let maxReserved = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const r = await pool.query<{ amt: string }>(`select coalesce(sum(amount_usd), 0)::text amt from ${T("usage_reservations")} where released_at is null`);
      maxReserved = Math.max(maxReserved, Number(r.rows[0].amt));
      await sleep(10);
    }
  })();
  const latch = makeLatch(n);
  const deps = makeDeps(latch);
  const outcomes = await Promise.all(
    Array.from({ length: n }, () =>
      handleSearchRequest("sushi", "stub anchor", deps).then((o) => {
        if (o.status === 503) latch.mark();
        return o;
      })
    )
  );
  sampling = false;
  await sampler;
  return { admitted: outcomes.filter((o) => o.status === 200).length, refused: outcomes.filter((o) => o.status === 503).length, maxReserved };
}

async function main() {
  const before = await liveCounts();
  await pool.query(`create schema "${schema}"`);
  for (const t of ["api_usage", "usage_reservations", "app_settings"]) await pool.query(`create table ${T(t)} (like ${t} including all)`);

  try {
    // ============ 1. Concurrency ============
    area = "concurrency";
    for (const sc of [
      { name: "money-limited", spend: 34.6, settings: { daily_cap_usd: 1000, max_concurrent_searches: 50, search_reservation_usd: 0.15 }, expectAdmitted: 2 },
      { name: "concurrency-limited", spend: 0, settings: { daily_cap_usd: 1000, max_concurrent_searches: 4, search_reservation_usd: 0.15 }, expectAdmitted: 4 },
      { name: "just under the threshold, default limits", spend: 34.3, settings: { daily_cap_usd: 1000, max_concurrent_searches: 4, search_reservation_usd: 0.15 }, expectAdmitted: 4 },
    ]) {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 35);
      for (const [k, v] of Object.entries(sc.settings)) await setSetting(k, v);
      if (sc.spend > 0) await seedSpend(sc.spend, `(${monthStartSql()} + interval '1 minute')`);
      const gauge = { cur: 0, max: 0 };
      const rec = makeRecorder(0.01);
      let emails = 0;
      const r = await runConcurrent(20, (latch) => ({
        gateDb: db, runPipeline: holdingPipeline(gauge, latch) as never, insertSearchRow: async () => "stub-search-id",
        recordUsage: rec.fn as never, sendQuotaAlertEmail: async () => { emails++; },
      }));
      const monthSpend = sc.spend;
      check(`${sc.name}: 20 at once, admitted exactly ${sc.expectAdmitted}`, r.admitted === sc.expectAdmitted, `admitted ${r.admitted}, refused ${r.refused}`);
      check(`${sc.name}: the other ${20 - sc.expectAdmitted} get 503`, r.refused === 20 - sc.expectAdmitted && r.admitted + r.refused === 20);
      check(`${sc.name}: pipelines running at once never exceed admitted count`, gauge.max <= sc.expectAdmitted, `max in flight ${gauge.max}`);
      check(`${sc.name}: spend + max reserved stays under the $35 threshold`, monthSpend + r.maxReserved < 35, `${monthSpend} + ${r.maxReserved.toFixed(2)} = ${(monthSpend + r.maxReserved).toFixed(2)}`);
      check(`${sc.name}: all reservations released afterwards`, (await openReservationCount()) === 0, `${await reservationRows()} reservation rows, all released`);
    }

    // gate failure fails closed, and nothing paid runs
    {
      let pipelineCalled = false;
      const brokenPool = { connect: async () => { throw new Error("db down"); }, query: async () => { throw new Error("db down"); } } as never;
      const o = await handleSearchRequest("sushi", "x", { gateDb: { pool: brokenPool }, runPipeline: (async () => { pipelineCalled = true; return stubPipelineResult(); }) as never });
      check("gate error: 503 and no pipeline call (fails closed)", o.status === 503 && !pipelineCalled);
    }

    // ============ 2. Daily cap ============
    area = "daily cap";
    await clearAll();
    await setSetting(SETTING_KEYS.monthlyThreshold, 100);
    await seedSpend(2.84);
    {
      const rec = makeRecorder(0.1);
      const deps = { gateDb: db, runPipeline: (async () => stubPipelineResult()) as never, insertSearchRow: async () => "s", recordUsage: rec.fn as never, sendQuotaAlertEmail: async () => {} };
      const a = await handleSearchRequest("sushi", "x", deps);
      const b = await handleSearchRequest("sushi", "x", deps);
      check("today $2.84 of $3.00: first search admitted", a.status === 200, `status ${a.status}`);
      check("after it records $0.10 (today $2.94), the next search is refused", b.status === 503, `status ${b.status}, today ${(await getTodaySpendUsd(db)).toFixed(2)}`);
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      await seedSpend(2.995);
      let geocodeCalls = 0;
      const o = await handleReverseGeocode(1, 2, { gateDb: db, reverseGeocode: (async () => { geocodeCalls++; return "x"; }) as never, recordUsage: makeRecorder().fn as never });
      check("reverse-geocode: today $2.995 + $0.01 reaches the $3.00 cap, refused with no call", o.status === 503 && geocodeCalls === 0);
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      for (let i = 0; i < 4; i++) await seedReservation(0.15, 1);
      const rec = makeRecorder();
      const search = await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (async () => stubPipelineResult()) as never, insertSearchRow: async () => "s", recordUsage: rec.fn as never });
      let geocodeCalls = 0;
      const geo = await handleReverseGeocode(1, 2, { gateDb: db, reverseGeocode: (async () => { geocodeCalls++; return "Stub Address"; }) as never, recordUsage: rec.fn as never });
      check("4 searches already running: a 5th search is refused", search.status === 503);
      check("4 searches already running: reverse-geocode is still admitted (no concurrency cap)", geo.status === 200 && geocodeCalls === 1);
      check("reverse-geocode records 1 geocoding call and releases its reservation", rec.calls.length === 1 && rec.calls[0].geocodingCalls === 1 && (await openReservationCount()) === 4);
    }

    // ============ 3. Release ============
    area = "release";
    await clearAll();
    await setSetting(SETTING_KEYS.monthlyThreshold, 100);
    {
      let message = "";
      try {
        await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (async () => { throw new Error("pipeline exploded"); }) as never, recordUsage: makeRecorder().fn as never });
      } catch (e) { message = (e as Error).message; }
      check("a thrown pipeline error propagates and the reservation is released", message === "pipeline exploded" && (await openReservationCount()) === 0 && (await reservationRows()) === 1);
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      const rec = makeRecorder(0.02);
      const opened = await openSearchStream("sushi", "x", {
        gateDb: db,
        runPipeline: (async (_c: unknown, _a: string, hooks: { onAnchor: (s: string) => void }, tally: UsageTally) => {
          tally.geocodingCalls = 1; tally.geminiCalls = 1; tally.placesCalls = 3;
          hooks.onAnchor("Stub Address");
          await sleep(300);
          return { anchorFormattedAddress: "Stub Address", step1CandidateCount: 3, step2SurvivorCount: 0, scoredCount: 0, shownCount: 0, geminiCalls: 1, placesCalls: 3, geocodingCalls: 1, geminiTokenCostUsd: 0.02 } as StreamPipelineResult;
        }) as never,
        insertSearchRow: async () => "stub-search-id", recordUsage: rec.fn as never, sendQuotaAlertEmail: async () => {},
      });
      if (!("stream" in opened)) throw new Error("expected a stream");
      const reader = opened.stream.getReader();
      await reader.read(); // the "start" event
      const heldWhileConnected = await openReservationCount();
      await reader.cancel(); // the client disconnects mid-stream
      const released = await waitUntil(async () => (await openReservationCount()) === 0);
      check("client disconnect: reservation was held while the search ran", heldWhileConnected === 1);
      check("client disconnect: reservation is released afterwards", released);
      check("client disconnect: usage is still recorded, once", rec.calls.length === 1 && rec.calls[0].placesCalls === 3);
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      await seedReservation(0.15, 9); await seedReservation(0.15, 9); await seedReservation(0.15, 9); await seedReservation(0.15, 11);
      const open = await getOpenReservations(db);
      const o = await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (async () => stubPipelineResult()) as never, insertSearchRow: async () => "s", recordUsage: makeRecorder().fn as never });
      check("a reservation older than 10 minutes is ignored (3 open of 4, cap 4: admitted)", open.count === 3 && o.status === 200, `open count ${open.count}`);
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      for (let i = 0; i < 4; i++) await seedReservation(0.15, 9);
      const o2 = await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (async () => stubPipelineResult()) as never, insertSearchRow: async () => "s", recordUsage: makeRecorder().fn as never });
      check("4 reservations 9 minutes old still count (cap 4: refused)", o2.status === 503);
      await clearAll();
      await seedReservation(0.15, 1);
      const rowId = (await pool.query<{ id: string }>(`select id from ${T("usage_reservations")} limit 1`)).rows[0].id;
      await releaseReservation(rowId, db);
      await releaseReservation(rowId, db);
      check("releasing twice is harmless", (await openReservationCount()) === 0);
    }

    // ============ 4. Failure recording (the real pipeline code, stubbed network) ============
    area = "failure recording";
    const stubs: PipelineDeps = {
      geocode: (async () => ({ latitude: 37.76, longitude: -122.47, formattedAddress: "Stub Address" })) as never,
      step1: async () => ({ text: step1Lines(2), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 }),
      searchPlaces: (async (req: { textQuery?: string }) => [fakePlace(req.textQuery ?? "x")]) as never,
      score: (async () => { throw new Error("scorer boom"); }) as never,
    };
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      const rec = makeRecorder();
      let message = "";
      try {
        await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (c, a, tally) => runSearchPipeline(c, a, tally, stubs), recordUsage: rec.fn as never, insertSearchRow: async () => "never-used" });
      } catch (e) { message = (e as Error).message; }
      const c = rec.calls[0];
      check("live handler: failure after 2 Places calls records once", message === "scorer boom" && rec.calls.length === 1);
      check("  recorded exactly: 2 Places calls, 1 geocode, 3 Gemini calls (Step 1 + 2 scoring attempts), no search id", !!c && c.placesCalls === 2 && c.geocodingCalls === 1 && c.geminiCalls === 3 && c.searchId === null, JSON.stringify(c));
      check("  recorded Gemini cost is the completed Step 1 call's cost ($0.003), nothing invented", !!c && Math.abs(c.geminiTokenCostUsd - 0.003) < 1e-9, `${c?.geminiTokenCostUsd}`);
      check("  reservation released", (await openReservationCount()) === 0);
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      const rec = makeRecorder();
      const okStubs: PipelineDeps = { ...stubs, score: (async () => stubScoreResult(0.004)) as never };
      const o = await handleSearchRequest("sushi", "x", { gateDb: db, runPipeline: (c, a, tally) => runSearchPipeline(c, a, tally, okStubs), recordUsage: rec.fn as never, insertSearchRow: async () => "stub-search-id", sendQuotaAlertEmail: async () => {} });
      const c = rec.calls[0];
      check("live handler: a successful search records exactly once (no double record)", o.status === 200 && rec.calls.length === 1 && !!c && c.searchId === "stub-search-id" && c.placesCalls === 2 && c.geminiCalls === 3, JSON.stringify(c));
    }
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 100);
      const rec = makeRecorder();
      const opened = await openSearchStream("sushi", "x", { gateDb: db, runPipeline: (c, a, hooks, tally) => runSearchPipelineStreaming(c, a, hooks, tally, stubs), recordUsage: rec.fn as never, insertSearchRow: async () => "never-used" });
      if (!("stream" in opened)) throw new Error("expected a stream");
      const events: string[] = [];
      for await (const e of parseNdjsonStream(opened.stream)) events.push(e.type);
      const released = await waitUntil(async () => (await openReservationCount()) === 0);
      const c = rec.calls[0];
      check("stream handler: failure ends with an error event", events[events.length - 1] === "error", events.join(","));
      check("  records once: 2 Places calls, 1 geocode, 3 Gemini calls", rec.calls.length === 1 && !!c && c.placesCalls === 2 && c.geocodingCalls === 1 && c.geminiCalls === 3, JSON.stringify(c));
      check("  reservation released", released);
    }

    // ============ 5. Alert once ============
    area = "alert";
    {
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 35);
      await seedSpend(36);
      let emails = 0;
      const send = async () => { emails++; await sleep(20); };
      const out = await Promise.all(Array.from({ length: 20 }, () => sendThresholdAlertOnce({ sendEmail: send, searchCountThisMonth: 1, db })));
      check("20 concurrent crossings send exactly 1 email", emails === 1 && out.filter((o) => o === "sent").length === 1 && out.filter((o) => o === "already_sent").length === 19, `emails ${emails}`);
      const again = await sendThresholdAlertOnce({ sendEmail: send, searchCountThisMonth: 1, db });
      check("a later request over the same threshold sends nothing", again === "already_sent" && emails === 1);
      const raised = await raiseMonthlyQuotaThreshold(db);
      const notYet = await sendThresholdAlertOnce({ sendEmail: send, searchCountThisMonth: 1, db });
      check("raising the threshold ($35 -> $50) re-arms the alert: not crossed yet, no email", raised === 50 && notYet === "not_crossed" && emails === 1);
      await seedSpend(15); // month now 51
      const out2 = await Promise.all(Array.from({ length: 20 }, () => sendThresholdAlertOnce({ sendEmail: send, searchCountThisMonth: 1, db })));
      check("crossing the raised threshold sends exactly 1 more email (2 in total)", emails === 2 && out2.filter((o) => o === "sent").length === 1, `emails ${emails}`);
      // a failing sender clears the claim so a later request can retry
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 35);
      await seedSpend(36);
      let threw = false;
      try { await sendThresholdAlertOnce({ sendEmail: async () => { throw new Error("resend down"); }, searchCountThisMonth: 1, db }); } catch { threw = true; }
      let retried = 0;
      const retry = await sendThresholdAlertOnce({ sendEmail: async () => { retried++; }, searchCountThisMonth: 1, db });
      check("a failed send is rethrown and does not use up the alert (a retry sends)", threw && retry === "sent" && retried === 1);
    }
    {
      // handler level: 20 searches admitted together, their recorded costs carry month-to-date over the threshold
      await clearAll();
      await setSetting(SETTING_KEYS.monthlyThreshold, 35);
      await setSetting(SETTING_KEYS.dailyCap, 1000);
      await setSetting(SETTING_KEYS.maxConcurrentSearches, 20);
      await setSetting(SETTING_KEYS.searchReservation, 0.01);
      await seedSpend(34.0, `(${monthStartSql()} + interval '1 minute')`);
      let emails = 0;
      const rec = makeRecorder(0.06);
      const r = await runConcurrent(20, (latch) => ({
        gateDb: db, runPipeline: holdingPipeline({ cur: 0, max: 0 }, latch) as never, insertSearchRow: async () => "s", recordUsage: rec.fn as never,
        sendQuotaAlertEmail: async () => { emails++; await sleep(30); },
      }));
      check("handler level: 20 admitted searches cross the threshold together, exactly 1 email", r.admitted === 20 && emails === 1, `admitted ${r.admitted}, month-to-date ${(await getMonthToDateSpendUsd(db)).toFixed(2)}, emails ${emails}`);
    }

    // ============ 6. Timezone ============
    area = "timezone";
    {
      const at = async (fn: (ref: string) => string, iso: string) => {
        const r = await pool.query<{ v: string }>(`select to_char((${fn("$1::timestamptz")}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') v`, [iso]);
        return r.rows[0].v;
      };
      const cases: Array<[string, (ref: string) => string, string, string]> = [
        ["month, daylight time: 06:59:59Z on Oct 1 is still September", monthStartSql, "2026-10-01T06:59:59Z", "2026-09-01T07:00:00Z"],
        ["month, daylight time: 07:00:00Z on Oct 1 starts October", monthStartSql, "2026-10-01T07:00:00Z", "2026-10-01T07:00:00Z"],
        ["month, standard time: 07:59:59Z on Dec 1 is still November", monthStartSql, "2026-12-01T07:59:59Z", "2026-11-01T07:00:00Z"],
        ["month, standard time: 08:00:00Z on Dec 1 starts December", monthStartSql, "2026-12-01T08:00:00Z", "2026-12-01T08:00:00Z"],
        ["month, standard time: 07:59:59Z on Jan 1 2027 is still December", monthStartSql, "2027-01-01T07:59:59Z", "2026-12-01T08:00:00Z"],
        ["month, standard time: 08:00:00Z on Jan 1 2027 starts January", monthStartSql, "2027-01-01T08:00:00Z", "2027-01-01T08:00:00Z"],
        ["month, back to daylight: 06:59:59Z on Apr 1 2027 is still March", monthStartSql, "2027-04-01T06:59:59Z", "2027-03-01T08:00:00Z"],
        ["month, back to daylight: 07:00:00Z on Apr 1 2027 starts April", monthStartSql, "2027-04-01T07:00:00Z", "2027-04-01T07:00:00Z"],
        ["day, daylight time: 06:59:59Z is still the previous day", dayStartSql, "2026-07-15T06:59:59Z", "2026-07-14T07:00:00Z"],
        ["day, daylight time: 07:00:00Z starts the day", dayStartSql, "2026-07-15T07:00:00Z", "2026-07-15T07:00:00Z"],
        ["day, standard time: 07:59:59Z is still the previous day", dayStartSql, "2026-12-15T07:59:59Z", "2026-12-14T08:00:00Z"],
        ["day, standard time: 08:00:00Z starts the day", dayStartSql, "2026-12-15T08:00:00Z", "2026-12-15T08:00:00Z"],
      ];
      for (const [label, fn, input, expected] of cases) {
        const got = await at(fn, input);
        check(label, got === expected, `${input} -> ${got}`);
      }
      // the gate's own queries use those boundaries: rows one second either side of the real boundaries
      await clearAll();
      const bounds = (await pool.query<{ m: string; d: string }>(`select to_char(${monthStartSql()} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') m, to_char(${dayStartSql()} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') d`)).rows[0];
      const rows: Array<[number, string, string]> = [[1000, `${monthStartSql()} - interval '1 second'`, bounds.m], [1, monthStartSql(), bounds.m], [100, `${dayStartSql()} - interval '1 second'`, bounds.d], [2, dayStartSql(), bounds.d]];
      for (const [amt, when] of rows) await seedSpend(amt, `(${when})`);
      const stamps = (await pool.query<{ amt: string; at: string }>(`select gemini_token_cost_usd::text amt, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') at from ${T("api_usage")}`)).rows;
      const expectMonth = stamps.filter((r) => r.at >= bounds.m).reduce((a, r) => a + Number(r.amt), 0);
      const expectDay = stamps.filter((r) => r.at >= bounds.d).reduce((a, r) => a + Number(r.amt), 0);
      const gotMonth = await getMonthToDateSpendUsd(db);
      const gotDay = await getTodaySpendUsd(db);
      check("gate month query counts a row at the Los Angeles month start and not one second before", Math.abs(gotMonth - expectMonth) < 1e-9 && gotMonth < 1000, `month-to-date ${gotMonth}, expected ${expectMonth}`);
      check("gate day query counts a row at the Los Angeles day start and not one second before", Math.abs(gotDay - expectDay) < 1e-9, `today ${gotDay}, expected ${expectDay}`);
    }

    // ============ 7. Input caps ============
    area = "input caps";
    {
      check(`${MAX_INPUT_CHARS} characters is allowed, ${MAX_INPUT_CHARS + 1} is not`, !exceedsInputLimit("a".repeat(200)) && exceedsInputLimit("a".repeat(201)));
      check("the limit is applied to the trimmed value", !exceedsInputLimit("   " + "a".repeat(200) + "   ") && exceedsInputLimit("   " + "a".repeat(201)));
      const liveBefore = await liveCounts();
      const fetchBefore = fetchCalls;
      const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const long = "x".repeat(201);
      const probes: Array<[string, Promise<Response>]> = [
        ["/api/search anchor", searchPost(req("/api/search", { category: "sushi", anchor: long }))],
        ["/api/search category", searchPost(req("/api/search", { category: long, anchor: "Hayes Valley" }))],
        ["/api/search-query query", searchQueryPost(req("/api/search-query", { query: long }))],
        ["/api/search-stream anchor", searchStreamPost(req("/api/search-stream", { category: "sushi", anchor: long }))],
        ["/api/search-stream query", searchStreamPost(req("/api/search-stream", { query: long }))],
        ["/api/search-stream category", searchStreamPost(req("/api/search-stream", { category: long, anchor: "Hayes Valley" }))],
      ];
      for (const [label, p] of probes) {
        const res = await p;
        check(`201 characters in ${label}: HTTP 400`, res.status === 400, `status ${res.status}`);
      }
      const liveAfter = await liveCounts();
      check("  and no paid call: 0 network calls, no live reservation or usage row written", fetchCalls === fetchBefore && liveAfter.u === liveBefore.u && liveAfter.a === liveBefore.a, `network calls ${fetchCalls - fetchBefore}`);

      const fourteen = parseStep1Places(step1Lines(14));
      check(`Step 1 text with 14 places parses to ${MAX_STEP1_PLACES}, first ones kept in order`, fourteen.length === 10 && fourteen[0].name === "Stub Place 1" && fourteen[9].name === "Stub Place 10", `${fourteen.length} places`);
      for (const which of ["live", "stream"] as const) {
        let lookups = 0;
        const stubs14: PipelineDeps = {
          geocode: (async () => ({ latitude: 37.76, longitude: -122.47, formattedAddress: "Stub Address" })) as never,
          step1: async () => ({ text: step1Lines(14), inputTokens: 100, outputTokens: 100, thoughtTokens: 0 }),
          searchPlaces: (async () => { lookups++; return []; }) as never,
          score: (async () => { throw new Error("must not be called"); }) as never,
        };
        const tally = newUsageTally();
        const res =
          which === "live"
            ? await runSearchPipeline("sushi", "x", tally, stubs14)
            : await runSearchPipelineStreaming("sushi", "x", { onAnchor: () => {}, onCard: () => {} }, tally, stubs14);
        check(`${which} pipeline, Step 1 stub returns 14 places: 10 looked up, 10 counted`, lookups === 10 && tally.placesCalls === 10 && res.step1CandidateCount === 10 && res.placesCalls === 10, `lookups ${lookups}, step1CandidateCount ${res.step1CandidateCount}`);
      }
    }
  } finally {
    area = "cleanup";
    if (/^zz_spendtest_[a-z0-9]+$/.test(schema)) await pool.query(`drop schema "${schema}" cascade`);
    const after = await liveCounts();
    const leftover = (await pool.query<{ n: number }>(`select count(*)::int n from information_schema.schemata where schema_name = $1`, [schema])).rows[0].n;
    check("temporary schema dropped", leftover === 0);
    check("live api_usage, usage_reservations, searches and app_settings row counts unchanged", before.a === after.a && before.u === after.u && before.s === after.s && before.k === after.k, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    check("no network call was made at any point outside the blocked-fetch probes", fetchCalls === 0, `fetch calls ${fetchCalls}`);
    await closePool();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) FAILED:`);
    for (const f of failed) console.error(`  [${f.area}] ${f.label}  ${f.detail}`);
    process.exit(1);
  }
}
main().catch(async (err) => {
  console.error("verify-spend-protection crashed:", err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
