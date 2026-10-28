// Verification for per-call timeouts (2026-10-20). No paid call is possible: every Google/Gemini call is a stub,
// and fetch is replaced by a guard that only lets requests to 127.0.0.1 through (a local server this script
// starts), counting and throwing on anything else.
//
// Parts:
//   A. pipelines (live and stream), FAKE TIME: a hung geocode / Gemini Step 1 / Places lookup / scoring call is
//      aborted at its limit and counted as started; a scoring retry is not started after the deadline; the
//      worst-case end time stays under the route limit; negative controls with the timeouts or the deadline off.
//   B. handlers, fake time, temporary schema: a timed-out call is recorded as started, the reservation released.
//   C. REAL I/O against a local server that never answers: the abort really cancels a fetch, and the installed
//      Gemini SDK honours both a fetch signal and its own `timeout` option; the Places/geocoding client functions
//      forward the signal to fetch.
import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GoogleGenAI } from "@google/genai";
import { closePool, getPool } from "../src/db.js";
import { runSearchPipeline, newUsageTally, type PipelineDeps, type UsageTally } from "../src/search-pipeline.js";
import { runSearchPipelineStreaming } from "../src/search-pipeline-stream.js";
import { handleSearchRequest } from "../src/search-request-handler.js";
import { openSearchStream } from "../src/search-stream-handler.js";
import { handleReverseGeocode } from "../src/reverse-geocode-handler.js";
import { callWithTimeout, CallTimeoutError, type Timers } from "../src/call-timeout.js";
import { makeDeadline } from "../src/deadline.js";
import { geocodeAddress, reverseGeocode, searchNearbyPlaces } from "../src/places-client.js";
import {
  PIPELINE_DEADLINE_MS, PLACES_CALL_TIMEOUT_MS, GEOCODE_CALL_TIMEOUT_MS, GEMINI_CALL_TIMEOUT_MS, SEARCH_ROUTE_MAX_DURATION_SECONDS, WORST_CASE_PIPELINE_END_SECONDS,
} from "../src/time-limits.js";
import { SETTING_KEYS } from "../src/spend-gate.js";
import { parseNdjsonStream, type StreamEvent } from "../src/stream-events.js";
import type { RecordUsageInput } from "../src/quota-gate.js";
import type { CandidatePlace } from "../src/types.js";
import { createTempGateSchema } from "./lib/temp-gate-schema.js";

const results: Array<{ ok: boolean }> = [];
let area = "";
function check(label: string, ok: boolean, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${label}${detail ? `  (${detail})` : ""}`);
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ===== fetch guard: only the local server is reachable =====
const realFetch = globalThis.fetch;
let externalFetchCalls = 0;
const blockedHosts = new Set<string>();
const urlOf = (url: unknown) => (typeof Request !== "undefined" && url instanceof Request ? url.url : String(url));
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (urlOf(url).startsWith("http://127.0.0.1:")) return realFetch(url as never, init);
  externalFetchCalls++;
  try { blockedHosts.add(new URL(urlOf(url)).host); } catch { /* not a URL */ }
  throw new Error("verify-call-timeouts: external network call blocked");
}) as typeof fetch;

// ===== fake time =====
class FakeTime {
  now = 1_000_000;
  readonly start = 1_000_000;
  private timers: Array<{ at: number; cb: () => void }> = [];
  readonly timersApi: Timers = {
    setTimeout: (cb, ms) => {
      const t = { at: this.now + ms, cb };
      this.timers.push(t);
      return () => { this.timers = this.timers.filter((x) => x !== t); };
    },
  };
  sleep = (ms: number) => new Promise<void>((r) => this.timersApi.setTimeout(r, ms));
  elapsedMs = () => this.now - this.start;
  /** Fires every remaining timer (e.g. other in-flight calls that time out at the same instant). */
  async drain() {
    for (let i = 0; i < 1000; i++) {
      await new Promise<void>((r) => setImmediate(r));
      if (this.timers.length === 0) return;
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers.shift()!;
      this.now = Math.max(this.now, t.at);
      t.cb();
    }
  }
  /** Drives the promise to completion, firing fake timers in order whenever nothing else can run. */
  async run<T>(p: Promise<T>, maxIdleMs = 20_000): Promise<{ settled: boolean; value?: T; error?: unknown; atMs: number }> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    p.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
    let idleMs = 0;
    while (!settled) {
      await new Promise<void>((r) => setImmediate(r)); // drain microtasks
      if (settled) break;
      if (this.timers.length === 0) {
        await realSleep(2); // real I/O (the database) may still be in flight
        idleMs += 2;
        if (idleMs > maxIdleMs) break;
        continue;
      }
      idleMs = 0;
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers.shift()!;
      this.now = Math.max(this.now, t.at);
      t.cb();
    }
    return { settled, value, error, atMs: this.now - this.start };
  }
}

const fakePlace = (key: string): CandidatePlace =>
  ({ name: `Stub Place ${key}`, address: `${key} Fake St`, placeId: `stub-id-${key}`, rating: 4.5, googleCategories: ["sushi_restaurant"], priceRange: { startPrice: 30, endPrice: 50 }, descriptionSignals: [], location: { latitude: 37.76, longitude: -122.47 } }) as unknown as CandidatePlace;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Stub Place ${i + 1} — ${i + 1} Fake St`).join("\n");
