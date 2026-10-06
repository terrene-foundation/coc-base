# gate2-target-verifiability — loom#1745 + loom#1750

Regression lock for the Gate-2 **target-verifiability** gate in
`.claude/bin/sync-gate2-worktree.mjs`.

## What it guards

Gate-2 asserts a distribution contract — "this tree landed, CI-gated" — that it never
checked the TARGET could honour. `commitPushPrMaybeMerge` opened a PR into any resolvable
target and `gatedMergeHint` told the operator to "merge after CI green", on repos where no
check will ever report. The operator's only options were merge-blind or hold.

The gate probes `repos/<owner>/<repo>/branches/main/protection` before any commit/push side
effect, classifies the target `verifiable` / `unverifiable` / `unknown`, SURFACES the verdict
loudly, records it in the receipt (`target_verifiability`), and — on the `--merge` path only —
REFUSES (exit 6) unless `--accept-unverified-target` is passed.

## Bipolar by construction

Every verdict case is paired. Pole A payloads MUST classify `verifiable` (gate silent); pole
B/C payloads MUST NOT (gate fires). A classifier hardwired to either pole reds on the other,
so nothing here is "shown only to pass".

The sharpest pair is `null-vs-absent-discriminated`. GitHub omits `required_status_checks`
entirely for one repo state and returns it `null` for another. `p.required_status_checks?.…`
collapses both to one falsy value; `hasKey` keeps them apart and gives each its own reason.

Two cases are SOURCE PINS. A perfect classifier that nothing calls is exactly the un-gated
shape this fixture exists to prevent, and it prints an identical green
(`instrument-discipline.md` MUST-1).

## Measured mutations (2026-08-16, `GATE2_DRIVER=<mutant>`)

Unmutated control: **19/19 PASS, exit 0**.

| # | Mutation | Result |
|---|----------|--------|
| M1 | `classifyTargetVerifiability` returns `verifiable` unconditionally | exit 1, 5/19 — reds all three poles + notice + receipt cases |
| M2 | `hasKey(p,"required_status_checks")` → `p?.required_status_checks` | exit 1, 18/19 — reds `null-vs-absent-discriminated` ONLY |
| M3 | `--merge` refusal predicate → `if (false)` | exit 1, 18/19 — reds `wiring/auto-merge-refuses-on-non-verifiable` ONLY |
| M4 | errored probe returns `status:"not-found"` (reads an auth failure as "unprotected") | exit 1, 18/19 — reds `probe/auth-failure-maps-to-error` ONLY |
| M5 | probe call replaced by a hardcoded `verifiable` verdict in `commitPushPrMaybeMerge` | exit 1, 18/19 — reds `wiring/probe-is-called-before-the-commit` ONLY |

M2–M5 each red exactly one case, which is what makes those cases readable as evidence about
their own proposition rather than as generic smoke.

## loom#1750 — the distributed verifier and the `unregistered` tier

#1745 made an unverifiable target loud. It could not make one verifiABLE: loom distributed
the COC artifact corpus and distributed nothing able to validate it, so the only route out of
`unverifiable` was for someone to hand-author a workflow, and every new target repeated the
gap. #1750 adds the other half — `.claude/ci-templates/coc-artifact-validate.yml`, emitted
into the Gate-2 worktree at `.github/workflows/coc-artifact-validate.yml` by `emitCiVerifier`.

Three properties are under test here, and the third is the one that is easy to get wrong:

1. **Preserve semantics are STRUCTURAL.** loom writes exactly one path under `.github/` and
   never enumerates any other, so `emit/preserves-a-target-owned-workflow` asserts the sibling
   file is still there — not that a preserve list happened to cover it.
2. **The tier changes the REMEDY, not the decision.** `unregistered` refuses `--merge` on the
   same footing as `unverifiable`; only a human running the registration command flips a
   target to `verifiable`. `unregistered/still-refuses-auto-merge` pins that.
3. **`unknown` does not upgrade.** A file in the tree is not evidence about protection state.
   `unregistered/does-NOT-upgrade-an-unknown-verdict` is the pole a naive "verifier present ⇒
   say unregistered" implementation reds on.

