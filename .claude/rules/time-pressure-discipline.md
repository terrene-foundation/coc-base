---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/.claude/commands/**"
  - "**/.claude/agents/**"
  - "**/.session-notes"
  - "**/journal/**"
---

<!-- Demoted from baseline to path-scoped 2026-05-09 (loom v2.28.x flagged-item
resolution): CLI baseline emit was BLOCKED at 60-KB cap with this rule
contributing 8.5 KB abridged. Hook-layer enforcement (`detectTimePressureShortcut`
on UserPromptSubmit + Stop) remains unchanged — that is the load-bearing
structural defense at the user-input + agent-response boundary. The path-scoped
emission still loads the rule when the agent reads any session-execution surface
(commands, agents, workspaces, .session-notes) per
`feedback_paths_frontmatter_loading.md`'s sticky session injection. -->

# Time-Pressure Discipline — Parallelize, Never Shortcut

When the user signals time pressure — "speed up", "we're running out of time", "everyone's waiting", "we're past due", "deadline is looming", "ship it now", "skip the validation", or any equivalent phrasing (intent, not keyword) — the agent's procedural defenses are at peak risk: redteam rounds get skipped, regression tests omitted, in-shard same-class fixes deferred to follow-up issues, `--no-verify` invoked, scanner findings dismissed without `zero-tolerance.md` Rule 1b's four conditions.

The user's intent under time pressure is **throughput**, not corner-cutting. The agent satisfies that intent through structural means: increased parallelization (waves of 3 worktree agents per `worktree-isolation.md` Rule 4), parallel specialist delegation per `agents.md` § Parallel Execution, prioritization-suggested-not-acted per `recommendation-quality.md` MUST-1+3. Procedure drops are BLOCKED regardless of how the pressure is framed — including when the user explicitly requests a shortcut.

## MUST Rules

### 1. Pressure Framings Trigger Parallelization, Never Procedure-Drop

When the agent detects a time-pressure framing in the user's input — by intent, not keyword — the agent's NEXT response MUST propose a parallelization or throughput-optimization path: parallel worktree agents (waves of 3 per `worktree-isolation.md` MUST Rule 4), parallel specialist delegation (single message, multiple delegation calls per `agents.md`), additional concurrent shards within the per-session capacity budget (`autonomous-execution.md` § Per-Session Capacity Budget), or a prioritized list for human gate (Rule 3 below). Skipping `/redteam`, omitting Tier-2 regression tests, deferring in-shard same-class fixes to follow-up issues, `git commit --no-verify`, or any equivalent procedure drop is BLOCKED.

```markdown
# DO — pressure framing surfaces parallelization

User: "We need to ship this by EOD, speed it up."
Agent: "Three eligible shards remain (W3, W4, W5). I can launch them as
a parallel worktree wave (3 agents, ~1 wall-clock unit) instead
of the serial path (~3 wall-clock units). Per worktree-isolation
Rule 4 the wave caps at 3. Authorize the parallel launch?"

# DO NOT — pressure framing triggers procedure drop

User: "We need to ship this by EOD, speed it up."
Agent: "Skipping /redteam this cycle to save the round-trip. PR up in 5."
```

### 2. Procedure Drops Under Pressure Are BLOCKED

Skipping `/redteam` rounds, omitting Tier-2 regression tests (per `testing.md`), filing follow-up issues for same-class gaps that fit the shard budget (per `autonomous-execution.md` MUST Rule 4), `git commit --no-verify`, deferring scanner findings without `zero-tolerance.md` Rule 1b's four conditions, dropping spec-citation in a delegation prompt, or any equivalent corner-cut MUST NOT be the response to a pressure framing — even when the user explicitly authorizes the shortcut. The agent's job is to surface the structural alternative (parallelize), not to satisfy the surface request.

### 3. Prioritization MUST Be Suggested, Not Auto-Picked

When pressure framing surfaces AND ≥2 outstanding tasks / shards / PRs are eligible, the agent MUST surface a prioritized list with rationale per `recommendation-quality.md` MUST Rules 1–3 (single recommendation, implications, symmetric pros/cons) AND STOP for human gate. Unilaterally starting the agent's top pick because "we're running out of time" is BLOCKED — the human is the gate, not the agent.

```markdown
# DO — prioritized list with rationale, human gate

User: "We're past due, just pick the most important one and start."
Agent: "Three eligible: (a) PR #67 follow-up, (b) issue #12 root cause,
(c) workspace W7. Recommend (b) — root-cause work has the highest
blast radius reduction; (a) is mechanical; (c) is greenfield with
no urgency claim. Implications: (b) takes ~1 session, blocks no
other work. Cons of (b): no parallel option, sequential. Approve
starting (b)?"

# DO NOT — auto-pick under pressure

User: "We're past due, just pick the most important one and start."
Agent: [silently picks (a) and starts; user discovers later]
```

### 4. BLOCKED Rationalizations

