# integrity-guard audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One
fixture per scope-restriction predicate the hook
(`.claude/hooks/integrity-guard.js`, B3a) relies on.

## Predicates covered

| Fixture                              | Predicate exercised                                                | Expected disposition |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------- |
| `01-block-non-codify-branch/`        | Active branch IS NOT `codify/<display_id>-<date>`                  | block                |
| `02-halt-no-lease-on-codify-branch/` | Branch matches but no covering `codify-lease` record in fold       | halt-and-report      |
| `03-pass-branch-and-lease-match/`    | Branch + lease both pass                                           | silent passthrough   |
| `04-pass-unwatched-path/`            | Target path NOT in §2.3 watched set                                | silent passthrough   |
| `05-pass-foreign-codify-branch/`     | Branch is `codify/<OTHER>-<date>` (different operator)             | block                |
| `06-structural-null-malformed-log/`  | Coordination log truncated mid-line; fold throws → structural-NULL | (depends on branch)  |

## Why these and only these

The hook's scope-restriction predicates are:

1. **Watched-tool predicate** (`isWatchedTool`): Edit | Write only.
2. **Watched-path predicate** (`isWatchedPath`): the §2.3 integrity-
   critical artifact set — `.claude/operators.roster.json`,
   `.claude/learning/coordination-log.jsonl`,
   `.claude/learning/posture.json`, journal/, team-memory/,
   workspace journal dirs.
3. **Structural branch predicate** (`resolveActiveBranch` via
   `git rev-parse --abbrev-ref HEAD`): the ONLY branch that ships
   `severity: "block"`, grounded in the process-local structural
   primitive per `hook-output-discipline.md` MUST-2. Fixtures 01
   and 05 cover both negative branches.
4. **Lease-record lookup** (`findCoveringLease`): the registry-class
   signal. Fixture 02 covers absent-lease, fixture 03 covers
   present-lease.
5. **Structural-NULL fallback** (try/catch around log read + fold):
   fixture 06 covers the unrecoverable internal-error case per
   `cc-artifacts.md` Rule 7.
