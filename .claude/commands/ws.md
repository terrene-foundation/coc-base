---
name: ws
description: "Show workspace status dashboard. Read-only."
---

Display the current workspace status. Do not modify any files.

1. List all directories under `workspaces/` (excluding `instructions/` and `_template/`).

2. For the most recently modified workspace (or `$ARGUMENTS` if specified):
   - Show workspace name and path
   - Derive current phase from filesystem:
     - Has `01-analysis/` files -> Analysis done
     - Has `todos/active/` files -> Todos created
     - Has `todos/completed/` files -> Implementation in progress
     - Has `04-validate/` files -> Validation done
     - Agents/skills were updated in phase 05 -> Codification done (check workspace `.session-notes` or `04-validate/`)
   - Count files in `todos/active/` vs `todos/completed/`
   - List the 5 most recently modified files in the workspace
   - If `.session-notes` exists, show its contents and age

### Missing-phase scan (loom #19 P2)

Before reporting the summary, check for missing canonical phase dirs against
the contract in `workspaces/_template/README.md`:

- `briefs/`, `01-analysis/`, `02-plans/`, `03-user-flows/`, `04-validate/`, `journal/`, `todos/active/`, `todos/completed/`

For each missing dir, emit a flagged warning at the TOP of the output (use
`!! MISSING:` prefix so it's visually loud in plain terminals):

```
!! MISSING: briefs/        — /analyze likely skipped; ask user for a brief
!! MISSING: 01-analysis/   — architecture work without /analyze; halt and run it
!! MISSING: todos/active/  — /todos was skipped; halt and run it before /implement
```

Missing-phase dirs are NOT a failure — they are a signal that the
corresponding phase has not run yet. The flag is advisory.

### Journal

- Read the workspace's `journal/` directory
- Count total entries and entries by type
- Show the 3 most recent entries (number, type, date, topic)

3. Present as a compact summary.