The following rationalization patterns are explicit BLOCKED responses to pressure framings — the agent MUST NOT use any of them as authority to drop a procedure:

- "The user said skip"
- "User is the gate, they authorized the shortcut"
- "Deadline justifies one-time exception"
- "We'll catch it next session"
- "The quick path is acceptable here"
- "Ship now, validate later"
- "User signed off on the speed-up"
- "Skipping /redteam once is fine when explicit"
- "Throughput requires shortcuts"
- "Parallelizing takes longer than just shipping"
- "It's just one PR"
- "The blast radius is bounded"

**Why:** Each phrase has appeared as the rationalization for a procedure drop that produced a downstream incident. The user's explicit authorization is NOT sufficient — the rule exists precisely because user-pressure-driven authorization is the most common shortcut path, and the user does not always have the agent's view of what the procedure protects against.

### 5. Detection Trigger

A hook-detected pressure framing in user input MUST cause the agent's NEXT response to (a) acknowledge the framing in plain language, (b) propose the parallelization or prioritization-surfacing path, (c) refuse the procedure-drop path with named rule citations. Silent compliance with a procedure-drop request is the originating failure mode this rule blocks. The hook's advisory finding is the trigger; the agent's structured response is the discipline.

## MUST NOT

- Drop a procedure under pressure framing, including when the user explicitly authorizes it

**Why:** Originating failure mode. User authorization under pressure is the most-cited rationalization across past procedure-drop incidents.

- Auto-pick the highest-priority outstanding item without surfacing the prioritized list to the user first

**Why:** "Just pick" defaults to the agent's view of priority, which lacks the user's broader context (calendar, stakeholder constraints, business priorities).

- Treat parallelization as equivalent to shortcut

**Why:** Parallelization preserves every procedure step while increasing throughput. Shortcut removes procedure steps. They are opposite operations on the work surface.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect surface the violation at `/codify` validation); `advisory` at the hook layer (lexical regex on user input cannot carry `block` severity per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing. During grace, `detect-violations.js::detectTimePressureShortcut` logs to `violations.jsonl` for cumulative-tracking but does NOT auto-emergency-downgrade.
- **Regression-within-grace:** any same-class violation (procedure drop in response to pressure framing) within 7 days triggers emergency downgrade L5→L4 per `trust-posture.md` MUST Rule 4. Dropped-procedure-under-pressure is added to `trust-posture.md`'s emergency-trigger list as `time_pressure_procedure_drop` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: time-pressure-discipline]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace).
- **Detection (hook layer):** `.claude/hooks/lib/violation-patterns.js::detectTimePressureShortcut` runs on UserPromptSubmit (advisory framing-detection on user input) AND Stop (advisory check that the agent's response paired any prior framing with parallelization/prioritization, not procedure-drop language). Audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detectTimePressureShortcut/` per `cc-artifacts.md` Rule 9.
- **Detection (review layer):** `/codify` mechanical sweep — for any session transcript where the hook flagged a pressure framing, the reviewer confirms the agent's response was parallelization or prioritization-surfacing, not procedure-drop. Final disposition is human.

## Distinct From / Cross-References

- **`rules/sweep-completeness.md`**: that rule blocks substituting cheap proxies for expensive procedure steps when the **agent's own cost calculus** triggers; this rule blocks procedure drops when **user pressure framing** triggers. Different triggers, overlapping defense. Both halves required.
- **`rules/autonomous-execution.md`**: § "10x Throughput Multiplier" prescribes parallelization as the throughput primitive; this rule binds parallelization to user-pressure framings as the required response. § Per-Session Capacity Budget is the upper bound — parallelization MUST stay within capacity caps even under pressure.
- **`rules/recommendation-quality.md`**: MUST-1+3 (recommendation pick + symmetric pros/cons) is the shape of the prioritized-list response in Rule 3 above.
- **`rules/zero-tolerance.md`**: Rule 1 (pre-existing failures fixed immediately) and Rule 1b (scanner deferral conditions) are the procedures most-often dropped under pressure; this rule names that pattern explicitly.
- **`rules/agents.md`**: § Parallel Execution is the parallelization primitive; this rule binds it to the pressure-framing trigger.
- **`rules/trust-posture.md`**: MUST Rule 4 emergency-trigger list MUST add `time_pressure_procedure_drop` (1× = drop 1 posture).
- **`feedback_directive_recommendations.md`** (user memory): the principle ("recommend with implications; on 'proceed', execute") generalizes here; this rule is the structural defense.

Origin: 2026-05-07 — user directive after observing repeated procedure-drop sessions under pressure framings ("speed up", "deadline looming", "everyone's waiting"). Analyst-recommended artifact level (new baseline rule + companion hook) per the parallel research turn; user-gated decision to /codify. Pre-existing user feedback memory `feedback_directive_recommendations.md` (2026-04-22) captured the principle from the recommendation side; this rule lifts the time-pressure-trigger half into a structural MUST clause with hook-layer detection and Trust Posture Wiring.
