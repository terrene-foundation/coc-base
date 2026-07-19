---
id: "ORCHESTRATION-LAUNCH-LEDGER"
paths: ["**/workspaces/**", "**/.session-notes*", "journal/**"]
---

# Orchestration Launch-Ledger — Track Spawned Agents In A Durable Artifact That Survives Context Boundaries

An orchestrator that spawns background / parallel agents holds the map of what it launched — track → agent → branch → status — in WORKING MEMORY. A context boundary (compaction, `/clear`, resume, sub-agent handoff) ERASES that memory while the agents keep running. On the far side the orchestrator (a) spawns a DUPLICATE of a track already in-flight, and (b) mis-attributes its OWN already-pushed branches to a "parallel session" it did not launch. The fix is a DURABLE artifact: an on-disk launch-ledger the compaction cannot erase, consulted BEFORE every spawn and matched AGAINST every completion notification.

This rule owns the DURABLE-LEDGER + DEDUP-BEFORE-SPAWN + MATCH-COMPLETION-BEFORE-REACTING discipline. It composes with the orchestration rules that govern WHEN to parallelize and WHETHER work is real — it does not restate them (§ Distinct From).

## MUST Rules

### 1. An Orchestrator Spawning Background Agents MUST Maintain A Durable On-Disk Launch-Ledger

Any orchestrator that spawns ≥1 background / parallel / worktree-isolated agent MUST record each launch in a DURABLE on-disk ledger — a table in the active workspace, `.session-notes`, or a workspace ledger file — that SURVIVES compaction. Each row maps: track/shard → agent id-or-name → branch (if any) → status (`in-flight` / `landed` / `stopped`). In-memory-only tracking (relying on the transcript / working memory to remember what was launched) is BLOCKED — the transcript is exactly what the context boundary erases.

```markdown
# DO — durable ledger row per launched agent, written before/at spawn

| track          | agent     | branch        | status    |
| -------------- | --------- | ------------- | --------- |
| engine-feature | W2-engine | feat/engine-x | in-flight |
| store-adapter  | W2-store  | feat/store-y  | in-flight |

# DO NOT — hold the launch map in working memory only

"I've launched the engine + store agents; I'll remember them." (a compaction erases this)
```

**Why:** The launch map in working memory is destroyed by the exact event (compaction / `/clear` / resume) the orchestrator cannot predict; a durable on-disk row is the only copy that survives to the far side of the boundary where dedup and attribution actually happen.

### 2. Check The Ledger BEFORE Spawning — Never Spawn A Track Already Present

Before spawning any agent, the orchestrator MUST consult the launch-ledger and confirm the track is NOT already present as `in-flight` (or `landed`). Spawning a track that the ledger shows already running is BLOCKED — that is the duplicate-agent failure mode directly. If the ledger is absent or stale, RECONCILE it (re-read the workspace / `git branch` / the task registry) BEFORE spawning, not after the collision surfaces.

```markdown
# DO — consult the ledger, find store-adapter already in-flight, do NOT re-spawn

Ledger shows `store-adapter → W2-store → in-flight` → skip; monitor the existing agent.

# DO NOT — spawn without checking → duplicate of an already-running track

Spawn a second store-adapter agent (the first fell out of context after a compaction)
```

**Why:** The duplicate spawn wastes the run, races the original for the same branch/scope, and is invisible until the collision surfaces at merge; a 2-second ledger read before every spawn converts a silent duplicate into a no-op skip.

### 3. Match Every Completion Notification Against The Ledger BEFORE Reacting

When an agent-completion notification arrives, the orchestrator MUST match its agent id/name against the launch-ledger BEFORE reacting to the landed work. A branch/PR the ledger attributes to a SELF-LAUNCHED agent MUST NOT be reasoned about as another session's output. Reacting to a completion (merging, re-launching, re-attributing) WITHOUT the ledger match is BLOCKED.

```markdown
# DO — notification for W2-store → match ledger row → it is MY launch, treat as such

Completion: agent W2-store, branch feat/store-y → ledger row confirms self-launched → merge as planned

# DO NOT — react to a self-launched landed branch as a "parallel session's" work

"feat/store-y appeared — another session must have produced it" (the ledger shows YOU launched it)
```

