# adjacency-leasecheck audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One
fixture per scope-restriction predicate the hook relies on. Each fixture
is a self-contained JSON payload (PreToolUse stdin shape) + an expected
disposition (severity verdict, NOT the full validation body — body
prose is exercised by the Tier-2 integration tests).

## Predicates covered

| Fixture                              | Predicate exercised                                                               | Expected disposition           |
| ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------ | -------------------- |
| `01-watched-edit-on-claimed-path/`   | Edit on a path SAME-conflicting with an active sibling claim                      | halt-and-report                |
| `02-watched-edit-on-unrelated-path/` | Edit on a path INDEPENDENT of all active claims                                   | silent (passthrough)           |
| `03-watched-write-on-workspace/`     | Write on a path inside a workspace with an active workspace-scoped sibling claim  | halt-and-report                |
| `04-watched-write-on-non-cwd-path/`  | Write on an absolute path OUTSIDE the repo (`/tmp/...`)                           | silent (passthrough)           |
| `05-non-watched-tool-noop/`          | Tool is Read (not Edit                                                            | Write) — hook MUST passthrough | silent (passthrough) |
| `06-structural-null-malformed-log/`  | Coordination log file is truncated mid-line (malformed JSONL)                     | silent + advisory              |
| `07-filesystem-exception-positive/`  | §4.2 — sibling worktree porcelain match on exact target path                      | **halt-and-report**            |
| `08-filesystem-exception-negative/`  | Same dir as a porcelain-flagged file, but NOT the exact path → ADJACENT not §4.2  | advisory                       |
| `09-self-claim-no-self-conflict/`    | Active claim is the operator's own → no halt                                      | silent (passthrough)           |

## Why these and only these

The hook's scope-restriction predicates are (per `cc-artifacts.md`
Rule 9 + the architecture v11 §4.3 row):

1. **Watched-tool predicate** (`isWatchedTool`): only Edit | Write fire
   the hook; non-watched tools passthrough. Fixtures 01-05 + 09 are
   `Edit`/`Write`; fixture 05 explicitly exercises the non-watched
   passthrough path.
2. **Repo-relative path predicate** (`repoRelative`): absolute paths
   outside the repo passthrough; fixture 04 is the positive negative-
   case.
3. **Self-claim exclusion**: `verified_id !== self` filter on active
   claims; fixture 09 covers the self-claim case (an own active claim
   MUST NOT halt the operator's own Edit/Write).
4. **§4.2 filesystem exception**: the branch grounded in the `git status
   --porcelain` structural primitive. Since loom#1323 it emits
   **halt-and-report**, not `block` — `hook-output-discipline.md` MUST-2
   would PERMIT block (the signal is structural, not lexical), but a
   sibling worktree has a physically separate working tree, so the write
   cannot clobber its bytes and the only real collision is a recoverable
   3-way merge conflict at merge time. NO branch of this hook ships
   severity:block. Fixtures 07 (positive — exact path match) AND 08
   (negative — same dir, no exact match → falls back to ADJACENT
   advisory) cover both sides per `hook-output-discipline.md` MUST-4.
   Because §4.1 SAME and §4.2 now share a severity, fixture 07 also
   locks the `why`-text discriminator (`§4.2 filesystem exception`) so a
   deleted §4.2 branch cannot pass via the §4.1 fallthrough.
5. **Structural-NULL fallback** (`cc-artifacts.md` Rule 7): malformed
   log MUST surface {continue:true}; fixture 06 covers the unrecoverable
   internal-error case.

Live behavioral coverage lives at
`tests/integration/adjacency-leasecheck.test.js`. These fixtures are
the static regression locks for the scope-restriction predicates that
the integration tests exercise via real subprocess spawns.
