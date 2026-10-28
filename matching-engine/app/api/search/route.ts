// Real /api/search route (private development log GO LIVE item #3) — the structured, category+anchor
// entry point. Real request-handling logic (quota check, pipeline, DB writes, alert email,
// heart-tier/sort response shaping) lives in src/search-request-handler.ts as of 2026-08-16 —
// extracted so the new free-text entry point (app/api/search-query/route.ts) reuses the exact
// same real, fail-closed flow rather than a second, driftable copy. This file's only real job
// now is parsing/validating the HTTP request body and shaping the HTTP response.
import { NextRequest, NextResponse } from "next/server";
import { isPublicCategorySlug, type PublicCategorySlug } from "../../../src/category-config.js";
import { handleSearchRequest } from "../../../src/search-request-handler.js";
import { exceedsInputLimit, INPUT_TOO_LONG_ERROR } from "../../../src/input-limits.js";

// Vercel terminates a function that runs past this many seconds, and its finally blocks do not run, so the search
// pipelines stop starting new paid calls at an internal deadline well before it. The value must be a literal here;
// src/time-limits.ts holds the same number and scripts/verify-deadline.ts checks they match.
export const maxDuration = 150;

export async function POST(request: NextRequest) {
  let body: { category?: string; anchor?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { category, anchor } = body;
  if (exceedsInputLimit(category) || exceedsInputLimit(anchor)) {
    return NextResponse.json(INPUT_TOO_LONG_ERROR, { status: 400 });
  }
  if (!category || !isPublicCategorySlug(category)) {
    return NextResponse.json({ error: "Unknown category." }, { status: 400 });
  }
  if (!anchor || typeof anchor !== "string" || anchor.trim().length === 0) {
    return NextResponse.json({ error: "Missing anchor location." }, { status: 400 });
  }
  const categorySlug: PublicCategorySlug = category;

  const outcome = await handleSearchRequest(categorySlug, anchor.trim());
  return NextResponse.json(outcome.body, { status: outcome.status });
}
