// Results area for the progressive search on /alt. Purely presentational: it renders the view state
// built by src/stream-events.ts, so each card appears as soon as its event arrived, in arrival order
// (the cards array is rendered as given, never sorted). CSS class names come in as a prop so this file
// has no stylesheet import and can be rendered in a plain Node test.
import { ResultsList } from "../components/ResultsList.js";
import { stillDiggingHint, streamNotice, type StreamViewState } from "../../src/stream-events.js";

export interface StreamingResultsClasses {
  resultsArea?: string;
  stillDigging?: string;
  notice?: string;
}

export function StreamingResults({ view, classes = {} }: { view: StreamViewState; classes?: StreamingResultsClasses }) {
  // Nothing to show until the first card, unless the search finished with no results.
  if (view.cards.length === 0 && view.phase !== "done") return null;

  const hint = stillDiggingHint(view);
  const notice = streamNotice(view);
  const finished = view.phase !== "streaming";

  return (
    <div className={classes.resultsArea} data-phase={view.phase}>
      <p>
        Real category: {view.category} — real anchor: {view.anchor} — {view.cards.length} result(s){finished ? "." : " so far."}
      </p>
      {view.resolvedAnchor && <p>Searching near: {view.resolvedAnchor}</p>}
      <ResultsList results={view.cards} />
      {hint && <p className={classes.stillDigging}>{hint}</p>}
      {notice && <p className={classes.notice}>{notice}</p>}
    </div>
  );
}
