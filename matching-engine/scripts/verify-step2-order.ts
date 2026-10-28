// Verification for search-pipeline.ts's runStep2Lookups (Step 2 concurrency, 2026-10-20).
// Pure logic with a stubbed lookup: no API calls, no cost. Proves that lookups which FINISH out of
// order still come back in Step 1's order, that dedupeByPlaceId therefore keeps the first-listed
// duplicate, that nulls (filtered-out places) are dropped without reordering, and that the
// concurrency cap is respected while lookups really do overlap.
import { runStep2Lookups, STEP2_CONCURRENCY } from "../src/search-pipeline.js";
import { dedupeByPlaceId } from "../src/places-client.js";
import type { CandidatePlace } from "../src/types.js";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const place = (name: string, placeId: string): CandidatePlace => ({
  name, placeId, rating: 4.5, googleCategories: ["sushi_restaurant"], descriptionSignals: [],
} as CandidatePlace);

interface Item { name: string; placeId: string; delayMs: number; pass?: boolean }

async function main() {
  // 1. Completion order is the REVERSE of Step 1 order: item 0 is slowest, the last is fastest.
  {
    const items: Item[] = ["A", "B", "C", "D", "E"].map((n, i) => ({ name: n, placeId: `id-${n}`, delayMs: (5 - i) * 40 }));
    const finished: string[] = [];
    const out = await runStep2Lookups(items, async (it) => {
      await sleep(it.delayMs);
      finished.push(it.name);
      return place(it.name, it.placeId);
    });
    check("lookups really finished out of order", finished.join("") === "EDCBA", `finish order ${finished.join("")}`);
    check("results are in Step 1 order anyway", out.map((p) => p.name).join("") === "ABCDE", `result order ${out.map((p) => p.name).join("")}`);
  }

  // 2. Filtered-out places (null) are dropped and the rest keep their relative Step 1 order.
  {
    const items: Item[] = [
      { name: "A", placeId: "a", delayMs: 60, pass: true },
      { name: "B", placeId: "b", delayMs: 10, pass: false },
      { name: "C", placeId: "c", delayMs: 30, pass: true },
      { name: "D", placeId: "d", delayMs: 5, pass: false },
      { name: "E", placeId: "e", delayMs: 1, pass: true },
    ];
    const out = await runStep2Lookups(items, async (it) => {
      await sleep(it.delayMs);
      return it.pass ? place(it.name, it.placeId) : null;
    });
    check("filtered places dropped, survivors keep Step 1 order", out.map((p) => p.name).join("") === "ACE", out.map((p) => p.name).join(""));
  }

  // 3. The same (fake) place listed twice under two names, an alias of Stub Sushi A: the
  //    LATER-listed alias finishes first.
  //    dedupeByPlaceId keeps the first occurrence, so the first-LISTED mention must survive.
  {
    const items: Item[] = [
      { name: "Stub Sushi A (fake)", placeId: "same-id", delayMs: 80 },
      { name: "Stub Sushi A alias (fake)", placeId: "same-id", delayMs: 1 },
      { name: "Other Place", placeId: "other-id", delayMs: 20 },
    ];
    const out = dedupeByPlaceId(await runStep2Lookups(items, async (it) => {
      await sleep(it.delayMs);
      return place(it.name, it.placeId);
    }));
    check(
      "duplicate place_id: the first-listed mention survives dedupe",
      out.length === 2 && out[0].name === "Stub Sushi A (fake)" && out[1].name === "Other Place",
      out.map((p) => p.name).join(" | ")
    );
  }

  // 4. Concurrency cap: 12 lookups, never more than STEP2_CONCURRENCY in flight, and they do overlap.
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const items: Item[] = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, placeId: `p${i}`, delayMs: 30 }));
    const t0 = Date.now();
    const out = await runStep2Lookups(items, async (it) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(it.delayMs);
      inFlight--;
      return place(it.name, it.placeId);
    });
    const elapsed = Date.now() - t0;
    check(`never more than ${STEP2_CONCURRENCY} in flight`, maxInFlight <= STEP2_CONCURRENCY, `max ${maxInFlight}`);
    check("lookups overlap (limit actually reached)", maxInFlight === STEP2_CONCURRENCY, `max ${maxInFlight}`);
    check("all 12 returned, in order", out.length === 12 && out.every((p, i) => p.name === `P${i}`));
    // 12 x 30ms serially = 360ms; at 5 wide it is 3 rounds = ~90ms. Loose bound to avoid timer flakiness.
    check("faster than serial", elapsed < 300, `${elapsed}ms vs ~360ms serial`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll Step 2 ordering/concurrency checks passed.");
}
main();
