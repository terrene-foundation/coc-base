# `deletion-blind` — reserved for the MUST-4 Phase-2 detector's fixtures (NOT YET BUILT)

This directory is EMPTY of fixture cases on purpose, and this file exists so that the path
`.claude/audit-fixtures/verification-gate-integrity/deletion-blind/` — cited by MUST-4's
clause-scoped Trust Posture Wiring — RESOLVES rather than dangling. A dangling citation in a
Wiring block is a `spec-accuracy.md` phantom reference and reds `validate-xref-integrity.mjs`.

**Do not read this directory's existence as coverage.** Per `cc-artifacts.md` Rule 9 the audit
fixtures land WITH the Phase-2 detector, and that detector does not exist. The deferral is
declared and dated in `.claude/test-harness/phase2-deferrals.json` under
`verification-gate-integrity.md#deletion-blind`.

## What covers MUST-4 today

Gate-review (Phase 1) plus one bipolar probe pair, `vgi-must4-deletion-blindness`, whose
candidates live one level up:

- violation — `../flag-removal-verified-by-rerunning-present-subject-gate.txt`
- compliant — `../clean-removal-verified-by-fieldwise-union-reconstruction.txt`

## Why a detector here is genuinely hard, not merely unscheduled

MUST-4's authority is the PRE-operation state, and the operation destroys it. A detector that
runs after the merge has nothing left to compare against, so it would have to hook the merge
itself rather than inspect the result. That is why this deferral is dated rather than promised
as imminent, and why the graduation condition in the registry names the two shapes a detector
could actually catch — a post-merge verification citing only a present-subject gate's green, and
a union check compared on key sets alone.

## Graduation

Delete this README in the same change that lands the first real fixture case here. Any detector
landing alongside it MUST itself carry the negative control MUST-1 requires, or it reproduces the
exact class it exists to catch.
