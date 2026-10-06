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

## Mode gate (re-keyed 2026-09-12)

The registry branch (fixtures 02–04) is gated on `isGovernanceEnabled`, the
predicate `journal-reserve.js::reserveJournalSlotSigned` emits the reservation
record under — not `isCoordinationEnabled`, which stood it down on every
enrolled single-human repo. Signature verification inside the fold still follows
coordination (`skipSignatureVerify` when it is OFF, matching
`journal-reserve.js::_foldHighWater`). `run.mjs` pins the three modes:

- **C5** unenrolled (governance OFF) ⇒ unreserved write passes; existing file still BLOCKs.
- **C6** enrolled-solo (coordination OFF, governance ON) ⇒ unreserved REFUSED; self-reserved passes.
- **C7** enrolled-solo, end to end ⇒ the slot the real reserve returns is writable; the next is refused.
- **C8** a non-verifying signature ⇒ passes with coordination OFF (membership-only fold), refused with coordination ON.

## Whole-chain acceptance and the hook budget (2026-09-12)

- **C9** a 2000-record chained log: a mid-chain reservation passes, an unreserved slot and an
  off-chain reservation are refused UNRESERVED — each equal to the full fold's verdict. A fold of
  reservation records ONLY rejects every reservation past seq 0 on rule-2, so this row reds on a
  record-type pre-filter; C1–C8 (one record at seq 0) cannot.
- **C10** `COC_JOURNAL_GUARD_BUDGET_MS=1` (tighten-only, clamped to the 4000ms default, applied only
  once a journal slot is identified) ⇒ HALT-AND-REPORT "reservation check did not complete within
  the hook budget — slot unverified", never a bare `{continue:true}`; the same budget passes a
  non-journal Write and an unenrolled repo untouched.

Live behavioral coverage with real ssh-keygen + real coc-sign lives
at `tests/integration/integrity-guards.test.js`. These fixtures are
the static regression locks for the scope-restriction predicates.
