---
id: "SWEEP-COMPLETENESS"
paths: [".claude/commands/sweep.md", ".claude/commands/redteam.md", ".claude/commands/codify.md", ".claude/commands/wrapup.md", ".claude/commands/cc-audit.md", ".claude/commands/cli-audit.md", ".claude/commands/i-audit.md", ".claude/commands/i-harden.md", ".claude/commands/i-polish.md", ".claude/skills/sweep/**", ".claude/skills/spec-compliance/**", "**/redteam-*.md", "**/sweep-*.md", "**/04-validate/**"]
---

# Sweep / Multi-Step Protocol Completeness

Depth for every clause — BLOCKED corpora, extended DO/DO NOT, skip-class detail, cross-rule map, tool-backing pattern, N=3 derivation, MUST-4 Wiring rationale, post-mortems: `.claude/guides/rule-extracts/sweep-completeness.md`.

Two sibling failures end identically — a report slot that reads as coverage and answers nothing. Rules 1–3 govern substituting a CHEAP PROXY for a mandated step; Rule 4 governs emitting a NON-ANSWER in place of one, run after run.

Call a mandated step too expensive / "needs a separate trigger" / "deferrable to /redteam" and you MUST ask the human BEFORE substituting a proxy. Silent substitution is BLOCKED; "yesterday's sweep skipped it too" does NOT authorize today's.

The substitution decision is the trigger. The human is the gate.

## MUST Rules

### 1. Substitution Decision Triggers a Human Gate

When a mandated step is judged too expensive to run inline AND no skill/command/rule authorizes the substitution, the agent MUST stop and surface: WHICH step, WHY, WHAT proxy, WHAT coverage is lost — then ASK skip / substitute / run-full / different-approach.

```markdown
# DO — "Sweep 5 mandates per-spec MUST-symbol + Tier-2 verification (~10–30 min).
# `spec-cite-check --strict` (~1s) checks citations resolve, NOT symbols or
# coverage. Skip / substitute / run full / other?"
# DO NOT — silent substitution
[runs cite-check, reports `0/0/0` as the Sweep 5 result, ships clean]
```

**BLOCKED rationalizations:** "yesterday's sweep substituted, today's can too" / "the cheap tool is green" / "the expensive step needs a trigger we don't have" / "asking is bureaucracy" — full list in extract.

**Why:** Substitution goes invisibly until someone asks "what did you actually check?" By then the report has shipped and the next session inherits the framing.

### 2. Proxy Output MUST Be Labeled, Never Relabeled

After a human-gated substitution the output MUST carry the PROXY's name, never the mandated step's. `Sweep 5: 0/0/0 cite-check (substituted per user approval)` is fine; `Sweep 5: 0/0/0 (clean)` is BLOCKED.

**Why:** A reader cannot tell, from the second form, that the mandated step did not run. The substitution becomes invisible institutional knowledge.

### 3. Skill / Command Text Tightening Is The Long-Term Fix

When a skill repeatedly produces substitution decisions, propose a `/codify` that either (a) tightens the prose into a tool invocation, or (b) authorizes substitution with named bounds. This rule is run-time defense; tool-backed text is design-time defense.

**Why:** A rule firing every cycle signals the structural defense is wrong. Recurring substitutions need design-time tooling so the gate stops firing.

### 4. The SAME Unadjudicated Verdict On 3 Consecutive Runs MUST ESCALATE

A step emitting the SAME unadjudicated verdict — `manual-supplement-required`, an N/A the repo shape BLOCKS, any "cannot adjudicate here" placeholder — on **3 consecutive runs** MUST NOT emit it a 4th. The 3rd is a **Decision Point** (report § 5): author the missing check, OR record a dated disposition sentinel carrying `owner` + `issue` + `until`. A disposition NEVER resets the count — it suppresses escalation until `until` passes, then escalation resumes. Run `node .claude/bin/unadjudicated-escalation.mjs` at Closure, embed its sentinel; exit 1 = escalation owed.

```markdown
# DO — 3rd consecutive run: surface it as a Decision Point
DECISION [Sweep 5] manual-supplement-required ×3 — author the check, or disposition it
<!-- unadjudicated-disposition:v1 key="manual-supplement-required" issue=1722 owner=<handle> until=2026-09-30 -->
# DO NOT — emit the identical non-verdict a 4th time
FINDING [Sweep 5] manual-supplement-required
```