`onbase/reads-the-commit-not-the-working-tree` exists because the first implementation of
`ciVerifierOnBase` used `git cat-file -e`, which was MEASURED to exit **128** for a path
absent from the tree AND 128 for a bogus sha — one status for two opposite meanings. Every
call therefore returned `null` and silently fell back to a filesystem read, which on the
`--finalize` path answers a different question ("is it in the tree now?", yes — a prior
`--stage-only` wrote it) and would have downgraded every first-ever delivery to "already
landed, register now". `git ls-tree` separates the three states and the case pins it.

### Measured mutations (2026-08-16, unmutated control **48/48 PASS, exit 0**)

> The `N/48` denominators in this table and the `N/19` in the one above are the suite
> size ON THE DATE EACH ROW WAS MEASURED, and are deliberately not restated as the suite
> grows — a re-written denominator would claim a re-measurement that never happened. The
> CURRENT control is the one in § Running, and it is the only figure to cite as live.

Driver mutations run via `GATE2_DRIVER=<mutant>`; template mutations edit
`.claude/ci-templates/coc-artifact-validate.yml` in place and restore. Each was confirmed to
have APPLIED (`cmp` against the original) before its result was read — a mutation that does
not change the file is a second non-discriminating instrument, not a verdict
(`instrument-discipline.md` MUST-2(b)).

| #   | Mutation                                                                       | Result                                                          |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| M6  | `notVerifiable` ignores `present` (never upgrades to `unregistered`)           | exit 1, 45/48 — reds both tier cases + the notice case          |
| M7  | the `unknown` branch upgrades when the verifier is present                     | exit 1, 47/48 — reds `does-NOT-upgrade-an-unknown-verdict` ONLY |
| M8  | `ciVerifierOnBase` reverts to `fs.existsSync`                                  | exit 1, 46/48 — reds both `onbase/` cases                       |
| M9  | `emitCiVerifier` `rm -rf`s `.github/workflows/` before writing                 | exit 1, 47/48 — reds `preserves-a-target-owned-workflow` ONLY   |
| M10 | the template context-name check becomes `if (false)`                           | exit 1, 47/48 — reds `refuses-a-template-whose-context-name-drifted` ONLY |
| T1  | a `paths:` filter is added back to the template's `pull_request` arm           | exit 1, 47/48 — reds `pr-arm-carries-no-subtracting-filter` ONLY |
| T2  | the aggregator job is renamed away from `COC required checks`                  | exit 1, 43/48 — reds the name pin + every emit case (the emit refuses a drifted template, which is the intended fail-closed) |
| T3  | the aggregator's `*)` default branch exits 0 instead of 1                      | exit 1, 47/48 — reds `unrecognised-outcome-reds` ONLY           |
| T4  | the "no validator ran" floor is made unreachable                               | exit 1, 47/48 — reds `validator-absence-is-a-RED` ONLY          |
| M11 | the SINGLE-SHOT `emitCiVerifier(...)` call is deleted (finalize left intact)   | exit 1, 47/48 — reds `emitter-runs-before-the-single-shot-manifest-capture` ONLY |

**M11 is a correction, not a new case (2026-08-17, rebase onto `main`).** As authored, that
pin `indexOf`-searched the WHOLE driver, so its first hit was the FINALIZE path's emit. Measured
two-pole on the rebased tree: deleting the single-shot call left it **48/48 green**, and deleting
the finalize call reddened only `finalize-re-emits-into-the-enriched-worktree` — it reddened only
when BOTH calls were gone, so it could not return the other answer for the property in its own
name (`instrument-discipline.md` MUST-1/MUST-2). The pin now slices from `// ── Mode: single-shot`
before searching, and the M11 row is the two-pole re-measure of the fixed form.

### Measured mutations (2026-08-18, correctness round, RE-MEASURED after rebase onto
`a89705d9`, unmutated control **82/82 PASS, exit 0**)

Six poles added for four defects a correctness pass found on this branch. Each row was run
against the fixed driver, one mutation at a time, restoring between runs; the mutation was
confirmed applied before its result was read.

