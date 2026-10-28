// Verification for the progressive-results client side. A stubbed stream, no live calls, no cost.
//   Part 1: the NDJSON parser (split lines, several lines per chunk, CRLF, blank lines, no final newline,
//           malformed lines, multi-byte characters split across chunks).
//   Part 2: the view-state reducer (arrival order, no re-sorting, final states).
//   Part 3: the incremental render: the real /alt results component rendered to HTML after each event.
//   Part 4: consumeSearchStream with a stream released in timed pieces (cards appear before the end) and
//           with streams that close or fail partway (cards kept).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  consumeSearchStream, diggingMessage, encodeEvent, initialStreamState, parseNdjsonStream, reduceStream, stillDiggingHint,
  NETWORK_ERROR_MESSAGE, type ClientEvent, type StreamCard, type StreamEvent, type StreamViewState,
} from "../src/stream-events.js";
import { StreamingResults } from "../app/alt/StreamingResults.js";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const card = (name: string, heartCount: 3 | 2 | null): StreamCard => ({
  name, address: `${name} Street`, neighborhood: null, locality: "San Francisco", typeDisplayName: "Japanese Restaurant",
  distanceMiles: 0.8, rating: 4.5, priceRange: { startPrice: 30, endPrice: 50 }, mapsLink: `https://maps.example/${encodeURIComponent(name)}`,
  verdict: heartCount === 3 ? "strong_match" : heartCount === 2 ? "possible_match" : null, heartCount, unverified: heartCount === null,
  confidence: "high", evidence: [`evidence for ${name}`], caveat: null,
});
const start: StreamEvent = { type: "start", category: "sushi", anchor: "100 Example St", resolvedAnchor: "100 Example St, Exampleville, CA 00000, USA (fake)" };
const placeA: StreamEvent = { type: "place", place: card("Stub Place Alpha", 2) };   // 2 hearts arrives FIRST
const placeB: StreamEvent = { type: "place", place: card("Stub Place Bravo", 3) };   // 3 hearts arrives second
const placeC: StreamEvent = { type: "place", place: card("Stub Place Charlie", 3) };
const done: StreamEvent = { type: "done", searchId: "s1", shown: 3, step1Places: 10, survivors: 5, scored: 4, zeroResults: false };

// failAtEnd: deliver the chunks, then fail the connection a moment later (an error raised in the same tick
// would discard chunks that are still queued, which is not what a dropped connection does).
const streamOfBytes = (chunks: Uint8Array[], failAtEnd = false) =>
  new ReadableStream<Uint8Array>({
    async start(c) {
      for (const ch of chunks) c.enqueue(ch);
      if (failAtEnd) {
        await sleep(30);
        c.error(new Error("connection reset"));
      } else {
        c.close();
      }
    },
  });
const streamOf = (chunks: string[], failAtEnd = false) => streamOfBytes(chunks.map((s) => enc.encode(s)), failAtEnd);
async function collect(body: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of parseNdjsonStream(body)) out.push(e);
  return out;
}
const types = (evs: ClientEvent[]) => evs.map((e) => e.type).join(",");
const html = (view: StreamViewState) => renderToStaticMarkup(createElement(StreamingResults, { view, classes: { stillDigging: "dig", notice: "note" } }));
const feed = (events: ClientEvent[]) => events.reduce(reduceStream, initialStreamState());

