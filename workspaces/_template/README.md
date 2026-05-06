# Workspace Template

Copy this directory under `workspaces/<my-workspace>/` to start a new workspace
with the canonical phase-directory layout pre-scaffolded. The empty dirs
(each with a `.gitkeep`) make missing-phase states visible at `ls`-time and
prevent the "just do the work" trap where an agent skips `/analyze` because
`briefs/` was missing.

## Phase contract

```
workspaces/<my-workspace>/
├── briefs/             User input — the brief that kicked off this workspace.
├── 01-analysis/        /analyze output — failure points, requirements, ADRs.
├── 02-plans/           /analyze + /todos — architecture plans, shard maps.
├── 03-user-flows/      /analyze — user-facing flow specs (when applicable).
├── 04-validate/        /redteam — validation rounds, audit findings.
├── journal/            Decisions + discoveries (numbered, append-only).
└── todos/
    ├── active/         /todos creates here; /implement consumes here.
    └── completed/      /implement moves here on completion.
```

## Phase order

1. **briefs/** — drop the user's brief here first.
2. **/analyze** → produces `01-analysis/`, `02-plans/`, optionally `03-user-flows/`.
3. **/todos** → produces `todos/active/<NN>-<name>.md`.
4. **/implement** → drains `todos/active/` → `todos/completed/`.
5. **/redteam** → produces `04-validate/<round-N>-*.md`.
6. **/codify** → updates loom rules/skills/agents (no workspace output).
7. **/release** → tags and ships.

`journal/` is written across all phases — DISCOVERY, DECISION, REFLECTION
entries.

## Missing-phase signals

If a workspace has files but is missing one of the above directories, the
agent SHOULD treat that as a phase-gate skip signal:

- No `briefs/` → `/analyze` was likely skipped; ask the user for a brief
  before continuing.
- No `01-analysis/` → architecture work landed without analysis; halt and
  run `/analyze` first.
- No `todos/active/` or `todos/completed/` → `/todos` was skipped; halt
  and run it before any implementation.

`/ws` (workspace status dashboard) flags missing-phase dirs in red.

Origin: loom issue #19 Proposal 2 (2026-04-21 tpc/tpc_cash_treasury-scenario
/redteam — workspace had only `04-validate/` and `journal/`, agent drafted
spec content + 13-shard program directly without `/analyze` or `/todos`).
