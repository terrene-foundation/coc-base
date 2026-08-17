# FIXTURE (synthetic) — VIOLATION pole: a named sibling system's security-posture history

This file reproduces the GAP-C class in the surface where it actually shipped: a
**distributed rule-depth extract** that explains a real design lesson and, in doing so,
names a non-public sibling system AND discloses its security-posture history.

Every token below is SYNTHETIC — the system name in the quoted passage is invented for this
fixture, names no real system, and is declared in this fixture's own denylist so the scan
flags it. It is deliberately written ONCE in this file (see the count-lock below), so this
sentence names it by description rather than repeating it.

The prose shape is deliberately faithful to the real defect — the disclosure rides inside
an otherwise-legitimate design rationale, which is why prose review kept passing it:

> The carve-out covers reading a sibling governance repo's prior-art (the seam needs that
> sibling's event-schema, plus the Synthguard `.codex-mcp-guard/` fail-open→fail-closed
> prior-art).

Exactly ONE occurrence of the token in this fixture tree -> exactly ONE finding (the
count-lock). The sibling `clean-extract.md` carries the SAME lesson genericized and MUST
stay clean, so a second finding means the compliant pole regressed.
