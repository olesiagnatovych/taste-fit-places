// Event shapes, NDJSON parser and view-state reducer for the progressive search stream
// (/api/search-stream). Pure and client-safe: no server imports (no db, quota-gate, Gemini), so the
// /alt page can import it and tests can run it with no network.
//
// Wire format: one JSON object per line ("\n" terminated), over a normal streamed response.
//   start  — sent once the anchor address is resolved
//   place  — one per place, as soon as it finishes scoring (never for a "not_a_match" place)
//   done   — final counts and the zero-results flag; usage has been recorded when this arrives
//   error  — same outcomes as the non-streaming routes: { status, message, suggestedCategory? }
// The client adds one more event of its own, "interrupted", when the connection ends without a
// done or error event.

/** Same fields the plain results list renders today (matches ResultsList's SearchResultItem). */
export interface StreamCard {
  name: string;
  address: string | null;
  neighborhood: string | null;
  locality: string | null;
  typeDisplayName: string | null;
  distanceMiles: number | null;
  rating: number;
  priceRange: { startPrice: number; endPrice: number } | null;
  mapsLink: string;
  verdict: "strong_match" | "possible_match" | null;
  heartCount: 3 | 2 | null;
  unverified: boolean;
  confidence: "high" | "medium" | "low" | null;
  evidence: string[];
  caveat: string | null;
}

export type StreamEvent =
  | { type: "start"; category: string; anchor: string; resolvedAnchor: string }
  | { type: "place"; place: StreamCard }
  | {
      type: "done";
      searchId: string;
      shown: number;
      /** Places Step 1 listed (after de-duplicating by name). */
      step1Places: number;
      /** Places that passed the Step 2 filters. */
      survivors: number;
      /** Places sent to Step 3 scoring (after de-duplicating by place id). */
      scored: number;
      zeroResults: boolean;
      /** Present and true when the request ran out of time and stopped early; the cards already sent are valid. */
      timedOut?: boolean;
      reason?: "ran_out_of_time";
      message?: string;
    }
  | { type: "error"; status: number; message: string; suggestedCategory?: string };

export type ClientEvent = StreamEvent | { type: "interrupted" };

const KNOWN_TYPES = new Set(["start", "place", "done", "error"]);

export function encodeEvent(event: StreamEvent): string {
  return JSON.stringify(event) + "\n";
}

/** Same message the non-streaming page shows when the network call itself fails. */
export const NETWORK_ERROR_MESSAGE = "Real network error — could not reach the search API.";

/**
 * Reads a streamed response body and yields one event per complete line. Handles lines split across
 * chunks, several lines in one chunk, CRLF line ends, blank lines, and a last line with no trailing
 * newline. A line that is not valid JSON, or has no known "type", is skipped (not fatal). A read
 * error from the underlying stream propagates to the caller.
 */
export async function* parseNdjsonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (raw: string): StreamEvent | null => {
    const line = raw.trim();
    if (!line) return null;
    try {
      const value = JSON.parse(line) as { type?: unknown };
      if (value && typeof value === "object" && typeof value.type === "string" && KNOWN_TYPES.has(value.type)) {
        return value as StreamEvent;
      }
    } catch {
      // malformed line: skip
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const event = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const last = parseLine(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Feeds every event from a streamed response to `onEvent`. If the connection ends, or the read
 * fails, before a done or error event arrived, `onEvent` receives one "interrupted" event so the
 * view can keep the cards already shown.
 */
export async function consumeSearchStream(
  response: { body: ReadableStream<Uint8Array> | null },
  onEvent: (event: ClientEvent) => void
): Promise<void> {
  let terminal = false;
  try {
    if (response.body) {
      for await (const event of parseNdjsonStream(response.body)) {
        if (terminal) continue; // nothing after a done or error is meaningful
        onEvent(event);
        if (event.type === "done" || event.type === "error") terminal = true;
      }
    }
  } catch {
    // connection dropped mid-read: handled below as "interrupted"
  }
  if (!terminal) onEvent({ type: "interrupted" });
}

// ===== view state =====

export type StreamPhase = "waiting" | "streaming" | "done" | "error" | "interrupted";

export interface StreamViewState {
  /** waiting = no card yet; streaming = at least one card, more may come; the rest are final. */
  phase: StreamPhase;
  category: string | null;
  anchor: string | null;
  resolvedAnchor: string | null;
  /** Cards in arrival order. Never re-sorted. */
  cards: StreamCard[];
  zeroResults: boolean;
  /** True when the search finished early because it ran out of time. */
  timedOut: boolean;
  error: { status: number; message: string; suggestedCategory?: string } | null;
}

export function initialStreamState(): StreamViewState {
  return { phase: "waiting", category: null, anchor: null, resolvedAnchor: null, cards: [], zeroResults: false, timedOut: false, error: null };
}

const isFinal = (s: StreamViewState) => s.phase === "done" || s.phase === "error" || s.phase === "interrupted";

export function reduceStream(state: StreamViewState, event: ClientEvent): StreamViewState {
  if (isFinal(state)) return state;
  switch (event.type) {
    case "start":
      return { ...state, category: event.category, anchor: event.anchor, resolvedAnchor: event.resolvedAnchor };
    case "place":
      return { ...state, phase: "streaming", cards: [...state.cards, event.place] };
    case "done":
      return { ...state, phase: "done", zeroResults: event.zeroResults, timedOut: event.timedOut === true };
    case "error":
      return { ...state, phase: "error", error: { status: event.status, message: event.message, suggestedCategory: event.suggestedCategory } };
    case "interrupted":
      // No card yet: this is a plain network failure, same message as the non-streaming page.
      // Cards already shown are kept as they are.
      return state.cards.length === 0
        ? { ...state, phase: "error", error: { status: 0, message: NETWORK_ERROR_MESSAGE } }
        : { ...state, phase: "interrupted" };
  }
}

/** The quiet message shown until the first card arrives; null otherwise. */
export function diggingMessage(state: StreamViewState): string | null {
  return state.phase === "waiting" ? "digging…" : null;
}

/** The small hint shown while more cards may still arrive; null otherwise. */
export function stillDiggingHint(state: StreamViewState): string | null {
  return state.phase === "streaming" ? "still digging…" : null;
}

/** A note shown under cards that stay on screen after a problem; null when there is nothing to say. */
export function streamNotice(state: StreamViewState): string | null {
  if (state.phase === "done" && state.timedOut) return "Ran out of time. These are the places found so far.";
  if (state.cards.length === 0) return null;
  if (state.phase === "interrupted") return "The connection closed early. These are the places that arrived.";
  if (state.phase === "error" && state.error) return state.error.message;
  return null;
}
