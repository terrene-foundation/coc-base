# user-flow-validation audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/coc-artifact-eval-coverage.md` MUST-1: a
bipolar fixture pair (fires + clean) per detection predicate. This directory currently
covers **MUST-8** (a release / verification gate drives the un-pre-configured
real-consumer path) — the predicate added 2026-07-22 via `/sync-from-build` kailash-rs
Gate-1 classification. The remaining predicates (MUST-1..7) are covered by the load-bearing
REVIEW layer (reviewer at `/implement`, cc-architect at `/codify`); their structural
fixtures backfill when their detectors land.

**Detection layer.** The load-bearing detector is the REVIEW layer (reviewer at
`/implement`, release-specialist at `/release`, cc-architect at `/codify`). Whether a gate
pre-seeded the consumer's runtime state is judgment-bearing (`hook-output-discipline.md`
MUST-2), so each `.expected` is the **reviewer's expected disposition**
(`FLAG MUST-8 — <reason>` or `CLEAN — <reason>`), NOT a live hook JSON return.

**Origin-incident reproduction** (per `rule-authoring.md` Rule 9 — fixtures reproduce the
originating incident's conditions, not idealized versions):

| Fixture                                      | Predicate | Expect | Origin condition reproduced                                               |
| -------------------------------------------- | --------- | ------ | ------------------------------------------------------------------------- |
| `flag-release-gate-pre-seeded-happy`         | MUST-8    | FLAG   | v4.37.0 gate seeded `set_oidc_jwks`, drove good-vs-bad only, PASSED       |
| `clean-release-gate-cold-real-consumer-walk` | MUST-8    | CLEAN  | v4.37.1 gate: cold un-seeded entry + real RS256 variants + boundary paths |

**Probe suite.** The bipolar LLM-judge probe suite for MUST-8 is staged at
`.claude/test-harness/probes/user-flow-validation.probes.jsonl`
(efficacy + no-false-positive + meta-compliance). Its `eval-manifest.json` registration
is **DEFERRED** — declared, not hidden. The deferral is recorded in
`eval-manifest.json::_deferred_probes` with a reason and an expiry, and is printed as a
`NOTE:` on every CI run. An earlier version of this paragraph said the suite stages as
`.probes.jsonl` "escaping check (e)"; that rename bypass is CLOSED (loom#1368 part 2C —
check (e) now enumerates both `.probes.json` and `.probes.jsonl`), so the file extension
no longer clears the orphan check. Registration lands when the suite is converted to the
canonical `.probes.json` JSON-array form with `artifact_id` rows.
