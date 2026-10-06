---
id: "WORKTREE"
name: worktree
description: "Create a dedicated sibling worktree for isolated development and complete the PR-to-main loop."
---

# /worktree — dedicated sibling worktree for parallel development

Creates a durable, session-rootable git worktree **OUTSIDE** the repo (a sibling), so a
session can work in parallel with another operator on the same clone WITHOUT (a) colliding on
the shared working tree, (b) duplicating the path-scoped rule corpus, or (c) placing a full nested
checkout INSIDE the repo's own `.claude/**` glob range, where parent-repo recursive tooling (a
`grep -r` / a validator run with `--root .`) descends into it and pulls a duplicate corpus in as
tool output — plus the human-org clutter of a ~24MB checkout in the working tree.

On (b): the CC runtime keys path-scoped (`priority: >0`) rules on the resolved directory chain above
the TOUCHED FILE, walking up past the agent's own root into any ancestor `.claude/`. A NESTED worktree
has TWO matching `.claude/` roots above every file it touches; a SIBLING has one. Measured at loom
(2026-07-26, CC 2.1.220, untracked-sentinel probe): a nested-rooted session loaded the same path-scoped
rule TWICE under two distinct paths, plus an ancestor-ONLY rule in full; a sibling-rooted session
loaded each exactly once. `CLAUDE.md` and baseline (`priority: 0`) rules do NOT ancestor-load.
**Sibling placement is a QUOTA REQUIREMENT, not a tidiness preference.** Loom's own corpus cost:
74 path-scoped rules totalling 1,185,700 B, of which a single `.claude/rules/**` touch matches
~13 rules ≈ 291,914 B (~73k tokens) that a nested root pays TWICE (per-touch digits indicative —
a reimplemented glob matcher, `skills/30-claude-code-patterns/worktree-orchestration.md` § Cost at
loom; the duplication itself is measured). Do NOT substitute a downstream repo's figure — that same
section warns it is a different harness.

**The requirement binds the AGENT-WAVE worktree too.** A subagent dispatched with `isolation: "worktree"`
lands at `<repo>/.claude/worktrees/agent-<id>` — nested under the repo's OWN `.claude/` — and pays the
same double-load, which is why `rules/worktree-isolation.md` Rule 1 BLOCKS that flag and `EnterWorktree({name})`
outright. An earlier loom finding reported the opposite (that a dispatched subagent inherits its parent's
corpus and is not itself a double-load). That finding was an **UNCONTROLLED NULL** — the instrument was
never shown able to display an own-root block at all, so its silence is indistinguishable from a true
negative (`rules/instrument-discipline.md` MUST-3(a)). It is WITHDRAWN as unsupported and **licenses no
carve-out**: there is no dispatched-subagent exemption from sibling placement. Any re-test MUST use a
root-distinguishing instrument with BOTH a positive and a negative control — `bin/probe-ancestor-load.mjs`;
do not re-derive one from prose. Full rationale + measured matrix + repro protocol:
`rules/worktree-isolation.md` Rules 1 + 7 and `skills/30-claude-code-patterns/worktree-orchestration.md`
§ Ancestor-Load Measurement.

