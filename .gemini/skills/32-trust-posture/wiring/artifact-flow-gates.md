# artifact-flow-gates — governance bookkeeping

**This file carries the Trust-Posture Wiring, the Origin record and the full-length rationale for
`.claude/rules/artifact-flow-gates.md` (proposals and Gate-1 / Gate-2 operations). It is NOT a rule and states no new obligation — every MUST
and MUST NOT token below RESTATES a clause that lives in the rule.** Moved verbatim from the rule body
of `artifact-flow.md` when it was split into four path-scoped rules (context-budget workstream,
2026-10-10); each rule keeps its clauses and its BLOCKED corpora.

---

## Full Why paragraphs (moved from the rule body)

### Why — Intake Disclosure Scrub

**Why:** Gate-1 placement enters loom git history BEFORE Gate-2 ever runs; a disclosure that lands at Gate-1 is already permanent and correlatable across 30+ downstream consumers — redaction-after is partial, the exact `upstream-issue-hygiene.md` Rule-1 failure mode.

### Why — Exact Gate-1 / Gate-2 Tracking — MUST-1

**Why:** A developer may be live in the target's local checkout, and a Gate-2 overlay silently collides with their uncommitted work — the stranded-overlay class. A worktree from `origin/main` is clean by construction and lands the change as a PR the dev pulls, so no live-checkout state is ever overwritten.

### Why — Exact Gate-1 / Gate-2 Tracking — MUST-2

**Why:** Without a per-op receipt a distribution's exact file-set and provenance live only in session memory and evaporate at the context boundary; the receipt is the durable, greppable record of what landed where. The scrub is required because the receipt is committed to loom's journal — a synced/publishable surface — while two of its fields carry a private-org identifier and an operator home path. Full reasoning: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Why The Receipt And Its Scrub.

## Intake Disclosure Scrub — Origin and Trust Posture Wiring

Origin: 2026-05-17 — #263 forest-closure follow-up; receipts journal 0082 / 0083 / 0084.

**Trust Posture Wiring (Intake Disclosure Scrub):**

- **Severity:** `halt-and-report`. The scanner half is a structural exit-code signal, but the proposal-body half is a human-judgment gate — the composite clause carries `halt-and-report`, not `block` (per `hook-output-discipline.md` MUST-2: judgment-bearing gates do not carry block severity).
- **Grace period:** 7 days from this clause landing; during grace a Gate-1 placement made without the two scrub actions logs to `violations.jsonl` for cumulative tracking only.
- **Cumulative posture impact:** same-class violations (a Gate-1 placement of a proposal that was not disclosure-scrubbed) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation (Gate-1 placement of an un-scrubbed proposal) within 7 days = emergency downgrade per `trust-posture.md` MUST Rule 4, routed through the GENERIC `regression_within_grace` trigger (1× = drop 1 posture) — no dedicated key.
- **Receipt requirement:** SessionStart MUST require `[ack: intake-disclosure-scrub]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** the #263 `scan-synced-disclosure.mjs --check --root` invocation IS the mechanical detector for the artifact-file half; the sync-reviewer Gate-1 step-0 confirms the human body-scrub occurred. Final disposition is human. **This clause NO LONGER CHAINS to trust-posture's § Two-Phase Rollout, and its Phase 2 is RETIRED rather than pending (2026-09-13); no structural audit fixtures are owed.** The MECHANICAL half is SHIPPED AND ENFORCING, not awaiting a rollout (`.claude/bin/scan-synced-disclosure.mjs`, fixtures at `.claude/audit-fixtures/scan-synced-disclosure/`, wired into the sync/codify commands and the Gate-1/Gate-2 agents), so a Gate-1 placement cannot reach a distribution without it having run. The HUMAN half will never gain a detector — its only mechanizable proxy is the tenant NAME, which § Canon Neutrality already disqualifies as non-discriminating, so deferring it to a rollout gated on a condition nothing measures was booking teeth that cannot arrive, which `hook-output-discipline.md` MUST-5(b) forbids. **Gate-review, plus the shipped scanner, ARE the enforcement layers here, permanently.**
- **Invoker class:** `agent-mid-procedure` ONLY — sync-reviewer at step 0 of `/sync-from-build` and `/sync-from-use` runs `scan-synced-disclosure.mjs --check --root` over the incoming proposal's tree and confirms the human body-scrub. Both commands are `loom_only`, so the gate is invokable at the `platform` role, where Gate-1 runs. The `ci` step that runs `.claude/bin/scan-synced-disclosure.mjs --check` in `.github/workflows/coc-artifact-eval.yml` scans loom's own tree, not a proposal before placement, so it is not claimed as this gate's invoker.
- **Violation scope:** the Intake Disclosure Scrub clause ONLY (clause-scoped).
- **Origin:** see the Origin line above this block — 2026-05-17, #263 forest-closure follow-up; receipts journal 0082 / 0083 / 0084.

Depth — the fixture/command inventory, the registry-row reasoning, and why the separate `rollout` entry keeps its own date — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Intake Disclosure Scrub — Detection Depth.

## Trust Posture Wiring — Probe Pairs For This Rule

- **Detection mechanism:** the `MUST-1-firing`, `MUST-2-firing` and `intake-scrub-firing` pairs in `.claude/test-harness/probes/artifact-flow-gates.probes.json` (fixtures `.claude/audit-fixtures/artifact-flow/`) exercise this rule — each of those rows names `.claude/rules/artifact-flow-gates.md` as its `artifact`. The suite is registered under its own `artifact-flow-gates` manifest key; its pairs moved there from `artifact-flow.probes.json` when this rule was split from `artifact-flow.md` (2026-10-10), and it carries a copy of the meta-compliance pair. MUST NOT has no pair — dated-deferred in `clause-coverage-baseline.json`.

## Exact Gate-1 / Gate-2 Tracking — Trust Posture Wiring

**Trust Posture Wiring (Exact Gate-1 / Gate-2 Tracking):**

- **Severity:** `halt-and-report` at gate-review (a worktree-vs-local-checkout landing and a receipt-presence property are judgment-bearing over the session's command history, not a single structural tool-call signal — per `hook-output-discipline.md` MUST-2 the hook layer stays `advisory`).
- **Grace period:** 7 days from this clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (a Gate-2 overlay into a live local checkout, OR a gate op declared complete without its exact-tracking receipt) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key; named deviation per Rule 8 (reasoning: companion § Regression-Key Dispositions).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect / reviewer inspects any session transcript that ran `/sync-to-build` or `/sync-to-use` and confirms (a) the distribution drove `.claude/bin/sync-gate2-worktree.mjs` and (b) each gate op emitted its journal `DECISION` + coordination-log receipt; the `sync-reviewer` Gate-1 step confirms the ingest half. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/exact-gate-tracking/` per `cc-artifacts.md` Rule 9.
- **Invoker class:** `agent-mid-procedure` ONLY — `/sync-to-build` and `/sync-to-use` drive `.claude/bin/sync-gate2-worktree.mjs`, which lands the worktree and builds the receipt; sync-reviewer at `/sync-from-build` and `/sync-from-use` confirms the ingest half; cc-architect / reviewer confirm per § Detection mechanism. All four sync commands are `loom_only`, so the gate is invokable at the `platform` role. No hook or CI step fires this clause.
- **Violation scope:** MUST 1 (worktree-from-remote-main landing) + MUST 2 (exact-tracking receipt per gate op).
- **Origin:** Directive 1 co-owner-directed origination (`journal/0403`); see § Origin.
