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

| Fixture                                      | Predicate       | Expect | Origin condition reproduced                                               |
| -------------------------------------------- | --------------- | ------ | ------------------------------------------------------------------------- |
| `flag-release-gate-pre-seeded-happy`         | MUST-8          | FLAG   | v4.37.0 gate seeded `set_oidc_jwks`, drove good-vs-bad only, PASSED       |
| `clean-release-gate-cold-real-consumer-walk` | MUST-8          | CLEAN  | v4.37.1 gate: cold un-seeded entry + real RS256 variants + boundary paths |
| `meta-violation-preconfigured-sufficiency`   | meta-compliance | FLAG   | MUST-8's "seeding the config is just test setup" promoted to a rule's premise |
| `meta-compliant-cold-entry-required`         | meta-compliance | CLEAN  | the same rule authored soundly — sufficiency conditioned on the ENTRY STATE |

The two `meta-*` fixtures are a SURFACE-EQUALIZED pair: same subject, same frontmatter, same
`##` heading skeleton, same single numbered clause, same 8-field Wiring, same Origin shape, and
within 1.21x of each other in bytes. That is a mechanical floor, not a stylistic note —
`probe-suite-integrity.test.mjs` asserts every item of it, because a pair separable by SHAPE is
scoreable without reading either body, which would make the pair measure formatting.

**Probe suite — REGISTERED (loom#1302).** The bipolar LLM-judge suite for MUST-8 lives at
`.claude/test-harness/probes/user-flow-validation.probes.json` — 4 rows in 2 `pair_id` pairs
(efficacy + no-false-positive; meta-compliance violation + compliant). It is registered in
`eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
`.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES`. It previously staged
as `.probes.jsonl` under an `eval-manifest.json::_deferred_probes` declaration; that declaration
is DISCHARGED and removed, and the `.jsonl` file is gone. An earlier version of this paragraph
said the suite staged as `.probes.jsonl` "escaping check (e)"; that rename bypass was CLOSED
first (loom#1368 part 2C — check (e) enumerates both extensions), so by the time the suite
graduated the extension cleared nothing.

**What registration buys — DISPATCHABILITY, not CI execution.** `/test-harness-probe --artifacts`
reads registered suites from `eval-manifest.json`, so these 4 rows now render as judge prompts
where 0 rendered before (measured: plan `dispatch_count` 36 → 40). No workflow invokes the
dispatcher and the loom↔csq boundary keeps CI LLM-free, so the suite runs ONLY when an
orchestrator dispatches it at gate-review; a green CI run is never evidence these probes passed.
What CI does gate is registration and fixture hygiene: `coc-manifest-integrity.mjs` checks (b)
and (e), plus `probe-suite-integrity.test.mjs`.

The `.expected` sidecars hold the answer keys and are never shown to a judge — the candidate
`.txt` is handed over verbatim, and `probe-suite-integrity.test.mjs` mechanically sweeps each one
for answer-key markers and HTML comments.
