"use client";
// Alternative homepage at /alt — a React port of UI/Alt-Home-Mockup/home_real.html. The real
// homepage (app/page.tsx) is untouched. The code between the "search logic" markers below is that
// page's logic copied unchanged (its long comments trimmed): category/location state, the
// structured-vs-free-text routing, the geolocation bridge, the 480px placeholder switch, the error
// outcomes. New here: the Airbnb-style field states and dropdown suggestions, the white/red search
// button, and the scattered red drawings.
import { memo, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { isPublicCategorySlug } from "../../src/category-config.js";
import { useGeolocationAddress } from "../../src/use-geolocation-address.js";
import { ResultsList, type SearchResultItem } from "../components/ResultsList.js";
import { StreamingResults } from "./StreamingResults.js";
import {
  consumeSearchStream,
  diggingMessage,
  initialStreamState,
  reduceStream,
  type StreamViewState,
} from "../../src/stream-events.js";
import styles from "./alt.module.css";

// ===== search logic: copied from app/page.tsx =====
type SearchOutcome =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "results"; results: SearchResultItem[]; category: string; anchor: string; resolvedAnchor: string }
  // New on /alt: results arriving one by one from /api/search-stream (see src/stream-events.ts).
  | { kind: "streaming"; view: StreamViewState }
  | {
      kind: "error";
      message: string;
      suggestedCategory?: string;
      reason: "validation" | "category-no-match" | "quota-denied" | "network" | "geolocation" | "server-other";
    };

const MOBILE_BREAKPOINT_QUERY = "(max-width: 480px)";
// ===== end copied block =====

// ---- drawings: shape data copied from the mockup's SVG helpers (S/C/E/G) ----
type Shape =
  | { t: "p"; d: string }
  | { t: "c"; cx: number; cy: number; r: number }
  | { t: "e"; cx: number; cy: number; rx: number; ry: number }
  | { t: "g"; transform: string; children: Shape[] };
const S = (d: string): Shape => ({ t: "p", d });
const C = (cx: number, cy: number, r: number): Shape => ({ t: "c", cx, cy, r });
const E = (cx: number, cy: number, rx: number, ry: number): Shape => ({ t: "e", cx, cy, rx, ry });
const G = (transform: string, children: Shape[]): Shape => ({ t: "g", transform, children });

// Each entry's `label` is the drawing's caption (not a place name).
const CATS: Array<{ label: string; shapes: Shape[] }> = [
  { label: "Coffee", shapes: [S("M30 50 Q56 54 84 50 L79 86 Q78 96 68 96 L46 96 Q36 96 35 86 Z"), S("M83 58 Q102 56 99 72 Q96 85 80 82"), E(58, 102, 42, 6), S("M48 38 Q42 29 49 21 Q55 14 49 7"), S("M67 38 Q61 29 68 21 Q74 14 68 7")] },
  { label: "Bakery", shapes: [S("M14 94 Q2 70 22 56 Q18 30 48 28 Q60 12 72 28 Q102 30 98 56 Q118 70 106 94 Q98 72 82 68 Q60 60 38 68 Q22 72 14 94 Z"), S("M22 56 Q32 58 36 69"), S("M48 28 Q44 46 46 63"), S("M72 28 Q76 46 74 63"), S("M98 56 Q88 58 84 69")] },
  { label: "Sushi", shapes: [G("translate(-2 24) scale(.95)", [S("M18 78 Q18 62 40 62 L64 62 Q86 62 86 78 Q86 92 64 92 L40 92 Q18 92 18 78 Z"), S("M14 66 Q40 38 90 60 Q70 76 30 72 Q18 72 14 66 Z"), S("M34 58 Q38 66 36 70 M50 54 Q54 62 52 70")]), C(92, 30, 18), C(92, 30, 8)] },
  { label: "Pizza", shapes: [S("M14 32 Q60 6 106 32 L60 110 Z"), S("M21 42 Q60 20 99 42"), C(54, 56, 8), C(76, 60, 7), C(62, 82, 6)] },
  { label: "Art Gallery", shapes: [S("M16 20 H104 V100 H16 Z"), S("M26 30 H94 V90 H26 Z"), S("M26 62 L48 40 L66 60 L78 48 L94 62"), C(78, 38, 6), S("M38 20 L60 6 L82 20")] },
  { label: "Cafe", shapes: [S("M4 40 L14 20 H106 L116 40"), S("M4 40 q8 10 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0"), S("M34 20 L26 40 M54 20 L50 40 M74 20 L74 40 M94 20 L98 40"), S("M10 44 V106 M110 44 V106 M4 106 H116"), S("M20 54 H54 V92 H20 Z"), S("M30 78 h14 l-2 10 h-10 z"), S("M68 54 H98 V106 H68 Z"), C(92, 82, 1.8)] },
  { label: "Wine Bar", shapes: [S("M38 12 Q35 52 60 58 Q85 52 82 12 Z"), S("M60 58 V102"), S("M40 108 Q60 98 80 108"), S("M37 28 Q60 36 83 28"), S("M46 40 Q47 48 52 52")] },
];
const PIN: Shape[] = [S("M60 110 C60 110 22 70 22 44 A38 38 0 0 1 98 44 C98 70 60 110 60 110 Z"), C(60, 44, 13)];
const SHAPES_BY_NAME = Object.fromEntries(CATS.map((c) => [c.label, c.shapes]));

