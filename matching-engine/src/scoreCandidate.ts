// Shared Step 3 scoring module (2026-08-09) — extracted from the real, corrected
// implementation validated in step3-latency-step3-only-corrected.ts (private development log, Task 34).
// Generic to the Step 3 mechanism itself, not category-specific, so Coffee/Pizza's Step 3
// (not yet built) can reuse this directly instead of duplicating it a third and fourth time.
//
// REVERTED 2026-08-09 (Task 39) — DECIDED directly by the product owner, the private development log same
// date: dropped the strict JSON `response_format` schema entirely, reverted to free-form
// text output using Perplexity's own recommended 4-line labeled format (VERDICT/CONFIDENCE/
// EVIDENCE/CAVEAT). `thinking_level: "low"` and bounded concurrency are UNCHANGED — those
// are separate, already-proven-safe levers, not part of that revert.
//
// FIXED 2026-08-09 (Task 40) — Task 39's own required repeat-call check found the revert did
// NOT fix the real reliability problem: 8/8 identical calls to one real place
// returned `status: "incomplete"`, and the old `parsedOk` check (only checking whether
// VERDICT/CONFIDENCE happened to parse from the text) was masking this — it reported
// `parsedOk: true` even when the real API-level `status` field said the call genuinely
// didn't complete. This rewrite makes `interaction.status === "completed"` the ONLY real
// success signal, independent of text-parsing luck. On any other status (especially
// `"incomplete"`), the whole independent call is retried up to 2 more times with backoff
// (~0.75–1.5s, then ~2–4s, both with jitter). If still not `"completed"` after all retries,
// returns a real, honest `unverified: true` result — verdict/confidence explicitly null, not
// guessed, not silently dropped — so downstream code can distinguish "genuinely not a fit"
// from "we don't actually know" rather than conflating the two.
//
// Explicitly NOT included: Task 34's Step 4 (gemini-3.5-flash-lite) and Step 5 (priority
// tier) — Step 4 has a real, confirmed false-negative failure (claimed a known-good real
// place, "does not appear to be a real establishment"); Step 5 was never justified.
// Model is fixed at gemini-3.6-flash, standard tier, per explicit instruction.
//
// ROOT-CAUSED AND FIXED 2026-08-09 (Task 42, resolving Tasks 37/39/40/41's shared open
// question) — `max_output_tokens: 500` was the real, sole cause of the reliability problem
// this file's retry logic was built to work around. Task 42's clean, non-confounded 2x2
// (prompt structure x output cap, 4 cells, zero exceptions) proved `max_output_tokens` caps
// the COMBINED thinking + output budget for Maps-grounded calls, not output alone — real
// thought-token usage ran 194–542 under the 500 cap (cut off mid-thought) vs. 1121–2691
// uncapped on the identical place/prompt. Raised to 4000 here: generous, real headroom above
// every observed uncapped thought-token count in Tasks 41–42 (max real observed: 2691) plus
// real output (max real observed: ~640), while still bounding runaway cost/latency on a
// genuine outlier — not removed entirely, since Task 42 proved both approaches safe and this
// keeps an explicit ceiling. The Task 40 retry-with-real-`status` logic stays exactly as-is —
// it was correctly built and remains a real safety net for genuine transient failures, just no
// longer the primary fix for what was actually, all along, a token-budget problem.
//
// PARAPHRASE-ONLY CITATION FIX, 2026-08-11 (Task 50) — see the comment directly above
// `freeFormPrompt` for the full reasoning. Prompt now bans quotation marks around generated
// wording (paraphrase-only, since exact quote fidelity can't be verified against what the real
// API returns — confirmed empirically, Task 49) and explicitly prohibits rating/popularity/
// generic praise from counting as taste-fit evidence on its own. Re-verified against all 6
// required ground truths (six real sushi places) — all verdicts held, evidence text confirmed genuinely paraphrased, not quoted.
//
// DISCONFIRMING-EVIDENCE-FIRST, 2026-08-11 (Task 53) — see the comment directly above
// `freeFormPrompt` for the full reasoning. Task 51's real stress test found Task 50's rules
// alone produce honest downgrades but don't surface real, findable negative evidence (one
// coffee place). Prompt now forces identifying the strongest evidence against fit before
// forming any verdict, and requires real negative/contradicting evidence to be surfaced, not
// silently dropped. Re-verified against all 6 required ground truths again — see the private development log
// Task 53 for the real before/after on the Task 51 stress-test batch specifically.
//
// SEARCH-REGION CONTEXT — added 2026-08-12 (Task 57) for Pizza's then-region-dependent
// thick-dough treatment, REMOVED 2026-08-12 (Task 58). The product owner reverted that design back to one
// uniform "medium fit" rule everywhere — its sole real grounding example (a specific pizzeria on
// Koh Tao, Thailand) no longer held up as the product owner remembered it, not because region-dependent taste
// rules are a bad idea in general (tracked as a real, separate future architecture idea,
// the private development log, once there's current grounding to build one from). `ScoreCandidateInput` no
// longer has a `searchRegion` field; `freeFormPrompt` no longer takes or injects one. No caller
// in this codebase used this for anything other than Pizza's now-reverted design, so removing it
// changes nothing for Wine/Sushi/Coffee's prompt text (which never referenced it).

