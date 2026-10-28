// Per-call timeout for paid calls (2026-10-20, spend protection). Wraps one call so that
//   1. an AbortSignal is handed to it and aborted when the time is up (so a fetch or an SDK request is
//      actually cancelled), and
//   2. the caller stops WAITING at the same moment (the wrapper rejects with CallTimeoutError even if the
//      callee ignores the signal), so one hung call can never hold a request past its budget.
// A call that times out has still been started; the pipelines count calls when they start, so an aborted
// call is already in the usage tally.
//
// Why not AbortSignal.timeout() directly: it cannot be driven by a fake clock in tests, and it would not
// stop the wait for a callee that ignores the signal. This uses an AbortController with the same effect.
// The timer source is injectable (Timers) for tests; production uses setTimeout.
export class CallTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`call timed out after ${timeoutMs} ms`);
    this.name = "CallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface Timers {
  /** Schedules cb after ms; returns a function that cancels it. */
  setTimeout(cb: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  setTimeout(cb, ms) {
    const handle = setTimeout(cb, ms);
    return () => clearTimeout(handle);
  },
};

/** Runs fn with an AbortSignal and a timeout. A non-finite timeoutMs (Infinity) means no timeout. */
export async function callWithTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, timers: Timers = realTimers): Promise<T> {
  const controller = new AbortController();
  if (!Number.isFinite(timeoutMs)) return fn(controller.signal);
  let cancel: () => void = () => {};
  const timedOut = new Promise<never>((_, reject) => {
    cancel = timers.setTimeout(() => {
      const err = new CallTimeoutError(timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timedOut]);
  } finally {
    cancel();
  }
}
