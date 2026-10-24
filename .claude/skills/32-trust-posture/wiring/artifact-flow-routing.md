# artifact-flow-routing — governance bookkeeping

**This file carries the Trust-Posture Wiring, the Origin record and the rest of the full-length rationale for
`.claude/rules/artifact-flow-routing.md` (routing, upflow and tenant gates). It is NOT a rule and states no new obligation — every MUST
and MUST NOT token below RESTATES a clause that lives in the rule.** Moved verbatim from the rule body
of `artifact-flow.md` when it was split into four path-scoped rules (context-budget workstream,
2026-10-10); each rule keeps its clauses and its BLOCKED corpora.

---

## Full Why paragraphs (moved from the rule body)

The **Why:** paragraphs of § Issue Routing By Change Type and § Canon Neutrality moved back inline into `.claude/rules/artifact-flow-routing.md`, verbatim and at their pre-split position, later on 2026-10-10: they are what lets `check-clause-coverage.mjs` derive those sections as named clauses. The paragraphs below are the rest.

### Why — Downstream-Consumer Routing

**Why:** An own-repo issue produces an orphan proposal nobody upstream sees (the consumer's Step-7c manifest is push-only), and one filed directly against loom bypasses the USE-template-side review that catches variant-vs-global misclassification. The USE template is the only repo class that originates proposals to loom, so routing every downstream-consumer change through it preserves the Gate-1 audit trail the splitter rule depends on.

### Why — Consultant Dual-Route Self-Serve (D4)

**Why:** Routing through an engineer for classification re-introduces the synchronous hand-off DECISION-4 removes — the consultant blocks on engineer availability and the engineer becomes a bottleneck for every product's signal. The dual-route lets ONE `/codify` cover both change-TYPEs async, with the per-lane human gate as the trust boundary.

## Canon Neutrality — Origin and Trust Posture Wiring

Origin: 2026-07-13 — co-owner-directed origination (`journal/0478`). Full narrative: companion § Canon Neutrality — Origin.

**Trust Posture Wiring (Canon-Neutrality — A Tenant Gate Never Gates A Canon Build):**

Applies to the **Canon Neutrality** clause (added 2026-07-13); per `trust-posture.md` MUST-8 grandfather cutoff it lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant. Grandfather scope + the clause-scoped precedent: companion § Wiring Grandfather Scope And Clause-Scoped Precedent.

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm no tenant-specific gate blocks a canon build, and that any tenant-name scrub was NOT treated as fixing an architectural tenant-coupling); `advisory` at the hook layer (whether a gate is tenant-specific-gating-canon is judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a tenant-specific gate coupling a canon build, OR a tenant-name scrub treated as fixing a tenant-coupling) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session authoring or editing a canon artifact for a tenant-specific gate (works-council / customer sign-off / tenant legal approval) framed as blocking a canon wave/build, and confirm any tenant-name scrub was paired with a check that the underlying gate is not architecturally coupling canon. **Probes: REGISTERED — `.claude/test-harness/probes/artifact-flow-routing.probes.json`** — the `canon-neutrality-firing` pair for § Canon Neutrality plus a meta-compliance pair. The clause pairs that sat beside it in `artifact-flow.probes.json` before the 2026-10-10 split now live one suite per part, beside this one: `artifact-flow-gates.probes.json` (`MUST-1-firing`, `MUST-2-firing`, `intake-scrub-firing`), `artifact-flow-distribution.probes.json` (`MUST-NOT-firing`) and `artifact-flow.probes.json` (`MUST-NOT-firing`), each with its own meta-compliance pair; read the row/pair counts off the suite, never off this line. Fixtures + `.expected` sidecars at `.claude/audit-fixtures/artifact-flow/`. **Phase 2 is RETIRED, not pending (2026-09-11): no hook detector will EVER be built**, and no fixtures are owed. The only mechanical signal — the tenant NAME — is disqualified by this clause's own text (`instrument-discipline.md` MUST-1, `hook-output-discipline.md` MUST-2), so booking one is the shape `rule-authoring.md` MUST NOT names. Gate-review plus the registered `canon-neutrality-firing` pair ARE the enforcement layers, permanently; rationale `phase2-deferrals.json` key `artifact-flow.md#canon-neutrality`.
- **Invoker class:** `agent-mid-procedure` ONLY — gate-review by reviewer at `/implement` and cc-architect at `/codify` per § Severity, plus the `canon-neutrality-firing` probe pair, which executes only when an orchestrator dispatches `/test-harness-probe`. No runtime or CI arm is claimed: Phase 2 is retired and no hook or checker fires this clause. At an audience that surfaces neither `/implement` nor `/codify` the gate is REACHABLE-BUT-UNINVOKABLE.
- **Violation scope:** the Canon-Neutrality clause ONLY (clause-scoped); pre-existing grandfathered `artifact-flow.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (`journal/0478` co-owner-directed origination) + the #411 DECISION-1 re-scope (#1002).

## Trust Posture Wiring — Probe Pairs For This Rule

- **Detection mechanism:** the `canon-neutrality-firing` pair in `.claude/test-harness/probes/artifact-flow-routing.probes.json` (fixtures `.claude/audit-fixtures/artifact-flow/`) exercises the Canon Neutrality clause — both rows name `.claude/rules/artifact-flow-routing.md` as their `artifact` and declare `"covers": ["MUST-Canon-Neutrality"]`. The suite is registered under its own `artifact-flow-routing` manifest key; the pair moved there from `artifact-flow.probes.json` when this rule was split from `artifact-flow.md` (2026-10-10), and it carries a copy of the meta-compliance pair. Issue Routing By Change Type has no pair — dated-deferred in `clause-coverage-baseline.json`.

Depth — the probe-registration semantics, the consumer-lane measurement, the pole diff and the regression-key reasoning — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Canon Neutrality — Wiring Depth.