import { GoogleGenAI } from "@google/genai";
import { callWithTimeout, realTimers, type Timers } from "./call-timeout.js";
import { GEMINI_CALL_TIMEOUT_MS } from "./time-limits.js";
import type { Deadline } from "./deadline.js";
import type { CandidatePlace } from "./types.js";

const MODEL = "gemini-3.6-flash";
const PRICING_STANDARD = { in: 1.5, out: 7.5 }; // $/1M tokens — verified live, ai.google.dev/gemini-api/docs/pricing, 2026-08-09 (Task 34)
const MAX_OUTPUT_TOKENS = 4000; // FIXED 2026-08-09 (Task 42) — was 500, the confirmed root cause of the intermittent scoring failures in Tasks 37–43 (see DECISIONS.md decision 5 and docs/experiments.md). On Maps-grounded calls this cap covers the thinking AND the output budget together.
const MAX_RETRIES = 2; // up to 2 retries = 3 total attempts — kept as a real safety net for genuine transient failures (Task 40), no longer the primary fix now that the real cap-truncation cause is fixed (Task 42)

export type Verdict = "strong_match" | "possible_match" | "not_a_match";
export type Confidence = "high" | "medium" | "low";

export interface ScoreCandidateInput {
  place: CandidatePlace;
  /** Real taste-profile text (e.g. SUSHI_TASTE_PROFILE, WINE_TASTE_PROFILE) — caller's
   * responsibility, this module has no category-specific knowledge. */
  tasteProfile: string;
  /** e.g. "a real sushi restaurant near <neighborhood>, <city>" — used
   * directly in the prompt, caller-supplied so this stays generic across categories/anchors. */
  locationDescription: string;
  anchor: { latitude: number; longitude: number };
  /** Request deadline (2026-10-20): checked before EVERY attempt, including each retry and after each backoff wait; once expired no further attempt starts and the result is "unverified". */
  deadline?: Deadline;
  /** Replaceable pieces for tests (stub Gemini call, fake sleep and timers). Production leaves this unset. */
  hooks?: ScoreCandidateHooks;
}

export interface ScoreCandidateHooks {
  create?: (params: Record<string, unknown>, options: { signal: AbortSignal; timeout?: number }) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  timers?: Timers;
  /** Per-attempt timeout in ms; defaults to GEMINI_CALL_TIMEOUT_MS. Infinity disables it (negative control). */
  timeoutMs?: number;
}

export interface ScoreCandidateResult {
  place: string;
  verdict: Verdict | null;
  confidence: Confidence | null;
  evidence: string[];
  caveat: string;
  rawText: string;
  parsedOk: boolean;
  /**
   * True only when every attempt exhausted real retries without the API ever reporting
   * `status: "completed"`. A real, honest "we don't know" state — verdict/confidence are
   * explicitly null here, never guessed. Downstream code (both pipelines) must handle this
   * as its own case, distinct from a genuine "not_a_match" verdict.
   */
  unverified: boolean;
  /** The real, raw `interaction.status` from the LAST attempt made (whether that attempt
   * succeeded or not) — kept for diagnostics, not just inferred from parsing. */
  lastApiStatus: string | null;
  /** How many real API calls this result required (1 = succeeded on the first try). */
  attemptsUsed: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cost: number;
  citationCount: number;
  error?: string;
}

