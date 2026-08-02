# Example Rule — Wiring present, Detection block names NO verifiable binding

This fixture is MUST-4's own canonical DO-NOT example. The Detection bullet
matches `DETECTION_BULLET_RE`, so the rule is unambiguously "wired", but it
names a human review step rather than a path — so `TOKEN_RE` extracts ZERO
candidates.

Before the state split (loom#1467) this graded `wired-and-resolving`: a POSITIVE
attestation over a rule where nothing was verified, because `else state =
"wired-and-resolving"` was a terminal fall-through reached whenever `live`,
`unclassified` and `deferredAbsent` were all empty — INCLUDING when `candidates`
was empty. Zero paths verified and every path verified produced the identical
label.

It must now grade `wired-no-verifiable-binding`, and must NOT be critical: the
state is reported, not fatal.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review.
- **Detection mechanism:** cc-architect reviews it at /codify.
- **Violation scope:** MUST-1.
