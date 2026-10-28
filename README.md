# Taste-Fit Places

**An AI recommender that finds places that fit my taste, not the crowd's ratings.**

Code written with Claude Code; I set direction, designed the experiments and made the calls.

Demo on request.

---

## The problem

Google's "good place" isn't mine, and mine isn't the crowd's.

I look for natural wine (cloudy, funky, sometimes "weird") and for relaxed, human service, where the staff are themselves and nobody performs. Many people rate exactly these things down. Ratings and review counts push niche places below popular, well-marketed ones. So the places I want are often the hardest ones to find.

Before this app, I solved it by hand. I read reviews, looked at photos and cross-checked lists, for every trip and every new neighborhood.

## Two user goals

1. **Time to value.** Get to a place that fits in minutes, not after an evening of research.
2. **Discovery.** Surface places that a normal search doesn't show.

The full user problem is in [docs/user-problem.md](docs/user-problem.md).

## Results

| What | Result | Label |
|---|---|---|
| Time to find a place that fits | 30 → 5–10 minutes | STATED, my own use |
| Discovery | 40% more fitting places than my manual search (2 new on top of 5), Lower East Side, my own check on 2026-10-28 | STATED |
| Model failures on the scoring call | 37.5% (3 of 8) → 0 of 23 after the root-cause fix | MEASURED |
| Review quotes after the paraphrase-only rule | 0 quotation marks across 14 live calls | MEASURED |
| Categories in the search path | 5: coffee, wine, art, sushi, pizza | — |

**MEASURED** = counted in a logged test run. **STATED** = my own experience, not a controlled test.

## How it works

Two Google services do the work. **Grounding with Google Maps** means Gemini answers using Google Maps data and cites the places it used. **Places API (New)** is Google's structured place data: name, rating, price, opening hours.

1. **Find.** Gemini, with Grounding with Google Maps, suggests real places near the location for the category.
2. **Check.** Places API (New) looks up each place. For food categories, Google's own server drops places rated below 4.0 and the most expensive price tier. The app requests no review text and stores no Google place content, only place IDs.
3. **Judge.** Gemini, with Grounding, scores each place against my taste profile for that category: a clear fit, a possible fit, or not a fit. Each fit comes with a short reason in its own words.
4. **Decide.** Each result card links to the place in Google Maps. The final call stays with me.

Diagram and details: [docs/architecture.md](docs/architecture.md).

There are two home pages. `/` is the main home page. `/alt` is an alternative design that streams results one by one as they are scored.

## The trust decision: why review quotes were removed

The first version showed review quotes as evidence, and a separate check verified every quote against the real review text. That check flagged unverified quotes in 25%, 25% and 30% of results, across 3 runs on the same 20 candidates (MEASURED).

The compliance rebuild then moved scoring to Grounding with Google Maps. Grounding cites places, not reviews: 0 of 92 grounded citations carried review-level text (MEASURED). So a quote can no longer be checked. An invented quote can make a place look like a better fit than it is, or bury a place that really fits. So the app paraphrases only, and the final call stays with me in Google Maps.

Full reasoning: [DECISIONS.md](DECISIONS.md).

## Decisions and experiments

- [DECISIONS.md](DECISIONS.md): the main product and technical calls, each with the options, the trade-off and the evidence.
- [docs/experiments.md](docs/experiments.md): the key experiments, each as question → method → result.

## How I build with AI

I keep design and execution in separate contexts: a chat for design, Claude Code for execution. Hooks verify claims before they get written down, and the logs are the source of truth, not memory. Details: [docs/how-i-build-with-ai.md](docs/how-i-build-with-ai.md).

## Process scale

- 198 commits since 2026-07-23, as of 2026-10-27 (MEASURED, private development repo).
- The experiment log runs to Task 110 (MEASURED). Logged entries start at Task 19.

This public repo is a clean copy with new history. The private repo's logs contain real place data and personal context, so they are summarized here, not copied.

## Status and what's next

- **Working locally:** the search path for all 5 categories, both home pages, spend protection (built and tested locally, not deployed).
- **Known issue:** a test for an older fallback design (`npm run test:orchestrator`) fails. Rating filtering moved to Google's server, so this code path no longer works. Nothing in the live search path uses it.
- **Proposed, not built:** cold start, meaning how a new user without my years of saved places gets a taste profile.

## Run it locally

```bash
cd matching-engine
cp .env.example .env   # add your own keys
npm install
npm run dev
```

You need your own Google Places API and Gemini API keys. The search routes also need a Postgres database for spend protection (`DATABASE_URL`; schema in [`schema/schema.sql`](schema/schema.sql) at the repo root, which is `../schema/schema.sql` from `matching-engine/`).

## What is not in this repo

- The admin page and its login (they are part of spend protection in the private build).
- My Google Maps lists, raw experiment scripts and logs. They contain real places and personal context.
- Any Google Places content. Sample data in tests is invented and marked as fake.

## Credits

The handwritten font is drawn from handwriting by my son.
