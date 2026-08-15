# `session-notes-continuity` audit fixtures

Backs `.claude/hooks/session-notes-guard.js`, the structural detector for
`rules/session-notes-continuity.md` (MUST-1 read-order, MUST-2 no-truncate-read,
MUST-3 boundedness). Fixtures ship WITH the detector per `cc-artifacts.md` Rule 9.

Run: `node .claude/audit-fixtures/session-notes-continuity/run.mjs`
Registered: `.claude/test-harness/ci-audit-fixtures.json` (`mode: run`, `min_cases: 26`)

## Coverage shape

One case per **scope-restriction predicate**, not one per clause. The predicates a wrong
edit would silently widen or narrow: what counts as a continuity artifact; what counts as
a truncation; root (directive) versus workspace (narrative) surface; what the tri-state
ordering signal does on UNKNOWN; and where the ceiling boundary sits.

Every case exercises a PURE decision function — no stdin, no spawn, no git, no
filesystem. `repoDir` is a nonexistent synthetic root on purpose: classification is
lexical by contract, so no case can pass by accident of what is on the machine's disk.

## Established RED (`instrument-discipline.md` MUST-2)

Each case carries a `reds_under:` naming the mutation that makes it FAIL. Those were not
reasoned about — they were RUN. 28 mutations were applied to `session-notes-guard.js` one
at a time, the suite executed against each, and the reddened set recorded.

**Result: 26/26 cases red-shown, 0 never-red.** No case in this suite is asserted to be a
regression guard without having been demonstrated failing.

Three findings from that pass are recorded here because they are exactly what the
exercise exists to surface, and suppressing them would make this README the same kind of
non-instrument it is documenting:

1. **One case was VACUOUS and was rewritten.** `marker-sanitizes-session-id` originally
   asserted `!markerPath.includes("..")`. `path.join` normalizes `..` away, so that read
   identically with and without the sanitize — the mutation reddened nothing. It now
   asserts `dirname(markerPath) === tmpdir()` (no separator survives into the filename),
   which discriminates, plus a deep-traversal containment arm. The same mutation that
   proved it vacuous now reds it.

2. **One mutation is INERT, and that is RESOLVED rather than recorded as "no bug."**
   Removing only the `!sessionId` guard from `markerPathFor` reds nothing, because the
   path is defended twice: an empty string clears that guard's type test and is caught by
   the later `!safe` check. A non-reddening mutation leaves two live hypotheses
   (`instrument-discipline.md` MUST-2(b)) — vacuous case, or inert mutation. Removing
   BOTH guards reds the case, which settles it as the second.

3. **Two `reds_under` annotations were wrong on first write and were corrected to
   measurement.** `fragment-first-unblocks` does not red under `rootNotesSeen !== true`
   (`true !== true` is false, so it still passes); it reds when the conjunct is dropped
   entirely. `ceiling-boundary-over-limit-advises` does not red under `>` → `>=`; it reds
   when the branch is neutered.

## Bound, stated rather than implied

These fixtures cover the STRUCTURAL tier only. MUST-1's read-order clause is ultimately a
session-history judgment, and its semantic tier is UNCOVERED: the probe suite
`.claude/test-harness/probes/session-notes-continuity.probes.json` is unwritten under a
dated declaration in `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals`.
A green run here is evidence about the detector's predicates, never about whether the rule
changes agent behavior.
