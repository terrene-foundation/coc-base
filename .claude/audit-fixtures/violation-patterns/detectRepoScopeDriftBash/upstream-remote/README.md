# detectRepoScopeDriftBash — upstream-remote allowance fixtures

Per issue #36 (2026-05-06): hierarchical-fork class — a coc-project consumer with a documented `upstream` remote pointing at a parent-product MUST be able to write `gh --repo <parent>` issues/PRs without false-positive flagging. The detector now consults `git remote get-url upstream` (normalized to `Org/Repo`) BEFORE the basename heuristic.

## Test cases (issue #36 § "Test cases to add")

Each fixture is a JSON spec the test harness consumes (the test sets up a temp git repo with the specified remote then invokes the hook with the command). The 7 cases enumerate the behavior contract:

| #   | upstream remote URL             | command form                             | Expected                                               |
| --- | ------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| 1   | `git@github.com:Org/parent.git` | `gh issue create --repo Org/parent ...`  | NO flag (SSH form match)                               |
| 2   | `https://github.com/Org/parent` | `gh issue create --repo Org/parent ...`  | NO flag (HTTPS form match)                             |
| 3   | `Org/parent`                    | `gh pr create --repo Org/parent ...`     | NO flag (slug form match)                              |
| 4   | `git@github.com:Org/parent.git` | `gh issue create --repo Org/sibling ...` | FLAG (sibling, not upstream)                           |
| 5   | (no upstream remote)            | `gh issue create --repo Org/parent ...`  | FLAG (basename heuristic preserved for flat consumers) |
| 6   | (any) — cwd basename = `parent` | `gh issue create --repo Org/parent ...`  | NO flag (basename heuristic passes pre-existing)       |
| 7   | `git@github.com:Org/parent.git` | `gh ...` (no `--repo` flag)              | NO flag (regex doesn't match)                          |

The fixtures live alongside the existing scope-restriction predicates per `cc-artifacts.md` Rule 9 (committed test fixtures for every audit-tool predicate).

Trust Posture Wiring: this is a refinement of detectRepoScopeDriftBash (already at `severity: halt-and-report` per loom 2.20.0 PR #31). No new severity, no new rule_id.
