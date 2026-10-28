"use client";
// Real homepage — visual/markup port (2026-09-24) of the real, confirmed-final design mockups
// (discover-v1-launch-FINAL.html and discover-error-state-category-FINAL.html, private, not in
// this repo — every other file in that folder confirmed stale
// relative to these two, not used here). This is a visual port, not a logic rewrite: every real
// piece of logic below (category/location state, the structured-vs-free-text routing, the
// geolocation bridge, ResultsList's own rendering) is unchanged from the original ugly/
// functional MVP (Task 85) — only the markup/styling changed, plus one real, deliberate
// addition: an explicit `reason` on the error outcome (see SearchOutcome below), so the
// confirmed-final error design triggers on the real signal the backend actually gives for
// "couldn't match your category" (HTTP 422 from /api/search-query — the only route/status that
// means that) rather than on fragile message-text matching.
//
// Confirmed product decision, not re-derived here (DECISIONS.md, 2026-09-24): the error design
// shows a generic "nothing by that name, please check the spelling" message only — it does NOT
// surface `suggestedCategory` even when the backend's real fuzzy-match finds one. That field is
// still read off the response (kept, in case a future v2 needs it) but deliberately never
// rendered.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isPublicCategorySlug } from "../src/category-config.js";
import { useGeolocationAddress } from "../src/use-geolocation-address.js";
import { ResultsList, type SearchResultItem } from "./components/ResultsList.js";
import styles from "./page.module.css";

type SearchOutcome =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "results";
      results: SearchResultItem[];
      category: string;
      anchor: string;
      /** Real, Google-resolved formatted address for this exact search's anchor (added
       * 2026-09-26) — surfaces a real geocoding misresolution (e.g. bare "panhandle"
       * resolving to Florida, ~2065 miles off) directly on screen instead of leaving it
       * silent. The exact string the search API already returns, not re-derived here. */
      resolvedAnchor: string;
    }
  | {
      kind: "error";
      message: string;
      suggestedCategory?: string;
      /** Real, status-code-derived — NOT inferred from message text. "category-no-match" is
       * the one real case with a confirmed design (HTTP 422, the only status either search
       * route returns for "couldn't tell what you're looking for"). Everything else renders
       * as plain text against the default (non-error) hero, since no design exists for those
       * yet — not invented here. */
      reason: "validation" | "category-no-match" | "quota-denied" | "network" | "geolocation" | "server-other";
    };

// Real, same breakpoint as page.module.css's own @media (max-width: 480px) rule — CSS alone
// can't change a native <input>'s placeholder text, so this is the JS side of that same real
// fix (2026-09-26, corrected same day: an earlier attempt restructured the search bar into a
// stacked layout to give the full placeholder room, which broke the locked pill/vertical-
// divider design — checked the actual math this time: even near-zero padding only leaves
// ~133px per field at 375px, nowhere near enough for "type what you're looking for" at any
// legible size, so the string itself has to shorten on narrow viewports, not the layout).
const MOBILE_BREAKPOINT_QUERY = "(max-width: 480px)";

