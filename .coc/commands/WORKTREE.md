---
id: "WORKTREE"
name: worktree
description: "Create + root a dedicated SIBLING worktree for parallel/isolated development (never nested under .claude/worktrees/), with the PR-to-main loop."
---

# /worktree — dedicated sibling worktree for parallel development

Creates a durable, session-rootable git worktree **OUTSIDE** the repo (a sibling), so a
session can work in parallel with another operator on the same clone WITHOUT (a) colliding on
the shared working tree or (b) placing a full nested checkout INSIDE the repo's own `.claude/**`
glob range, where parent-repo recursive tooling (a `grep -r` / a validator run with `--root .`)
descends into it and pulls a duplicate corpus in as tool output — plus the human-org clutter of a
~24MB checkout in the working tree. This is NOT a rule double-load: CC roots at the nearest `.git`
boundary and loads exactly ONE `.claude/` corpus (every worktree has its own `.git`). Full rationale
+ empirical evidence: `rules/worktree-isolation.md` Rule 7.

This is **NOT** the agent-wave isolation primitive (`isolation: "worktree"` /
`EnterWorktree({name})` → `.claude/worktrees/`, transient scratch — `rules/worktree-isolation.md`
Rules 1–6). Use `/worktree` for a **human/session** worktree you root into and work from.

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

- NEVER create a session worktree under `.claude/worktrees/` or anywhere below the repo root — a nested checkout falls inside the repo's `.claude/**` glob range (parent-repo tooling recursion) and clutters the working tree (`rules/worktree-isolation.md` Rule 7).
- NEVER `EnterWorktree({name})` for durable session work.
- Coordination state (`.claude/learning/`) is NOT copied into the worktree but is NOT lost: it is shared via the `refs/coc/**` refs (worktrees share `.git`), and ceremony helpers resolve the MAIN checkout (posture per `rules/trust-posture.md` MUST-1; the codify-lease per `rules/knowledge-convergence.md` Rule 3). See `rules/multi-operator-coordination.md` § "§2 essentials".
- Cross-repo placement resolves via the operator's own layout; the MAIN repo's parent dir `.<slug>-wt/` (derived location-independently via `git-common-dir`) is the recommended default, not a hardcoded requirement (`rules/cross-repo.md` MUST-1).
