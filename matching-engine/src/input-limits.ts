// Input length cap for the paid routes (2026-10-20, spend protection). The anchor and the free-text
// query go into Gemini prompts (the anchor again in every scoring prompt), so an unbounded string is
// an unbounded token bill. Checked before any paid call, and before the spend gate, so a rejected
// request costs nothing and holds no reservation.
export const MAX_INPUT_CHARS = 200;

export const INPUT_TOO_LONG_ERROR = { error: `Input is too long (at most ${MAX_INPUT_CHARS} characters).` };

/** True when the value is a string whose trimmed length is over the cap. Non-strings are left to each route's existing validation. */
export function exceedsInputLimit(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > MAX_INPUT_CHARS;
}
