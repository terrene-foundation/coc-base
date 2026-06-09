# /implement Integration — Posture-Aware Execution

`/implement` MUST consult `posture.json` at session start (the `posture-gate.js` SessionStart hook injects this automatically; this file documents the contract).

## Posture-bound implementation behavior

### L5 DELEGATED — full autonomy

Plan, edit, commit, open PR, run worktree-isolated parallel agents, full /codify. Confirmation required only for: cross-repo writes, release tags, destructive ops (per `rules/git.md`).

### L4 CONTINUOUS_INSIGHT

Same as L5 PLUS:

- Mandatory journal entry per shard (`workspaces/<X>/journal/`)
- /redteam Round 1 (mechanical sweeps) MUST run before merge
- Surface posture status in the closing summary of each session

### L3 SHARED_PLANNING

- One shard at a time (no parallel worktree agents)
- /todos plan approval gate before /implement (re-approve every shard)
- PR creation requires explicit user instruction
- Commits to feat/\* branches require explicit user instruction (working-tree edits OK)

### L2 SUPERVISED

- Read-only by default
- Every Edit/Write requires user instruction in the immediate prior turn
- Every Bash beyond read-only commands (ls, cat, git status, git diff, gh view) requires instruction
- Linters/formatters OK without instruction

### L1 PSEUDO_AGENT

- Propose plans + diffs in chat only
- Zero working-tree mutations
- The user runs commands; the agent advises

## Reading current posture in /implement

The hooks inject the posture into `additionalContext` at SessionStart. /implement MUST surface it in its first reply:

> "Current posture: L4 CONTINUOUS_INSIGHT (since 2026-05-06, 1 day at this posture). Constraints: mandatory journal per shard, /redteam Round 1 before merge."

## Acknowledgement when pending_verification non-empty

Posture-gate SessionStart injects `[ack: <rule_id>]` requirement when any pending verification is active. /implement MUST emit the literal token in its first response of the session. Failure to emit twice = `acknowledgement_failure` violation logged.
