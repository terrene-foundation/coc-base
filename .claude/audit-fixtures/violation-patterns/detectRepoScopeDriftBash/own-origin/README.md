# `detectRepoScopeDriftBash` — own-origin allowance fixtures

Regression-locks the **OWN-ORIGIN allowance**: a `gh --repo <slug>` command is
in-scope (detector returns `null`) when `<slug>` matches the CWD repo's own
`origin` remote — including from a git **worktree** whose directory basename
differs from the repo slug.

## Root cause locked

Before this allowance, `detectRepoScopeDriftBash` decided in-scope by
`targetRepo.includes(path.basename(cwd))`. From a worktree — cwd basename
`gate-admin` for repo `esperie-enterprise/loom` — the basename never appears in
the slug, so every owner workflow command (`gh pr create/view/merge --repo
esperie-enterprise/loom`) false-flagged `repo-scope-discipline/MUST-NOT-1`. The
fix resolves the CWD repo's own `origin` slug (`git remote get-url origin`,
worktree-safe: worktrees share the common `.git`) and suppresses the flag when
the target equals it. It is the structural-signal sibling of the pre-existing
`upstream`-remote allowance (issue #36).

## Cases (`test.mjs`, `node:test`)

| Case                                 | Setup                                                              | Expected                                        |
| ------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| own-origin from worktree-shaped dir  | `origin=git@github.com:Org/loom.git`, cwd basename `wt-gate-admin` | `null` (in-scope)                               |
| own-origin, https origin form        | `origin=https://github.com/Org/loom.git`, differing dir            | `null` (in-scope)                               |
| different slug with origin set       | target `Other/repo`                                                | `halt-and-report` (no over-suppression)         |
| no origin remote + basename mismatch | git repo, no `origin`                                              | `halt-and-report` (existing behavior preserved) |

Run: `node --test .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/own-origin/test.mjs`

Sibling fixture dirs: `upstream-remote/` (issue #36 parent-product allowance),
`authorization-receipt/` (User-Authorized Exception condition-4 receipt).
