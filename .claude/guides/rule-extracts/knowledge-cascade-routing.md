# `knowledge-cascade-routing.md` — depth extract

Depth companion to `.claude/rules/knowledge-cascade-routing.md`. Every `extract §` pointer in
that rule resolves here. Created 2026-09-13 by a rule-injection-budget paired extraction
(`rule-authoring.md` Rule 10 path (a)): the rule body keeps every MUST, MUST NOT, BLOCKED
entry, DO/DO-NOT block and `**Why:**` line, plus the named scanner / fixtures / probe paths
`coc-artifact-eval-coverage.md` MUST-4 requires; what moved here is narrative around them.

## Probe registration + dispatch bookkeeping

Moved verbatim from the rule's `**Detection mechanism:**` bullet.

The suite is **10 rows in 5 bipolar `pair_id` pairs** — one firing pair per derived clause
(MUST-1, MUST-2, MUST-3, MUST-NOT) plus a meta-compliance pair — each carrying BOTH a
violation and a compliant pole, with candidate fixtures + answer-key sidecars at
`.claude/audit-fixtures/knowledge-cascade-routing/`.

Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses.

Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.

Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives this suite;
at those targets the semantic tier is not a live gate and enforcement is gate-review at the
consumer's end.