**Why:** A self-launched branch mis-read as external work leads the orchestrator to either re-do it, abandon it, or reason about phantom concurrent sessions — the mis-attribution half of the amnesia failure; the ledger match is the one check that tells own-work from other-work after the boundary.

## MUST NOT

- Spawn a background / parallel agent whose track the launch-ledger already shows `in-flight` or `landed`

**Why:** The originating duplicate-agent failure mode — spawning a track already running wastes the run and races the original.

- React to an agent-completion notification (merge / re-launch / re-attribute) without first matching its agent id against the ledger

**Why:** Without the match, a self-launched landed branch is mis-attributed to a "parallel session," and the orchestrator reasons about work it actually produced as if it were external.

- Rely on the session transcript / working memory as the launch record instead of a durable on-disk ledger

**Why:** The transcript is precisely what compaction / `/clear` / resume erases; a launch record that lives only there is gone at the boundary where dedup and attribution are needed.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` confirm any session that spawned background agents maintained a durable launch-ledger, checked it before spawning, and matched completions against it); `advisory` at the hook layer (whether a spawn was ledger-checked and a completion was ledger-matched is a session-history judgment per `hook-output-discipline.md` MUST-2 — no structural tool-call-time signal, so no `block`).
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (a background-agent orchestration run with no durable ledger; a duplicate spawn of an in-flight track; a completion reacted to without a ledger match) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a launch-tracking property is a session-history judgment; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `wave-loop.md` MUST-6/7 + `agents.md` § Triad took.
- **Receipt requirement:** SessionStart soft-gate `[ack: orchestration-launch-ledger]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` inspect any session that spawned background agents and confirm (a) a durable on-disk launch-ledger exists with a row per launched agent, (b) the transcript shows a ledger consult before each spawn, (c) each completion was matched against the ledger before the orchestrator reacted. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `Stop`/`PostToolUse` detector flagging a background-agent spawn with no adjacent durable-ledger write, paired with the review layer per `probe-driven-verification.md` MUST-4; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/orchestration-launch-ledger/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (no durable ledger) + MUST-2 (duplicate spawn of an in-flight track) + MUST-3 (completion reacted to without a ledger match).
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Distinct from** `wave-loop.md` MUST-6 (never idle-wait while independent in-budget work is launchable) — that governs WHETHER to launch more; this governs TRACKING what was already launched. MUST-7 (reconcile a pre-existing backlog item against ground truth before implementing) is the backlog-item analogue; this rule is the same reconcile reflex applied to SPAWNED AGENTS across a context boundary.
- **Distinct from** `agents.md` § The Default Execution Mode Is The Triad + § Worktree Orchestration — those govern HOW to parallelize (decompose, isolate, verify deliverables); this governs the durable LEDGER that survives compaction so the parallel launches are not lost.
- **Composes with** `knowledge-convergence.md` MUST-1 (`.session-notes` single-writer) — the ledger commonly lives in the workspace/session-notes surface that rule governs; this rule adds the launch-tracking CONTENT, not a second writer.
- **Same epistemic family as** `zero-tolerance.md` Rule 1c / `verify-claims-before-write.md` MUST-2 — a launch map carried across a context boundary is structurally unfalsifiable until re-derived; the durable ledger is the re-derivation surface.

## Origin

2026-07-19 — GitHub issue #1232, filed from an orchestrator session in a downstream consumer repo where the failure and the fix were observed. Two background agents (an engine feature + a store-adapter) were launched, fell out of context after a compaction, and a DUPLICATE store-adapter agent was spawned before the collision surfaced; the self-launched, already-pushed branches were momentarily reasoned about as if another session had produced them. Landed at loom via `/sync-from-build` Gate-1 classification (Wave-1 of the sync-from-backlog follow-ups, journal/0552); the generic launch-tracking principle cascades, the downstream-consumer identifier stays in the local `/codify` receipt per `upstream-issue-hygiene.md` MUST-2. Authored `priority:10` + `scope:path-scoped` + `cli_delivery:skill-channel` under the measured saturated-baseline constraint (codex 10.13% / gemini 10.43% headroom, within the 15% proximity band) and scoped to the workspace / session-notes surfaces where the ledger lives — the same orchestration-surface path-scoping `wave-loop.md` uses; a genuinely-first spawn before any workspace file is touched is the one reachability edge (surfaced as a residual at land-time), bounded because a background-agent orchestrator is by construction doing plan-/workspace-anchored work that fires the glob early.
