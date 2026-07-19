# Parallel-Dispatch-Default — The Triad Execution Mode + Brief-Claim Verification (depth)

Companion to `rules/agents.md` § "The Default Execution Mode Is The Triad" and § "Parallel
Brief-Claim Verification". The rule carries the CLI-neutral MUST contracts; this file carries
the DO/DO-NOT blocks, the BLOCKED-rationalization corpora, the bounding-gate enumeration, and
the Why paragraphs the rule points to. Loaded on-demand when orchestrating a wave.

## 1. The Triad Is The Default Execution Mode

The default execution mode for every actionable input is the TRIAD, each DEFAULT-ON:

1. **Parallelize** — dispatch onto the parallel primitive (a Workflow or parallel agent
   delegation) by DEFAULT, not serial/inline, not only under `/autonomize`; wherever the input
   has ≥2 independent sub-parts, decompose onto ONE parallel wave.
2. **/autonomize** — execute autonomously under the permission envelope: recommend AND take the
   optimal, root-cause, evidence-backed fix, no question-spam (`commands/autonomize.md`).
3. **/redteam-to-convergence** — every substantive change is adversarially verified to 2
   consecutive clean rounds before "done" (this REINFORCES, does not restate, `rules/agents.md`
   § Quality Gates + § Holistic Post-Multi-Wave Redteam + `rules/self-referential-codify.md`
   Rule 1).

```text
# DO — actionable input with ≥2 independent sub-parts → ONE parallel wave, autonomized,
#      then redteamed to 2 consecutive clean rounds before calling it done
# DO NOT — execute a decomposable input inline-serially, or idle while an independent
#          shard is dispatchable, or call it "done" before the redteam converges
```

**Serial carve-out (keep).** Drops to SERIAL/inline ONLY for a genuinely-atomic single-item
task (one indivisible unit) OR a factual/confirmation/recommendation reply — a one-liner needs
no workflow and no redteam. Forcing a workflow onto a 1-item serial task is pure latency
overhead; the carve-out is the anti-"always-workflow" gate.

**BLOCKED rationalizations:**

- "the triad needs `/autonomize` to be invoked first" (NO — it is the DEFAULT, not an opt-in)
- "parallel-by-default is my call each session"
- "serial is simpler, I'll decompose later"
- "`/redteam` is a separate phase, not part of doing the work"
- "a clear pick means I can skip the redteam"
- "keep-executing means I override the gate" (NO — the triad fills the default posture; it
  NEVER overrides a gate)

**Bounded by the SAME gates as `rules/wave-loop.md` MUST-6** (cross-ref, not restated): genuine
data/build dependencies; the structural human gates (`rules/autonomous-execution.md` §
Structural vs Execution Gates — plan-approval, release); capacity + throttle
(`rules/autonomous-execution.md` § Per-Session Capacity Budget + `rules/worktree-isolation.md`
Rule 4); prudence/sensitivity confirmation (`commands/autonomize.md` § Prudence +
`rules/recommendation-quality.md` MUST-8); the clean-gate-stop (`rules/recommendation-quality.md`
MUST-3). `/autonomize` is self-bounding — it already mandates confirming destructive /
hard-to-reverse / sensitivity-elevating actions.

**Why:** the triad is the baseline throughput+quality response, not a per-session opt-in; the
atomic/factual serial carve-out prevents over-decomposing a one-liner into a workflow; the
bounding gates ensure "always executing" never degrades into "always overriding a gate".

## 2. Parallel Brief-Claim Verification When Issue Count ≥ 3 (extracted depth)

The rule's MUST: when `/analyze` runs against a brief covering ≥ 3 distinct issues, the
orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to
independently re-grep / re-read every factual claim. Inaccuracies MUST be recorded in the
workspace journal AND the plan's "Brief corrections" section AS THE GATE before `/todos`.
Single-agent analysis on a ≥3-issue brief is BLOCKED.

**BLOCKED rationalizations:**

- "The brief was authored by the user, it must be accurate"
- "Sequential single-agent analysis catches inaccuracies anyway"
- "Three parallel agents triple the cost for the same conclusion"
- "I'll spot-check a couple of claims, that's good enough"
- "Brief verification is /redteam's job, not /analyze's"
- "The brief's claims are 'mostly correct', the rounding errors don't change the plan"
- "If a claim turns out wrong, /todos can correct it"

**Why:** Briefs reflect the author's mental model, which decays as code evolves; single-agent
analysis cannot resist the brief's framing without independent reading. Parallel deep-dive
verification is the structural defense — N agents, N claim-clusters, one wall-clock unit.

## CLI dispatch syntax

The concrete `Agent(subagent_type=…)` (CC) / `bin/coc` inline-cat (Codex) / `@specialist`
(Gemini) delegation code lives in `specialist-delegation-syntax.md` (the `examples` slot
target). This file is CLI-neutral depth; that file is the per-CLI mapping.