// Suggestions: [text put in the field, drawing name]
const CATLIST: Array<[string, string]> = [
  ["coffee shops", "Coffee"],
  ["wine bars", "Wine Bar"],
  ["art experiences", "Art Gallery"],
];

// Slot positions (% of the hero) from the mockup.
const DESK: Array<[number, number]> = [[3, 4], [19, 15], [37, 3], [55, 15], [70, 3], [84, 13], [91, 30], [32, 74], [70, 71], [85, 80]];
const MOB: Array<[number, number]> = [[3, 3], [46, 2], [5, 19], [56, 19], [5, 77], [56, 79]];

function Shapes({ shapes }: { shapes: Shape[] }) {
  return (
    <>
      {shapes.map((s, i) => {
        if (s.t === "p") return <path key={i} className={styles.stroke} d={s.d} />;
        if (s.t === "c") return <circle key={i} className={styles.stroke} cx={s.cx} cy={s.cy} r={s.r} />;
        if (s.t === "e") return <ellipse key={i} className={styles.stroke} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />;
        return (
          <g key={i} transform={s.transform}>
            <Shapes shapes={s.children} />
          </g>
        );
      })}
    </>
  );
}

function Icon({ shapes }: { shapes: Shape[] }) {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <g filter="url(#altWob)">
        <Shapes shapes={shapes} />
      </g>
    </svg>
  );
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

interface PatchSpec { label: string; shapes: Shape[]; size: number; fontRem: number; rotate: number; textRotate: number; textShift: number }
interface DrawingLayout { specs: PatchSpec[]; slots: Array<[number, number]> }

// Random choices (which drawings, sizes, tilts, slot order), made on the client after mount so the
// server-rendered HTML never differs from the first client render.
function buildLayout(): DrawingLayout {
  const mobile = window.innerWidth <= 480;
  const slots = shuffle((mobile ? MOB : DESK).slice());
  const picks = shuffle(CATS.slice()).slice(0, mobile ? 5 : 7);
  const specs = picks.map((c) => ({
    label: c.label,
    shapes: c.shapes,
    size: Math.round(rnd(mobile ? 70 : 104, mobile ? 100 : 150)),
    fontRem: rnd(3, 3.8) * (mobile ? 0.75 : 1),
    rotate: Number(rnd(-14, 14).toFixed(1)),
    textRotate: Number(rnd(-8, 8).toFixed(1)),
    textShift: Math.round(rnd(-12, 12)),
  }));
  return { specs, slots };
}

type Box = { left: number; right: number; top: number; bottom: number };
const hit = (a: Box, b: Box, m: number) => !(a.right + m < b.left || a.left - m > b.right || a.bottom + m < b.top || a.top - m > b.bottom);

