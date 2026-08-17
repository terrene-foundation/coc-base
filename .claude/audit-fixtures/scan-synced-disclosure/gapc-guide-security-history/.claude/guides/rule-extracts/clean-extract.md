# FIXTURE (synthetic) — COMPLIANT pole: the same lesson, genericized

This is the no-false-positive half of the pair. It carries the SAME design lesson as
`leaky-extract.md` with the identifying specifics removed, and MUST NOT flag.

> The carve-out covers reading a sibling governance repo's prior-art (a loom↔sibling seam
> needs that sibling's event-schema; a second sibling carries guard-hardening prior-art for
> the same design).

What this pole locks: the scrub must remain a SCRUB, not a deletion. The transferable
content — that a guard was hardened from fail-open to fail-closed, and that reading a
sibling's prior-art is a legitimate orchestration-root operation — is fully present here.
Only the identity of the system that learned the lesson is gone.

If a future "fix" strips the lesson itself, this fixture still passes, so it is
deliberately NOT the only guard: the paired `leaky-extract.md` proves the detector fires,
and this file proves the generic vocabulary is not over-matched.
