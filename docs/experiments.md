# Key experiments

Each experiment: **question → method → result.** Labels: **MEASURED** = counted in a logged test run. **STATED** = my own experience, not a controlled test.

The private experiment log runs to Task 110 (MEASURED). Logged entries start at Task 19. The scripts behind these experiments used real places, so they are summarized here, not copied.

---

## Can quoted review evidence be trusted? (v1 citation check)

- **Question.** When the model quotes a review as evidence, is the quote real?
- **Method.** A second step checked every quoted phrase against the real review text. The same 20 candidates were run 3 times with an identical prompt and identical source data.
- **Result.** Unverified quotes in 25%, 25% and 30% of results (MEASURED). Prompt hardening between runs didn't make the rate converge. One coffee place got an identical invented detail in independent runs, which pointed to the model's training data, not to the source.
- **What changed.** Verification became the safeguard, not prompt wording. Later, in the rebuild, quotes were removed entirely (next experiment).

## Do grounded citations carry review text?

- **Question.** After moving to Gemini with Grounding with Google Maps, can a quote still be checked against a review?
- **Method.** Inspect every grounded citation from a live wine-bar comparison run.
- **Result.** 0 of 92 grounded citations carried review-level text (MEASURED). Citations point to places, not reviews.
- **What changed.** Paraphrase-only evidence (decision 3).

## Does the paraphrase-only rule hold?

- **Question.** With quotation marks banned in the scoring prompt, does the model still present text as quotes?
- **Method.** Full pipeline reruns and direct checks on known places. Every evidence and caveat text was checked by hand.
- **Result.** 0 quotation marks across 14 live calls (MEASURED).

## Why does the scoring call fail intermittently? (Tasks 37–43)

- **Question.** After a speed change, the scoring call sometimes came back incomplete. What is the real cause?
- **Method.** Repeat identical calls to measure the failure rate. Remove one suspect at a time. Finish with a 2×2 test: prompt structure × output-token cap.
- **Result.** 3 of 8 identical calls failed (37.5%). Removing the JSON format alone made it worse. The 2×2 test showed the cause was the output cap: on grounded calls, the cap covers the model's internal reasoning *and* its answer. Raising it from 500 to 4000 gave 0 failures in 23 calls (MEASURED).

## How much faster and cheaper can scoring get? (Task 34)

- **Question.** Which speed changes are safe for the scoring step?
- **Method.** Apply a recommended sequence of changes cumulatively, on known places, and check that the known results stay correct.
- **Result.** Three changes together (parallel calls, low thinking, compact JSON output) measured ~5x faster and ~68% cheaper (MEASURED). Switching to a smaller model as well produced a false negative on a known-good place, so it was rejected.
- **Later.** Compact JSON was dropped after the investigation above, so today's pipeline keeps the parallel calls and low thinking, not the full measured gain.

## Does the taste profile change the outcome, or only the wording?

- **Question.** Is Gemini with Grounding plus a written taste profile better than the v1 pipeline, and is it compliant?
- **Method.** A three-way comparison for wine bars in one neighborhood: a plain run, a Grounding run with the taste profile, and the v1 pipeline.
- **Result.** The taste-profile run excluded places by name for lacking natural-wine evidence. This was the directional basis for the compliance rebuild.

## Does the result count mean anything?

- **Question.** If Grounding returns fewer places, does that signal real scarcity?
- **Method.** Same location and profile; change only the closing instruction, from asking for a fixed number of places to "fewer is correct if honest". Then repeat the honest version several times.
- **Result.** Asking for a fixed number made the model pad the list. The honest instruction returned far fewer places, but the count was not stable across repeat runs. One honest call is not reliable evidence of scarcity (logged result).

## Can the engine judge a whole destination? (Tasks 100–103)

- **Question.** Can facts that Google has, or a score against my criteria, separate destinations I liked from destinations I would not choose again?
- **Method.** Expectations and pass rules written down before any paid call (pre-registered in Tasks 102 and 103). Structured counts from the Places API and scores from the production scorer.
- **Result.** In Tasks 102 and 103, no attribute and no score separated liked from not-liked places (MEASURED). An earlier test (Task 100) separated one known negative, but only because the test description included a rule the AI had inferred and I don’t hold (“a railway between village and sea is bad”). I corrected it. A follow-up (Task 101) showed that the same description still rejected beaches in a place I liked in 6 of 12 runs (MEASURED, Task 101), even without that sentence. So that one positive result doesn’t generalize.
- **What changed.** I stopped spending on it (decision 8).

## Wiring a new category end to end (Task 110)

- **Question.** Does pizza, wired into the live search path, behave as the validated experiment did?
- **Method.** Expectations written down before the run; then one real run through the full pipeline.
- **Result.** The wired path matched the pre-registered expectations (logged result). A stub-only check, `scripts/verify-pizza-wiring.ts`, is in this repo.
