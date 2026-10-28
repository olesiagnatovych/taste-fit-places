// Verification for the streaming search's server side. Stubs only: no API calls, no cost.
//   - runPipelined (src/pipelined-scoring.ts): scoring starts before all lookups finish, at most 3
//     scores in flight, duplicates are scored once, filtered places are never scored, cards come out
//     in completion order, failures are thrown after started work settles.
//   - isShownResult / buildResultCard (src/result-card.ts): "not_a_match" is never shown, an
//     unverified place is, and the card has exactly the fields the results list renders.
//   - The Step 1 prompt text is identical in the live pipeline and the streaming pipeline.
import { readFileSync } from "node:fs";
import { runPipelined } from "../src/pipelined-scoring.js";
import { buildResultCard, isShownResult } from "../src/result-card.js";
import type { CandidatePlace } from "../src/types.js";
import type { ScoreCandidateResult } from "../src/scoreCandidate.js";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cand { id: string; lookupMs: number; scoreMs?: number; pass?: boolean }
const run = (candidates: Cand[], extra: { scoreFn?: (c: Cand) => Promise<string>; lookupConcurrency?: number; scoreConcurrency?: number } = {}) => {
  const scoredOrder: string[] = [];
  const events: Array<{ id: string; at: number }> = [];
  const t0 = Date.now();
  const promise = runPipelined<Cand, Cand, string>({
    candidates,
    lookupConcurrency: extra.lookupConcurrency ?? 5,
    scoreConcurrency: extra.scoreConcurrency ?? 3,
    lookup: async (c) => {
      await sleep(c.lookupMs);
      return c.pass === false ? null : c;
    },
    keyOf: (c) => c.id,
    score: extra.scoreFn ?? (async (c) => {
      await sleep(c.scoreMs ?? 10);
      return `scored-${c.id}`;
    }),
    onScored: (c) => {
      scoredOrder.push(c.id);
      events.push({ id: c.id, at: Date.now() - t0 });
    },
  });
  return { promise, scoredOrder, events, t0 };
};