// PARAPHRASE-ONLY FIX, 2026-08-11 (Task 50) — the private development log's 2026-08-10 research
// ("does Grounding with Google Maps guarantee citation/quote accuracy?") found the real
// Interactions API response has no field that lets us verify a quoted sentence is genuinely
// verbatim from a real review — confirmed empirically against real, live raw responses in
// Task 49 (place_citation annotations carry only start_index/end_index/place_id/name/url/type,
// nothing text-level). The old prompt's "real quoted or closely paraphrased text" instruction
// invited exactly the failure mode the old raw-Places-API architecture had a confirmed
// ~25–30% rate of (SoHo Coffee POC, three runs) and never rebuilt verification for under
// Gemini+Grounding. Fix: ban quotation marks around generated wording entirely — paraphrase
// only, cited to the place-level Maps annotation, not to an unverifiable exact quote.
//
// Also folds in the same-day sycophancy research (private development log, "is grounded LLM
// evaluation leniency a documented pattern?") — real true-negative rates below 25% in
// LLM-as-judge literature. Explicitly prohibits rating/popularity/generic praise from counting
// as taste-fit evidence on its own, so vague-but-positive review language can't silently read
// as a strong match.
//
// DISCONFIRMING-EVIDENCE-FIRST, 2026-08-11 (Task 53) — the private development log's 2026-08-11
// hallucination-prevention research names this a real, adapted version of documented
// adversarial/counterfactual RAG bias-mitigation research, not generic "be critical" prompting.
// Task 51's real stress test found the Task 50 rules alone produce honest downgrades on thin
// evidence but do NOT surface real, findable negative evidence that exists (one coffee
// place: downgraded from strong_match to possible_match, but the real negative reviews
// found by hand never appeared in the model's own output). This rule forces the model to
// look for disconfirming evidence BEFORE forming a verdict, not just weigh whatever it happens
// to have retrieved. Real, honest limit, not overclaimed: this doesn't guarantee the Maps tool
// retrieves negative evidence in the first place — "none found" must stay distinct from "none
// exists," a limit this project cannot fix from the prompt side alone.
function freeFormPrompt(locationDescription: string, tasteProfile: string): string {
  return `Does ${locationDescription} fit this specific taste profile, based on its real Google Maps reviews and description?

TASTE PROFILE:
${tasteProfile}

Before producing any verdict: first identify the strongest real evidence AGAINST fit for this specific place. Then identify the strongest real evidence FOR fit. Weigh both before deciding — do not form a verdict from supporting evidence alone.

Respond in EXACTLY this 4-line labeled format, nothing else — no markdown, no extra commentary:
VERDICT: strong_match | possible_match | not_a_match
CONFIDENCE: high | medium | low
EVIDENCE: two concise real observations, separated by " | ", each under 15 words, paraphrased in your own words from actual reviews/description — never in quotation marks, never presented as if verbatim
CAVEAT: one concise real observation noting any gap or hedge, or "none" if there isn't one

Three hard rules on evidence, all non-negotiable:
1. Never use quotation marks to present generated wording as if it were a verbatim review quote. Paraphrase every observation in your own words instead — the citation is to the place itself (via the Maps annotation), not to an exact quoted sentence, since exact quote fidelity cannot be verified downstream.
2. A high rating, general popularity, or generic praise (e.g. "great," "amazing," "cute," "friendly," "highly rated") is NOT taste-fit evidence on its own. If the only real evidence available is generic praise with no specific, checkable detail tied to this taste profile's actual criteria, that is insufficient evidence, not positive support — reflect this honestly in CONFIDENCE (low), and do not claim strong_match on the strength of vague enthusiasm alone when evidence for a specific criterion is genuinely absent.
3. Do not infer a match from a high rating, generic praise, or the absence of negative evidence. Missing evidence is insufficient, not supportive. If real negative or contradicting evidence about this specific taste profile's criteria exists in the reviews, it must be surfaced — in EVIDENCE if it's the deciding factor, in CAVEAT otherwise — never silently dropped in favor of only the positive evidence found.`;
}

