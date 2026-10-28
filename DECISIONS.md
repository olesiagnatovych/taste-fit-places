# Decisions

The main product and technical calls behind Taste-Fit Places. Each one follows the same shape: **context → options → call → trade-off → evidence.**

Labels: **MEASURED** = counted in a logged test run. **STATED** = my own experience or judgment, not a controlled test. Task numbers refer to the private experiment log, which is summarized in [docs/experiments.md](docs/experiments.md).

---

## 1. Rank by taste fit, not by popularity

**Context.** Ratings and review counts measure what most people like. What I look for (natural wine, relaxed and human service, places without marketing) is often rated down by the same crowd. A place can have a lower rating *because* it doesn't try to please everyone.

**Options.**
- Sort by rating and review count, like a normal map search.
- Use ratings only as a floor, and judge fit against an explicit taste profile.

**Call.** Ratings are a floor only (4.0 for food categories). Above the floor, the only ranking signal is fit with a written taste profile per category: a clear fit first, then a possible fit.

**Trade-off.** A taste profile has to be written and kept up to date. That is real work, and it only covers the categories I have written profiles for (5 today).

**Evidence.** 40% more fitting places than my manual search (2 new on top of 5), Lower East Side, my own check on 2026-10-28 (STATED).

---

## 2. Compliance rebuild: Places API (New) + Gemini with Grounding

**Context.** Version 1 fetched review text from the Places API and ran it through my own rules and a Claude-based scoring step. Google's terms restrict creating new content from Google Maps content. Grounding with Google Maps (through Gemini) is Google's named exception, on the condition that its citations are shown and its output is not changed. There is no special exception for a solo, personal, non-commercial user.

**Options.**
- Keep the v1 pipeline and accept low confidence that it complies with Google's terms.
- Rebuild: Places API (New) for structured fields only, and Gemini with Grounding for every judgment that needs reviews.

**Call.** Rebuild. The app requests no review text, and the database stores no Google place content, only place IDs. Rating and price filters moved into the Places API request itself, so Google's own server applies them.

**Trade-off.** I gave up direct access to review text, so I can no longer check a model's claims word for word (see decision 3). I also depend on how Grounding retrieves and summarizes, which I can't fully see.

**Evidence.** In the first three-way comparison (wine bars), the Grounding run changed the outcome itself, not only the wording. It excluded places by name because they lacked natural-wine evidence (logged comparison). The architecture section in [docs/architecture.md](docs/architecture.md) shows what is stored and what is not.

---

## 3. Removing review quotes

**Context.** v1 showed review quotes as evidence for each match. A separate check compared every quote with the real review text. It flagged unverified quotes in 25%, 25% and 30% of results, across 3 runs on the same 20 candidates (MEASURED). The rate didn't improve after hardening the prompt, so this was a property of generation, not one bad prompt.

After the rebuild, Grounding returns citations to places, not to reviews: 0 of 92 grounded citations carried review-level text (MEASURED). So a quote can no longer be verified at all.

**Options.**
- Keep showing quotes and trust them.
- Show no evidence at all.
- Paraphrase only: short observations in the model's own words, cited to the place.

**Call.** Paraphrase only, never in quotation marks. Each result card links to the place in Google Maps, and the final call stays with the user there.

**Trade-off.** An invented quote is dangerous in both directions. It can create a false positive (overrating a place) or a false negative (burying a place that really fits). A paraphrase is less vivid than a quote, and I accept that, because a paraphrase doesn't claim to be something it isn't.

**Evidence.** 0 quotation marks across 14 live calls after the paraphrase-only rule (MEASURED).

---

## 4. Keeping the no-outside-knowledge rule

**Context.** In v1, a model repeated the same specific, confident detail about one coffee place across independent runs. That detail was not in the source text. It came from the model's training data. I considered allowing outside knowledge, because true information is true information.

**Options.**
- Allow the model to use what it already knows about a place.
- Keep the rule: every claim must come from the source given to the model.

**Call.** Keep the rule. From the output alone, there is no way to tell "true and from training" from "false and invented". Both read as equally confident. Allowing outside knowledge wouldn't add "real facts, sometimes"; it would add unverifiable claims, every time. If more detail is needed, the right way is to add a real, checkable source (for example, a business's own website). That idea is logged, not built.

**Trade-off.** Some places get thinner evidence than the model could produce.

**Evidence.** The repeated fabrication above, and the 25% / 25% / 30% citation-check results (MEASURED). In the rebuild, the same idea carries over as an evidence rule in the scoring prompt: missing evidence counts as insufficient, never as support.

---

## 5. Root cause over a quick fix: the token-cap investigation

**Context.** After a speed change, the scoring call failed on 3 of 8 identical repeat calls (37.5%, MEASURED). Failed calls came back silently incomplete. Two causes looked guilty and were both live: a "low thinking" setting and a strict JSON output format.

