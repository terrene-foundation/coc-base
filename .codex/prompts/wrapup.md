---
name: wrapup
description: "Write .session-notes so the next session resumes without re-discovering context."
---

The only deliverable is a `.session-notes` file that lets a fresh session start producing work within 2–3 minutes of reading it, without having to re-explore the codebase.

**Before running:** if significant decisions, discoveries, or risks from this session are not yet in `journal/`, run `/journal new DECISION|DISCOVERY|RISK <topic>` first. `.session-notes` is not a decision log.

**Release drift check (MUST — BUILD repos only):** Before writing `.session-notes`, run `node .claude/hooks/lib/release-drift.js` via a quick inline check (or inspect the `[RELEASE-DRIFT]` lines from session-start). If any packages have commits since their last tag, surface this to the user with a recommendation to run `/release` before ending the session. Record the unreleased package list in `.session-notes` under an "Unreleased packages" section so the next session sees the backlog. Silent on downstream repos / non-package repos.

## What the next session already has for free

Do NOT duplicate these — the next session reads them directly:

- **Commits & diffs** — `git log`, `git status`, `git diff`
- **Outstanding work** — `workspaces/<project>/todos/active/`
- **Decisions & discoveries** — `workspaces/<project>/journal/`
- **Phase outputs** — `01-analysis/`, `02-plans/`, `03-user-flows/`, `04-validate/`
- **Domain specs** — `specs/` (detailed domain truth, always current)
- **Project context** — `CLAUDE.md`

## What ONLY wrapup can provide

Three things nothing else captures:

1. **Priority ordering** — out of everything in the repo, which files should the next session read first, and in what order
2. **In-flight state** — what's true RIGHT NOW that isn't yet committed, journaled, or filed as a todo
3. **Traps** — specific pitfalls the next session will walk into without warning

If content doesn't fit one of those three, it belongs somewhere else. Put it there before running `/wrapup`.

## Where to write

1. If `$ARGUMENTS` names a workspace, write `workspaces/$ARGUMENTS/.session-notes`
2. Else use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. Else write `.session-notes` at the repo root

## Format

Hard cap: **50 lines**. Overflow means the content belongs in `todos/active/` or `journal/`, not here. Omit any section that would be empty.

```markdown
# Session Notes — <YYYY-MM-DD>

## Where we are

One short paragraph (≤4 lines). Current work, current phase, last concrete
change. Just enough for the next session to orient — not a history.

## Read first

1. `path/to/file` — why it matters (one line)
2. `path/to/file` — why it matters
   (3–6 files, priority-ordered)

## In-flight state

- Uncommitted decisions, half-done refactors, mid-migration state.
- Facts that are true NOW but aren't in git/todos/journal yet.
  (omit if none)

## Traps

- Concrete pitfalls the next session will hit.
- One line each. Link to the fix location if you know it.
  (omit if none)

## Open questions for the human

(omit if none)
```

## Hard rules

- **Write, not verify.** Do NOT run grep, git log, git show, git diff, gh, pytest, ls, find, or file reads during wrapup. The only permitted tool calls are: workspace resolution (one `ls workspaces/` if needed) and the final `Write .session-notes`. **Tool call cap: 2.**
- **Memory only.** Produce the notes from conversation memory. If you're unsure whether a claim is still true, omit it — the next session can discover it from git.
- **No accomplishments list.** The next session reads `git log`. Do not describe what happened this session.
- **No outstanding-todo list.** The next session reads `todos/active/`. Do not itemize remaining work.
- **No decision log.** Journal decisions with `/journal` before running `/wrapup`, not in session notes.
- **No quantitative claims.** Do not write "N tests passing", "3 files changed", or "27 todos remaining". Numbers must be verified; verification is forbidden here. Point at the source of truth instead.
- **No oversight checklist.** Verification commands belong in the next session's task list, not session notes.
- **50-line output cap.** Overflow belongs in `todos/` or `journal/`.
- **Overwrite** existing `.session-notes`. Only the latest matters.
- **The "Read first" list is the one section that MUST be present.** Without it, the next session has no entry point. If you can't produce a useful list, point at `CLAUDE.md` as the sole entry and say why.

## Why this is lean

Previous versions forced a tool-call cascade ("the tool call is the verification, not your memory") that consumed 200K+ tokens per run on large workspaces. The cascade existed to catch stale claims. The lean fix is to **not make claims that could go stale**: instead of "27 todos remaining" (must be verified), write "see `todos/active/`" (always current by definition).

`.session-notes` is a pointer file, not a report. Its job is to save the next session's discovery time. That's all.