| #   | Mutation                                                                                  | Result                                                                 |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C1  | `preexisting` reverts to the unconditional `onBase === null ? fs.existsSync(dest) : onBase` | exit 1, 81/82 — reds `an-UNRESOLVED-base-probe-never-manufactures-already-landed` ONLY |
| C2  | the OVER-fix: `onBase === null` always resolves `false`, killing the legitimate fs read     | exit 1, 81/82 — reds `the-single-shot-filesystem-fallback-is-PRESERVED` ONLY |
| C3  | the `probeUnresolved` WARN suffix is dropped from `formatCiVerifierReport`                  | exit 1, 81/82 — reds `an-unresolved-probe-is-ANNOUNCED-not-silently-resolved` ONLY |
| C4a | `treeAlreadyWritten: true` deleted from the `--finalize` call site                           | exit 1, 81/82 — reds `finalize-DECLARES-its-tree-already-written` ONLY |
| C4b | `treeAlreadyWritten: true` ALSO added to the single-shot call site (over-declaration)        | exit 1, 81/82 — reds the same pin ONLY (it is bipolar over both sites) |
| C5  | `isInvokedAsMain` reverts to taking a module URL and converting inside                       | exit 1, 81/82 — reds `isInvokedAsMain-takes-the-SAME-argument-shape-as-its-sibling` ONLY |
| C6  | the withdrawn "Its verifiability verdict is unaffected" sentence is restored                 | exit 1, 81/82 — reds `the-opt-out-report-does-not-claim-the-verdict-is-UNAFFECTED` ONLY |

C1/C2 and C4a/C4b are deliberate PAIRS: without the second pole of each, a fix that simply
hardwires the safe answer (or declares the flag everywhere) would satisfy the first.

These rows were measured twice: once at control 80/80 before the rebase onto `a89705d9`, and
again at control 82/82 after it. EVERY mutation reddened the SAME pin, and only that pin, in
both runs — a rebase that changed which pin a mutation reds would be a finding, not a merge
artifact, so it was checked rather than assumed. Each mutation was confirmed APPLIED before
its result was read (C4a `grep -c` 1 -> 0, C4b 1 -> 2, C6 1 -> 2).

## Running

```bash
node .claude/audit-fixtures/gate2-target-verifiability/run.mjs        # prints its own control
node .claude/bin/run-audit-fixtures.mjs --only gate2-target-verifiability
```

**Case count — CURRENT vs AS-OF.** The CURRENT count is deliberately **not restated
here**. The runner prints its own control on every run and
`.claude/test-harness/ci-audit-fixtures.json` declares the floor; those two are the
sources, and the floor is authoritative by construction — prose is compared TO it and
can never redefine it (`audit-fixture-prose-count-coupling.test.mjs`). A number copied
into this paragraph would be a SECOND source of truth that goes stale on the next
fixture addition, which is the exact drift loom#1793 exists to stop and which this
paragraph itself caused: it said `82` after the count had moved to `94`, and CI caught
it. Read the count, do not cite it.

The `19/19`, `48/48`, `80/80` and `82/82` figures in the mutation tables above are a
different thing and are deliberately LEFT STANDING: each is AS-OF the date its table
carries, and a mutation result is only readable against the control it was measured
on. Renumbering them to today's count would falsify the measurement rather than
refresh it. Do NOT cite any of them as the current count either.

The **cases added after the 48-case measurement and carrying no table row**
(the loom#1760 second pass — the `escapePole` family, the containment and
`landedInTree` disjunction pins, the call-site region pins, the dry-run set — plus
the two cwd-anchoring cases from the SEC-1 lane) carry their measured two-pole
evidence in a comment AT each case rather than as a table row here, because several
of them pin a DISJUNCTION whose single-lever mutations are individually inert — a
one-line table row would misreport them. Read the case comment, not this table, for
those. (This paragraph said `26` when authored: correct against its own baseline,
stale by the time it landed, because the SEC-1 lane added two cases in the commit
directly beneath it. Same off-by-a-sibling-lane drift the § Running figure carried.)

No network: the protection probe takes an injectable runner, so every `gh` outcome
(404 / auth failure / unparseable body) is exercised without a live repo. The #1750 cases use
throwaway temp trees (and one throwaway `git init`) rather than a live target.
