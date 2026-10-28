// Step 2 -> Step 3 pipelining for the streaming search. Generic on purpose, so it can be tested with
// stubbed lookups and a stubbed scorer (no live calls).
//
// What it does: runs the Step 2 lookups `lookupConcurrency` at a time. As soon as one lookup passes
// the filters (returns a place, not null) that place goes straight into a scoring queue that runs
// `scoreConcurrency` at a time, without waiting for the other lookups. Each scored place is handed to
// `onScored` the moment it finishes, in completion order.
//
// De-duplication: the live pipeline drops a repeated place_id after ALL lookups finished and keeps the
// FIRST-LISTED mention. A stream cannot wait, so here the first mention to PASS a lookup wins and a
// later mention with the same key is never scored (so it is never billed twice). Both mentions are
// lookups of the same Google place, so the kept data is the same place either way; only which mention's
// text produced the lookup can differ.
//
// Errors: the first failure (a lookup or a scorer) is remembered and thrown once everything already
// started has settled. Nothing new is started after a failure.
import { mapWithConcurrency } from "./scoreCandidate.js";

export interface PipelinedOptions<C, P, R> {
  candidates: C[];
  /** Returns the place if it passed the filters, otherwise null. */
  lookup: (candidate: C) => Promise<P | null>;
  /** De-duplication key for a passing place (its place id). */
  keyOf: (place: P) => string;
  score: (place: P) => Promise<R>;
  /** Called once per scored place, as it finishes. */
  onScored: (place: P, result: R) => void;
  lookupConcurrency: number;
  scoreConcurrency: number;
  /** Checked before every lookup and every scoring call starts; when it returns false nothing new starts (lookups are skipped, queued places are dropped). In-flight calls finish. */
  canStart?: () => boolean;
}

export interface PipelinedTimings {
  /** Date.now() values; null when nothing was scored. */
  lookupsDoneAt: number;
  firstScoreStartAt: number | null;
  lastScoreEndAt: number | null;
}

export interface PipelinedResult extends PipelinedTimings {
  /** Places that passed the filters (before de-duplication). */
  survivors: number;
  /** Places actually sent to scoring (after de-duplication). */
  queued: number;
  /** Places whose scoring finished. */
  scored: number;
  /** Lookups that were not started because canStart() returned false. */
  skippedLookups: number;
  /** Queued places dropped, never scored, because canStart() returned false. */
  skippedScores: number;
}

export async function runPipelined<C, P, R>(o: PipelinedOptions<C, P, R>): Promise<PipelinedResult> {
  const seen = new Set<string>();
  const pending: P[] = [];
  let active = 0;
  let survivors = 0;
  let queued = 0;
  let scored = 0;
  let skippedLookups = 0;
  let skippedScores = 0;
  let firstError: { error: unknown } | null = null;
  let firstScoreStartAt: number | null = null;
  let lastScoreEndAt: number | null = null;
  let idleWaiters: Array<() => void> = [];

  const isIdle = () => active === 0 && (pending.length === 0 || firstError !== null);
  const notifyIfIdle = () => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const pump = () => {
    while (active < o.scoreConcurrency && pending.length > 0 && firstError === null) {
      if (o.canStart && !o.canStart()) {
        skippedScores += pending.length;
        pending.length = 0;
        break;
      }
      const place = pending.shift() as P;
      active++;
      if (firstScoreStartAt === null) firstScoreStartAt = Date.now();
      o.score(place)
        .then((result) => {
          scored++;
          lastScoreEndAt = Date.now();
          o.onScored(place, result);
        })
        .catch((error) => {
          if (firstError === null) firstError = { error };
        })
        .finally(() => {
          active--;
          pump();
          notifyIfIdle();
        });
    }
  };

  const whenIdle = () => (isIdle() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)));

  let lookupFailure: { error: unknown } | null = null;
  await mapWithConcurrency(o.candidates, o.lookupConcurrency, async (candidate) => {
    // A failure anywhere stops new lookups from starting; ones already started just finish.
    if (firstError !== null || lookupFailure !== null) return;
    if (o.canStart && !o.canStart()) {
      skippedLookups++;
      return;
    }
    try {
      const place = await o.lookup(candidate);
      if (place === null) return;
      survivors++;
      const key = o.keyOf(place);
      if (seen.has(key)) return;
      seen.add(key);
      queued++;
      pending.push(place);
      pump();
    } catch (error) {
      if (lookupFailure === null) lookupFailure = { error };
    }
  });
  const lookupsDoneAt = Date.now();

  await whenIdle();
  if (lookupFailure) throw (lookupFailure as { error: unknown }).error;
  if (firstError) throw (firstError as { error: unknown }).error;

  return { survivors, queued, scored, skippedLookups, skippedScores, lookupsDoneAt, firstScoreStartAt, lastScoreEndAt };
}
