# detectRepoScopeDriftBash — User-Authorized Exception receipt fixtures

Per `rules/repo-scope-discipline.md` § User-Authorized Exception condition 4 + journal 0077/0078/0080, and `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.

Closes the gap where a properly user-authorized cross-repo action (user-initiated + confirmed + journal-receipt-written-before-act) still tripped the trust-posture L1 critical downgrade. `detectRepoScopeDriftBash` calls `hasCrossRepoAuthorizationReceipt(targetSlug, cwd, requiredMode)` (`.claude/hooks/lib/violation-patterns.js:346-467`, called at `:736`) before emitting; a recent receipt containing the greppable **tier-qualified** marker `cross-repo-authorized: <owner/repo> <read|write>` for the exact target slug clears the action (returns `null`). Receipts are read from `.claude/cross-repo-authz/` first, then `journal/` + workspace journals, at `dirsFor` (`:381-402`). The trailing mode token is REQUIRED — the matcher is anchored `^cross-repo-authorized:[ \t]+<slug>[ \t]+(read|write)[ \t]*$` (`:374-377`) — and the tier is fail-closed: a `read` receipt never clears a write (`:354`).

The search is **WORKTREE-WIDE** (#174): `hasCrossRepoAuthorizationReceipt` scans the caller's own root first and, only on a miss, sweeps every sibling worktree of the same repo via `sibling-porcelain.js::enumerateSiblingWorktrees` (`:449-462`). Every worktree shares one `.git` and one operator, so a receipt in any of them is authoritative; the session cwd and the cwd a guarded command runs in are routinely different worktrees of one repo.

`test.mjs` is a self-contained smoke test (temp `git init` repos, content-timestamped journal files, and a scratch repo with two linked worktrees) locking the behavior contract:

| Case                    | Setup                                                                 | Expected                                                                       |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| receipt present, recent | `journal/NNNN.md` with `cross-repo-authorized: Org/target write`, `timestamp:` now | `detectRepoScopeDriftBash` → `null` (in-scope)                     |
| no receipt              | off-repo `gh --repo Org/target`, no marker anywhere                   | `halt-and-report` (gap NOT a blanket relaxation)                               |
| wrong-slug receipt      | marker present but for `Org/other`, not the target                    | `halt-and-report` (slug-specific)                                              |
| stale receipt           | marker for the target but content `timestamp:` > 6h old               | `halt-and-report` (condition 5 — scoped to ONE action; no cross-session reuse) |
| workspace journal       | marker in `workspaces/<name>/journal/.pending/NNNN.md`, recent        | `null` (workspace journals scanned)                                            |
| #174 worktree topology  | scratch repo + linked worktrees A and B sharing one common-dir; porcelain reports 3 worktrees | fixture sanity — without it every `#174` row below is vacuous   |
| #174 negative control   | no receipt in ANY worktree, called from sibling B                     | `false` / `halt-and-report` (the search must still discriminate)               |
| #174 sibling receipt    | receipt in A; called from A, from sibling B, and from the main checkout | all three → `true`, guard returns `null`                                      |
| #174 workspace paths    | `workspaces/<ws>/journal/` and `.pending/` receipts in a SIBLING root | `true` (both search paths survive per worktree)                                |
| #174 exclusions         | receipt under `workspaces/_template/` or `workspaces/instructions/` in a sibling | `false` (`_`-prefixed and `instructions` stay excluded)            |
| #174 no widening        | `read` receipt in a sibling vs a `write` ask; `Org/target-internal` receipt vs `Org/target`; expired and future-dated sibling receipts | all `false` — the sweep widens WHERE, never the tier, slug or age window |

Severity unchanged (`halt-and-report` per `hook-output-discipline.md` MUST-2 — the allowance is a structural durable-on-disk signal, same class as the issue-#36 upstream-remote allowance; the finding, when it fires, is never `block`).

**Mutation check.** Replacing the sibling sweep with the pre-#174 `return scanRoot(root)` reds exactly the three `#174` rows that depend on it — `a receipt in worktree A is authoritative from A, B and main`, `workspace-journal paths survive PER WORKTREE`, and `widening the SEARCH widens nothing else` — while the topology-sanity, negative-control, exclusion and all five pre-existing rows stay green (measured 2026-10-06: 8/11 pass, exit 1). The instrument therefore discriminates the wiring it locks.

Run: `node .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/authorization-receipt/test.mjs`
