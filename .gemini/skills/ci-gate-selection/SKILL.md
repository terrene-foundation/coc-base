---
name: ci-gate-selection
description: "Narrowing a CI gate suite without going blind: diff-scoped selection by reverse-dependency closure, and enrolment-by-default discovery. Measured economics + calibration blind spots."
---

# CI Gate Selection — Narrow What RUNS, Guarantee Nothing Silently OPTS OUT

Two patterns, harvested from two repos in this family that built them **independently**, in different languages, from the same pain. They are complements, not alternatives:

- **Selection** (`§2`) decides which of N gates a given change needs. It makes the suite cheap.
- **Enrolment** (`§3`) decides which gates are in N at all. It stops the suite going blind — including blind to what selection just narrowed away.

Shipping selection without enrolment is how a suite becomes fast and worthless: every narrowing decision is a place a gate can quietly stop being asked, and nothing reports it.

`rules/ci-job-budget.md` MUST-1 already requires every PR-reachable job to be **required**, **relevance-gated**, or **budgeted**. It does not say how to COMPUTE relevance, and a wrong answer there is a gate that no longer gates. This skill is that missing HOW. Depth: `reverse-dependency-scoping.md` (the closure, the fail-open contract, the calibration procedure) and `enrolment-by-default.md` (glob discovery, the marker contract, the population precondition).

## When to use

Before narrowing any gate suite — a CI matrix, a pre-flight command set, an audit-fixture run, a probe dispatch. Before adding a `paths:` filter or an `if:` skip to a job. Before writing a hand-maintained list of "the checks we run". After a gate is found unwired.

## 1. The ordering — parallelism first, selection second

**Measured this session: parallelising an already-serial gate suite bought ~5x, and it was free** — no selection logic, no calibration, no new way to be wrong. Diff-scoped selection is second-order next to that.

The ordering matters because the two efforts are not comparable in risk. Parallelism cannot make a gate blind; it runs everything, sooner. Selection can, and its failure mode is silent. A reader who inverts the order spends the harder, riskier effort on the smaller win, and often spends it on a suite whose real problem was that it ran one thing at a time.

```text
# DO — exhaust the free win, then decide whether the paid one is still needed
serial suite → parallel suite (~5x, no new failure mode) → measure again → scope if still slow
# DO NOT — reach for scoping because it is the more interesting problem
serial suite → reverse-dependency closure → still serial → ~1.4x and a new blind spot
```