**BLOCKED rationalizations:** "it is not claiming clean" / "the issue is filed, that IS the disposition" / "nothing changed since last run" / "the tool still does not exist" / "it escalated last time too" / "the row is honest" / "N is arbitrary".

**Why:** A verdict that never discriminates is not evidence (`instrument-discipline.md` MUST-1), and repeated forever it consumes a report slot, reads as coverage, and answers nothing. Nobody notices, because it looks like output.

**Why N=3:** the 1st emission is the honest labeling Rule 2 MANDATES, the 2nd can be a fix in flight; by the 3rd it has survived two chances to change. 3 is the corpus's own "pattern, not incident" constant (`trust-posture.md` MUST-4) — inherited, not invented.

## Skip-Class Carve-Out

A DECLARED "N inherited-canon-CLEAN artifacts skipped (reviewed upstream)" line from the fork dual-surface seat (`commands/redteam.md` § Step 0.5) does not trigger Rule 1 — byte-identical-to-canon was reviewed upstream by construction, and the count IS the Rule-2 trail. An UNDECLARED skip stays a Rule-1 substitution.

## MUST NOT

- Silently substitute a cheaper tool for a mandated protocol step

**Why:** The originating failure mode — invisible to readers, propagates as institutional drift.

- Cite "yesterday's sweep did the same" as authorization

**Why:** Yesterday's substitution was its own failure; treating it as precedent compounds the gap.

- Label the proxy's output as the mandated step's result

**Why:** It removes the audit trail that lets the next reader know the step didn't run.

- Re-emit an unadjudicated verdict at or past the 3-run threshold without escalating or dispositioning it

**Why:** Repetition is the only signal a placeholder has become permanent; suppressing it leaves a dead gate printing forever.

**Distinct from**: `rules/time-pressure-discipline.md` blocks drops from USER pressure framings; this blocks drops from the agent's OWN cost calculus (1–3) and from INERTIA (4).

## Trust Posture Wiring — MUST-4 (unadjudicated-verdict escalation)

Applies to **MUST-4** + its § MUST NOT bullet ONLY (2026-08-16); canonical-8-field per `trust-posture.md` MUST-8. Rules 1–3 stay grandfathered (2026-05-04) until `/codify`-touched. Per-field rationale: extract § MUST-4 Wiring.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify`, reviewer at `/redteam`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (re-emission at/past threshold with neither escalation nor live disposition; a disposition lacking `owner`/`issue`/`until`; one extended past expiry) route to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1) — NO dedicated key; named deviation per `trust-posture.md` Rule 8 (extract).
- **Receipt requirement:** SessionStart soft-gate `[ack: sweep-completeness]` IFF `posture.json::pending_verification` includes the `sweep-completeness` rule_id.
- **Detection mechanism:** structural + review. Scanner `.claude/bin/unadjudicated-escalation.mjs` derives the streak from the COMMITTED sweep reports — durable receipts, never a private counter a session could reset. Fixtures `.claude/audit-fixtures/unadjudicated-escalation/` are BIPOLAR (escalating AND non-escalating runs, plus invalid-disposition and streak-broken poles), in `ci-audit-fixtures.json`. Probes `.claude/test-harness/probes/sweep-completeness.probes.json` — MUST-4 pair + meta pair, `scanner: null`, pinned in `PINNED_SUITES`, dispatched via `/test-harness-probe`, never in CI, so a green CI run is NEVER evidence they passed. AUTHORED, not deferred.
- **Violation scope:** MUST-4 + its § MUST NOT bullet ONLY.
- **Origin:** See § Origin (loom#1722).

Origin: 2026-05-04 — `/sweep` reported 0 CRIT/HIGH after substituting cite-check for the mandated Sweep 5 protocol. **MUST-4 — 2026-08-16 (loom#1722):** Sweep 5 emitted `manual-supplement-required` for FIVE consecutive sessions where repo-level-specs mode blocks the N/A sentinel and no equivalent check exists — an honest label that had become a permanent non-answer, because a check that NEVER discriminates was never escalated, only re-printed.
