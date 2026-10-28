// Streaming counterpart of search-request-handler.ts, for /api/search-stream. Same flow and the same
// fail-closed rules, but the response is a stream of newline-delimited JSON events (see
// stream-events.ts) instead of one JSON body:
//
//   1. spend gate (reserveSpend)         -> refused or failed: plain 503 with the generic message (no stream is opened)
//   2. runSearchPipelineStreaming()      -> "start" once the anchor is resolved, a "place" per scored place
//   3. insert the searches row, record usage, claim-and-send the threshold alert -> once, at the end
//   4. "done" (or "error"), then close, then release the reservation
//
// If the client disconnects, the pipeline still runs to the end, usage is still recorded and the
// reservation is still released: the Gemini and Places calls were already made, so their cost is real.
// If the pipeline throws after paid calls, what was started is recorded (see usage-settle.ts).
import { recordUsage } from "./quota-gate.js";
import { sendQuotaAlertEmail } from "./alerts.js";
import { getPool } from "./db.js";
import { GENERIC_DENIAL, type SearchRequestOutcome } from "./search-request-handler.js";
import { runSearchPipelineStreaming, type StreamPipelineHooks, type StreamPipelineResult } from "./search-pipeline-stream.js";
import { newUsageTally, type UsageTally } from "./search-pipeline.js";
import { buildResultCard } from "./result-card.js";
import { encodeEvent, type StreamEvent } from "./stream-events.js";
import { defaultGateDb, reserveSpend, sendThresholdAlertOnce, type GateDb } from "./spend-gate.js";
import { recordFailedUsage, safeRelease } from "./usage-settle.js";
import { makeDeadline, RAN_OUT_OF_TIME_MESSAGE, type Deadline } from "./deadline.js";
import { PIPELINE_DEADLINE_MS } from "./time-limits.js";
import type { PublicCategorySlug } from "./category-config.js";

export type OpenedStream = { denied: SearchRequestOutcome } | { stream: ReadableStream<Uint8Array> };

/** Replaceable pieces, so tests can run the whole flow with stubs and no paid call. Every field defaults to the real thing. */
export interface SearchStreamDeps {
  gateDb?: GateDb;
  runPipeline?: (category: PublicCategorySlug, anchor: string, hooks: StreamPipelineHooks, tally: UsageTally, deadline: Deadline) => Promise<StreamPipelineResult>;
  /** Clock for the request deadline; tests pass a fake one. */
  now?: () => number;
  insertSearchRow?: (category: PublicCategorySlug, anchor: string) => Promise<string>;
  recordUsage?: typeof recordUsage;
  sendQuotaAlertEmail?: typeof sendQuotaAlertEmail;
}

async function defaultInsertSearchRow(category: PublicCategorySlug, anchor: string): Promise<string> {
  const searchRow = await getPool().query<{ id: string }>(`insert into searches (query_params) values ($1) returning id`, [
    JSON.stringify({ category, anchor }),
  ]);
  return searchRow.rows[0].id;
}

export async function openSearchStream(categorySlug: PublicCategorySlug, anchor: string, deps: SearchStreamDeps = {}): Promise<OpenedStream> {
  const gateDb = deps.gateDb ?? defaultGateDb();
  const record = deps.recordUsage ?? recordUsage;
  // The request deadline starts here, at the start of the request: past it the pipeline starts no new paid call.
  const now = deps.now ?? Date.now;
  const deadline = makeDeadline(now(), PIPELINE_DEADLINE_MS, now);

  // ===== Spend gate — fail closed on ANY error, before anything is streamed or any paid call is made =====
  let reservation;
  try {
    reservation = await reserveSpend("search", gateDb);
  } catch (err) {
    console.error("search-stream-handler: spend gate failed — failing closed (deny):", err);
    return { denied: { status: 503, body: GENERIC_DENIAL } };
  }
  if (!reservation.admitted) {
    return { denied: { status: 503, body: GENERIC_DENIAL } };
  }
  const reservationId = reservation.reservationId;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false; // the client went away; keep working so usage still gets recorded
        }
      };
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const tally = newUsageTally();
      let recorded = false;
      try {
        const pipelineResult = await (deps.runPipeline ?? ((c, a, h, t, d) => runSearchPipelineStreaming(c, a, h, t, { deadline: d })))(
          categorySlug,
          anchor,
          {
            onAnchor: (resolvedAnchor) => emit({ type: "start", category: categorySlug, anchor, resolvedAnchor }),
            onCard: ({ place, result }) => emit({ type: "place", place: buildResultCard(place, result) }),
          },
          tally,
          deadline
        );

        // ===== Usage and cost, recorded once at the end =====
        const searchId = await (deps.insertSearchRow ?? defaultInsertSearchRow)(categorySlug, anchor);
        await record({
          searchId,
          geminiCalls: pipelineResult.geminiCalls,
          placesCalls: pipelineResult.placesCalls,
          geocodingCalls: pipelineResult.geocodingCalls,
          geminiTokenCostUsd: pipelineResult.geminiTokenCostUsd,
        });
        recorded = true;

        try {
          await sendThresholdAlertOnce({
            sendEmail: deps.sendQuotaAlertEmail ?? sendQuotaAlertEmail,
            searchCountThisMonth: pipelineResult.step1CandidateCount > 0 ? 1 : 0,
            db: gateDb,
          });
        } catch (err) {
          // The non-streaming route withholds the results in this case. Cards may already be on
          // screen here, so the stream ends with the same generic denial as an error event.
          console.error("search-stream-handler: quota-alert email failed to send on the threshold-crossing search — failing closed (deny), real cost was already incurred:", err);
          emit({ type: "error", status: 503, message: GENERIC_DENIAL.error });
          return;
        }

        emit({
          type: "done",
          searchId,
          shown: pipelineResult.shownCount,
          step1Places: pipelineResult.step1CandidateCount,
          survivors: pipelineResult.step2SurvivorCount,
          scored: pipelineResult.scoredCount,
          zeroResults: pipelineResult.shownCount === 0,
          // Ran out of time: usage for the calls made is already recorded; cards already sent stay valid.
          ...(pipelineResult.timedOut ? { timedOut: true, reason: "ran_out_of_time", message: RAN_OUT_OF_TIME_MESSAGE } : {}),
        });
      } catch (err) {
        console.error("search-stream-handler: pipeline failed:", err);
        // Paid calls may already have been made: record what was started, once.
        if (!recorded) await recordFailedUsage(tally, record);
        emit({ type: "error", status: 500, message: "Search failed. Please try again shortly." });
      } finally {
        close();
        await safeRelease(reservationId, gateDb);
      }
    },
  });

  return { stream };
}
