# `deletion-blind` — the MUST-4 Phase-2 detector is RETIRED; no fixtures are owed here

This directory is EMPTY of fixture cases on purpose, and this file exists so that the path
`.claude/audit-fixtures/verification-gate-integrity/deletion-blind/` — cited by MUST-4's
clause-scoped Trust Posture Wiring — RESOLVES rather than dangling. A dangling citation in a
Wiring block is a `spec-accuracy.md` phantom reference and reds `validate-xref-integrity.mjs`.

**Do not read this directory's existence as coverage.** Per `cc-artifacts.md` Rule 9 the audit
fixtures land WITH the Phase-2 detector — and as of 2026-09-13 that detector will never exist.

**CORRECTED 2026-09-13.** This file used to say the detector was "NOT YET BUILT" and that "the
deferral is declared and dated in `.claude/test-harness/phase2-deferrals.json` under
`verification-gate-integrity.md#deletion-blind`". Both sentences are now FALSE: the row was
RETIRED in the deferral-burndown lane and moved to `acknowledged_non_deferrals`, so there is no
dated declaration to point at and nothing is pending. They are corrected here rather than left,
because a README asserting a pending tier is the same absence-reads-as-clean shape this rule
governs.

The retirement was taken on CORRECTED grounds, and the correction matters: the row's own
argument had been that the pre-operation authority a detector would need is destroyed by the
operation it audits. That does NOT hold — a merge's parents survive in the object store. What
holds is that the deciding property is WHICH GATE a removal verification RESTS ON, which is a
property of the claim rather than of the tree, and a key-set comparison cannot be told from any
other key-set comparison without first recognising the code AS a union reconstruction.

This directory stays so the Wiring citation RESOLVES rather than dangling — a dangling citation
is a `spec-accuracy.md` phantom reference and reds `validate-xref-integrity.mjs`.

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