async function main() {
  // ===== Part 1: parser =====
  {
    const wire = [start, placeA, placeB, done].map(encodeEvent).join("");
    const cut = [wire.slice(0, 17), wire.slice(17, 90), wire.slice(90, 91), wire.slice(91)]; // splits inside lines
    check("lines split across chunks are rejoined", types(await collect(streamOf(cut))) === "start,place,place,done");
    check("several lines in one chunk", types(await collect(streamOf([wire]))) === "start,place,place,done");
    check("CRLF line ends and blank lines", types(await collect(streamOf([wire.replace(/\n/g, "\r\n\r\n")]))) === "start,place,place,done");
    check("last line without a trailing newline", types(await collect(streamOf([encodeEvent(start) + JSON.stringify(placeA)]))) === "start,place");
    check(
      "malformed and unknown lines are skipped, later events still parsed",
      types(await collect(streamOf([encodeEvent(start), "{not json\n", '{"type":"mystery"}\n', '"just a string"\n', encodeEvent(placeA)]))) === "start,place"
    );
    // Multi-byte characters ("—", "é") cut in the middle of their bytes.
    const bytes = enc.encode(encodeEvent({ type: "error", status: 503, message: "Café — closed" }));
    const mid = bytes.indexOf(0xe2) + 1; // inside the 3-byte em dash
    const evs = await collect(streamOfBytes([bytes.slice(0, mid), bytes.slice(mid)]));
    check("multi-byte characters split across chunks", evs.length === 1 && evs[0].type === "error" && (evs[0] as { message: string }).message === "Café — closed");
  }

  // ===== Part 2: reducer =====
  {
    let v = initialStreamState();
    check("initial: waiting, nothing to show", v.phase === "waiting" && v.cards.length === 0);
    v = reduceStream(v, start);
    check("after start: still waiting, anchor known", v.phase === "waiting" && v.resolvedAnchor?.startsWith("100 Example St") === true);
    v = reduceStream(v, placeA);
    v = reduceStream(v, placeB);
    v = reduceStream(v, placeC);
    check("cards kept in arrival order (a 2-heart card stays before 3-heart cards)", v.cards.map((c) => c.name).join(",") === "Stub Place Alpha,Stub Place Bravo,Stub Place Charlie");
    v = reduceStream(v, done);
    check("done: final, three cards", v.phase === "done" && v.cards.length === 3 && !v.zeroResults);
    check("events after a final state are ignored", reduceStream(v, placeA).cards.length === 3);
    const zero = feed([start, { type: "done", searchId: "s2", shown: 0, step1Places: 10, survivors: 0, scored: 0, zeroResults: true }]);
    check("zero results: done with the flag, no cards", zero.phase === "done" && zero.zeroResults && zero.cards.length === 0);
    const errNoCards = feed([start, { type: "error", status: 422, message: "Couldn't tell what you're looking for", suggestedCategory: "coffee" }]);
    check("error before any card: error state with status and suggestion", errNoCards.phase === "error" && errNoCards.error?.status === 422 && errNoCards.error?.suggestedCategory === "coffee");
    const netNoCards = feed([start, { type: "interrupted" }]);
    check("connection closed before any card: same network error as the plain page", netNoCards.phase === "error" && netNoCards.error?.message === NETWORK_ERROR_MESSAGE && netNoCards.error?.status === 0);
    const cut = feed([start, placeA, placeB, { type: "interrupted" }]);
    check("connection closed partway: cards kept", cut.phase === "interrupted" && cut.cards.length === 2);
    const lateErr = feed([start, placeA, { type: "error", status: 503, message: "Search is temporarily unavailable. Please try again shortly." }]);
    check("error after a card: card kept", lateErr.phase === "error" && lateErr.cards.length === 1);
  }

  // ===== Part 3: incremental render (the real results component, after each event) =====
  {
    let v = initialStreamState();
    check("digging message until the first card", diggingMessage(v) === "digging…" && html(v) === "");
    v = reduceStream(v, start);
    check("still digging message after start, nothing rendered yet", diggingMessage(v) === "digging…" && html(v) === "");
    v = reduceStream(v, placeA);
    let h = html(v);
    check("first card: digging message gone, card rendered, 'still digging' hint shown", diggingMessage(v) === null && h.includes("Stub Place Alpha") && h.includes("still digging") && h.includes("1 result(s) so far"));
    v = reduceStream(v, placeB);
    h = html(v);
    check("second card added, first still in place (no jump)", h.includes("Stub Place Alpha") && h.includes("Stub Place Bravo") && h.indexOf("Stub Place Alpha") < h.indexOf("Stub Place Bravo"));
    v = reduceStream(v, placeC);
    h = html(v);
    check("three cards in arrival order, not sorted by hearts", h.indexOf("Stub Place Alpha") < h.indexOf("Stub Place Bravo") && h.indexOf("Stub Place Bravo") < h.indexOf("Stub Place Charlie") && h.includes("heartCount: 2") && stillDiggingHint(v) === "still digging…");
    v = reduceStream(v, done);
    h = html(v);
    check("done: hint gone, final count shown", !h.includes("still digging") && h.includes("3 result(s).") && stillDiggingHint(v) === null);
    check("zero results renders the same empty message as today", html(feed([start, { type: "done", searchId: "s", shown: 0, step1Places: 3, survivors: 0, scored: 0, zeroResults: true }])).includes("No real results."));
    h = html(feed([start, placeA, placeB, { type: "interrupted" }]));
    check("closed partway: both cards stay, with a note, no 'still digging'", h.includes("Stub Place Alpha") && h.includes("Stub Place Bravo") && h.includes("connection closed early") && !h.includes("still digging"));
    h = html(feed([start, placeA, { type: "error", status: 503, message: "Search is temporarily unavailable." }]));
    check("error after a card: card stays, message shown", h.includes("Stub Place Alpha") && h.includes("Search is temporarily unavailable.") && !h.includes("still digging"));
    check("error before any card renders no results area (the page shows the error state)", html(feed([start, { type: "error", status: 422, message: "x" }])) === "");
  }

  // ===== Part 4: consumeSearchStream =====
  {
    // 4a. A stream released in timed pieces: each card must be delivered when its piece arrives,
    // not held until the stream ends.
    const t0 = Date.now();
    const arrivals: Array<{ type: string; at: number }> = [];
    let closedAt = 0;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const e of [start, placeA, placeB, placeC, done]) {
          c.enqueue(enc.encode(encodeEvent(e)));
          await sleep(60);
        }
        closedAt = Date.now() - t0;
        c.close();
      },
    });
    const views: Array<{ at: number; cards: number }> = [];
    let view = initialStreamState();
    await consumeSearchStream({ body }, (ev) => {
      arrivals.push({ type: ev.type, at: Date.now() - t0 });
      view = reduceStream(view, ev);
      views.push({ at: Date.now() - t0, cards: view.cards.length });
    });
    const placeAt = arrivals.filter((a) => a.type === "place").map((a) => a.at);
    check("cards are delivered as pieces arrive, before the stream ends", placeAt.length === 3 && placeAt[0] < closedAt - 100, `first card at ${placeAt[0]}ms, stream closed at ${closedAt}ms`);
    check("cards arrive spread out, one per piece", placeAt[1] - placeAt[0] >= 40 && placeAt[2] - placeAt[1] >= 40, placeAt.join(","));
    check("card count grows 0,1,2,3 as events arrive (start, three places, done)", views.map((v) => v.cards).join(",") === "0,1,2,3,3", views.map((v) => v.cards).join(","));
    check("a normal stream ends with done and no 'interrupted'", arrivals[arrivals.length - 1].type === "done" && !arrivals.some((a) => a.type === "interrupted"));

    // 4b. Closes after two cards, no done.
    const got: ClientEvent[] = [];
    await consumeSearchStream({ body: streamOf([encodeEvent(start), encodeEvent(placeA), encodeEvent(placeB)]) }, (e) => got.push(e));
    check("stream that closes early ends with 'interrupted' and keeps the cards", types(got) === "start,place,place,interrupted" && feed(got).cards.length === 2);

    // 4c. The connection fails mid-stream.
    const got2: ClientEvent[] = [];
    await consumeSearchStream({ body: streamOf([encodeEvent(start), encodeEvent(placeA)], true) }, (e) => got2.push(e));
    check("stream that errors mid-read ends with 'interrupted' and keeps the card", types(got2) === "start,place,interrupted" && feed(got2).cards.length === 1);

    // 4d. An explicit error event is final: no 'interrupted' after it.
    const got3: ClientEvent[] = [];
    await consumeSearchStream({ body: streamOf([encodeEvent({ type: "error", status: 500, message: "Search failed." })]) }, (e) => got3.push(e));
    check("an error event is final, no 'interrupted' added", types(got3) === "error");

    // 4e. No body at all.
    const got4: ClientEvent[] = [];
    await consumeSearchStream({ body: null }, (e) => got4.push(e));
    check("no body: 'interrupted'", types(got4) === "interrupted");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll search-stream client checks passed.");
}
main();
