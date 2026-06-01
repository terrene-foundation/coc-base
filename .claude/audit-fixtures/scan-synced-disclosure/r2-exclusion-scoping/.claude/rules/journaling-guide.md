# R2 exclusion-scoping fixture — journaling-guide.md (MUST be SCANNED + flag)

Locks must-fix #5 (issue #263 Round-2): the prior `isExcluded` journal
predicate used `segs.some(s => /^journal/.test(s))` — a `/^journal/`
PREFIX on an ARBITRARY path segment. It over-excluded every synced file
whose basename merely STARTS with `journal` (this file's basename is
`journaling-guide.md`), so a synthetic leak here was 0-scanned (silent
leak). The fix scopes the exclusion to the `journal/` DIRECTORY only.

This file is `rules/journaling-guide.md` — a SYNCED rule, NOT
accepted-history. The synthetic leak below MUST flag (proving the
over-exclusion is gone):

The nightly build ran on Fakename-MacStudio at
/Users/notesperie/repos/loom for the regression sweep.

All tokens SYNTHETIC and invented for this fixture.
