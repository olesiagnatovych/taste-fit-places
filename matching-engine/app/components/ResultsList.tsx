// Real, plain, unstyled results display (2026-09-24) — deliberately no styling/design system,
// per direct instruction: this exists to unblock real use of the search pipeline
// right now, while real UI/design work happens separately (see the private development log, this task's entry —
// the two real mockup files this would eventually use don't currently exist in this repo, a
// real gap flagged in last night's launch-readiness audit, not referenced or waited on here).
//
// Renders the EXACT real /api/search + /api/search-query response shape
// (search-request-handler.ts:121-137) — not a redesigned/re-shaped subset. `SearchResultItem`
// below is a plain, local type matching that real shape (not imported from
// search-request-handler.ts, which pulls in server-only modules — quota-gate.ts/db.ts/
// email.ts — that must never reach the client bundle).
export interface SearchResultItem {
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

export function ResultsList({ results }: { results: SearchResultItem[] }) {
  if (results.length === 0) {
    return <p>No real results.</p>;
  }

  return (
    <ol>
      {results.map((r, i) => (
        <li key={`${r.name}-${i}`} style={{ marginBottom: "1.25rem" }}>
          <div>name: {r.name}</div>
          <div>address: {r.address ?? "(none)"}</div>
          <div>typeDisplayName: {r.typeDisplayName ?? "(none)"}</div>
          <div>distanceMiles: {r.distanceMiles ?? "(not computed)"}</div>
          <div>rating: {r.rating}</div>
          <div>
            priceRange: {r.priceRange ? `$${r.priceRange.startPrice}-$${r.priceRange.endPrice}` : "(none)"}
          </div>
          <div>
            mapsLink: <a href={r.mapsLink} target="_blank" rel="noreferrer">{r.mapsLink}</a>
          </div>
          <div>verdict: {r.unverified ? "(unverified — real API call didn't complete)" : r.verdict ?? "(none)"}</div>
          <div>heartCount: {r.heartCount ?? "(none)"}</div>
          <div>evidence: {r.evidence.length > 0 ? r.evidence.join(" | ") : "(none)"}</div>
          <div>caveat: {r.caveat ?? "(none)"}</div>
        </li>
      ))}
    </ol>
  );
}