async function main() {
  // 1. Scoring starts before the last lookup finishes.
  {
    const cands: Cand[] = [
      { id: "fast", lookupMs: 10, scoreMs: 10 },
      { id: "b", lookupMs: 15, scoreMs: 10 },
      { id: "c", lookupMs: 20, scoreMs: 10 },
      { id: "d", lookupMs: 25, scoreMs: 10 },
      { id: "e", lookupMs: 30, scoreMs: 10 },
      { id: "slow", lookupMs: 400, scoreMs: 10 }, // 6th: starts after one of the first five frees a slot
    ];
    const { promise, events } = run(cands);
    const r = await promise;
    const firstCardAt = events[0].at;
    check("first card arrives before the slowest lookup finishes", firstCardAt < 300, `first card at ${firstCardAt}ms, slow lookup takes 400ms`);
    check("all 6 scored", r.scored === 6 && events.length === 6, `scored ${r.scored}`);
    check("scoring began before lookups were done", r.firstScoreStartAt !== null && r.firstScoreStartAt < r.lookupsDoneAt);
  }

  // 2. At most 3 scoring calls at once, and 3 is reached.
  {
    let inFlight = 0;
    let max = 0;
    const cands: Cand[] = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, lookupMs: 2 }));
    const { promise } = run(cands, {
      scoreFn: async (c) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await sleep(40);
        inFlight--;
        return c.id;
      },
    });
    await promise;
    check("scoring concurrency is capped at 3", max === 3, `max in flight ${max}`);
  }

  // 3. Same place id twice: scored once.
  {
    let scoreCalls = 0;
    const { promise } = run(
      [{ id: "same", lookupMs: 5 }, { id: "same", lookupMs: 1 }, { id: "other", lookupMs: 3 }],
      { scoreFn: async (c) => { scoreCalls++; await sleep(5); return c.id; } }
    );
    const r = await promise;
    check("duplicate place id is scored once", scoreCalls === 2 && r.queued === 2 && r.survivors === 3, `score calls ${scoreCalls}, queued ${r.queued}, survivors ${r.survivors}`);
  }

  // 4. Filtered places are never scored.
  {
    const scoredIds: string[] = [];
    const { promise } = run(
      [{ id: "a", lookupMs: 3 }, { id: "x", lookupMs: 3, pass: false }, { id: "b", lookupMs: 3 }],
      { scoreFn: async (c) => { scoredIds.push(c.id); return c.id; } }
    );
    await promise;
    check("filtered-out place is never sent to scoring", !scoredIds.includes("x") && scoredIds.length === 2, scoredIds.join(","));
  }

  // 5. Cards come out in completion order, not input order.
  {
    const cands: Cand[] = [
      { id: "slowScore", lookupMs: 1, scoreMs: 120 },
      { id: "midScore", lookupMs: 1, scoreMs: 60 },
      { id: "fastScore", lookupMs: 1, scoreMs: 10 },
    ];
    const { promise, scoredOrder } = run(cands);
    await promise;
    check("cards are emitted as each finishes (completion order)", scoredOrder.join(",") === "fastScore,midScore,slowScore", scoredOrder.join(","));
  }

  // 6. A scorer failure is thrown, and no new scoring starts after it.
  {
    let started = 0;
    const cands: Cand[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, lookupMs: 1 }));
    const { promise } = run(cands, {
      scoreFn: async (c) => {
        started++;
        await sleep(20);
        if (c.id === "p0") throw new Error("scorer boom");
        return c.id;
      },
    });
    let message = "";
    try { await promise; } catch (e) { message = (e as Error).message; }
    check("scorer failure is thrown", message === "scorer boom", message);
    check("nothing new starts after a failure", started <= 4, `${started} scoring calls started of 8`);
  }

  // 7. A lookup failure is thrown.
  {
    const promise = runPipelined<Cand, Cand, string>({
      candidates: [{ id: "a", lookupMs: 1 }, { id: "b", lookupMs: 1 }],
      lookupConcurrency: 2, scoreConcurrency: 3,
      lookup: async (c) => { if (c.id === "b") throw new Error("lookup boom"); return c; },
      keyOf: (c) => c.id, score: async (c) => c.id, onScored: () => {},
    });
    let message = "";
    try { await promise; } catch (e) { message = (e as Error).message; }
    check("lookup failure is thrown", message === "lookup boom", message);
  }

  // 8. not_a_match is never shown; unverified is; the card has the same fields as the results list.
  {
    const base = { place: "P", confidence: "high", evidence: ["e1"], caveat: "c", rawText: "", parsedOk: true, attemptsUsed: 1, lastStatus: "completed", cost: 0, latencyMs: 0 };
    const mk = (over: Partial<ScoreCandidateResult>) => ({ ...base, verdict: "strong_match", unverified: false, ...over }) as unknown as ScoreCandidateResult;
    check("strong_match is shown", isShownResult(mk({ verdict: "strong_match" })));
    check("possible_match is shown", isShownResult(mk({ verdict: "possible_match" })));
    check("not_a_match is never shown", !isShownResult(mk({ verdict: "not_a_match" })));
    check("an unverified place is shown", isShownResult(mk({ verdict: null, unverified: true })));

    const place = { name: "Stub Place Test", address: "1 Test St", placeId: "ChIJtest", rating: 4.5, distanceMeters: 1609.344, priceRange: { startPrice: 30, endPrice: 50 }, googleCategories: [], descriptionSignals: [] } as unknown as CandidatePlace;
    const card = buildResultCard(place, mk({ verdict: "possible_match" }));
    const expectedKeys = ["address","caveat","confidence","distanceMiles","evidence","heartCount","locality","mapsLink","name","neighborhood","priceRange","rating","typeDisplayName","unverified","verdict"];
    check("card has exactly the results-list fields", JSON.stringify(Object.keys(card).sort()) === JSON.stringify(expectedKeys), Object.keys(card).sort().join(","));
    check("card values: hearts, distance, maps link", card.heartCount === 2 && card.distanceMiles === 1 && card.mapsLink.includes("query_place_id=ChIJtest"));
    const unverifiedCard = buildResultCard(place, mk({ verdict: null, unverified: true }));
    check("unverified card has no verdict or hearts", unverifiedCard.verdict === null && unverifiedCard.heartCount === null && unverifiedCard.unverified === true);
  }

  // 9. The Step 1 prompt is word-for-word the same in the live and the streaming pipeline.
  {
    const grab = (file: string) => readFileSync(new URL(file, import.meta.url), "utf-8").split("\n").find((l) => l.includes("const step1Prompt ="));
    const live = grab("../src/search-pipeline.ts");
    const stream = grab("../src/search-pipeline-stream.ts");
    check("Step 1 prompt is identical in both pipelines", !!live && live === stream);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll pipelined-scoring checks passed.");
}
main();
