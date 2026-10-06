# codify-lease-journal-scope — RS-50 regression lock

Locks `codify-lease.js::_sortDedupRel` / `_resolveJournalScope`: every lease scope
auto-unions the journal directories `/codify`'s own phase-complete gate writes to,
in a **bounded** shape the signed `codify-lease` record can actually carry.

## The defect this locks

**RS-50 (original).** `commands/codify.md` Step 0 tells the caller the helper
unions only `.claude/learning/learning-codified.json` +
`.claude/.proposals/latest.yaml`. § "Journal (MUST — phase-complete gate)" then
REQUIRES a journal entry before `/codify` may be reported complete. A caller
following the command literally acquired a lease covering two files and was then
halt-and-reported by `integrity-guard.js` for the journal write — "no covering
codify-lease record found in the folded coordination log" — on a step the same
command mandates.

Source: kailash-coc-rs proposal entry **RS-50** (`action: modify`, `origin: downstream`).

**The record overflow (2026-08-16).** The RS-50 fix resolved those prefixes by
ENUMERATING `workspaces/` on disk. That list is O(repo size) and lands verbatim in
`content.scope_files` of the signed record, which `coc-emit.js::_defaultAppend`
caps at 2048 B. Measured: the record crosses the cap at the **twelfth** enumerated
workspace and reached **2964 B** on loom's 31 — reproduced end-to-end 2026-08-23
against the real `_defaultAppend` — so every **main-checkout** acquire was REFUSED
and the cross-clone visibility surface `knowledge-convergence.md` MUST-3 names
never emitted from there, while `acquireCodifyLease` kept returning `{ok: true}`.

**Not "every acquire" — that earlier claim is withdrawn.** The live coordination
log holds **195** successfully-emitted `codify-lease` records. The refusal tracks
the ENUMERATED COUNT, hence the CHECKOUT: the main checkout has 32 workspace
journal dirs (34 scope entries → 2964 B → refused), a worktree materializes ~11
because most workspace journals are untracked (→ ~13 entries → fits). The log's
own histogram is both the evidence and the reason this went unnoticed: emitted
`scope_files` counts run 2..19 and then stop dead, zero above 19 — the cap was
**censoring its own audit trail**, so the surface an investigator would read
looked healthy precisely because the failures never reached it. The largest
surviving record is 2036 B against the 2048 B cap: **12 B** of headroom.