const okGeocode = (async () => ({ latitude: 37.76, longitude: -122.47, formattedAddress: "Stub Address" })) as never;

interface HungLog { startedAtMs: number[]; signals: AbortSignal[] }
/** A call that never answers. honor=true rejects when its signal aborts (like fetch); honor=false ignores the signal entirely. */
function hungCall(ft: FakeTime, log: HungLog, honor: boolean) {
  return (..._args: unknown[]) => {
    const last = _args[_args.length - 1];
    const signal = last instanceof AbortSignal ? last : (last as { signal?: AbortSignal } | undefined)?.signal;
    log.startedAtMs.push(ft.elapsedMs());
    if (signal) log.signals.push(signal);
    return new Promise<never>((_, reject) => {
      if (honor && signal) signal.addEventListener("abort", () => reject(signal.reason));
    });
  };
}
const newLog = (): HungLog => ({ startedAtMs: [], signals: [] });
type Which = "live" | "stream";
async function runPipelineWith(which: Which, tally: UsageTally, deps: PipelineDeps) {
  return which === "live"
    ? runSearchPipeline("sushi", "x", tally, deps)
    : runSearchPipelineStreaming("sushi", "x", { onAnchor: () => {}, onCard: () => {} }, tally, deps);
}

async function main() {
  // ============ A. pipelines in fake time ============
  area = "timeouts";
  for (const which of ["live", "stream"] as const) {
    for (const honor of [true, false]) {
      const mode = honor ? "stub honours the signal" : "stub ignores the signal";
      // hung geocode
      {
        const ft = new FakeTime(); const log = newLog(); const tally = newUsageTally();
        const r = await ft.run(runPipelineWith(which, tally, { timers: ft.timersApi, geocode: hungCall(ft, log, honor) as never }));
        check(`${which}, hung geocode (${mode}): aborted at ${GEOCODE_CALL_TIMEOUT_MS / 1000} s with CallTimeoutError`, r.settled && r.error instanceof CallTimeoutError && r.atMs === GEOCODE_CALL_TIMEOUT_MS, `at ${r.atMs / 1000} s`);
        check(`  counted as started: geocode 1, Gemini 0, Places 0${honor ? "; its signal was aborted" : ""}`, tally.geocodingCalls === 1 && tally.geminiCalls === 0 && tally.placesCalls === 0 && (!honor || log.signals[0].aborted));
      }
      // hung Step 1
      {
        const ft = new FakeTime(); const log = newLog(); const tally = newUsageTally();
        const r = await ft.run(runPipelineWith(which, tally, { timers: ft.timersApi, geocode: okGeocode, step1: hungCall(ft, log, honor) as never }));
        check(`${which}, hung Gemini Step 1 (${mode}): aborted at ${GEMINI_CALL_TIMEOUT_MS / 1000} s`, r.settled && r.error instanceof CallTimeoutError && r.atMs === GEMINI_CALL_TIMEOUT_MS, `at ${r.atMs / 1000} s`);
        check(`  counted as started: geocode 1, Gemini 1, Places 0${honor ? "; its signal was aborted" : ""}`, tally.geocodingCalls === 1 && tally.geminiCalls === 1 && tally.placesCalls === 0 && (!honor || log.signals[0].aborted));
      }
      // hung Places lookups (3 places)
      {
        const ft = new FakeTime(); const log = newLog(); const tally = newUsageTally();
        const r = await ft.run(runPipelineWith(which, tally, { timers: ft.timersApi, geocode: okGeocode, step1: (async () => ({ text: lines(3), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 })) as never, searchPlaces: hungCall(ft, log, honor) as never }));
        await ft.drain(); // the other two lookups time out at the same instant
        check(`${which}, hung Places lookups (${mode}): aborted at ${PLACES_CALL_TIMEOUT_MS / 1000} s`, r.settled && r.error instanceof CallTimeoutError && r.atMs === PLACES_CALL_TIMEOUT_MS, `at ${r.atMs / 1000} s`);
        check(`  counted as started: all 3 lookups${honor ? ", all 3 signals aborted" : ""}`, tally.placesCalls === 3 && log.startedAtMs.length === 3 && (!honor || log.signals.every((s) => s.aborted)), `places ${tally.placesCalls}`);
      }
    }
  }

  // ============ scoring retries: real scoreCandidate through the pipelines, stubbed Gemini call ============
  area = "scoring retries";
  /** preMs = time spent before scoring can start, spread over geocode (<15 s), Step 1 (<30 s) and one lookup (<15 s). */
  async function scoringRun(which: Which, preMs: number, opts: { places?: number; deadline?: boolean; scoreTimeoutMs?: number } = {}) {
    const ft = new FakeTime(); const log = newLog(); const tally = newUsageTally();
    const places = opts.places ?? 1;
    const geoMs = Math.min(preMs, 14_000);
    const step1Ms = Math.min(preMs - geoMs, 29_000);
    const lookupMs = Math.min(preMs - geoMs - step1Ms, 14_000);
    const deps: PipelineDeps = {
      timers: ft.timersApi,
      geocode: (async () => { await ft.sleep(geoMs); return { latitude: 37.76, longitude: -122.47, formattedAddress: "Stub Address" }; }) as never,
      step1: async () => { await ft.sleep(step1Ms); return { text: lines(places), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 }; },
      searchPlaces: (async (req: { textQuery?: string }) => { await ft.sleep(lookupMs); return [fakePlace(req.textQuery ?? "x")]; }) as never,
      scoreHooks: { create: hungCall(ft, log, true) as never, sleep: ft.sleep, timers: ft.timersApi, ...(opts.scoreTimeoutMs !== undefined ? { timeoutMs: opts.scoreTimeoutMs } : {}) },
      ...(opts.deadline === false ? {} : { deadline: makeDeadline(ft.start, PIPELINE_DEADLINE_MS, () => ft.now) }),
    };
    const run = await ft.run(runPipelineWith(which, tally, deps), opts.scoreTimeoutMs === Infinity ? 400 : 20_000);
    await ft.drain();
    return { ft, log, tally, run };
  }
  const fmt = (xs: number[]) => xs.map((x) => (x / 1000).toFixed(1)).join(", ");
  for (const which of ["live", "stream"] as const) {
    // S1: scoring hangs on every attempt; all three attempts start before the deadline and each is aborted at 30 s
    {
      const { log, tally, run } = await scoringRun(which, 0);
      const res = run.value as { geminiCalls: number } | undefined;
      const aborted = log.signals.length === 3 && log.signals.every((sg) => sg.aborted && sg.reason instanceof CallTimeoutError);
      check(`${which}, scoring hangs: 3 attempts, each aborted by its own ${GEMINI_CALL_TIMEOUT_MS / 1000} s timeout`, run.settled && log.startedAtMs.length === 3 && aborted, `attempt starts at ${fmt(log.startedAtMs)} s`);
      check(`  pipeline ends at ${(run.atMs / 1000).toFixed(1)} s; Gemini calls counted = 1 (Step 1) + 3 attempts = 4`, run.atMs >= 92_000 && run.atMs <= 96_000 && tally.geminiCalls === 4 && res?.geminiCalls === 4, `gemini ${tally.geminiCalls}`);
    }
    // S2: 43 s are spent before scoring (geocode 14 + Step 1 29): attempt 1 at 43 s, attempt 2 at ~74 s ends ~104 s, no 3rd
    {
      const { log, tally, run } = await scoringRun(which, 43_000);
      const after = log.startedAtMs.filter((t) => t >= PIPELINE_DEADLINE_MS).length;
      check(`${which}, a scoring retry is not started after the deadline`, run.settled && log.startedAtMs.length === 2 && after === 0, `attempt starts at ${fmt(log.startedAtMs)} s; pipeline ended ${(run.atMs / 1000).toFixed(1)} s`);
      check("  no backoff wait was spent on the retry that would not start; Gemini counted = 3 (Step 1 + 2 attempts)", run.atMs < PIPELINE_DEADLINE_MS + 6_000 && tally.geminiCalls === 3, `gemini ${tally.geminiCalls}`);
    }
    // S3: 9 places, scoring hangs: places 4-6 queue behind the 3 workers and start only after ~93 s, just before the deadline
    {
      const { log, tally, run } = await scoringRun(which, 0, { places: 9 });
      const lastStart = Math.max(...log.startedAtMs);
      const after = log.startedAtMs.filter((t) => t >= PIPELINE_DEADLINE_MS).length;
      check(`${which}, 9 places, every scoring call hangs: ${log.startedAtMs.length} attempts started (places 1-3 retry; late places get one attempt; the rest are skipped), none at or after 100 s`, run.settled && after === 0 && log.startedAtMs.length === 12 && lastStart < PIPELINE_DEADLINE_MS, `latest start ${(lastStart / 1000).toFixed(1)} s, pipeline ended ${(run.atMs / 1000).toFixed(1)} s`);
      check(`  a call started at ${(lastStart / 1000).toFixed(1)} s, just before the deadline, still ends by ${(run.atMs / 1000).toFixed(1)} s (<= 130 s)`, run.atMs <= WORST_CASE_PIPELINE_END_SECONDS * 1000 && run.atMs > PIPELINE_DEADLINE_MS, `Gemini calls counted ${tally.geminiCalls}`);
    }
    // sweep: worst-case end time across pre-scoring offsets, with more places than workers so late starts happen
    {
      let worstEnd = 0; let worstStart = 0; let allOk = true; let n = 0;
      for (let pre = 0; pre <= 57_000; pre += 3_000) {
        const { log, run } = await scoringRun(which, pre, { places: 9 });
        n++;
        worstEnd = Math.max(worstEnd, run.atMs);
        worstStart = Math.max(worstStart, ...log.startedAtMs);
        if (!run.settled || log.startedAtMs.some((t) => t >= PIPELINE_DEADLINE_MS)) allOk = false;
      }
      check(`${which}, worst-case sweep (${n} runs, 9 places, 0-57 s before scoring, every scoring call hangs): no call starts at or after 100 s`, allOk, `latest call start ${(worstStart / 1000).toFixed(1)} s`);
      check(`  worst-case end ${(worstEnd / 1000).toFixed(1)} s <= deadline + 30 s = ${WORST_CASE_PIPELINE_END_SECONDS} s, under the ${SEARCH_ROUTE_MAX_DURATION_SECONDS} s route limit`, worstEnd <= WORST_CASE_PIPELINE_END_SECONDS * 1000 && worstEnd < SEARCH_ROUTE_MAX_DURATION_SECONDS * 1000, `${(worstEnd / 1000).toFixed(1)} s`);
    }
  }

  // ============ negative controls ============
  area = "negative controls";
  {
    const ft = new FakeTime(); const log = newLog(); const tally = newUsageTally();
    const r = await ft.run(runPipelineWith("live", tally, { timers: ft.timersApi, geocode: okGeocode, step1: hungCall(ft, log, true) as never, callTimeoutMs: { gemini: Infinity } }), 400);
    check("timeouts off: a hung Gemini Step 1 never returns (no abort, would run to the platform limit)", !r.settled && log.signals[0].aborted === false, `fake time reached ${(ft.elapsedMs() / 1000).toFixed(0)} s, still waiting`);
  }
  {
    const { run, log } = await scoringRun("live", 0, { scoreTimeoutMs: Infinity });
    check("scoring timeout off: a hung scoring call never returns", !run.settled && log.startedAtMs.length === 1);
  }
  {
    const { log, run } = await scoringRun("live", 43_000, { deadline: false });
    const after = log.startedAtMs.filter((t) => t >= PIPELINE_DEADLINE_MS).length;
    check("deadline off: the 3rd attempt DOES start after 100 s (so the deadline check is what stops it)", run.settled && log.startedAtMs.length === 3 && after === 1, `attempt starts at ${fmt(log.startedAtMs)} s`);
  }

  // ============ B. handlers in fake time, temporary schema ============
  area = "handlers";
  const tmp = await createTempGateSchema("zz_calltimeout", 9900000005);
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (urlOf(url).startsWith("http://127.0.0.1:")) return realFetch(url as never, init);
    externalFetchCalls++;
    try { blockedHosts.add(new URL(urlOf(url)).host); } catch { /* not a URL */ }
    throw new Error("verify-call-timeouts: external network call blocked");
  }) as typeof fetch; // createTempGateSchema installs its own blocker; keep the local-server guard
  const { db, T } = tmp;
  const pool = getPool();
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  const before = await tmp.liveCounts();
  const openCount = async () => (await pool.query<{ n: number }>(`select count(*)::int n from ${T("usage_reservations")} where released_at is null`)).rows[0].n;
  const calls: RecordUsageInput[] = [];
  const recorder = async (input: RecordUsageInput) => {
    calls.push(input);
    await q(`insert into ${T("api_usage")} (gemini_calls, places_calls, geocoding_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd) values ($1, $2, $3, $4, 0, 0)`, [input.geminiCalls, input.placesCalls, input.geocodingCalls, input.geminiTokenCostUsd]);
    return { geminiGroundingSurchargeUsd: 0, placesSurchargeUsd: 0, geocodingSurchargeUsd: 0, totalCostUsd: input.geminiTokenCostUsd };
  };
  const resetGate = async () => {
    await tmp.clear(); calls.length = 0;
    await q(`insert into ${T("app_settings")} (key, value) values ($1, '100'), ($2, '1000')`, [SETTING_KEYS.monthlyThreshold, SETTING_KEYS.dailyCap]);
  };
  try {
    {
      await resetGate();
      const ft = new FakeTime(); const log = newLog();
      const deps: PipelineDeps = { timers: ft.timersApi, geocode: okGeocode, step1: hungCall(ft, log, true) as never };
      const p = handleSearchRequest("sushi", "x", { gateDb: db, now: () => ft.now, runPipeline: (c, a, t, d) => runSearchPipeline(c, a, t, { ...deps, deadline: d }), recordUsage: recorder as never, insertSearchRow: async () => "never" });
      const r = await ft.run(p);
      check("live handler, hung Step 1: fails at 30 s with the timeout error", r.settled && r.error instanceof CallTimeoutError && r.atMs === GEMINI_CALL_TIMEOUT_MS, `at ${r.atMs / 1000} s`);
      check("  records the calls started, once (geocode 1, Gemini 1, Places 0), no search id", calls.length === 1 && calls[0].geocodingCalls === 1 && calls[0].geminiCalls === 1 && calls[0].placesCalls === 0 && calls[0].searchId === null, JSON.stringify(calls[0]));
      check("  reservation released", (await openCount()) === 0);
    }
    {
      await resetGate();
      const ft = new FakeTime(); const log = newLog();
      const deps: PipelineDeps = { timers: ft.timersApi, geocode: okGeocode, step1: (async () => ({ text: lines(3), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 })) as never, searchPlaces: hungCall(ft, log, true) as never };
      const opened = await openSearchStream("sushi", "x", { gateDb: db, now: () => ft.now, runPipeline: (c, a, h, t, d) => runSearchPipelineStreaming(c, a, h, t, { ...deps, deadline: d }), recordUsage: recorder as never, insertSearchRow: async () => "never" });
      if (!("stream" in opened)) throw new Error("expected a stream");
      const events: StreamEvent[] = [];
      const r = await ft.run((async () => { for await (const e of parseNdjsonStream(opened.stream)) events.push(e); })());
      for (let i = 0; i < 200 && (await openCount()) !== 0; i++) await realSleep(25);
      const last = events[events.length - 1] as Extract<StreamEvent, { type: "error" }>;
      check("stream handler, hung Places lookups: ends at 15 s with an error event", r.settled && last.type === "error" && last.status === 500 && r.atMs === PLACES_CALL_TIMEOUT_MS, `${events.map((e) => e.type).join(",")} at ${r.atMs / 1000} s`);
      check("  records the calls started, once (geocode 1, Gemini 1, Places 3)", calls.length === 1 && calls[0].geocodingCalls === 1 && calls[0].geminiCalls === 1 && calls[0].placesCalls === 3, JSON.stringify(calls[0]));
      check("  reservation released", (await openCount()) === 0);
    }
    {
      await resetGate();
      const ft = new FakeTime(); const log = newLog();
      const p = handleReverseGeocode(1, 2, { gateDb: db, timers: ft.timersApi, reverseGeocode: hungCall(ft, log, true) as never, recordUsage: recorder as never });
      const r = await ft.run(p);
      const out = r.value as { status: number } | undefined;
      check(`reverse-geocode, hung call: 502 at ${GEOCODE_CALL_TIMEOUT_MS / 1000} s`, r.settled && out?.status === 502 && r.atMs === GEOCODE_CALL_TIMEOUT_MS, `status ${out?.status} at ${r.atMs / 1000} s`);
      check("  the aborted call is recorded as made (1 geocoding call), once", calls.length === 1 && calls[0].geocodingCalls === 1, JSON.stringify(calls[0]));
      check("  reservation released", (await openCount()) === 0);
      await resetGate();
      const r2 = await handleReverseGeocode(1, 2, { gateDb: db, reverseGeocode: (async () => { throw new Error("HTTP 500 from Google"); }) as never, recordUsage: recorder as never });
      check("reverse-geocode, an ordinary failure (not a timeout): 502 and nothing recorded (unchanged behaviour)", r2.status === 502 && calls.length === 0);
    }
  } finally {
    await tmp.drop();
    const after = await tmp.liveCounts();
    check("temporary schema dropped; live api_usage, usage_reservations, searches and app_settings row counts unchanged", JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)}`);
  }

  // ============ C. real I/O against a local server that never answers ============
  area = "real I/O";
  const sockets = new Set<import("node:net").Socket>();
  let requestsSeen = 0;
  let requestsClosed = 0;
  const server = http.createServer((req) => {
    requestsSeen++;
    req.on("close", () => { requestsClosed++; }); // the client hung up (abort reached the wire)
    // never respond
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const waitFor = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await realSleep(10); } return cond(); };
  try {
    {
      const t0 = Date.now(); const seen0 = requestsSeen; const closed0 = requestsClosed;
      let err: unknown;
      try { await callWithTimeout(120, (signal) => fetch(`${base}/x`, { signal })); } catch (e) { err = e; }
      const dt = Date.now() - t0;
      const closed = await waitFor(() => requestsClosed > closed0);
      check("a hung fetch is aborted at the timeout (real timers, 120 ms) and the connection is closed on the wire", err instanceof CallTimeoutError && dt >= 100 && dt < 600 && requestsSeen > seen0 && closed, `${dt} ms`);
    }
    const ai = new GoogleGenAI({ apiKey: "test-not-a-key" });
    const params = { model: "test-model", input: "hello" } as never;
    {
      const ac = new AbortController(); setTimeout(() => ac.abort(new Error("test abort")), 150);
      const t0 = Date.now(); const seen0 = requestsSeen; let err: unknown;
      try { await ai.interactions.create(params, { signal: ac.signal, server_url: base } as never); } catch (e) { err = e; }
      const dt = Date.now() - t0;
      check("Gemini SDK honours a fetch signal: its create() call is cancelled when the signal aborts", err !== undefined && dt < 2000 && requestsSeen > seen0, `rejected after ${dt} ms, requests that reached the local server: ${requestsSeen - seen0}`);
    }
    {
      const t0 = Date.now(); const seen0 = requestsSeen; let err: unknown;
      try { await ai.interactions.create(params, { timeout: 200, server_url: base } as never); } catch (e) { err = e; }
      const dt = Date.now() - t0;
      // Informational finding about the SDK, not a pass/fail on its retry count: the SDK's own timeout option does end the call,
      // but only after its internal retries, so it is not a bound on its own. That is why the pipelines pass only their signal.
      check("Gemini SDK `timeout` option alone (200 ms): the call does end (does not hang), but not at 200 ms", err !== undefined && dt < 30_000, `rejected after ${dt} ms with ${requestsSeen - seen0} request(s) reaching the local server: the SDK retried internally, so its timeout alone is not a bound`);
    }
    {
      const t0 = Date.now(); const seenBefore = requestsSeen; let err: unknown;
      try { await callWithTimeout(200, (signal) => ai.interactions.create(params, { signal, server_url: base } as never)); } catch (e) { err = e; }
      const dt = Date.now() - t0;
      const seenAfter = requestsSeen;
      check("our wrapper around the SDK call (signal only, as the pipelines use it): CallTimeoutError at ~200 ms with a single request", err instanceof CallTimeoutError && dt >= 180 && dt < 700 && seenAfter - seenBefore === 1, `${dt} ms, ${seenAfter - seenBefore} request`);
      await realSleep(300);
      check("  and the SDK sends no further request after the abort (no retry loop)", requestsSeen === seenAfter, `requests after abort: ${requestsSeen - seenAfter}`);
    }
    {
      // the Places / geocoding client functions forward the signal to fetch (stubbed fetch records it; no real key used)
      const savedKey = process.env.GOOGLE_PLACES_API_KEY;
      process.env.GOOGLE_PLACES_API_KEY = "test-not-a-key";
      const seen: Array<{ url: string; signal?: AbortSignal | null }> = [];
      const outer = globalThis.fetch;
      globalThis.fetch = ((url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), signal: init?.signal });
        return new Promise((_, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)); });
      }) as typeof fetch;
      try {
        for (const [name, fn] of [
          ["geocodeAddress", (s: AbortSignal) => geocodeAddress("x", s)],
          ["reverseGeocode", (s: AbortSignal) => reverseGeocode(1, 2, s)],
          ["searchNearbyPlaces", (s: AbortSignal) => searchNearbyPlaces({ latitude: 1, longitude: 2, radiusMeters: 100, textQuery: "x" }, s)],
        ] as const) {
          seen.length = 0;
          const ac = new AbortController();
          const p = fn(ac.signal);
          setTimeout(() => ac.abort(new Error("test abort")), 30);
          let err: unknown;
          try { await p; } catch (e) { err = e; }
          check(`${name}: passes the caller's signal to fetch and the call ends when it aborts`, err !== undefined && seen.length === 1 && seen[0].signal === ac.signal && ac.signal.aborted);
        }
      } finally {
        globalThis.fetch = outer;
        if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = savedKey;
      }
    }
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }

  area = "limits";
  check("per-call limits: Places 15 s, geocoding 15 s, Gemini 30 s; worst case 130 s under the 150 s route limit", PLACES_CALL_TIMEOUT_MS === 15_000 && GEOCODE_CALL_TIMEOUT_MS === 15_000 && GEMINI_CALL_TIMEOUT_MS === 30_000 && WORST_CASE_PIPELINE_END_SECONDS === 130 && SEARCH_ROUTE_MAX_DURATION_SECONDS === 150);
  check("no call left the machine (only the local test server was reachable)", externalFetchCalls === 0, `blocked external fetches ${externalFetchCalls} ${[...blockedHosts].join(",")}`);

  await closePool();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}
main().catch(async (err) => {
  console.error("verify-call-timeouts crashed:", err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
