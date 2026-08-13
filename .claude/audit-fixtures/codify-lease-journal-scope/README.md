# codify-lease-journal-scope — RS-50 regression lock

Locks `codify-lease.js::_sortDedupRel` / `_resolveJournalScope`: every lease scope
auto-unions the journal directories `/codify`'s own phase-complete gate writes to,
**resolved** against the repo rather than hardcoded to one layout.

## The defect this locks

`commands/codify.md` Step 0 tells the caller the helper unions only
`.claude/learning/learning-codified.json` + `.claude/.proposals/latest.yaml`.
`commands/codify.md` § "Journal (MUST — phase-complete gate)" then REQUIRES a
journal entry before `/codify` may be reported complete. A caller following the
command literally acquired a lease covering two files and was then halt-and-reported
by `integrity-guard.js` for the journal write — "no covering codify-lease record
found in the folded coordination log" — on a step the same command mandates. The
documented workaround (release → widen `scopeFiles` → re-acquire) additionally hits
`scope-dirty` once the journal file is already written.

Source: kailash-coc-rs proposal entry **RS-50** (`action: modify`, `origin: downstream`).

## Fixture layout

Inline-case definition in `run.mjs`, the variant `cc-artifacts.md` Rule 9 sanctions
alongside per-case sidecars. Each case builds a REAL temp repo with a real directory
layout under `os.tmpdir()` and calls the REAL exported helper — no stubbed resolver,
no re-implementation of the function under test.

```
node .claude/audit-fixtures/codify-lease-journal-scope/run.mjs     # exit 0 = pass
CODIFY_LEASE_LIB=<path> node .../run.mjs                           # drive an alternate build
```

`CODIFY_LEASE_LIB` exists so the RED can be established against an unfixed build
without mutating the working tree.

## What makes a green here evidence

The lever is the **layout**, not the call: the same `_sortDedupRel([], root)` must
yield different prefixes for a root-journal repo, a workspace-journal repo, and a
repo with neither. A hardcoded-one-layout implementation reds on the layout it did
not hardcode; an implementation that unions nothing reds on all of them.

`findCoveringLease` is **not importable** — `integrity-guard.js` has no
`module.exports` and runs an unguarded `main()` IIFE, so requiring it would EXECUTE
the hook. The fixture therefore transcribes the covering predicate as `coversRel()`
and pins it: `RS-50/covering-predicate-pin` reds the moment the three real covering
lines change shape, which is what keeps the transcription from silently diverging.

## Mutations, as MEASURED (`instrument-discipline.md` MUST-2(b))

Each mutation was applied to a copy of the real module and driven through
`CODIFY_LEASE_LIB`; the mutation's presence in the mutated copy was confirmed by
`grep -c` before each run, so every row below is a mutation shown to reach the code.

| #      | Mutation                                                        | Result       | Cases red                                                                                                                                                              |
| ------ | --------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | the whole fix absent (module at `HEAD`, pre-fix)                | **3/9 PASS** | `RS-50`, `root-journal-covered-before-the-dir-exists`, `workspace-journal-covered`, `pending-subdir-covered`, `no-workspaces-dir-does-not-throw`, `meta-dirs-excluded` |
| **M2** | `_resolveJournalScope` returns early — no workspace enumeration | **6/9 PASS** | `workspace-journal-covered`, `pending-subdir-covered`, `meta-dirs-excluded`                                                                                            |
| **M3** | workspace entries emitted WITHOUT the trailing slash            | **8/9 PASS** | `meta-dirs-excluded` only                                                                                                                                              |

**M3 is recorded because it REFUTED a claim, not because it confirmed one.** The
first draft of the implementation comment asserted the trailing slash was
load-bearing for `.pending/` coverage. It is not: `findCoveringLease`'s third clause
(`!s.includes(".") && candidateRel.startsWith(s + "/")`) already covers a dot-free
bare dir, so both coverage cases stayed GREEN under M3 and only the
literal-membership case red. The comment was corrected to say so. The slash is kept
because it remains correct if a journal dir ever contains a dot — at which point the
third clause stops applying and the second is the only one left.

The honest consequence: **this suite does not pin the trailing-slash form** except
incidentally, through `meta-dirs-excluded`'s literal-membership assertion. A
maintainer who rewrites that case to assert coverage instead of membership removes
the last thing holding the emitted form.

## What a green does NOT prove

- It does **not** prove the end-to-end guard allows the write. That would require
  driving the real `integrity-guard.js` hook with coordination enabled, a roster, a
  genesis anchor, and signed fold records. This suite proves the SCOPE the guard
  reads is correct and that the covering predicate it is checked against is still
  the real one; the composed path is gate-review's.
- It does not cover a workspace created mid-session, after the lease was acquired.
  The caller can still pass that path explicitly in `scopeFiles`; the residual is
  recorded rather than closed.
