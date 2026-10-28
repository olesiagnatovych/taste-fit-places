#!/usr/bin/env python3
"""
Blocks writes to the decision logs (DECISIONS.md, and the private
architecture log) that attribute reasoning or intent to the product
owner without a verbatim quote or an explicit [inferred] tag nearby.

Real incident this fixes (2026-09-26): a decision-log entry recorded a
detailed "reasoning" as the product owner's own, when the actual message
was a short reply that stated no reasoning at all. The elaboration was
Claude's own construction, written into a permanent log as if it were
the product owner's words, and had to be traced back by hand.

This is a PreToolUse hook (deterministic - runs before the write
happens, not advisory) on Edit/Write, scoped to the two decision-log
files.
"""
import json
import re
import sys

TARGET_FILES = ("DECISIONS.md", "Architecture-Specs.md")

ATTRIBUTION_PATTERNS = [
    r"her (real )?reasoning",
    r"the product owner'?s (real )?reasoning",
    r"she (wants|said|explained|stated|felt|meant)",
    r"real reasoning,? stated by",
    r"her real reason",
    r"her stated (reason|intent|goal)",
]

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print(json.dumps({}))
        return

    tool_input = data.get("tool_input", {}) or {}
    file_path = tool_input.get("file_path", "") or ""

    if not any(file_path.endswith(t) for t in TARGET_FILES):
        print(json.dumps({}))
        return

    content = tool_input.get("content") or tool_input.get("new_string") or ""
    if not content:
        print(json.dumps({}))
        return

    flagged = []
    for pat in ATTRIBUTION_PATTERNS:
        for m in re.finditer(pat, content, re.IGNORECASE):
            window = content[max(0, m.start() - 60):m.end() + 300]
            has_quote = bool(re.search(r'["“‘\'].{3,}["”’\']', window))
            has_tag = "[inferred]" in window.lower() or "[stated]" in window.lower()
            if not has_quote and not has_tag:
                flagged.append(m.group(0))

    if flagged:
        reason = (
            "Blocked: this entry attributes reasoning/intent to the product owner ("
            + "; ".join(sorted(set(flagged)))
            + ") with no verbatim quote and no [stated]/[inferred] tag nearby. "
            "Fix: either quote their actual words directly, or mark the sentence "
            "[inferred] if it is your own construction, not something they said. "
            "(Real incident, 2026-09-26: a fabricated reasoning line had to be "
            "traced back by hand to find it was never real.)"
        )
        result = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
        print(json.dumps(result))
        return

    print(json.dumps({}))

if __name__ == "__main__":
    main()