// Placement pass, ported from the mockup: try each slot (with jitter), clamp inside the screen
// edges, and accept the first spot that clears the headline + search bar and earlier drawings.
function placeDrawings(hero: HTMLElement, headline: HTMLElement, row: HTMLElement, nodes: HTMLDivElement[], slots: Array<[number, number]>) {
  const a = headline.getBoundingClientRect();
  const b = row.getBoundingClientRect();
  const cr: Box = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: a.top, bottom: b.bottom };
  const placed: Box[] = [];
  let slotI = 0;
  for (const d of nodes) {
    const H = hero.clientHeight;
    const W = hero.clientWidth;
    let ok = false;
    let r: DOMRect = d.getBoundingClientRect();
    for (let k = 0; k < slots.length && !ok; k++) {
      const s = slots[(slotI + k) % slots.length];
      d.style.left = Math.max(2, s[0] + rnd(-3, 3)) + "%";
      d.style.top = s[1] + rnd(-2.5, 2.5) + "%";
      r = d.getBoundingClientRect();
      if (r.bottom > H - 14) d.style.top = d.offsetTop - (r.bottom - H + 14) + "px";
      if (r.right > W - 14) d.style.left = d.offsetLeft - (r.right - W + 14) + "px";
      if (r.left < 10) d.style.left = d.offsetLeft + 10 - r.left + "px";
      if (r.top < 10) d.style.top = d.offsetTop + 10 - r.top + "px";
      r = d.getBoundingClientRect();
      ok = !hit(r, cr, 10) && !placed.some((p) => hit(r, p, 8));
    }
    placed.push(r);
    slotI++;
    d.setAttribute("data-placed", "1");
  }
}

const ScatteredDrawings = memo(function ScatteredDrawings({
  heroRef,
  headlineRef,
  rowRef,
  hidden,
}: {
  heroRef: RefObject<HTMLElement | null>;
  headlineRef: RefObject<HTMLElement | null>;
  rowRef: RefObject<HTMLElement | null>;
  hidden: boolean;
}) {
  const [layout, setLayout] = useState<DrawingLayout | null>(null);
  const nodes = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    setLayout(buildLayout());
  }, []);

  useEffect(() => {
    if (!layout) return;
    let cancelled = false;
    const run = () => {
      const hero = heroRef.current, headline = headlineRef.current, row = rowRef.current;
      if (cancelled || !hero || !headline || !row) return;
      placeDrawings(hero, headline, row, nodes.current.filter((n): n is HTMLDivElement => !!n), layout.slots);
    };
    // Wait for the handwritten font so the title widths are measured correctly.
    if (document.fonts?.ready) document.fonts.ready.then(run);
    else run();
    return () => {
      cancelled = true;
    };
  }, [layout, heroRef, headlineRef, rowRef]);

  if (!layout) return null;
  return (
    <>
      {layout.specs.map((p, i) => (
        <div
          key={p.label}
          ref={(el) => {
            nodes.current[i] = el;
          }}
          className={`${styles.patch} ${hidden ? styles.patchHidden : ""}`}
          style={{ transform: `rotate(${p.rotate}deg)` }}
        >
          <svg width={p.size} height={p.size} viewBox="0 0 120 120" role="img" aria-label={p.label}>
            <g filter="url(#altWob)">
              <Shapes shapes={p.shapes} />
            </g>
          </svg>
          <span style={{ fontSize: `${p.fontRem.toFixed(2)}rem`, transform: `rotate(${p.textRotate}deg) translateX(${p.textShift}px)` }}>{p.label}</span>
        </div>
      ))}
    </>
  );
});

type FieldKey = "cat" | "loc";

