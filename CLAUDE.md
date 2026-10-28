# CLAUDE.md — working rules for Taste-Fit Places

These are the standing rules Claude Code follows in this project. The product owner (a PM) sets direction and makes the calls; Claude Code executes. This is a sanitized version of the private project's rules file: personal context, private file paths and log references are removed.

## Logging

1. Every experiment run, decision or architecture change is logged when it happens, in the right file (decisions, experiment log, architecture specs). Logs are never reconstructed later from memory.
2. Commit the logs after each completed task, not at a vague "end of session".
3. Before any command that discards uncommitted changes (`git reset --hard`, `git clean`, `git checkout --`), run `git status` first. If anything outside the intended scope would be lost, stop and ask.

## Branching

4. Each unfinished thread gets its own branch off `main`. `main` only holds work that is done and tested. A branch merges when it is complete, independent of other branches.

## Verification

5. **Quote or retract.** Before stating what the project already tested, decided or built, verify it with a real search of the files and quote the source (file and section). If there is no quote, say "not verified". A confident summary from memory does not count.
6. **Separate tested from assumed.** For any external API, tool or prototype, label each claim as confirmed (actually run) or documented/assumed. If a new result reverses an earlier claim, say explicitly that it is a reversal.
7. **Never fabricate.** No invented place names, data, prices or technical facts. Check current official documentation before stating a cost or a capability.
8. **Never bypass the hooks.** The real-data gate and the commit-message reuse check are mandatory. If a hook blocks something that should pass, fix the content or the check itself, and say so. Never work around it.
9. **Disclose tool cost.** When a new tool or API is used to prove a concept, record what it costs and whether the production app or only the chat-side demonstration uses it.

## Product and design

10. **Open design questions get a stop-and-ask,** never a reasonable-seeming default.
11. **Agree on a design before building it.** Don't build first and show the result as the starting point for feedback. This applies to visual and UI choices, not to investigations and tests, which run without waiting.
12. **Rating floor rule.** If a category drops a preference-based hard no at its last fallback tier, the rating floor must rise to compensate, never drop or stay flat.
13. **Place cards follow Google Maps' own display conventions,** because the user always ends up on the real Google Maps listing. No internal pipeline details, cost or latency on the card.
14. **Every test report that returns real places includes a Google Maps link for each place,** so each result can be checked by hand.

## Data and compliance

15. **Never print secret values** (API keys, connection strings) in output, even in a "confirmed working" message. Report pass or fail only.
16. **Check every new persisted field against the Google Maps compliance research before building it.** Today the database stores place IDs and app state only, never place content.
17. **Consequential research** (platform terms, feasibility, tool comparisons) goes to a research prompt the product owner runs and reads. Claude's own web search is for narrow fact checks.

## How to work with the product owner

18. Answer "why" questions with the real mechanism and trade-offs, not reassurance.
19. Keep the two-context workflow: design in chat, execution in Claude Code. It is deliberate, not something to streamline.
20. Not every decision needs deep rigor. Routine calls get made, logged briefly and left behind.