Byte split at the 2964 B main-checkout scale: `scope_files` dominates; `sig` is
**870 B** (re-measured 2026-08-23 as the median AND max across all 920 signed
records in the live log, so it is effectively a constant — an earlier "896 B"
here was wrong and contradicted this suite's own `MEASURED_GPG_SIG_BYTES`). An
EMPTY `scopeFiles` produced a byte-identical record, so no caller could shrink it.

## Fixture layout

Inline-case definition in `run.mjs`, the variant `cc-artifacts.md` Rule 9 sanctions
alongside per-case sidecars.

```
node .claude/audit-fixtures/codify-lease-journal-scope/run.mjs     # exit 0 = pass
CODIFY_LEASE_LIB=<path> node .../run.mjs                           # drive an alternate build
```

`CODIFY_LEASE_LIB` exists so the RED can be established against an unfixed build
without mutating the working tree.

## What makes a green here evidence

**The previous revision's lever is void, and was replaced rather than patched.** It
read: "the lever is the **layout**, not the call — the same `_sortDedupRel([], root)`
must yield different prefixes for a root-journal repo, a workspace-journal repo,
and a repo with neither." Under a bounded shape the scope is layout-INDEPENDENT by
design, so every layout case now passes no matter what the resolver does with the
directory tree. Rewriting only the assertions that reddened would have left a suite
of constants wearing the grammar of a regression lock.

**The lever is now the PAIR — bounded AND still covering.** Neither half is
sufficient on its own: a resolver returning `[]` is perfectly bounded, and the
enumeration that caused the outage was perfectly covering.

- an enumerating implementation reds `scope-is-bounded`, `record-fits-cap`, and
  `emitted-form-pinned`;
- an implementation that unions nothing, or emits a shape the real covering
  predicate does not accept, reds every coverage case.

`findCoveringLease` is still **not importable** — `integrity-guard.js` has no
`module.exports` and runs an unguarded `main()` IIFE, so requiring it would EXECUTE
the hook. Its three literal branches remain transcribed as `coversRel()`. The
fourth (`globCoversRel`) is **imported** from `guard-path-scope.js`, which is a
plain module, so that branch cannot drift at all.

## Two contract changes, recorded rather than absorbed

**(1) Meta-dirs are now COVERED.** The old `meta-dirs-excluded` case asserted that
`workspaces/_archive/journal/` and `workspaces/instructions/journal/` were NOT
scoped (`cc-artifacts.md` Rule 8). A single-segment wildcard cannot carry a
negative, and pushing the exclusion into the READER would move a writer-side
tidiness policy into the trust predicate. The exclusion is **dropped
deliberately**; the new `meta-dirs-now-covered` case asserts the new behaviour
under a **new name**, so the change shows up in the case list instead of hiding in
a flipped assertion.

Grounds: `guard-path-scope.js::WATCHED_SUBTREE_RX` watches
`workspaces/<any>/journal/` with **no** underscore exclusion, so those paths were
always WATCHED and never COVERABLE — this closes that residual rather than opening
a hole. It is nonetheless a real widening of what one lease authorises. It was
**escalated as a named question to Tier-1 redteam and ruled on** (2026-08-16,
accepted) rather than self-certified.

**The full argument lives at the case itself**, in `run.mjs` immediately above
`meta-dirs-now-covered` — not only here, and not only in the case name. A name
records that something changed; it does not record why, and the next reader of
that case must not have to reconstruct the reasoning. Summary of what is recorded
there: the exclusion is not expressible in a bounded wildcard (no negatives); the
alternative places writer-side tidiness policy inside a trust predicate; and the
change closes a watched-but-uncoverable incoherence. `cc-artifacts.md` Rule 8 is
not authority against it — Rule 8 governs hooks that ENUMERATE workspaces, a
different concern from lease coverage.

**The widening is BOUNDED, and the bound is enforced rather than asserted.**
`coverage-is-a-subset-of-the-watched-set` checks `covered ⇒ watched` over a probe
set with negative probes (so it cannot pass by covering nothing). What an
adversary or careless operator gains is therefore exactly: a session already
holding a valid lease, on its own date-terminal codify branch, under its own
verified signer, may write `workspaces/_archive/journal/**` without a fresh halt.
Nothing outside the watched set becomes reachable, and the branch + signer checks
in `findCoveringLease` are untouched.

**(2) The covering predicate gained a fourth branch,** and the pin was strengthened
because it failed to notice. The old pin asserted only that the three transcribed
lines were PRESENT — which stays true when a fourth branch is ADDED. That is
exactly what happened on 2026-08-16: the pin did not red, and the stale
transcription was caught incidentally by the coverage cases. The pin now asserts
the branch SET: all four lines present **and** exactly four `return rec;` branches
in the function, so a fifth reds here.

## The trailing-slash form

The previous README warned: *"A maintainer who rewrites [`meta-dirs-excluded`] to
assert coverage instead of membership removes the last thing holding the emitted
form."* That case is precisely what changed — so the form is not left unheld.
`emitted-form-pinned` now asserts the emitted array and both constants literally,
which is a **stronger** hold than the incidental one it replaces.

## Mutations, as MEASURED (`instrument-discipline.md` MUST-2(b))

Applied to a copy of the real module driven through `CODIFY_LEASE_LIB`. Each row's
mutation was shown to REACH the code before the run, so no row is a
mutation-that-never-executed masquerading as a verdict.

| #      | Mutation                                                              | Reach proof                                              | Result        | Cases red                                                                                                                             |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **M4** | per-workspace enumeration reintroduced (the pre-overflow-fix shape)   | mutant emits **48** journal entries vs the real **2**    | **7/14 PASS** | `workspace-journal-covered`, `pending-subdir-covered`, `scope-is-bounded`, `record-fits-cap`, `meta-dirs-now-covered`, `emitted-form-pinned` |
| **M5** | the covering wildcard widened to cross separators (`[^/]*` → `.*`)   | `globCoversRel` on a NESTED workspace flips `false` → `true` | **13/14 PASS** | `coverage-is-a-subset-of-the-watched-set` |

`record-fits-cap` reported **3731 B > 2048 B** under M4 — i.e. the case reproduces
the production overflow directly, not by proxy.

M5 is the one that keeps the accepted widening honest: it names the offending
path in its failure text (`COVERED but NOT WATCHED: workspaces/a/b/journal/…`),
so a future loosening of the glob reds with the reason attached rather than as a
bare boolean.

Historic rows M1–M3 measured against the pre-2026-08-16 revision are dropped rather
than restated: they were measured against a `_sortDedupRel(files, repoTop)` whose
second parameter no longer exists, so re-listing them would imply a currency they
do not have.

## What a green does NOT prove

- It does **not** prove the end-to-end guard allows the write. That needs the real
  `integrity-guard.js` driven with coordination enabled, a roster and signed fold
  records — which is what
  `tests/integration/multi-operator/integrity-guard-lease-glob-scope.test.js` does
  (and which is where a deletion of the `globCoversRel` wiring reds; this fixture
  would stay green, since `coversRel()` here is a local composition).
- It does not cover a workspace created mid-session, after the lease was acquired.
  Under the bounded shape this residual is now **closed** for the workspace-journal
  family — the glob matches workspaces that do not exist yet — but a caller needing
  any other new path still passes it explicitly in `scopeFiles`.
- It does not bound the CALLER's `scopeFiles`. Measured headroom after the fix:
  1523 B used of 2048 B, leaving room for roughly 14 further ~40 B paths. Beyond
  that the record still refuses — which is now surfaced LOUDLY
  (`[LEASE-RECORD-NOT-EMITTED]` on stderr plus a top-level `degraded` on the
  acquire result) instead of silently.
