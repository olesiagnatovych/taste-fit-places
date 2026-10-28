// Progressive-results search endpoint: same two inputs as the existing routes, one handler.
//   { category, anchor }  — the structured form, as /api/search takes it
//   { query }             — the free-text form, as /api/search-query takes it
// Request-level problems (bad body, unknown category, unparseable query, quota denial) return a plain
// JSON error with the SAME status codes as those routes (400, 422, 503), before any stream is opened.
// Everything after that is a newline-delimited JSON stream; see src/stream-events.ts for the events.
// /api/search and /api/search-query are untouched.
import { NextRequest, NextResponse } from "next/server";
import { isPublicCategorySlug, type PublicCategorySlug } from "../../../src/category-config.js";
import { parseQuery } from "../../../src/query-parser.js";
import { openSearchStream } from "../../../src/search-stream-handler.js";
import { exceedsInputLimit, INPUT_TOO_LONG_ERROR } from "../../../src/input-limits.js";

export const dynamic = "force-dynamic";

// Same text as app/api/search-query/route.ts (route files cannot export it to be shared).
const AMBIGUOUS_QUERY_ERROR =
  "Couldn't tell what you're looking for and where from that search. Try including a category (coffee, wine, or art) and a place or neighborhood.";

// Vercel terminates a function that runs past this many seconds, and its finally blocks do not run, so the search
// pipelines stop starting new paid calls at an internal deadline well before it. The value must be a literal here;
// src/time-limits.ts holds the same number and scripts/verify-deadline.ts checks they match.
export const maxDuration = 150;

export async function POST(request: NextRequest) {
  let body: { category?: string; anchor?: string; query?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (exceedsInputLimit(body.query) || exceedsInputLimit(body.category) || exceedsInputLimit(body.anchor)) {
    return NextResponse.json(INPUT_TOO_LONG_ERROR, { status: 400 });
  }

  let categorySlug: PublicCategorySlug;
  let anchor: string;

  if (typeof body.query === "string" || (body.category === undefined && body.anchor === undefined)) {
    const { query } = body;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return NextResponse.json({ error: "Missing query." }, { status: 400 });
    }
    const parsed = parseQuery(query);
    if (parsed.kind === "none") {
      return NextResponse.json({ error: AMBIGUOUS_QUERY_ERROR }, { status: 422 });
    }
    if (parsed.kind === "suggestion") {
      return NextResponse.json({ error: AMBIGUOUS_QUERY_ERROR, suggestedCategory: parsed.suggestedCategory }, { status: 422 });
    }
    categorySlug = parsed.category;
    anchor = parsed.location;
  } else {
    const { category, anchor: rawAnchor } = body;
    if (!category || !isPublicCategorySlug(category)) {
      return NextResponse.json({ error: "Unknown category." }, { status: 400 });
    }
    if (!rawAnchor || typeof rawAnchor !== "string" || rawAnchor.trim().length === 0) {
      return NextResponse.json({ error: "Missing anchor location." }, { status: 400 });
    }
    categorySlug = category;
    anchor = rawAnchor.trim();
  }

  const opened = await openSearchStream(categorySlug, anchor);
  if ("denied" in opened) {
    return NextResponse.json(opened.denied.body, { status: opened.denied.status });
  }

  return new Response(opened.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform keeps proxies and compression from buffering the stream into one chunk.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
