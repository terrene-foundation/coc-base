---
name: worktree
description: "Create + root a dedicated SIBLING worktree for parallel/isolated development (never nested under .claude/worktrees/), with the PR-to-main loop."
---

# /worktree — dedicated sibling worktree for parallel development

Creates a durable, session-rootable git worktree **OUTSIDE** the repo (a sibling), so a
session can work in parallel with another operator on the same clone WITHOUT (a) colliding on
the shared working tree, (b) duplicating the path-scoped rule corpus, or (c) placing a full nested
checkout INSIDE the repo's own `.claude/**` glob range, where parent-repo recursive tooling (a
`grep -r` / a validator run with `--root .`) descends into it and pulls a duplicate corpus in as
tool output — plus the human-org clutter of a ~24MB checkout in the working tree.

On (b): a session rooted at a NESTED worktree was measured (2026-07-26, CC 2.1.220, untracked-sentinel
probe) to load **path-scoped** rules from BOTH its own `.claude/rules/` AND the ancestor repo's — the
same rule twice, under two paths — while a SIBLING-rooted session loads each exactly once. `CLAUDE.md`
and baseline (`priority: 0`) rules do NOT ancestor-load. Sibling placement is therefore a quota
requirement, not a tidiness preference — for a worktree a SESSION ROOTS INTO; a dispatched subagent
inherits its parent session's corpus instead (measured) and is not itself a double-load.
Full rationale + measured matrix + repro protocol:
`rules/worktree-isolation.md` Rule 7 and `skills/30-claude-code-patterns/worktree-orchestration.md`
§ Ancestor-Load Measurement.

Durable session worktrees and transient agent-wave worktrees BOTH live outside the repo now:
`rules/worktree-isolation.md` Rule 1 retired `isolation: "worktree"` / `EnterWorktree({name})`,
the flags that placed agent waves under `.claude/worktrees/`. They differ in LIFECYCLE, not
placement. Use `/worktree` for a **human/session** worktree you root into and keep across tasks;
for a wave, the orchestrator makes a transient per-shard sibling with `git worktree add` directly,
dispatches with the absolute path pinned AND a mandated STEP-0 cwd assertion, and removes it after
the wave (`skills/30-claude-code-patterns/worktree-orchestration.md` § Retiring
`isolation: "worktree"`). A session that roots into its worktree (this command, step 3) gets the
cwd guarantee from the launch/re-root itself, so it needs no such assertion — a DISPATCHED agent
does, because nothing sets its cwd once the flag is gone.

## Arguments

`$ARGUMENTS`:

- `<name>` (required) — worktree + branch slug (e.g. `parallel-dev`, `feat-auth`). If absent, ask.
- `--branch <branch>` (optional) — branch name; default = `<name>` (add `-b`), or omit `-b` to enter an existing worktree.

## Procedure

### 1. Resolve repo + placement (assert never-nested)

```bash
# main_top = the MAIN repo's top, location-INDEPENDENT even when run from INSIDE a linked worktree.
# (git rev-parse --show-toplevel returns the WORKTREE's own top there → dirname would doubly-nest.)
# --git-common-dir resolves the SHARED .git; its parent is the main repo top.
main_top=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
# slug = CANONICAL repo name from the remote. Fallback: main_top basename (NOT a worktree dir name).
slug=$(basename -s .git "$(git remote get-url origin 2>/dev/null)"); slug=${slug:-$(basename "$main_top")}
origin_head=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); origin_head=${origin_head:-main}
wt_parent="$(dirname "$main_top")/.${slug}-wt"   # sibling in the MAIN repo's parent (portable to any clone
                                                 # layout incl. Windows C:\dev\); dot-prefix → hidden + outside
                                                 # the repo AND outside parent-dir repo-enumeration
wt_path="$wt_parent/<name>"
```

**Windows note:** sanitize `<slug>` against Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) and trailing dots/spaces; run `git config core.longpaths true` for deep worktree paths. The dot-prefix is cosmetic-only on Windows (no functional issue — `.git`/`.github` prove dot-dirs work there).

ASSERT `wt_path` is NOT under `$main_top` (never nest a session worktree inside the repo). If a caller passes a path under `$main_top` or under `.claude/worktrees/`, STOP and refuse — that is the placement trap Rule 7 blocks.

### 2. Create the worktree off FRESH remote default (never a stale local tip)

```bash
git fetch origin "$origin_head" --quiet
mkdir -p "$wt_parent"
git worktree add -b <branch> "$wt_path" "origin/$origin_head"   # or omit -b to enter an existing branch
git worktree list | grep -F "$wt_path"                          # verify it registered
```

### 3. Root the SESSION at the worktree

- **Claude Code, first entry from the launch directory:** `EnterWorktree({path: "<wt_path>"})` re-roots THIS session into the sibling (verified: a sibling `path` on first entry from the launch dir is accepted). Do **NOT** use `EnterWorktree({name})` — it creates under `.claude/worktrees/` (the nesting trap), and subsequent `{path}` switches are restricted to `.claude/worktrees/`.
- **Any CLI / most robust:** tell the user to launch a fresh session with the worktree as cwd (`cd "<wt_path>" && <cli>`). No first-entry caveat; works on Codex/Gemini (which have no `EnterWorktree`).

### 4. The PR-to-main loop (every task)

- Per task: `git -C "$wt_path" checkout -b <type>/<task-desc> "origin/$origin_head"` → commit → open PR → `gh pr merge <N> --admin --merge --delete-branch` → return to the worktree and re-cut off fresh `origin/$origin_head`. (`<task-desc>` is a per-task descriptor — e.g. `feat/auth-refresh` — NOT the repo `$slug` shell var from step 1; reusing `$slug` would collide across tasks.)
- The worktree is **durable** — do NOT delete it between tasks (unlike agent-wave worktrees). When fully done: `git worktree remove "$wt_path"` (add `--force` only after confirming a clean tree).

## Guardrails

- NEVER create a worktree under `.claude/worktrees/` or anywhere below the repo root — session (Rule 7) or agent-wave (Rule 1) — a nested root duplicates the matching path-scoped rule set (measured that duplication occurs; the per-touch SIZE is indicative only — a reimplemented glob matcher put a `.claude/rules/**` touch at 13 rules ≈ 292 KB, an independent reimplementation at 15 / ~334 KB), falls inside the repo's `.claude/**` glob range (parent-repo tooling recursion), and clutters the working tree (`rules/worktree-isolation.md` Rule 7).
- NEVER `EnterWorktree({name})` for durable session work.
- Coordination state (`.claude/learning/`) is NOT copied into the worktree but is NOT lost: it is shared via the `refs/coc/**` refs (worktrees share `.git`), and ceremony helpers resolve the MAIN checkout (posture per `rules/trust-posture.md` MUST-1; the codify-lease per `rules/knowledge-convergence.md` Rule 3). See `rules/multi-operator-coordination.md` § "§2 essentials".
- Cross-repo placement resolves via the operator's own layout; the MAIN repo's parent dir `.<slug>-wt/` (derived location-independently via `git-common-dir`) is the recommended default, not a hardcoded requirement (`rules/cross-repo.md` MUST-1).
