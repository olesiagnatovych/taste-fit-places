#!/bin/bash
# Enforces CLAUDE.md rule 5 (quote or retract): a subagent's conclusion is a claim, not a fact, until
# it's backed by a real quote from the source file. Fires on every SubagentStop.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStop",
    "additionalContext": "Before restating this subagent's conclusion as settled: does it include a verbatim quote with file name/line for the key claim? If not, treat the conclusion as unverified and say so explicitly instead of asserting it as fact - especially if it closes an open question or contradicts what the user said they remember (CLAUDE.md rule 5, quote or retract)."
  }
}
EOF
exit 0
