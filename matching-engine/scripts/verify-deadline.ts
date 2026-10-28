// Verification for the request deadline and route time limits (2026-10-20). Stubs only, and a FAKE CLOCK:
// a "slow" run advances the fake clock inside the stubs, so nothing waits in real time. fetch is blocked.
// What is real: both pipelines' own code, both handlers (handleSearchRequest, openSearchStream), the gate SQL
// (in a temporary schema inside the live database, dropped at the end, live row counts compared before/after),
// the stream parser and view reducer, and the route files' text.
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db.js";
import { runSearchPipeline, type PipelineDeps, type UsageTally, newUsageTally } from "../src/search-pipeline.js";
import { runSearchPipelineStreaming } from "../src/search-pipeline-stream.js";
import { handleSearchRequest } from "../src/search-request-handler.js";
import { openSearchStream } from "../src/search-stream-handler.js";
import { makeDeadline, RAN_OUT_OF_TIME_MESSAGE } from "../src/deadline.js";
import { PIPELINE_DEADLINE_MS, PIPELINE_DEADLINE_SECONDS, SEARCH_ROUTE_MAX_DURATION_SECONDS, REVERSE_GEOCODE_ROUTE_MAX_DURATION_SECONDS, LONGEST_CALL_TIMEOUT_MS, WORST_CASE_PIPELINE_END_SECONDS } from "../src/time-limits.js";
import { SETTING_KEYS } from "../src/spend-gate.js";
import { parseNdjsonStream, reduceStream, initialStreamState, streamNotice, type StreamEvent } from "../src/stream-events.js";
import type { RecordUsageInput } from "../src/quota-gate.js";
import type { CandidatePlace } from "../src/types.js";
import { createTempGateSchema } from "./lib/temp-gate-schema.js";