export default function HomePage() {
  const [categoryText, setCategoryText] = useState("");
  const [locationText, setLocationText] = useState("");
  const [outcome, setOutcome] = useState<SearchOutcome>({ kind: "idle" });
  const { state: geoState, requestLocation } = useGeolocationAddress();
  // Real, deliberate: starts false (matches server-rendered HTML) and corrects itself once
  // mounted — avoids a real hydration mismatch between server (no window) and client renders.
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    setIsMobileViewport(mql.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);
  // Real, deliberate bridge: requestLocation() isn't awaitable (the hook's result arrives via
  // React state over several seconds, not a returned Promise) — this ref holds the category
  // text the user typed at the moment they clicked Go with an empty location field, so the
  // effect below can actually run the search once geolocation resolves (or abandon it if
  // denied/unavailable), rather than the click handler blocking on nothing.
  const pendingCategoryRef = useRef<string | null>(null);

  async function runSearch(category: string, location: string) {
    setOutcome({ kind: "loading" });
    const normalizedCategory = category.trim().toLowerCase();
    const useStructured = isPublicCategorySlug(normalizedCategory);

    try {
      const res = useStructured
        ? await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: normalizedCategory, anchor: location }),
          })
        : await fetch("/api/search-query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: `${category} near ${location}`.trim() }),
          });

      const body = await res.json();

      if (res.ok) {
        setOutcome({
          kind: "results",
          results: (body.results ?? []) as SearchResultItem[],
          category: body.category,
          anchor: body.anchor,
          resolvedAnchor: body.resolvedAnchor,
        });
        return;
      }

      // Real, status-code-based reason — 422 is the one real, confirmed signal for "couldn't
      // match your category/location" (AMBIGUOUS_QUERY_ERROR, search-query/route.ts); 503 is
      // the real quota-gate denial (GENERIC_DENIAL, both routes); anything else is a real but
      // undesigned-for edge case (e.g. /api/search's 400s, dead paths given this page's own
      // client-side validation, kept as a safety net rather than assumed unreachable).
      const reason: "category-no-match" | "quota-denied" | "server-other" =
        res.status === 422 ? "category-no-match" : res.status === 503 ? "quota-denied" : "server-other";

      setOutcome({
        kind: "error",
        message: body.error ?? `Search failed (real HTTP ${res.status}).`,
        suggestedCategory: body.suggestedCategory,
        reason,
      });
    } catch {
      setOutcome({
        kind: "error",
        message: "Real network error — could not reach the search API.",
        reason: "network",
      });
    }
  }

  // Real bug fix (2026-09-26): the two inputs had no onKeyDown and weren't wrapped in a
  // <form> — only the Go button's own onClick triggered a search, so pressing Enter in either
  // field did nothing. Renamed from handleGoClick to handleSubmit and wired as the search
  // <form>'s onSubmit below (button type="submit" inside it) so Enter and the button now go
  // through the exact same real code path, not two separately-maintained triggers.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!categoryText.trim()) {
      setOutcome({
        kind: "error",
        message: "Enter a category (coffee, wine, or art) first.",
        reason: "validation",
      });
      return;
    }

    if (locationText.trim()) {
      runSearch(categoryText, locationText.trim());
      return;
    }

    // Real "location empty" case — the already-built, already-tested geolocation hook
    // (use-geolocation-address.ts), per direct instruction, not a new mechanism.
    pendingCategoryRef.current = categoryText;
    requestLocation();
  }

  // Real bridge: once the geolocation hook resolves a real address (or fails/is denied),
  // continue (or abandon) the search that was waiting on it.
  useEffect(() => {
    if (!pendingCategoryRef.current) return;

    if (geoState.status === "granted") {
      const category = pendingCategoryRef.current;
      pendingCategoryRef.current = null;
      setLocationText(geoState.address); // real, honest — shows what location was actually used
      runSearch(category, geoState.address);
    } else if (geoState.status === "denied" || geoState.status === "unavailable" || geoState.status === "error") {
      pendingCategoryRef.current = null;
      setOutcome({
        kind: "error",
        message: `Could not determine your real location: ${geoState.message} Enter a location manually instead.`,
        reason: "geolocation",
      });
    }
    // "requesting"/"resolving" — real, in-progress states, nothing to do yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoState]);

  const isBusy = outcome.kind === "loading" || geoState.status === "requesting" || geoState.status === "resolving";
  const isCategoryError = outcome.kind === "error" && outcome.reason === "category-no-match";

  // Real, in-progress/plain message for the one shared message slot — every non-error-design
  // case (loading, geolocation permission steps, and every error reason besides the one
  // confirmed-designed "category-no-match") renders here as plain text against the default
  // hero, rather than a second invented design.
  let plainMessage: string | null = null;
  if (geoState.status === "requesting") plainMessage = "Requesting real browser location permission…";
  else if (geoState.status === "resolving") plainMessage = "Got real coordinates — resolving a real address…";
  else if (outcome.kind === "loading") plainMessage = "Searching — real Gemini/Places calls, can take 20–30+ seconds.";
  else if (outcome.kind === "error" && !isCategoryError) plainMessage = outcome.message;

  return (
    <>
      <div className={styles.page}>
        <img
          src={isCategoryError ? "/images/IMG_7993.JPG" : "/images/IMG_8151.JPG"}
          alt=""
          className={`${styles.bgImage} ${isCategoryError ? styles.bgImageError : ""}`}
        />
        <div className={`${styles.scrim} ${isCategoryError ? styles.scrimError : ""}`} />
        <div className={styles.overlayBlack} />

        <div className={styles.content}>
          <div className={`${styles.headline} ${isCategoryError ? styles.headlineError : ""}`}>
            {isCategoryError ? (
              <>
                COULDN&apos;T DIG
                <br />
                THAT UP
              </>
            ) : (
              <>
                PLACES
                <br />
                THAT FEEL YOURS
              </>
            )}
          </div>

          <form className={styles.searchRow} onSubmit={handleSubmit}>
            <div className={styles.searchBar}>
              <div className={styles.field}>
                <input
                  type="text"
                  className={`${styles.fieldInput} ${isCategoryError ? styles.fieldInputError : ""}`}
                  placeholder={isMobileViewport ? "looking for" : "type what you're looking for"}
                  value={categoryText}
                  onChange={(e) => setCategoryText(e.target.value)}
                  disabled={isBusy}
                  aria-label="Category (coffee, wine, or art)"
                />
              </div>
              <div className={styles.divider} />
              <div className={styles.field}>
                <input
                  type="text"
                  className={`${styles.fieldInput} ${isCategoryError ? styles.fieldInputError : ""}`}
                  placeholder="add location"
                  value={locationText}
                  onChange={(e) => setLocationText(e.target.value)}
                  disabled={isBusy}
                  aria-label="Location (leave blank to use your current location)"
                />
              </div>
            </div>
            <button type="submit" className={styles.goBtn} aria-label="search" disabled={isBusy}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </form>

          {isCategoryError && (
            <div className={styles.messageRow}>
              <div className={styles.errorText}>nothing by that name, please check the spelling</div>
            </div>
          )}
          {plainMessage && (
            <div className={styles.messageRow}>
              <div className={styles.plainMessage}>{plainMessage}</div>
            </div>
          )}
        </div>
      </div>

      {outcome.kind === "results" && (
        <div className={styles.resultsArea}>
          <p>
            Real category: {outcome.category} — real anchor: {outcome.anchor} — {outcome.results.length} result(s).
          </p>
          <p>Searching near: {outcome.resolvedAnchor}</p>
          <ResultsList results={outcome.results} />
        </div>
      )}
    </>
  );
}
