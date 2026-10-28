# How I build with AI

I am a product manager, not an engineer. Claude Code writes the code. I set direction, design the experiments and make the calls. This page describes the working system around that: how work is split, how claims get checked, and where the truth lives.

## 1. Two separate contexts: design and execution

- **Design** happens in a chat: the problem, options, trade-offs, research prompts, experiment design.
- **Execution** happens in Claude Code: code, test runs and logging.

I could merge them into one conversation, and I chose not to. Keeping them separate creates a checkpoint. When Claude Code hits real ambiguity, it stops and asks, instead of the question getting smoothed over inside one long conversation. One concrete example: a fallback threshold (when exactly the fallback should start) surfaced as an open question because the execution context had to stop and ask. I would make an exception for a hard deadline. The separation is a trade-off, not a rule for its own sake.

## 2. Verification is built in, not promised

"I'll be more careful" is not a fix. Each repeated failure got a mechanism that runs automatically:

| Mechanism | What it blocks | Why it exists |
|---|---|---|
| Real-data gate (`matching-engine/scripts/hooks/pre-commit`, `validate-real-data.js`) | A UI or prototype file with place names that can't be confirmed as real places via the Places API | Claude once put invented place names and list names into a prototype, and I caught it, not the process. |
| Commit-message reuse check (`prepare-commit-msg`, `check-commit-msg.js`) | A commit message that is 90% or more similar to one of the last 10 | Old commit messages were reused for new, different changes, more than once. |
| Decision-attribution hook (`.claude/hooks/verify-decision-attribution.py`) | Writing reasoning into the decision log as "her reasoning" without a verbatim quote or an explicit `[inferred]` tag | A decision log entry once gave me an elaborate "reasoning" I had never said, and I had to trace it back through the chat history. |
| Subagent-claim hook (`.claude/hooks/verify-subagent-claim.sh`) | Restating a subagent's conclusion as settled when it has no verbatim quote from the source file | A summary can sound certain while the file says something else. |
| Cost-disclosure linter (private repo) | A log entry that describes a test or proof of concept without saying which tool was used and what it costs | Tools used to demonstrate something in chat were confused with tools the app pays for. |
| Stale-term sweep (private repo) | Terms for decisions that were reversed (for example, a database provider that was replaced) | Old decisions kept coming back through outdated notes. |

The last two check private log files, so they are described here, not included.

## 3. Root cause over quick fix

When something fails, I want to know exactly what happened and why, in concrete terms. The clearest example is the token-cap investigation (decision 5 in [DECISIONS.md](../DECISIONS.md)). Two convenient explanations were rejected through controlled tests before the real cause, a single number, was found.

The same discipline applies to the AI itself. When Claude Code reports a result, I check the evidence underneath it. More than once, a summary label didn't match the actual diff underneath it, and I caught it each time.

## 4. Logs are the source of truth

- **Decisions log:** one entry per decision, written in the same turn the decision is made.
- **Experiment log:** every test run, with the question, method, result and cost. Many entries are pre-registered: expectations are written down and committed before any paid call is made.
- **Architecture specs:** the longer reasoning behind each decision.

Two rules keep the logs honest:

- **Quote or retract.** Before stating what the project already tested or decided, find the actual quote in the log (file and section). If there isn't one, say "not verified". A confident summary from memory doesn't count. Long logs are exactly where models misremember, so this matters more as the project grows.
- **Separate tested from assumed.** Every claim about an external API or tool is labeled as *confirmed* (actually run) or *documented/assumed* (from docs or reasoning). I can't check code correctness myself, so this is the structure that lets me see what is real.

## 5. Agree before building

For anything visual, the design is agreed in conversation before anything is built. When Claude added unrequested UI details I had to react to and remove, that became a standing rule. Investigations and tests don't wait for permission. Design choices do.

## 6. Research has its own lane

Consequential research questions (platform terms, feasibility, tool comparisons) go to a separate research tool, with a prompt I run and read myself. Claude's own web search is for narrow fact checks, such as one API field name or one price.

## The working rules

The sanitized rules file Claude Code works from is [CLAUDE.md](../CLAUDE.md).