const results: Array<{ area: string; ok: boolean }> = [];
let area = "";
function check(label: string, ok: boolean, detail = "") {
  results.push({ area, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${label}${detail ? `  (${detail})` : ""}`);
}

// ===== fake clock and stubs =====
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, start };
}
const fakePlace = (key: string): CandidatePlace =>
  ({ name: `Stub Place ${key}`, address: `${key} Fake St`, placeId: `stub-id-${key}`, rating: 4.5, googleCategories: ["sushi_restaurant"], priceRange: { startPrice: 30, endPrice: 50 }, descriptionSignals: [], location: { latitude: 37.76, longitude: -122.47 } }) as unknown as CandidatePlace;
const scoreOk = (cost: number) => ({ place: "x", verdict: "strong_match", confidence: "high", evidence: ["e"], caveat: "", rawText: "", parsedOk: true, unverified: false, cost, latencyMs: 1, attemptsUsed: 1, lastStatus: "completed" }) as never;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Stub Place ${i + 1} — ${i + 1} Fake St`).join("\n");

interface Scenario { name: string; places: number; step1Ms: number; lookupMs: number; scoreMs: number; expect: { timedOut: boolean; lookups: number; scores: number; shown: number } }
const STEP1_COST = 0.003; // 1000 input + 200 output tokens at the pipeline's rates
const SCENARIOS: Scenario[] = [
  { name: "slow Step 1 (101 s)", places: 3, step1Ms: 101_000, lookupMs: 0, scoreMs: 0, expect: { timedOut: true, lookups: 0, scores: 0, shown: 0 } },
  { name: "slow lookups (60 s each)", places: 8, step1Ms: 0, lookupMs: 60_000, scoreMs: 0, expect: { timedOut: true, lookups: 2, scores: 0, shown: 0 } },
  { name: "slow scoring (60 s each)", places: 5, step1Ms: 0, lookupMs: 0, scoreMs: 60_000, expect: { timedOut: true, lookups: 5, scores: 2, shown: 2 } },
  { name: "normal 15 s run", places: 5, step1Ms: 5_000, lookupMs: 1_000, scoreMs: 1_000, expect: { timedOut: false, lookups: 5, scores: 5, shown: 5 } },
];
function makeStubs(clock: ReturnType<typeof fakeClock>, sc: Scenario) {
  const counts = { lookups: 0, scores: 0 };
  const deps: PipelineDeps = {
    geocode: (async () => ({ latitude: 37.76, longitude: -122.47, formattedAddress: "Stub Address" })) as never,
    step1: async () => { clock.advance(sc.step1Ms); return { text: lines(sc.places), inputTokens: 1000, outputTokens: 200, thoughtTokens: 0 }; },
    searchPlaces: (async (req: { textQuery?: string }) => { counts.lookups++; clock.advance(sc.lookupMs); return [fakePlace(req.textQuery ?? "x")]; }) as never,
    score: (async () => { counts.scores++; clock.advance(sc.scoreMs); return scoreOk(0.004); }) as never,
  };
  return { counts, deps };
}
const expectedGemini = (sc: Scenario) => (sc.expect.timedOut && sc.expect.lookups === 0 && sc.step1Ms > 100_000 ? 1 : 1 + sc.expect.scores);
function makeRecorder(poolQ: (sql: string, p: unknown[]) => Promise<unknown>, T: (t: string) => string) {
  const calls: RecordUsageInput[] = [];
  const fn = async (input: RecordUsageInput) => {
    calls.push(input);
    await poolQ(`insert into ${T("api_usage")} (gemini_calls, places_calls, geocoding_calls, gemini_token_cost_usd, gemini_grounding_surcharge_usd, places_surcharge_usd) values ($1, $2, $3, $4, 0, 0)`, [input.geminiCalls, input.placesCalls, input.geocodingCalls, input.geminiTokenCostUsd]);
    return { geminiGroundingSurchargeUsd: 0, placesSurchargeUsd: 0, geocodingSurchargeUsd: 0, totalCostUsd: input.geminiTokenCostUsd };
  };
  return { calls, fn };
}

async function main() {
  // ============ A. pipelines, fake clock ============
  area = "pipelines";
  for (const which of ["live", "stream"] as const) {
    for (const sc of SCENARIOS) {
      const clock = fakeClock();
      const { counts, deps } = makeStubs(clock, sc);
      deps.deadline = makeDeadline(clock.start, PIPELINE_DEADLINE_MS, clock.now);
      const tally: UsageTally = newUsageTally();
      let timedOut: boolean | undefined;
      let geminiCalls = 0, placesCalls = 0, geocodingCalls = 0, cost = 0, shown = 0;
      if (which === "live") {
        const r = await runSearchPipeline("sushi", "x", tally, deps);
        timedOut = r.timedOut; geminiCalls = r.geminiCalls; placesCalls = r.placesCalls; geocodingCalls = r.geocodingCalls; cost = r.geminiTokenCostUsd; shown = r.scored.length;
      } else {
        const r = await runSearchPipelineStreaming("sushi", "x", { onAnchor: () => {}, onCard: () => {} }, tally, deps);
        timedOut = r.timedOut; geminiCalls = r.geminiCalls; placesCalls = r.placesCalls; geocodingCalls = r.geocodingCalls; cost = r.geminiTokenCostUsd; shown = r.shownCount;
      }
      const e = sc.expect;
      const expCost = STEP1_COST * (sc.step1Ms > 100_000 ? 1 : 1) + 0.004 * e.scores;
      check(`${which}, ${sc.name}: timed out = ${e.timedOut}`, (timedOut === true) === e.timedOut, `timedOut ${timedOut}`);
      check(`${which}, ${sc.name}: ${e.lookups} lookups and ${e.scores} scoring calls started, no more`, counts.lookups === e.lookups && counts.scores === e.scores, `lookups ${counts.lookups}, scores ${counts.scores}`);
      check(`${which}, ${sc.name}: recorded exactly the calls made (geocode 1, Gemini ${expectedGemini(sc)}, Places ${e.lookups})`, geocodingCalls === 1 && geminiCalls === expectedGemini(sc) && placesCalls === e.lookups && tally.geminiCalls === geminiCalls && tally.placesCalls === placesCalls, `geocode ${geocodingCalls}, gemini ${geminiCalls}, places ${placesCalls}`);
      check(`${which}, ${sc.name}: cost is Step 1 plus the scoring calls made ($${expCost.toFixed(3)})`, Math.abs(cost - expCost) < 1e-9, `cost ${cost}`);
      check(`${which}, ${sc.name}: ${e.shown} results returned`, shown === e.shown, `shown ${shown}`);
    }
  }

  // ============ B. handlers, fake clock, temp schema ============
  area = "handlers";
  const tmp = await createTempGateSchema("zz_deadline", 9900000004);
  const { db, T } = tmp;
  const pool = getPool();
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  const before = await tmp.liveCounts();
  const openCount = async () => (await pool.query<{ n: number }>(`select count(*)::int n from ${T("usage_reservations")} where released_at is null`)).rows[0].n;
  const allRows = async () => (await pool.query<{ n: number }>(`select count(*)::int n from ${T("usage_reservations")}`)).rows[0].n;
  const resetGate = async () => {
    await tmp.clear();
    await q(`insert into ${T("app_settings")} (key, value) values ($1, '100'), ($2, '1000')`, [SETTING_KEYS.monthlyThreshold, SETTING_KEYS.dailyCap]);
  };
  try {
    for (const sc of [SCENARIOS[2], SCENARIOS[0], SCENARIOS[3]]) {
      const e = sc.expect;
      // live handler
      {
        await resetGate();
        const clock = fakeClock();
        const { deps } = makeStubs(clock, sc);
        const rec = makeRecorder(q, T);
        const outcome = await handleSearchRequest("sushi", "x", {
          gateDb: db, now: clock.now, runPipeline: (c, a, t, d) => runSearchPipeline(c, a, t, { ...deps, deadline: d }),
          recordUsage: rec.fn as never, insertSearchRow: async () => "stub-search-id", sendQuotaAlertEmail: async () => {},
        });
        const body = outcome.body as { timedOut?: boolean; note?: string; results?: unknown[] };
        const c = rec.calls[0];
        check(`live handler, ${sc.name}: HTTP 200 with ${e.shown} results${e.timedOut ? " and the ran-out-of-time note" : ", no note"}`, outcome.status === 200 && (body.results?.length ?? -1) === e.shown && (e.timedOut ? body.timedOut === true && body.note === RAN_OUT_OF_TIME_MESSAGE : body.timedOut === undefined && body.note === undefined), `results ${body.results?.length}, timedOut ${body.timedOut}`);
        check(`live handler, ${sc.name}: usage recorded once with exactly the calls made`, rec.calls.length === 1 && !!c && c.placesCalls === e.lookups && c.geminiCalls === expectedGemini(sc) && c.geocodingCalls === 1, JSON.stringify(c));
        check(`live handler, ${sc.name}: reservation released`, (await openCount()) === 0 && (await allRows()) === 1);
      }
      // stream handler
      {
        await resetGate();
        const clock = fakeClock();
        const { deps } = makeStubs(clock, sc);
        const rec = makeRecorder(q, T);
        const opened = await openSearchStream("sushi", "x", {
          gateDb: db, now: clock.now, runPipeline: (c, a, h, t, d) => runSearchPipelineStreaming(c, a, h, t, { ...deps, deadline: d }),
          recordUsage: rec.fn as never, insertSearchRow: async () => "stub-search-id", sendQuotaAlertEmail: async () => {},
        });
        if (!("stream" in opened)) throw new Error("expected a stream");
        const events: StreamEvent[] = [];
        for await (const ev of parseNdjsonStream(opened.stream)) events.push(ev);
        const released = await (async () => { for (let i = 0; i < 160; i++) { if ((await openCount()) === 0) return true; await new Promise((r) => setTimeout(r, 25)); } return false; })();
        const done = events[events.length - 1] as Extract<StreamEvent, { type: "done" }>;
        const places = events.filter((x) => x.type === "place").length;
        const c = rec.calls[0];
        check(`stream handler, ${sc.name}: ${places} cards then a done event`, done.type === "done" && places === e.shown, events.map((x) => x.type).join(","));
        check(`stream handler, ${sc.name}: done event ${e.timedOut ? "carries timedOut, reason ran_out_of_time and the message" : "has no timeout fields"}`, e.timedOut ? done.timedOut === true && done.reason === "ran_out_of_time" && done.message === RAN_OUT_OF_TIME_MESSAGE : done.timedOut === undefined && done.reason === undefined);
        check(`stream handler, ${sc.name}: usage recorded once with exactly the calls made`, rec.calls.length === 1 && !!c && c.placesCalls === e.lookups && c.geminiCalls === expectedGemini(sc) && c.geocodingCalls === 1, JSON.stringify(c));
        check(`stream handler, ${sc.name}: reservation released`, released);
        // client view: cards already sent stay, and the notice shows
        const view = events.reduce(reduceStream as never, initialStreamState()) as ReturnType<typeof initialStreamState>;
        check(`client view, ${sc.name}: ${e.shown} cards kept, ${e.timedOut ? "notice shown" : "no notice"}`, view.cards.length === e.shown && view.phase === "done" && view.timedOut === e.timedOut && (streamNotice(view) === RAN_OUT_OF_TIME_MESSAGE) === e.timedOut, `notice ${streamNotice(view)}`);
      }
    }
  } finally {
    await tmp.drop();
    const after = await tmp.liveCounts();
    area = "cleanup";
    check("temporary schema dropped; live api_usage, usage_reservations, searches and app_settings row counts unchanged", JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)}`);
    check("no network call", tmp.fetchCalls() === 0);
    await closePool();
  }

  // ============ C. limits live in one place and the routes match ============
  area = "limits";
  const routeLiteral = (path: string) => Number(/export const maxDuration = (\d+);/.exec(readFileSync(new URL(path, import.meta.url), "utf-8"))?.[1]);
  check(`/api/search, /api/search-query, /api/search-stream declare maxDuration = ${SEARCH_ROUTE_MAX_DURATION_SECONDS}`, ["../app/api/search/route.ts", "../app/api/search-query/route.ts", "../app/api/search-stream/route.ts"].every((p) => routeLiteral(p) === SEARCH_ROUTE_MAX_DURATION_SECONDS));
  check(`/api/reverse-geocode declares maxDuration = ${REVERSE_GEOCODE_ROUTE_MAX_DURATION_SECONDS}`, routeLiteral("../app/api/reverse-geocode/route.ts") === REVERSE_GEOCODE_ROUTE_MAX_DURATION_SECONDS);
  check(`the pipeline deadline is ${PIPELINE_DEADLINE_SECONDS} s (${PIPELINE_DEADLINE_MS} ms); deadline + longest call timeout (${LONGEST_CALL_TIMEOUT_MS / 1000} s) = ${WORST_CASE_PIPELINE_END_SECONDS} s, at least 15 s under the ${SEARCH_ROUTE_MAX_DURATION_SECONDS} s route limit`, PIPELINE_DEADLINE_MS === 100_000 && WORST_CASE_PIPELINE_END_SECONDS === 130 && WORST_CASE_PIPELINE_END_SECONDS + 15 <= SEARCH_ROUTE_MAX_DURATION_SECONDS);
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url)); // not .pathname: it percent-encodes this repo's folder name and the checks below would pass vacuously
  check("no vercel.json anywhere in the repo (request cancellation stays off); the repo root and matching-engine really exist", existsSync(repoRoot + "matching-engine/package.json") && !existsSync(repoRoot + "vercel.json") && !existsSync(repoRoot + "matching-engine/vercel.json"));
  let cancelHits = "";
  let grepRan = false;
  try { cancelHits = execFileSync("git", ["grep", "-l", "-E", "supportsCancellation\"?[[:space:]]*:", "--", ".", ":!matching-engine/scripts/verify-deadline.ts"], { cwd: repoRoot, encoding: "utf-8" }); grepRan = true; } catch (e) { grepRan = (e as { status?: number }).status === 1; /* git grep exits 1 when nothing matches; anything else means it did not run */ }
  check("supportsCancellation is not configured anywhere in tracked files (git grep ran and found nothing)", grepRan && cancelHits.trim() === "", cancelHits.trim());

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}
main().catch(async (err) => {
  console.error("verify-deadline crashed:", err);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