/**
 * Defensive, line-based parser for the 4-line labeled format — no JSON.parse, no schema
 * enforcement by the API. Used only to extract content FROM a call the real `status` field
 * already confirmed completed — text-parse success is no longer treated as a substitute for
 * that (Task 40's fix — Task 39 found the old version conflated the two).
 */
function parseLabeledFormat(text: string): {
  verdict: Verdict | null;
  confidence: Confidence | null;
  evidence: string[];
  caveat: string;
  parsedOk: boolean;
} {
  const verdictMatch = text.match(/VERDICT:\s*(strong_match|possible_match|not_a_match)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(high|medium|low)/i);
  const evidenceMatch = text.match(/EVIDENCE:\s*(.+)/i);
  const caveatMatch = text.match(/CAVEAT:\s*(.+)/i);

  const verdict = verdictMatch ? (verdictMatch[1].toLowerCase() as Verdict) : null;
  const confidence = confidenceMatch ? (confidenceMatch[1].toLowerCase() as Confidence) : null;
  const evidence = evidenceMatch
    ? evidenceMatch[1]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  let caveat = caveatMatch ? caveatMatch[1].trim() : "";
  if (caveat.toLowerCase() === "none") caveat = "";

  const parsedOk = verdict !== null && confidence !== null;

  return { verdict, confidence, evidence, caveat, parsedOk };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real backoff schedule, per explicit instruction: retry 1 waits ~0.75–1.5s (jittered),
 * retry 2 waits ~2–4s (jittered). Index 0 = wait before the 1st retry (2nd attempt overall),
 * index 1 = wait before the 2nd retry (3rd attempt overall). */
function backoffMs(retryIndex: number): number {
  if (retryIndex === 0) return 750 + Math.random() * 750; // 0.75–1.5s
  return 2000 + Math.random() * 2000; // 2–4s
}

interface RawCallResult {
  status: string | null;
  text: string;
  citationCount: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cost: number;
  latencyMs: number;
  error?: string;
}

type CreateFn = NonNullable<ScoreCandidateHooks["create"]>;

async function callOnce(create: CreateFn, input: ScoreCandidateInput): Promise<RawCallResult> {
  const start = Date.now();
  const timeoutMs = input.hooks?.timeoutMs ?? GEMINI_CALL_TIMEOUT_MS;
  try {
    // Each attempt gets its own timeout: the request is aborted and the wait ends after timeoutMs. A timed-out
    // attempt is caught below like any thrown error (status null, no cost known) and handled as a failed attempt.
    const interaction = (await callWithTimeout(
      timeoutMs,
      (signal) =>
        create(
          {
            model: MODEL,
            input: freeFormPrompt(input.locationDescription, input.tasteProfile),
            tools: [{ type: "google_maps", latitude: input.anchor.latitude, longitude: input.anchor.longitude }],
            generation_config: { thinking_level: "low", max_output_tokens: MAX_OUTPUT_TOKENS } as never,
            // No response_format — DECIDED 2026-08-09 (Task 39) to drop the strict JSON schema.
          },
          // Only our signal, not the SDK's own `timeout` option: measured against a hung local server, the SDK's
          // `timeout` alone did not bound the call (it retried internally, 5 requests over 7 s for a 200 ms timeout),
          // while our signal cancelled it at once with a single request.
          { signal }
        ),
      input.hooks?.timers ?? realTimers
    )) as Extract<Awaited<ReturnType<GoogleGenAI["interactions"]["create"]>>, { steps: unknown }> & { status?: string };
    const latencyMs = Date.now() - start;

    let text = "";
    let citationCount = 0;
    for (const step of interaction.steps) {
      if (step.type === "model_output") {
        for (const block of step.content ?? []) {
          if (block.type === "text") {
            text += block.text;
            for (const ann of block.annotations ?? []) {
              if (ann.type === "place_citation") citationCount += 1;
            }
          }
        }
      }
    }
    const usage = interaction.usage;
    const inputTokens = usage?.total_input_tokens ?? 0;
    const outputTokens = usage?.total_output_tokens ?? 0;
    const thoughtTokens = usage?.total_thought_tokens ?? 0;
    const cost = (inputTokens / 1_000_000) * PRICING_STANDARD.in + ((outputTokens + thoughtTokens) / 1_000_000) * PRICING_STANDARD.out;
    const status = (interaction as { status?: string }).status ?? null;

    return { status, text, citationCount, inputTokens, outputTokens, thoughtTokens, cost, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      status: null,
      text: "",
      citationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cost: 0,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Real, single-place Step 3 scoring call. One real place per call, always — the multi-place-
 * per-call risk that caused three sushi places' silent drops is structurally impossible
 * here regardless of how many of these run concurrently (see mapWithConcurrency below).
 *
 * `interaction.status === "completed"` is the ONLY real success signal (Task 40 fix) —
 * retries the whole independent call up to MAX_RETRIES times on any other status, with real
 * backoff between attempts. Returns `unverified: true` (verdict/confidence null, not guessed)
 * if every attempt exhausts without ever reaching `"completed"`.
 */
export async function scoreCandidate(input: ScoreCandidateInput): Promise<ScoreCandidateResult> {
  let create = input.hooks?.create;
  if (!create) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
    const ai = new GoogleGenAI({ apiKey });
    create = (params, options) => ai.interactions.create(params as never, options as never) as Promise<unknown>;
  }
  const sleepFn = input.hooks?.sleep ?? sleep;

  const overallStart = Date.now();
  let totalCost = 0;
  let lastResult: RawCallResult | null = null;
  let attemptsUsed = 0;

  let stoppedByDeadline = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Past the deadline there will be no retry, so do not wait out a backoff for it either.
      if (input.deadline?.expired()) {
        stoppedByDeadline = true;
        break;
      }
      await sleepFn(backoffMs(attempt - 1));
    }
    // Checked before EVERY attempt, after any backoff wait: no attempt, retry included, starts after the request deadline.
    if (input.deadline?.expired()) {
      stoppedByDeadline = true;
      break;
    }
    attemptsUsed += 1;
    const result = await callOnce(create, input);
    totalCost += result.cost;
    lastResult = result;

    if (result.status === "completed") {
      const parsed = parseLabeledFormat(result.text);
      return {
        place: input.place.name,
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        evidence: parsed.evidence,
        caveat: parsed.caveat,
        rawText: result.text,
        parsedOk: parsed.parsedOk,
        unverified: false,
        lastApiStatus: result.status,
        attemptsUsed,
        latencyMs: Date.now() - overallStart,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        thoughtTokens: result.thoughtTokens,
        cost: totalCost,
        citationCount: result.citationCount,
      };
    }
    // else: not "completed" (e.g. "incomplete", null on a real thrown error, or anything
    // else) — loop continues to the next retry, if any remain.
  }

  // Every attempt exhausted without ever reaching "completed" — real, honest unverified
  // result. Not a guessed "not_a_match", not silently dropped.
  return {
    place: input.place.name,
    verdict: null,
    confidence: null,
    evidence: [],
    caveat: "",
    rawText: lastResult?.text ?? "",
    parsedOk: false,
    unverified: true,
    lastApiStatus: lastResult?.status ?? null,
    attemptsUsed,
    latencyMs: Date.now() - overallStart,
    inputTokens: lastResult?.inputTokens ?? 0,
    outputTokens: lastResult?.outputTokens ?? 0,
    thoughtTokens: lastResult?.thoughtTokens ?? 0,
    cost: totalCost,
    citationCount: lastResult?.citationCount ?? 0,
    error: stoppedByDeadline ? `request deadline reached; no further attempt started${lastResult?.error ? ` (last attempt: ${lastResult.error})` : ""}` : lastResult?.error,
  };
}

/**
 * Bounded-concurrency map — real analog to asyncio.as_completed with a semaphore (Task 34's
 * design, empirically confirmed to stream results independently as each completes, not
 * batched — see the private development log Task 34 and the 2026-08-09 process-incident correction in
 * the private development log). Default concurrency 3, per Perplexity's own recommended starting point
 * (private development log, 2026-08-09) — Google does not publish an exact Maps-grounding
 * concurrency ceiling, so this stays a bounded, measured rollout, not an unbounded blast.
 * Individual pipelines (e.g. Sushi, Task 38) may override this with their own real-measured
 * concurrency value.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export const STEP3_CONCURRENCY_DEFAULT = 3;
