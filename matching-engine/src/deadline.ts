// A deadline for one search request (2026-10-20, spend protection): once it has passed, the pipelines
// stop STARTING new paid calls (no new Places lookups, no new scoring calls). Calls already in flight
// are left to finish. The clock is injectable so tests can run a "slow" pipeline instantly.
export interface Deadline {
  expired(): boolean;
  remainingMs(): number;
}

export function makeDeadline(startedAtMs: number, limitMs: number, now: () => number = Date.now): Deadline {
  return {
    expired: () => now() >= startedAtMs + limitMs,
    remainingMs: () => Math.max(0, startedAtMs + limitMs - now()),
  };
}

/** Shown to the user, and returned in the result note, when a search stopped early. */
export const RAN_OUT_OF_TIME_MESSAGE = "Ran out of time. These are the places found so far.";