Two carve-outs where selection genuinely leads: when the unit of work is a **compile** (parallel compiles of the same 81 packages still compile 81 packages — §2's whole point), and when the pool is saturated, where parallelism converts execution time into queue time and buys nothing (`rules/ci-cost-discipline.md` measured 78% of elapsed time as queue).

## 2. Pattern 1 — diff-scoped selection by reverse-dependency closure

**Reference implementation: kailash-rs, `scripts/ci/clippy-scope.mjs` (252 lines) + `scripts/ci/job-crate-scope.mjs`.** Cited, not vendored — see §5.

### Mechanism

1. Take the PR's changed-file list (`git diff --name-only <merge-base>...HEAD`).
2. Map each path to the **package** that owns it, against the workspace's own manifest — the authoritative enumeration, never a hand-kept prefix list (`rules/verification-gate-integrity.md` MUST-3(a)).
3. Compute the **reverse-dependency closure**: every package that transitively depends on a touched package. This is the set that can actually have been broken.
4. Emit the closure as gate arguments (`-p a -p b …`).
5. A **second** script decides which crate-scoped JOBS run at all, from the same closure — so an irrelevant job is skipped per-JOB, never by a workflow `paths:` filter (`rules/ci-job-budget.md` MUST-2: a path-filtered workflow providing a required context never reports, and the PR wedges).
6. **Any unresolvable path FAILS OPEN to `--workspace`.** Unknown means everything, never nothing.

### What it costs, in the right currency

**The selection axis that pays in a compiled language is the PACKAGE, not the test function.** Narrowing which test functions run leaves the compile untouched, and the compile is most of the bill. Measured on kailash-rs: a one-line leaf change costs **16–17s** of recompile against **40.8s to RUN one crate of 48** — warm, the run dominates, and only the `-p` closure cuts compile and run together.

Read that as a decision rule, not a constant: **scope on the axis your build system charges you for.** In an interpreted corpus with no compile step, the test-file axis may be the right one; in a compiled one it is nearly worthless.

### Measured — blast radius over 81 workspace packages

| quantity | measured |
| --- | --- |
| min / p25 / **median** / p75 / p90 / max | 1 / 2 / **6** / 18 / 30 / 46 |
| mean | 11.7 |
| crates reaching ≤10% of the workspace | **65%** |
| crates reaching >50% of the workspace | 9% |
| applied to 17 real commits | 5 resolved FULL, 12 resolved to 1–41 packages (median ~28) |

The median change narrows to **6 of 81 — a 93% reduction**. All five FULL resolutions touched `Cargo.lock` or the root manifest, i.e. the fail-open path firing exactly where it should.

### Blind spots — the three that make naive copying dangerous

**(a) The distribution is BIMODAL, not proportional.** 65% of crates reach ≤10% of the workspace; **7 hub crates reach 42–46 of 81 and are not narrowable at all.** A policy that assumes proportionality is wrong for both halves — it under-scopes the leaves (leaving an easy 93% on the table) and over-promises on the hubs (advertising a saving that cannot exist). Design for two regimes: narrow hard on leaves, and on a hub touch, accept the full run rather than inventing a partial one.

**(b) Fail-open is a REQUIREMENT, not a default.** Every unresolvable path — a new directory, a root manifest, a lockfile, a rename the mapper does not understand — MUST widen to the full run. A selector that fails CLOSED converts every gap in its own path-mapping into a silently-skipped gate, which is precisely the "absence reads as a pass" failure `rules/verification-gate-integrity.md` MUST-2 exists to block. The reference implementation carries this on both scripts.

**(c) Per-corpus calibration is MANDATORY; the constants do not travel.** Fan-out is a property of a repo's dependency graph, and graphs differ by an order of magnitude. loom carries a live instance: `.claude/bin/owed-suites.mjs` pins `FANOUT_MAX = 3` — above it, a file is reported BROAD and no suite is named as its owner. Measured against loom's own artifact graph (**p90 8, max 55**) that constant is defensible. Measured against a sibling repo's source graph (**p90 15, max 160**) the SAME constant would **refuse 44.3% of its modules** — every one of them BROAD, every one unowned. Same logic, same number, a reasonable threshold in one repo and a wall in the other. Port the INSTRUMENT; re-derive every NUMBER. Procedure: `reverse-dependency-scoping.md` § Calibration.

### The negative controls the reference carries

`clippy-scope.mjs` ships **12/12 arms** controlled; `job-crate-scope.mjs` ships **16 arms with BOTH `run=true` and `run=false` reachable**. That second form is the load-bearing one: a selector control that only ever demonstrates `run=true` proves the selector can say yes, and says nothing about whether it can correctly say no — the arm-vs-matcher gap `.claude/audit-fixtures/_lib/arm-coverage.mjs` mechanises for this corpus. A selector is a two-poled instrument and owes a firing at each pole, per arm (`rules/instrument-discipline.md` MUST-3(a)).

## 3. Pattern 2 — enrolment by default

**Reference implementation: csq, `scripts/run-ci-gates.sh` + `ci-gate-registry.txt`.** Cited, not vendored — see §5.

### The failure mode, in the implementation's own header (2026-08-08, verbatim)

> "On 2026-08-08 both gates written the previous session to prevent recurrence were found to be UNWIRED... The self-tests pass because they construct a synthetic fixture tree... They prove the gate DISCRIMINATES. They say nothing about whether it is ever ASKED... This is the fourth instance of one class in two sessions."

That is `rules/verification-gate-integrity.md` MUST-3(b) — invocation coverage — arrived at independently, in bash, from a different repo's pain. loom hit the same class seven times in one session and shipped two mechanisms for it: `check-clause-coverage.mjs` (lever L5: a clause added to an already-covered rule, zero probe rows, every gate green) and `.claude/audit-fixtures/_lib/arm-coverage.mjs`. **Consumer note:** the first lives under `.claude/bin/`, which is `loom_only` — MEASURED `skip` on all six lanes — so a consumer receives this description of it, not the tool. `arm-coverage.mjs` DOES ship (`copy` on all six). The pattern is the transferable part either way. Three repos, one defect class, three independent fixes. That convergence is the argument for distributing the pattern rather than re-deriving it a fourth time.

### Mechanism

1. Gates are **DISCOVERED BY GLOB**, never enumerated by hand. The filesystem is the authority; the runner asks it.
2. Every discovered file MUST carry a machine-readable enrolment marker (`# ci-gate:`).
3. **A missing marker is a FAILURE, not a skip.** This is the whole pattern. Everything else is plumbing.
4. Opting out is therefore an explicit, reviewable, greppable declaration — not the consequence of forgetting to add a line to a list.

The inversion is small and total: under hand-enumeration the default for a new gate is *unwired*, and wiring it is an act someone must remember; under enrolment-by-default the default is *wired*, and un-wiring it is an act someone must justify in a diff. The same inversion is why `check-clause-coverage.mjs` fails on a clause with no rows instead of reporting a suite that exists.

### Blind spot — enrolment is only as sound as its population

Enrolment-by-default converts a silent skip into a loud failure. That is a strict improvement **only if the glob's population is itself checkable**. If the glob can miss a gate — wrong directory, unexpected extension, a gate that lives outside the scanned root, a `.mjs` where the glob says `.sh` — then the loud failure never fires for the gate that most needed it, and the green now carries MORE authority than before because the mechanism looks exhaustive.

So the population needs its own control: a planted file that the glob MUST discover, run where the runner runs. Without it, the pattern relocates the trust rather than earning it. Detail: `enrolment-by-default.md` § The population control.

## 4. How the two compose

Selection is a per-run narrowing; enrolment is a per-gate census. Wire them in this order, and keep the census OUTSIDE the narrowing:

```text
# DO — the census runs unconditionally; only the gates it found are then scoped
enrolment census (all gates discovered + marked)  → unconditional, cheap, always runs
  └─ diff-scoped selection over the discovered set → per-run, fail-open
# DO NOT — scope the census itself
"the diff didn't touch scripts/ci/, so skip the gate census"   ← the census IS what
                                                                 notices the gap
```

A census cheap enough to run unconditionally is a design constraint on the census, not an excuse to gate it. If the census is expensive, that is the thing to fix.

## 5. Provenance — cited, not vendored

Both implementations belong to **other repos** and are referenced here as design evidence. Nothing in this skill is a copy of their code, and neither file is distributed by this manifest. `scripts/ci/clippy-scope.mjs`, `scripts/ci/job-crate-scope.mjs` (kailash-rs) and `scripts/run-ci-gates.sh`, `ci-gate-registry.txt` (csq) are named so a reader can find the prior art in the repo that owns it, under that repo's own authorization — not so it can be lifted.

Every figure in §2 and §3 is a measurement of the repo it names, on the date it names, and is evidence about **that** repo (`rules/ci-cost-discipline.md` § "the INSTRUMENT transfers; the NUMBERS do not"). Carrying kailash-rs's median-6 to another workspace is an unverified claim; the 44.3% figure in §2(c) exists precisely to show what happens when someone does.

## 6. Cross-references

| Concern | Authority |
| --- | --- |
| Whether a job may exist at all (required / gated / budgeted) | `rules/ci-job-budget.md` MUST-1 |
| Why relevance is a per-JOB `if:`, never a workflow `paths:` filter | `rules/ci-job-budget.md` MUST-2 |
| A gate's negative control, and absence-is-not-a-pass | `rules/verification-gate-integrity.md` MUST-1, MUST-2 |
| Scope and invocation checked against an authority | `rules/verification-gate-integrity.md` MUST-3 |
| An arm never shown to fire carries no information | `rules/instrument-discipline.md` MUST-3(a) |
| The scoped local pre-flight command sets | `rules/git.md` § "Pre-FIRST-Push CI Parity Discipline — SCOPED By Default" |
| What CI minutes actually are (queue vs execution) | `skills/30-claude-code-patterns/ci-cost-discipline-evidence.md` |

## 7. Searched for and NOT found

- **No measurement of the two patterns composed.** Both were measured alone, in different repos. The composition in §4 is a design argument, not a measured result — labelled as one per `rules/evidence-first-claims.md` MUST-4.
- **No cost figure for the enrolment census.** §4 asserts it must be cheap enough to run unconditionally; no instrument has produced its duration in any of the three repos.
- **No threshold is given for when scoping is worth building.** The ~5x parallelism figure and the 93% median narrowing were measured on different corpora and are not comparable; deriving a cut-off from them would be the invented-constant failure §2(c) names.
- **The ~5x parallelism figure is a single session's measurement on one suite**, not a corpus-wide result. It supports the ORDERING claim (free beats paid) and nothing finer.