Durable session worktrees and transient agent-wave worktrees BOTH live outside the repo now:
`rules/worktree-isolation.md` Rule 1 retired `isolation: "worktree"` / `EnterWorktree({name})`,
the flags that placed agent waves under `.claude/worktrees/`. They differ in LIFECYCLE, not
placement. Use `/worktree` for a **human/session** worktree you root into and keep across tasks;
for a wave, the orchestrator makes a transient per-shard sibling with `git worktree add` directly,
dispatches with the absolute path pinned AND a mandated STEP-0 cwd assertion (`skills/30-claude-code-patterns/worktree-orchestration.md`
§ Retiring `isolation: "worktree"`), and MUST reap it at the wave's terminal-lane transition
(`rules/worktree-isolation.md` Rule 8; procedure + tiering in that skill's § Teardown). A session that roots into its worktree (this command, step 3) gets the
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

### 2. Create the worktree off FRESH remote default (never a stale local tip) — LOCKED, and RECORDED

```bash
git fetch origin "$origin_head" --quiet
mkdir -p "$wt_parent"
# THE ONE CREATION AFFORDANCE. Creates the tree, LOCKS it, and records the
# creating session so the unattended teardown can tell this tree from another
# session's. `--base` is explicit — never a stale local tip (Rule 5).
node .claude/bin/worktree-reap.mjs --create "$wt_path" --branch <branch> --base "origin/$origin_head"
git worktree list | grep -F "$wt_path"                          # verify it registered
```

**A tree created WITHOUT `--lock` carries no owner, and the SessionEnd reaper will never
remove it** — it refuses every tree it cannot prove it created, so an unrecorded tree is
permanent until an operator retires it by hand. Raw `git worktree add` is therefore the
exception path, not the recipe; it exists for entering an existing branch
(`--create … --existing`) and nothing else. `--create` also refuses a nested target, so the
Rule 7 placement trap fails at the moment of creation rather than at measurement time.

### 3. Root the SESSION at the worktree

- **Claude Code, first entry from the launch directory:** `EnterWorktree({path: "<wt_path>"})` re-roots THIS session into the sibling (verified: a sibling `path` on first entry from the launch dir is accepted). Do **NOT** use `EnterWorktree({name})` — it creates under `.claude/worktrees/` (the nesting trap), and subsequent `{path}` switches are restricted to `.claude/worktrees/`.
- **Any CLI / most robust:** tell the user to launch a fresh session with the worktree as cwd (`cd "<wt_path>" && <cli>`). No first-entry caveat; works on Codex/Gemini (which have no `EnterWorktree`).

### 4. The PR-to-main loop (every task)

- Per task: `git -C "$wt_path" checkout -b <type>/<task-desc> "origin/$origin_head"` → commit → open PR → `gh pr merge <N> --admin --merge --delete-branch` → return to the worktree and re-cut off fresh `origin/$origin_head`. (`<task-desc>` is a per-task descriptor — e.g. `feat/auth-refresh` — NOT the repo `$slug` shell var from step 1; reusing `$slug` would collide across tasks.)
- The worktree is **durable** — do NOT delete it between tasks (unlike agent-wave worktrees). "Durable" means not deleted BETWEEN tasks; it never means permanent. When fully done, DELIVER it: `node .claude/bin/worktree-reap.mjs --deliver "$wt_path"` — **never `--force`**. Delivery unlocks the tree and reaps it on evidence (ZERO-LOSS only); if the reap KEEPS it — a dirty tree, or unpushed commits — the tree is RE-LOCKED, so the end state is always either GONE or LOCKED. A bare `git worktree remove` REFUSES a dirty tree, and that refusal is the safety net working; confirming a clean tree and THEN forcing is the check-then-clobber TOCTOU (`rules/worktree-isolation.md` Rule 8), because the state can change between the check and the removal, and unstaged + untracked-not-ignored work has NO reflog. `--deliver` refuses any tree this session did not create. To classify the whole forest rather than one tree, run `node .claude/bin/worktree-reap.mjs` (report-only; `--apply` reaps only what a ref preserves).

## Guardrails

- NEVER create a worktree under `.claude/worktrees/` or anywhere below the repo root — session (Rule 7) or agent-wave (Rule 1) — a nested root duplicates the matching path-scoped rule set (measured that duplication occurs; the per-touch SIZE is indicative only — a reimplemented glob matcher put a `.claude/rules/**` touch at 13 rules ≈ 292 KB, an independent reimplementation at 15 / ~334 KB), falls inside the repo's `.claude/**` glob range (parent-repo tooling recursion), and clutters the working tree (`rules/worktree-isolation.md` Rule 7).
- NEVER `EnterWorktree({name})` for durable session work.
- Work bound for the integration branch lands promptly through the repo's landing path, and never by a hand `git merge` / `cherry-pick` / `rebase` onto that branch — or the branch later reads as unlanded and gets re-landed (`rules/wip-discipline.md` MUST-4). Where the repo ships a provenance-recording landing script, that path is the script: **at loom**, `<loom>/.claude/bin/land-lane.mjs` (loom-only; not distributed).
- Coordination state (`.claude/learning/`) is NOT copied into the worktree but is NOT lost: it is shared via the `refs/coc/**` refs (worktrees share `.git`), and ceremony helpers resolve the MAIN checkout (posture per `rules/trust-posture.md` MUST-1; the codify-lease per `rules/knowledge-convergence.md` Rule 3). See `rules/multi-operator-coordination.md` § "§2 essentials".
- Cross-repo placement resolves via the operator's own layout; the MAIN repo's parent dir `.<slug>-wt/` (derived location-independently via `git-common-dir`) is the recommended default, not a hardcoded requirement (`rules/repo-scope-discipline.md` § MUST NOT).
