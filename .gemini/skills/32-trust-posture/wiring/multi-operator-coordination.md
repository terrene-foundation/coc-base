# multi-operator-coordination — governance bookkeeping

**This file carries the Trust-Posture Wiring and the Origin record for
`.claude/rules/multi-operator-coordination.md`. It is NOT a rule and states no new
obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the
rule, quoted so the Wiring fields can name what they bind.**

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch, and this rule's `paths: ["**/*"]` makes it load on every working turn; the skills
tree is not injected. Governance bookkeeping is read by gate-review and by the validators
(through `bin/lib/rule-governance-surface.mjs`, which reads the rule UNION this file),
never acted on mid-turn. This tree also SHIPS (`skills/32-trust-posture/**` is a
distribution tier) and is already on the self-referential allowlist, so consumers keep
their Wiring and edits here still fire the Tier-1 gate. Depth that is neither obligation
nor bookkeeping lives in `.claude/guides/rule-extracts/multi-operator-coordination.md`.

---

## §2 Coordination-Disposition Verification clause

**Trust Posture Wiring (Coordination-Disposition Verification clause).** Clause-scoped (2026-07-13); canonical-8-field per `trust-posture.md` MUST-8. Per-field narrative: skill § "Rule-body extract — §2 disposition clause: Wiring narrative".

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture) — the MUST-3/4 path, NOT the MUST-2-scoped `evidence_free_claim` key.
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; named deviation from the key-per-clause shape per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: multi-operator-coordination]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; one ack covers §1 + the always-on MUST clauses + this clause).
- **Detection mechanism:** Phase 1 (gate-review) — reviewer / cc-architect confirm a disposition claim cited a record-set verification, not a projection read. **Probes: REGISTERED — `.claude/test-harness/probes/multi-operator-coordination.probes.json`**, one bipolar `pair_id` FIRING pair per derived clause (§1 identity, §2 disposition, MUST-1, MUST-2, MUST-3, the always-on MUST NOT section) plus a meta-compliance pair — read the row/pair counts off the suite, never off this line; fixtures `.claude/audit-fixtures/multi-operator-coordination/`, registered in `eval-manifest.json` (probe-only, `scanner: null`), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, ZERO deferred clauses in `clause-coverage-baseline.json`. No workflow invokes `coc-probe-dispatch.mjs`, and `.claude/test-harness/**` is never-synced, so no consumer receives the suite. **Phase 2 is RETIRED, not pending (2026-09-13): no hook detector will EVER be built, and no structural audit fixtures are owed** — whether a disposition CLAIM rests on a command's output or on a projection read beside it is a judgment over prose no argv token, AST node or git-object fact carries, so a dated deferral against it is the shape `hook-output-discipline.md` MUST-5(b) forbids, and an instrument that cannot separate the probe pair's poles is not evidence (`instrument-discipline.md` MUST-1). **Gate-review IS the enforcement layer here, permanently.** The `coordination-disposition-verification/` fixture pointer is withdrawn WITH it, here and from `validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES`. Depth — the pole diff and the withdrawn entries — lives in the extract § §2 Disposition Clause — Detection Depth.
- **Violation scope:** the Coordination-Disposition Verification clause ONLY.
- **Origin:** `journal/0482` (co-owner-directed); parents `evidence-first-claims.md` MUST-3 + MUST-4.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/codify`); `block` at pre-tool-use ONLY where a structural primitive backs an IRRECOVERABLE outcome (`integrity-guard.js` off-codify-branch write; `signing-mutation-guard.js` degraded-mode unsigned mutation); `halt-and-report` for a missing claim on a SAME-class write AND for §4.2 cross-worktree contention in both guards detecting it; `advisory` at session-start banners (per `hook-output-discipline.md` MUST-2).
- **Grace period:** 14 days from rule landing. Named rationale (`trust-posture.md:121` requires one): a coordination-OFF repo enters grace at ENABLEMENT, so a 7-day window from landing expires before a late-enabling repo runs one coordinated session.
- **Cumulative posture impact:** any same-class violation contributes per `trust-posture.md` MUST-4 (5× in 30 days → drop posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (retired, loom#2102); Rule-8 deviation: the fold rules and guards already refuse the structural cases. **The window is this rule's OWN 14 days (§ Grace period above), NOT the generic trigger's default 7.** Depth — the per-entry override, why no MUST is asserted on it, the day-8-14 consequence and the citation-anchor accounting — lives in the paired skill § "The 14-day window" + the extract.
- **Receipt requirement:** SessionStart MUST require `[ack: multi-operator-coordination]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** structural — fold rules 1–3 at every fold; `adjacency-leasecheck.js` (MUST-2), `operator-gate.js` (MUST-3), `genesis-anchor-guard.js` + `fold-rule-9c.js` (MUST-4/7), client-side checkpoint-pin verification (MUST-5), validator-13 (MUST-6). Per-clause contract, gate sweeps, fixture dirs: skill § Trust Posture Wiring.
- **Violation scope:** `operator` — every `violations.jsonl` row carries the stamped `person_id` + `sig`; downgrades apply per-operator, not to `repo_floor`.
- **Origin:** See § Origin.

## Origin

Architecture v11 CONVERGED 2026-05-19. Decision chain, F-series registry, CONF-2 refutation, per-extraction record: skill § Origin. EXTRACT, never NARROW: `.claude/guides/rule-extracts/multi-operator-coordination.md` § Origin — Extraction Policy.

**Extraction record.** Depth — the S27-INJECTION (2026-08-19), citation-restoration and injection-budget passes, each ZERO de-scoping with every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block, `**Why:**` line and canonical Wiring field retained here — lives in the extract § Extraction Record.
