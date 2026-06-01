# detectWorktreeDrift audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectWorktreeDrift(filePath)` relies on. Inputs are absolute paths intended for an `Edit`/`Write` tool call; expected outputs are the JSON returned by the detector — `null` (no flag) or a structural violation object with `severity: "block"` (structural signal: env-var-pinned worktree boundary, NOT lexical — per `hook-output-discipline.md` MUST-2 block requires structural evidence).

Environment dependency: the detector returns `null` unconditionally when `CLAUDE_WORKTREE_PATH` is unset. Fixtures presume `CLAUDE_WORKTREE_PATH=/repo/.claude/worktrees/agent-fixture` is exported by the runner; otherwise both fixtures resolve to `null`.

| Fixture                              | Expects   | Predicate locked                                                                                                                |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `flag-abs-path-outside-worktree.txt` | `block`   | Absolute path starts with `/` AND does NOT start with `$CLAUDE_WORKTREE_PATH` → drift back to main checkout, structural block.  |
| `clean-abs-path-inside-worktree.txt` | `null`    | Absolute path is rooted at `$CLAUDE_WORKTREE_PATH` → in-scope, no flag.                                                         |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectWorktreeDrift`. Rule cross-reference: `rules/worktree-isolation.md` MUST Rule 1.
