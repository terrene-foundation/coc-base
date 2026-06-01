# journal-write-guard audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4.
One fixture per scope-restriction predicate the hook
(`.claude/hooks/journal-write-guard.js`, B3a) relies on. Each fixture
is a self-contained PreToolUse stdin payload + an expected disposition
(severity verdict, NOT the full validation body — body prose is
exercised by the Tier-2 integration tests at
`tests/integration/integrity-guards.test.js`).

## Predicates covered

| Fixture                     | Predicate exercised                                                 | Expected disposition |
| --------------------------- | ------------------------------------------------------------------- | -------------------- |
| `01-block-file-exists/`     | Target journal entry already exists on disk → block (fs.existsSync) | block                |
| `02-halt-slot-unreserved/`  | Slot has no `journal-slot-reservation` record in the fold           | halt-and-report      |
| `03-pass-self-reserved/`    | Slot reserved by SELF in the fold                                   | silent passthrough   |
| `04-halt-sibling-reserved/` | Slot reserved by a different operator                               | halt-and-report      |
| `05-pass-outside-repo/`     | Absolute path NOT under repoDir                                     | silent passthrough   |
| `06-pass-non-write-tool/`   | Tool is Read (not Write) — hook MUST passthrough                    | silent passthrough   |

## Why these and only these

The hook's scope-restriction predicates are (per `cc-artifacts.md`
Rule 9 + architecture v11 §2.3 + §4.3):

1. **Watched-tool predicate** (`isWatchedTool`): only `Write` fires
   the hook (Edit on existing journal entry is integrity-guard's
   territory). Fixture 06 exercises the non-watched passthrough path.
2. **Watched-path predicate** (`isWatchedPath`): only paths matching
   `journal/<NNNN>-*.md` and `workspaces/<name>/journal/<NNNN>-*.md`
   fire. Fixture 05 covers the outside-repo absolute-path negative.
3. **File-existence predicate** (`fs.existsSync`): the ONLY branch
   that ships `severity: "block"`, grounded in the structural
   primitive per `hook-output-discipline.md` MUST-2. Fixture 01
   covers the positive.
4. **Slot-reservation lookup** (`findSlotReservation`): the
   registry-class signal. Fixtures 02 (no record), 03 (self-record),
   and 04 (sibling-record) cover the three branches.

Live behavioral coverage with real ssh-keygen + real coc-sign lives
at `tests/integration/integrity-guards.test.js`. These fixtures are
the static regression locks for the scope-restriction predicates.
