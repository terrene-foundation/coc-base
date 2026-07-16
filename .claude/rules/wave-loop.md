---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/todos/**"
  - "**/.claude/commands/**"
  - "**/02-plans/**"
---

# Wave-Loop — Verify-And-Feed-Forward Between Milestone-Groups

Autonomous coding today runs `analyze → plan → todos → implement → ONE terminal /redteam`:
`/todos` writes every todo once, `/implement` drains `todos/active/` to empty, `/redteam`
runs once at the end feeding gaps only back to `/implement`. Verification **deferred to the
end** means a defect injected at any handoff (analysis→plan→todos→implement — each loses
fidelity) is not caught until the terminal redteam, by which point fixing it re-touches many
already-"completed" todos. That terminal-verification design IS the
implement→redteam→QA→fix→repeat loop that runs countless times.

The wave-loop inserts a **verify-and-feed-forward gate between milestone-groups**. It adds NO
new phase — it makes the existing `redteam → codify → (re-)todos → implement` loop
**re-entrant per milestone-group**, so drift is caught and fed forward at each boundary
instead of compounding silently. Convergence (`commands/redteam.md` § Convergence Criteria)
and parallel-decompose (`rules/agents.md` § Decompose Onto The Parallel Primitive By Default)
are REUSED unchanged, scoped to the wave; this rule does not restate them.

## MUST Rules

### 1. A Wave Is One Value-Ranked Milestone-Group Of Budget-Fitting Shards

A **wave** is exactly ONE value-ranked milestone-group (`commands/todos.md` § "numbered
milestones/groups", ranked per `rules/value-prioritization.md` MUST-1) whose every todo has
been sharded to fit `rules/autonomous-execution.md` § Per-Session Capacity Budget MUST-1.
THREE bounds hold simultaneously; violating any is BLOCKED:

- **Lower bound (anti-per-todo).** The gate fires at the milestone-GROUP boundary, never per
  shard. Per-shard convergence is BLOCKED — it overflows the verification-attention budget
  the other way and degrades into ritual.
- **Upper bound A (anti-whole-project, value axis).** A project with ≥2 value-distinct
  milestone-groups MUST decompose into ≥2 waves, so ≥1 inter-wave gate fires before the
  terminal redteam. One-wave-equals-whole-project reproduces today's deferred-verification
  failure and is BLOCKED.
- **Upper bound B (anti-overflow, invariant-surface axis).** A wave's CUMULATIVE
  load-bearing-invariant surface (the union of its shards' tracked invariants) MUST be ≤10
  base, OR ≤30–50 with a live executable convergence/eval harness (the
  `rules/autonomous-execution.md` MUST-3 feedback-loop multiplier). A milestone-group whose
  shard-union exceeds this MUST split into ≥2 waves at the invariant boundary — **even when
  value-coherent.** The wave gate thereby inherits the shard gate's attention ceiling at the
  aggregate; without it a value-coherent 8-shard wave (~50 invariants) "converges clean" on a
  surface too large to hold — `rules/sweep-completeness.md` theatre one layer up.

**Serial carve-out (the value gate, mirrors `rules/agents.md` § Decompose-By-Default).** A
genuinely single-milestone, single-convergence-surface project (one ≤500-LOC fix, one
invariant set) MAY run as ONE wave — its terminal `/redteam` IS its only wave gate. The
serial case MUST stay serial; forcing a ≥2-wave split on it is the per-todo ceremony this
rule forbids.

**Declaration is compulsory — it is the gate's on-ramp (the rule is inert without it).**
Every `/todos` plan MUST declare an EXPLICIT wave sequence (Wave 1…N, N≥1). The serial
carve-out is a one-wave declaration WITH its stated one-milestone/one-convergence-surface
justification — NEVER the silent absence of a declaration. A multi-shard plan that declares
no wave sequence, OR that collapses ≥2 value-distinct milestone-groups (or a shard-union
exceeding bound-B) into one wave WITHOUT a stated justification, is BLOCKED — an undeclared or
under-declared plan makes the MUST-2 inter-wave gate inert by construction (no boundary to
fire at), converting "no wave structure" from an invisible default into an explicit,
challengeable claim the `/todos` gate and detection sweep can test.

```markdown
# DO — multi-group decomposed into value-ranked waves; invariant-split when needed

Wave 1 (HIGH, ~6 inv): auth service + session store
Wave 2a/2b (MED): "billing engine" unions 9 shards ≈ 48 inv, no live harness →
split at the invariant boundary EVEN THOUGH value-coherent

# DO NOT — value-coherent mega-wave that overflows the convergence pass

Wave 1 = entire "billing engine" milestone, 9 shards ≈ 48 inv, one /redteam
("it's all one feature, the invariants relate") → clean verdict on an unholdable surface
```

**BLOCKED rationalizations:** "redteam each todo to be safe" / "per-shard convergence is
more rigorous" (anti-per-todo) · "it's all one feature, one wave is fine" / "we'll redteam
at the end like always" (anti-whole-project) · "it's one milestone, the invariants all
relate" / "the convergence pass can hold all the shards' invariants" / "value-coherent
means one wave" (anti-overflow) · "I'll just write the flat todo list" / "wave declaration is
for big projects only" / "the plan is obvious, no need to declare waves" / "I'll decide waves
at `/implement` time" (anti-no-declaration — the gate cannot fire on an undeclared plan).

**Why:** The shard gate bounds IMPLEMENTATION attention; the wave gate bounds VERIFICATION
attention — the same budget (`rules/autonomous-execution.md` MUST-1 "context window is not
attention"), one phase up. The value axis alone lets a value-coherent high-invariant wave
overflow invisibly; the invariant axis alone lets a low-invariant whole-project wave defer to
the end. Both bounds required.

### 2. The Inter-Wave Gate Fires At Every Boundary Except After The Final Wave

At the completion of every wave that is NOT the last, the orchestrator MUST run the
inter-wave gate G1→G5 before launching the next wave. Each step re-sequences EXISTING
machinery; the gate adds no new phase. Launching wave N+1 before G1–G4 complete clean is
BLOCKED.

| Step                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reuses                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **G1 — redteam to convergence**             | `/redteam` scoped to THIS wave's shards, to full Convergence Criteria (`commands/redteam.md` § Convergence Criteria), posture-invariant — convergence is on **BUG + INVEST-NOW findings only** (`commands/redteam.md` § Category-Based Finding Triage / `rules/product-completion-first.md`); INCREMENTAL findings accrete to the deferred-quality backlog carried to the terminal `/sweep`, and do NOT reset the wave's clean-round counter                                                                                                                                     | `/redteam` + `agents.md` § Redteam Reviewer Dispatch (criterion-3 evidence gate) |
| **G2 — capture the learning (LIGHTWEIGHT)** | Record the delta between what the wave's todos CLAIMED and what its redteam FOUND (misunderstanding, plan-drift, spec-divergence) as a journal `DISCOVERY`/`GAP` + a first-instance spec update **+ a `.session-notes` refresh** (a wave boundary IS a close-out — the `/wrapup` contract runs WITH the wave-close, staged into the wave-close commit, NOT as a separate manual `/wrapup`). **Full `/codify` is RESERVED for genuinely cross-project learnings — NOT run every wave** (avoids N codify-lease/PR cycles per project per `rules/knowledge-convergence.md` MUST-3). | `commands/journal.md`; `commands/wrapup.md`; `rules/specs-authority.md` Rule 5   |
| **G3 — update specs + remaining todos**     | First-instance spec update + sibling re-derivation sweep; amend UNSTARTED later-wave todos for version/symbol/signature drift the wave caused                                                                                                                                                                                                                                                                                                                                                                                                                                    | `rules/specs-authority.md` Rule 5/5b/5c                                          |
| **G4 — re-value-rank**                      | Re-rank the remaining waves and re-validate every deferred value-anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `rules/value-prioritization.md` MUST-1 + MUST-3                                  |
| **G5 — launch next wave**                   | Only after G1–G4 are clean; decompose onto the parallel primitive when the wave is ≥3 independent shards                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `rules/agents.md` § Decompose-By-Default                                         |

```markdown
# DO — gate fires, learning feeds forward, THEN next wave

Wave 1 complete → G1 /redteam converges (2 clean) → G2 journal GAP "plan assumed sync
API, service is async" → G3 spec + Wave-2 todos amended to async → G4 re-rank → G5 launch

# DO NOT — drain todos/active across the boundary with no gate

Wave 1 todos done → immediately start Wave 2 todos ("keep momentum") → Wave 1's
async-vs-sync drift silently propagates into Wave 2 and surfaces only at terminal redteam
```

**BLOCKED rationalizations:** "keep the momentum, gate at the end" / "the wave converged,
the next wave is independent" / "G2/G3/G4 are overhead between waves" / "we'll feed the
learning forward when we hit a problem".

**Why:** The whole defect-compounding failure mode is verification deferred past the
boundary where the learning is cheapest to apply. G1–G4 apply it at the boundary; G5 only
proceeds on a clean, fed-forward base.

### 3. The Wave-Gate Redteam Runs To Convergence (Per-Wave Instantiation Of 4a)

G1 runs `/redteam` to full convergence per `commands/redteam.md` § Convergence Criteria,
scoped to the wave, posture-invariant. Shipping a wave before its redteam reaches 2
consecutive clean rounds **on BUG + INVEST-NOW findings** (`commands/redteam.md` § Category-Based
Finding Triage / `rules/product-completion-first.md`; INCREMENTAL findings accrete to the
deferred-quality backlog carried to the terminal `/sweep` and do NOT reset the wave's clean-round
counter) is BLOCKED — the terminal-redteam obligation, fired per wave. This
rule binds the criteria and adds only the wave-local amplification below; it does not
re-derive them. **The per-wave design runs N boundary redteam rounds vs the terminal design's
one — multiplying throttle exposure — so G1 MUST honor the errored-reviewer evidence gate
(criterion 3 of the § Convergence Criteria G1 binds, per `rules/agents.md` § "Redteam Reviewer
Dispatch — Errored/Empty Is Zero Evidence" + `rules/evidence-first-claims.md` MUST-3): a G1
"clean round" counts ONLY when EVERY dispatched reviewer genuinely ran — a false-converged
wave feeds an un-reviewed base into G5's next wave. On the `rules/worktree-isolation.md`
Rule 4 synchronized-throttle signal, back off dispatch concurrency and re-run the throttled
reviewers before claiming G1 convergence.**

### 4. Later Waves Are Provisional, Re-Validated At Each Boundary — Not Frozen

`/todos` still writes ALL todos once (filtering scope is BLOCKED; the forest MUST stay
visible per `rules/value-prioritization.md` MUST-1). What changes: not-yet-started-wave todos
are **PROVISIONAL** — at each gate they are amended per `rules/specs-authority.md` Rule 5c and
re-ranked per `rules/value-prioritization.md` MUST-3 (G3/G4). The wave boundary IS the
re-validation trigger. Treating later-wave todos as frozen-final, OR deleting them to "wave 1
only" (losing forest visibility), is BLOCKED.

### 5. Wave-Boundary Convergence/Codify/Update Claims Cite Durable Receipts (Anti-Theatre)

Every wave-boundary claim ("Wave N converged", "learning codified", "specs/todos updated",
"re-ranked") MUST cite a durable external receipt per `rules/verify-resource-existence.md`
MUST-4: a journal entry, commit SHA, or `observations.jsonl` round-verdict. Self-attestation
in the disposition document ("Wave 2 converged ✓") is BLOCKED — structurally identical to the
self-attested verdict MUST-4 already blocks. Binds the existing rail; invents none.

## MUST NOT

- Size a wave by value-coherence alone, ignoring the cumulative invariant surface.

**Why:** A value-coherent milestone can union far more invariants than one convergence pass
can hold; the value axis does not bound the verification-attention budget (MUST-1 bound B).

- Run a full `/codify` at every wave boundary as the default G2.

**Why:** Per-wave full `/codify` produces N codify-lease/PR cycles per project
(`rules/knowledge-convergence.md` MUST-3 contention); lightweight journal+spec capture is the
default, full `/codify` reserved for cross-project learnings.

- Convert the inter-wave gate into a human approval gate.

**Why:** The inter-wave gate is an EXECUTION gate (`rules/autonomous-execution.md` §
Structural vs Execution Gates); the structural human gates remain `/todos` plan-approval and
`/release`. Human-on-the-Loop, not in-the-loop.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at `/codify` gate-review (cc-architect / reviewer greps
  the workspace journal for a per-wave-boundary convergence receipt + a re-value-rank
  receipt). No `block` — the signal is a review-layer judgment, not a structural tool-call
  primitive (`rules/hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (a wave launched without its gate; a
  mega-wave overflowing the invariant ceiling; a self-attested wave verdict) contribute to
  `rules/trust-posture.md` MUST Rule 4 cumulative math (3× same-rule / 5× total in 30d → drop
  1 posture).
- **Regression-within-grace:** any same-class violation within 7 days → emergency downgrade
  L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `wave_gate_skipped` added to
  that rule's emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: wave-loop]` in the agent's first
  response IF `posture.json::pending_verification` includes this rule_id. Soft-gate.
- **Detection mechanism:** Phase 1 — cc-architect / reviewer mechanical sweep at `/todos` +
  `/codify` + `/redteam`. **(0) Declaration check (the on-ramp): EVERY `/todos` plan MUST
  carry an explicit wave-sequence declaration; a multi-shard plan with no declared wave
  sequence, OR ≥2 value-distinct milestone-groups / a bound-B-exceeding shard-union collapsed
  to one wave without a stated justification, is the violation** — this fires on the
  undeclared/under-declared case, NOT only on already-multi-wave workspaces. (1) Any multi-wave
  workspace MUST then show (a) a journal convergence receipt per non-final wave (MUST-5), (b) a
  re-value-rank receipt per boundary (G4), (c) no wave's shard-union exceeding the MUST-1
  bound-B ceiling, (d) each non-final wave's convergence receipt names the full reviewer wave
  AND confirms every dispatched reviewer returned a genuine ran-signal (no errored / empty /
  timed-out / throttled reviewer counted toward a clean round) per the MUST-3 evidence-gate — a
  receipt-present-but-false-converged wave passes (a) yet fails (d). Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3
  real wave-loop projects): a `.claude/hooks/lib/violation-patterns.js` Stop-event detector
  (advisory) + audit fixtures at `.claude/audit-fixtures/wave-loop/` per `rules/cc-artifacts.md`
  Rule 9.
- **Violation scope:** MUST 1 (wave sizing — three bounds + compulsory wave-declaration), MUST 2 (gate fires every
  non-final boundary), MUST 3 (G1 reaches GENUINE convergence — a clean round counts only when every dispatched
  reviewer ran; a false-converged wave is a MUST-3 violation), MUST 5 (durable receipt). Every `violations.jsonl`
  row records which MUST clause fired.
- **Origin:** See § Origin below.

## Distinct From / Cross-References

- **Composes with (does not restate):** `commands/redteam.md` § Convergence Criteria (G1/
  MUST-3) — incl. criterion 3's errored-reviewer evidence-gate; `rules/agents.md` § "Redteam
  Reviewer Dispatch — Errored/Empty Is Zero Evidence" (the G1 evidence-gate MUST-3 binds) +
  § Decompose-By-Default (G5/serial carve-out);
  `rules/value-prioritization.md` MUST-1+3 (G4 + later-wave re-validation);
  `rules/specs-authority.md` Rule 5/5b/5c (G2/G3); `rules/autonomous-execution.md` §
  Per-Session Capacity Budget (the shard gate the wave gate sits above) + § Structural vs
  Execution Gates; `rules/verify-resource-existence.md` MUST-4 (MUST-5 rail);
  `rules/knowledge-convergence.md` MUST-3 (why G2 is lightweight).
- **Distinct from:** `rules/sweep-completeness.md` blocks substituting a cheaper proxy for a
  mandated step; this rule blocks deferring verification past the wave boundary. Both guard
  verification theatre, different triggers.

## Origin

2026-06-06 — co-owner-directed origination (`rules/artifact-flow.md` § Co-Owner-Directed
Origination); verbatim directive + receipt-first journal `journal/0226`. Designed by a
9-agent analysis workflow (5 analysts → synthesis → 3 adversarial reviewers, workspace
`workspaces/autonomous-wave-loop/`), validated by the authoring-side meta-ablation at
`.claude/test-harness/tests/wave-loop-ablation.test.mjs`. MUST-1 bound B (invariant-surface)
originates from the ceremony-axis review; the MUST-3/4/5 reference-binding collapse from the
duplication review. MUST-1 + MUST-2 are the genuinely-new load-bearing content; MUST-3/4/5
are reference-bindings to the rules they compose with.

**Length rationale (per `rules/rule-authoring.md` MUST NOT length cap).** ~252 lines, over the
200 guidance. Named rationale: the body is already minimized — MUST-3/4/5 are collapsed to
reference-bindings and the duplicative `agents.md` clause was dropped per the duplication
review — and the residual is structural: the mandatory 8-field Trust Posture Wiring
(`trust-posture.md` MUST-8, ~22 lines) + the 5-step G1→G5 gate table + the 3-bound wave
definition + the **compulsory-declaration clause** (the gate's on-ramp — without it the rule
is inert, per the 2026-06-07 co-owner review) are each load-bearing and non-decomposable.
Sibling precedent: `user-flow-validation.md` + `multi-operator-coordination.md` Origins.
