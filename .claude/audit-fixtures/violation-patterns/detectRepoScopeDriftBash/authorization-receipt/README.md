# detectRepoScopeDriftBash — User-Authorized Exception receipt fixtures

Per `rules/repo-scope-discipline.md` § User-Authorized Exception condition 4 + journal 0077/0078/0080, and `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.

Closes the gap where a properly user-authorized cross-repo action (user-initiated + confirmed + journal-receipt-written-before-act) still tripped the trust-posture L1 critical downgrade. `detectRepoScopeDriftBash` now calls `hasCrossRepoAuthorizationReceipt(targetSlug, cwd)` before emitting; a recent journal entry containing the greppable marker `cross-repo-authorized: <owner/repo>` for the exact target slug clears the write (returns `null`).

`test.mjs` is a self-contained smoke test (temp `git init` repo + controlled-mtime journal files) locking the behavior contract:

| Case                    | Setup                                                                 | Expected                                                                       |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| receipt present, recent | `journal/NNNN.md` with `cross-repo-authorized: Org/target`, mtime now | `detectRepoScopeDriftBash` → `null` (in-scope)                                 |
| no receipt              | off-repo `gh --repo Org/target`, no marker anywhere                   | `halt-and-report` (gap NOT a blanket relaxation)                               |
| wrong-slug receipt      | marker present but for `Org/other`, not the target                    | `halt-and-report` (slug-specific)                                              |
| stale receipt           | marker for the target but file mtime > 6h                             | `halt-and-report` (condition 5 — scoped to ONE action; no cross-session reuse) |
| workspace journal       | marker in `workspaces/<name>/journal/.pending/NNNN.md`, recent        | `null` (workspace journals scanned)                                            |

Severity unchanged (`halt-and-report` per `hook-output-discipline.md` MUST-2 — the allowance is a structural durable-on-disk signal, same class as the issue-#36 upstream-remote allowance; the finding, when it fires, is never `block`).

Run: `node .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/authorization-receipt/test.mjs`