export default function AltHomePage() {
  // ===== search logic: copied from app/page.tsx =====
  const [categoryText, setCategoryText] = useState("");
  const [locationText, setLocationText] = useState("");
  const [outcome, setOutcome] = useState<SearchOutcome>({ kind: "idle" });
  const { state: geoState, requestLocation } = useGeolocationAddress();
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    setIsMobileViewport(mql.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);
  const pendingCategoryRef = useRef<string | null>(null);

  async function runSearch(category: string, location: string) {
    setOutcome({ kind: "loading" });
    const normalizedCategory = category.trim().toLowerCase();
    const useStructured = isPublicCategorySlug(normalizedCategory);

    try {
      // One streaming endpoint takes both forms: { category, anchor } or { query }.
      const res = await fetch("/api/search-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          useStructured ? { category: normalizedCategory, anchor: location } : { query: `${category} near ${location}`.trim() }
        ),
      });

      if (!res.ok) {
        // Request-level problems arrive as a plain JSON error with the same status codes as before.
        const body = await res.json();
        const reason: "category-no-match" | "quota-denied" | "server-other" =
          res.status === 422 ? "category-no-match" : res.status === 503 ? "quota-denied" : "server-other";
        setOutcome({
          kind: "error",
          message: body.error ?? `Search failed (real HTTP ${res.status}).`,
          suggestedCategory: body.suggestedCategory,
          reason,
        });
        return;
      }

      // Cards are shown as their events arrive; if the connection closes early, the cards stay.
      let view = initialStreamState();
      await consumeSearchStream(res, (event) => {
        view = reduceStream(view, event);
        if (view.phase === "error" && view.cards.length === 0 && view.error) {
          const status = view.error.status;
          setOutcome({
            kind: "error",
            message: view.error.message,
            suggestedCategory: view.error.suggestedCategory,
            reason: status === 0 ? "network" : status === 422 ? "category-no-match" : status === 503 ? "quota-denied" : "server-other",
          });
        } else {
          setOutcome({ kind: "streaming", view });
        }
      });
    } catch {
      setOutcome({
        kind: "error",
        message: "Real network error — could not reach the search API.",
        reason: "network",
      });
    }
  }

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

    // Real "location empty" case — the already-built, already-tested geolocation hook.
    pendingCategoryRef.current = categoryText;
    requestLocation();
  }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoState]);

  const isStreamingNow = outcome.kind === "streaming" && (outcome.view.phase === "waiting" || outcome.view.phase === "streaming");
  const isBusy = outcome.kind === "loading" || isStreamingNow || geoState.status === "requesting" || geoState.status === "resolving";
  const isCategoryError = outcome.kind === "error" && outcome.reason === "category-no-match";

  let plainMessage: string | null = null;
  if (geoState.status === "requesting") plainMessage = "Requesting real browser location permission…";
  else if (geoState.status === "resolving") plainMessage = "Got real coordinates — resolving a real address…";
  else if (outcome.kind === "loading") plainMessage = "digging…";
  else if (outcome.kind === "streaming") plainMessage = diggingMessage(outcome.view);
  else if (outcome.kind === "error" && !isCategoryError) plainMessage = outcome.message;
  // ===== end copied block =====

  // ---- new: field states and dropdown ----
  const [activeField, setActiveField] = useState<FieldKey | null>(null);
  const heroRef = useRef<HTMLElement | null>(null);
  const headlineRef = useRef<HTMLHeadingElement | null>(null);
  const rowRef = useRef<HTMLFormElement | null>(null);
  const catInputRef = useRef<HTMLInputElement | null>(null);
  const locInputRef = useRef<HTMLInputElement | null>(null);
  const inputRefs = { cat: catInputRef, loc: locInputRef };

  function openField(k: FieldKey) {
    if (isBusy) return;
    setActiveField(k);
  }

  // Escape, or a click outside the search row, closes the dropdown. The isConnected check matters:
  // picking a suggestion re-renders and removes the clicked node before this listener runs.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (t.isConnected && rowRef.current && !rowRef.current.contains(t)) setActiveField(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveField(null);
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function onFieldClick(k: FieldKey, e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("[data-panel]")) return;
    openField(k);
    inputRefs[k].current?.focus();
  }

  function pickCategory(value: string) {
    setCategoryText(value);
    openField("loc");
    locInputRef.current?.focus();
  }

  function pickNearby() {
    setLocationText(""); // stays blank, so the existing geolocation path runs on submit
    setActiveField(null);
    locInputRef.current?.blur();
  }

  const typed = categoryText.trim().toLowerCase();
  const suggestions = CATLIST.filter(([text]) => !typed || text.includes(typed));
  const open = activeField !== null;
  const errorInput = isCategoryError ? styles.fieldInputError : "";

  return (
    <>
      <main ref={heroRef} className={styles.page}>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <filter id="altWob" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="3" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="3" />
          </filter>
        </svg>

        <img
          src={isCategoryError ? "/images/IMG_7993.JPG" : "/images/hills.jpg"}
          alt=""
          className={`${styles.bgImage} ${isCategoryError ? styles.bgImageError : ""}`}
        />
        <div className={`${styles.scrim} ${isCategoryError ? styles.scrimError : ""}`} />
        <div className={styles.overlayBlack} />

        <h1 ref={headlineRef} className={`${styles.headline} ${isCategoryError ? styles.headlineError : ""}`}>
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
        </h1>

        <form
          ref={rowRef}
          className={`${styles.searchRow} ${open ? styles.open : ""}`}
          onSubmit={(e) => {
            setActiveField(null);
            handleSubmit(e);
          }}
        >
          <div className={`${styles.searchBar} ${open ? styles.open : ""}`}>
            <div className={`${styles.field} ${activeField === "cat" ? styles.active : ""}`} onClick={(e) => onFieldClick("cat", e)}>
              <input
                ref={catInputRef}
                type="text"
                className={`${styles.fieldInput} ${errorInput}`}
                placeholder={isMobileViewport ? "looking for" : "type what you're looking for"}
                value={categoryText}
                onChange={(e) => setCategoryText(e.target.value)}
                onFocus={() => openField("cat")}
                disabled={isBusy}
                autoComplete="off"
                aria-label="Category (coffee, wine, or art)"
                aria-expanded={activeField === "cat"}
              />
              {activeField === "cat" && (
                <div className={styles.panel} data-panel role="listbox">
                  <h3>Suggested</h3>
                  {suggestions.length ? (
                    suggestions.map(([text, drawing]) => (
                      <button key={text} type="button" role="option" aria-selected={false} className={styles.opt} onClick={() => pickCategory(text)}>
                        <span className={styles.tile}>
                          <Icon shapes={SHAPES_BY_NAME[drawing]} />
                        </span>
                        <span>{text}</span>
                      </button>
                    ))
                  ) : (
                    <p className={styles.none}>No suggestion, press search to try it.</p>
                  )}
                </div>
              )}
            </div>
            <div className={styles.divider} />
            <div className={`${styles.field} ${activeField === "loc" ? styles.active : ""}`} onClick={(e) => onFieldClick("loc", e)}>
              <input
                ref={locInputRef}
                type="text"
                className={`${styles.fieldInput} ${errorInput}`}
                placeholder="add location"
                value={locationText}
                onChange={(e) => setLocationText(e.target.value)}
                onFocus={() => openField("loc")}
                disabled={isBusy}
                autoComplete="off"
                aria-label="Location (leave blank to use your current location)"
                aria-expanded={activeField === "loc"}
              />
              {activeField === "loc" && (
                <div className={styles.panel} data-panel role="listbox">
                  <h3>Suggested</h3>
                  <button type="button" role="option" aria-selected={false} className={styles.opt} onClick={pickNearby}>
                    <span className={styles.tile}>
                      <Icon shapes={PIN} />
                    </span>
                    <span>
                      nearby<small>use your current location</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button type="submit" className={styles.goBtn} aria-label="search" disabled={isBusy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>search</span>
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

        <ScatteredDrawings heroRef={heroRef} headlineRef={headlineRef} rowRef={rowRef} hidden={isCategoryError} />
      </main>

      {outcome.kind === "streaming" && (
        <StreamingResults
          view={outcome.view}
          classes={{ resultsArea: styles.resultsArea, stillDigging: styles.stillDigging, notice: styles.streamNotice }}
        />
      )}

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