**Options.**
- Remove the most likely cause and move on.
- Isolate each variable in a controlled test until one cause is proven.

**Call.** Isolate. I said at the time: "I can't build new architecture on a flimsy base." Removing the JSON format first did not fix it, and failures got worse. A clean 2×2 test (prompt structure × output cap) cleared both suspects. The real cause was an output-token cap of 500. On grounded calls, it covered the model's internal reasoning *and* its answer, so the model ran out of budget before it could answer. The fix was one number: 500 → 4000.

**Trade-off.** More test runs and more days before moving on. The quick fix would have looked like it worked some of the time, and the real cause would have stayed hidden.

**Evidence.** Model failures 37.5% (3 of 8) → 0 of 23 after the token-cap fix (MEASURED).

A related trade-off: an earlier experiment measured ~5x faster and ~68% cheaper scoring from three changes (parallel calls, low thinking, compact JSON output) (MEASURED, Task 34). Compact JSON was later dropped because it carried this reliability risk, so today's pipeline does not have the full gain. I took a slightly slower search over a real chance of a search silently returning too few results. The app replaces hours of manual research, so a short wait is a trade I take every time.

---

## 6. "If it's not explicitly prohibited, we don't touch it. If Google requires, we act."

**Context.** One question had no clear answer in Google's published terms: does hiding non-matching results from the screen count as changing content Google says should be displayed as returned? I checked it against the actual terms and found no yes or no.

**Options.**
- Assume the worst and redesign the results screen defensively.
- Ignore the question.
- Make an explicit, logged risk call.

**Call.** Make the risk call in my own words: "if it's not prohibited explicitly, we don't touch it. If Google requires, we act." It is written down with its reasoning, so it can be reversed quickly if Google's position changes.

**Trade-off.** I accept some platform risk to keep a usable product. If Google rules against this, the results screen has to change.

**Evidence.** The question was researched against the published terms and logged as unresolved (STATED). The decision is not a default that happened by not thinking about it.

---

## 7. Removing the Koh Tao region rule: kill the implementation, keep the idea

**Context.** I had a working, tested pizza rule that was strict in the US and Europe but allowed thick dough in Asia. It was based on one pizzeria I remembered loving on Koh Tao, Thailand. Later I realized the place had likely changed and no longer represented what I remembered.

**Options.**
- Keep the rule, since it was already built and tested.
- Remove the whole mechanism.

**Call.** Remove it. Thick dough is now one uniform "possible fit, with a caveat" everywhere. The general idea, that taste rules can depend on region, is logged as a real future feature, waiting for current evidence to build it on.

**Trade-off.** The built work is thrown away. That was a sunk cost; keeping a rule on evidence I no longer trusted would have been worse.

**Evidence.** The only grounding for the rule was one remembered place (STATED). One weak example is not enough to keep a rule that changes results for a whole region.

---

## 8. Knowing where the model stops

**Context.** I tested whether the engine could go beyond single places. Could facts that Google has, or a score against my criteria, separate destinations I liked from destinations I would not choose again? I wrote each test's expectations before running it.

**Options.**
- Keep spending to tune criteria and descriptions until the scores separate.
- Accept the result and keep the engine to what it does reliably.

**Call.** I stopped spending on it. The engine shortlists; I judge the feel.

**Trade-off.** No "find me a whole destination" feature for now.

**Evidence.** Two pre-registered tests (Tasks 102 and 103): no attribute and no score separated liked from not-liked places (MEASURED). An earlier test (Task 100) separated one known negative, but only because the test description included a rule the AI had inferred and I don’t hold (“a railway between village and sea is bad”). I corrected it. A follow-up (Task 101) showed that the same description still rejected beaches in a place I liked in 6 of 12 runs (MEASURED, Task 101), even without that sentence. So that one positive result doesn’t generalize.

---

## 9. Spend protection: my own app is the primary limit

**Context.** Every search makes paid calls to Google: Gemini with Grounding and the Places API. Google Cloud budget alerts are only alerts, not a hard cutoff. A public search box with no limit can produce a real bill.

**Options.**
- Rely on Google Cloud budget alerts.
- Build limits into the app itself.

**Call.** The app is the primary limit:
- A reservation gate checks the monthly spend before a search starts.
- There are daily and concurrent-search caps and input-length caps.
- Failed searches are still recorded.
- One alert fires when spend reaches the threshold, and new searches are denied until I raise it.
- Each paid call has its own timeout, and no new paid call starts after a 100-second request deadline.
- Request cancellation stays off. If the user closes the page, the server still records what was spent and releases the reservation.

**Trade-off.** More code and a database for one user. Cancellation stays off, so an abandoned search still finishes its calls already in flight.

**Evidence.** Built and tested locally with stubs and a fake clock; not deployed. Whether Google bills a request that was aborted mid-flight is unknown, so the app counts it as spent.
