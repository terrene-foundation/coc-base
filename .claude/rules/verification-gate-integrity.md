---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - ".github/workflows/**"
  - ".github/actions/**"
  - "scripts/ci/**"
  - "tools/**"
  - ".claude/audit-fixtures/**"
---

# Verification-Gate Integrity — A Gate Must Be Proven Able To Fail, And Its Absence Must Never Read As A Pass

Full DO/DO-NOT blocks, BLOCKED corpora, MUST-2's carve-out in full, the MUST-3/4 distinction, Origin, and the Wiring detail: `.claude/guides/rule-extracts/verification-gate-integrity.md`.

A gate that cannot fire is indistinguishable, to every reader, from a gate that fired and found nothing — both render green, and nobody investigates a passing check. This governs the INTEGRITY of a verification mechanism (CI checks, suites, guards, linters, audits), not whether its logic is correct: a perfectly-correct gate that never executes protects nothing.

## MUST Rules

### 1. A Gate Ships With A Negative Control That Runs Where The Gate Runs

Any check whose green is relied upon MUST carry a proof it can still go RED — a planted violation, a mutation, a known-bad fixture — executing in the same place and on the same cadence as the gate. A control that is unwired, or wired where the gate is not, proves nothing about the gate in production.

**Why:** A green is consistent with "ran and found nothing" AND "did not meaningfully run"; the control is the only artifact that separates them, and it must run where the gate runs or it separates them for a different gate.

### 2. Absence Of A Result Is Not A Pass — Assert Success Per Name

Any merge, release, or convergence gate MUST enumerate its required checks BY NAME and assert each one's terminal state. Gating on `failures == 0`, "nothing red", or a rollup is BLOCKED: a **cancelled**, **never-triggered**, or **never-reported** check contributes zero failures and satisfies such a gate having produced no verdict. A `skipped` MAY satisfy a required check ONLY when all three hold — (1) it REPORTED a terminal conclusion; (2) the skip came from the job's OWN condition, not an interrupted run and not an inherited `needs:` skip; (3) that context is enumerated as skippable, with its condition, in a reviewer-approved declaration. **Each repo MUST name where that enumeration lives**; an unnamed home makes the condition unsatisfiable, which is itself a gate that cannot fire.

**Why:** Cancellation, path-filter misses and never-registered contexts are all absence — the one outcome identical to success in every aggregate view — so naming the required set is what makes a missing verdict visible.

### 3. A Gate's COVERAGE — Scope And Invocation — Is Verified Against An Authority

**(a) Scope:** a path filter, prefix list, classifier, or allowlist MUST be derived from or checked against the authoritative enumeration of what it covers. **(b) Invocation:** every verification target that EXISTS MUST be named by an invocation that runs it, checked against the authoritative target list — a target no invocation names advertises coverage that has never executed once.

**Why:** A scope restatement and its self-test are written from one mental model, so the test can only confirm it; the authority is the only source that can return an answer the author did not already believe.

### 4. A Gate Over Present Subjects Cannot Detect Their DELETION

MUST-2 governs absence of a RESULT; this governs absence of the SUBJECT. A gate asking about the rows it can SEE cannot notice that a row is gone. Re-running it after an operation that could DROP rows (a merge resolution, migration, split, bulk edit) and reading its green as "nothing was lost" is BLOCKED. Answer the removal question by **union-reconstruction**: every row on either input present in the output, per key AND FIELD-WISE — a count is not a set, and a set of keys is not the rows. The check MUST carry its own negative control per MUST-1, and is ADDITIVE: it does not license skipping the gate.

**Why:** The gate reports success and the diff reads as a clean resolution, while what was lost is the RECORD that something was verified — so the system asserts, with a green check, a coverage it no longer has.

## MUST NOT

- Rely on a check's green without evidence it can go red — **Why:** an inert gate is green forever, and its inertness is invisible precisely because it is green.
- Treat `cancelled`, `neutral`, an UNDECLARED or dependency-inherited `skipped`, or a never-reported context as satisfying a required check — **Why:** absence-of-verdict renders identically to success in every aggregate view.
- Ship a scope list whose only validation is a fixture set restating it — **Why:** a self-certifying pair cannot surface the assumption both halves share.
- Silence a chronically-red gate instead of fixing or re-scoping it — **Why:** it is read as noise and stops being evidence — an inert gate reached from the opposite direction.

## Trust Posture Wiring

Covers MUST-1..4, all landing together at loom 2026-08-11 under one grace window. (BUILD carried a second clause-scoped block for MUST-4 only because its rule-wide grace had closed by then — an artifact of incremental landing, not applicable here.)

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement`, security-reviewer when the gate is security-enforcing, cc-architect at `/codify`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a check is "relied upon", whether a control is meaningful, and whether a diff could drop rows are judgment-bearing, not tool-call-time signals. No structural teeth at land time (`no-check: this governs CI/test-surface mechanisms, not an emission property; validate-emit.mjs checks what loom EMITS and no emitted-artifact invariant distinguishes a wired control from an unwired one — a structural check here would be the unfalsifiable gate MUST-1 forbids`).
- **Grace period:** 7 days from rule landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (an unwired control; a merge gate keyed on `failures == 0` or a rollup; a scope list validated only by fixtures restating it; a removal verified by re-running the gate whose subjects were removed; a key-only union comparison; a count reported as contents) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; gate-integrity is review-layer judgment and minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit. Named deviation per `trust-posture.md` Rule 8, as `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: verification-gate-integrity]` IFF `posture.json::pending_verification` includes this rule_id (one ack covers MUST-1..4).
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any diff adding, moving or re-scoping a verification mechanism, confirm (a) a negative control exists AND is invoked in the same job/suite, (b) merge/convergence assertions enumerate checks by name, (c) any scope list is checked against its authority, (d) any row-dropping diff carries a field-wise union-reconstruction with its own control. **No structural coverage is claimed: measured at placement, loom carries no CI negative-control audit, so all four clauses are gate-review properties here.** Semantic tier: scanner `null` (probe-only); probes `.claude/test-harness/probes/verification-gate-integrity.probes.json` — 8 rows, 4 bipolar pairs — registered in `eval-manifest.json`, pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, dispatched by `/test-harness-probe`, deliberately NOT in CI. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/verification-gate-integrity/` per `cc-artifacts.md` Rule 9. For MUST-4, Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with it at `.claude/audit-fixtures/verification-gate-integrity/deletion-blind/` per `cc-artifacts.md` Rule 9; that one is genuinely hard, since MUST-4's authority is the pre-operation state the operation destroys. Both are dated in `phase2-deferrals.json`.
- **Violation scope:** MUST-1 (unwired control) + MUST-2 (absence-as-pass) + MUST-3 (self-certifying scope list, either half) + MUST-4 (removal verified by a present-subject re-run, key-only union, or count-as-contents). Every row names the gate and the clause.
- **Origin:** See § Origin.

## Origin

2026-08-03 Rust SDK wave S14 — six instances across five tracks, none looking for it, including a script-injection guard green over 35 real findings while its own negative control PASSED (satisfying MUST-1, violating only MUST-3 — the evidence that the two are distinct). **MUST-4** — 2026-08-10 wave S24: a modify/delete resolution deleted five `status=executed` rows and the deprecation gate still printed `[PASS]`, because a row that does not exist cannot be overdue; caught only by a dry run. Per-instance detail and the loom Gate-1 placement accounting (four defects fixed in the never-reviewed draft; the Rule-10 path (a) byte measurement): the extract.
