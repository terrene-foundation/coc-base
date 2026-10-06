# CI Cost Discipline — Measurement, Decision Procedures, and Cross-Repo Mapping

Depth companion to `rules/ci-cost-discipline.md`. Every `MUST-N` anchor in that rule resolves here.

**Read this before proposing any change to PR cadence, batching policy, workflow concurrency configuration, or a "CI is slow" remedy.** It exists so the 2026-08-12 measurement is not re-derived, and so the one intuition that measured backwards is not re-adopted.

## 1. The measurement, stated once

Instrument:

```bash
gh run list --repo <owner>/<repo> --limit 100 \
  --json databaseId,conclusion,event,status,startedAt,updatedAt,headBranch,workflowName
# duration = updatedAt − startedAt, over runs where status == "completed"
```

Run against loom on 2026-08-12 at `--limit 800`; **793 of the 800 fetched runs were `completed`** and only those are counted. The eight non-completed runs are excluded deliberately: an in-flight run has no end timestamp, so including it would report a duration measured from an unfinished interval.

**Falsifying result, named before the figures were read** (`instrument-discipline.md` MUST-1): if consolidation and re-push discipline were not worth codifying, this instrument would print a cancellation share near zero, a runs-per-PR-branch ratio of 1.00, and no cancelled minutes concentrated on multi-run branches. It printed the opposite on all three.

| quantity                       | measured (n=793)                     |
| ------------------------------ | ------------------------------------ |
| total wall-clock               | **11,308 min ≈ 188.5 h**             |
| `pull_request` runs            | 532 runs / 9,306 min / avg **17.5**  |
| `push` (main) runs             | 261 runs / 2,002 min / avg 7.7       |
| successful `pull_request` run  | avg **20.8 min**                     |
| cancelled                      | **119 runs / 1,208 min** (15.0%)     |
| — on a **PR branch**           | **78 runs / 1,165 min** (avg 14.9)   |
| — on **main**                  | 41 runs / **42 min** (avg ~1)        |
| PR branches / PR runs          | 177 / 532 = **3.01 runs per branch** |
| branches with >1 run           | **103 of 177 = 58%**                 |
| runs-per-branch distribution   | 74×1, 38×2, 19×3, 11×4, 13×5, 8×6, 6×7, 3×8, and a tail to 24 and 48 |

### 1b. Sample size is itself a measurement error — the third in this family

The FIRST draft of this rule ran the identical instrument at `--limit 100` and reported 1.45 runs/branch and 27% cancelled. Both were artifacts. Re-run at increasing limits against the same repo:

| `--limit` | runs/PR branch | cancelled share |
| --------- | -------------- | --------------- |
| 100       | 1.55           | 27%             |
| 400       | 2.53           | —               |
| 800       | **2.98–3.01**  | **15.0%**       |

Monotonic, and the mechanism is plain: a fixed recent-N window truncates each branch's run history, so most branches appear holding only their newest run. That biases runs-per-branch toward 1.00 and inflates the cancelled share (recent activity is disproportionately re-push churn).

**Consequence worth carrying:** the co-owner's original estimate — "half the gate runs are always repeat attempts" — was VINDICATED at the honest sample size, on the branch axis: **58% of PR branches carried more than one run**. The first measurement made that estimate look wrong by ~3×. It was the measurement that was wrong, and a measurement is not automatically more trustworthy than the intuition it contradicts.

Only two workflows exist at loom — `COC Artifact Eval` (65 runs) and `Publish client-template` (27). Matrix fan-out is therefore **not** loom's cost driver.

### 1a. What those minutes actually are — the queue/execution split

The run-list instrument above reports `updatedAt − startedAt`, which is **wall-clock and includes queue wait**. It physically cannot separate queueing from executing. A second instrument — the job/step API — can, and it changes the interpretation of every figure in §1:

| quantity (heavy job, 30 runs)        | measured                          |
| ------------------------------------ | --------------------------------- |
| total queued                         | **1,750.5 min**                   |
| total executing                      | 492.9 min                         |
| **queue share of elapsed time**      | **78%**                           |
| avg queued per run                   | 134.7 min                         |
| avg executing per run                | **11.9 min**                      |
| wall-clock p50 / p90 / max           | 47 min / **183.5 min** / 293.3 min |
| billed-equivalent p50                | **14.3 min**                      |
| cancelled PR runs that ran ZERO steps | **13**                            |

Three consequences, each of which the rule states rather than eliding:

1. **Run LENGTH is not the driver either — QUEUE is.** The correct remedy is fewer queue entrants (MUST-2, MUST-3), not faster jobs. A job optimisation that halves the 11.9 min execution moves 6 minutes of a 47-minute p50.
2. **The 474 "wasted minutes" are not runner capacity.** Most of those runs never executed a step. Re-push discipline buys back author wall-clock and queue slots; it does **not** free machine time, and saying it does would be an over-claim of exactly the kind `evidence-first-claims.md` MUST-4 blocks.
3. **Wall-clock and billed cost diverge by ~3×** (p50 47 min vs 14.3 min billed-equivalent). Any argument about CI must say which one it is spending. Most "CI is killing us" complaints are about the first; most budget conversations are about the second.

Do not import a "reduce the matrix" or "speed up the job" remedy from repos where those dominate without re-running BOTH instruments.

## 2. The intuition that measured backwards

The prevailing framing when this rule was commissioned was that burst-merging into a shared-concurrency `main` is a principal source of waste, supported by the observation that 10 of the 25 cancellations were on `main`.

**The count is correct and the cost inference is wrong.** Those main-branch cancellations totalled **42 minutes across 41 runs** — about a minute each — because a `main` run is killed by the next merge almost immediately after starting. Burst-merging at loom destroys approximately nothing.

**1,165 of the 1,208 cancelled minutes (96.5%) are on PR branches**, killed by a subsequent push to the same open PR. That is the entire waste, and it is the behaviour that feels free from inside the session, because the destroyed run is asynchronous wall-clock nobody in the session is watching.

This is why `rules/ci-cost-discipline.md` leads with MUST-1 and states MUST-4 at its measured cost. The general lesson generalizes past CI: **a count of events is not a measure of their cost**, and the cheap-feeling action was the expensive one precisely because nothing reported its bill.

**The same error then recurred one level up, in this rule's own first draft.** Having correctly replaced a count with a duration, the draft treated the duration as though it measured WORK — justifying itself as saving 474 runner-minutes. §1a refutes that: the minutes are mostly queue, and 13 of the cancelled runs executed nothing. So the sequence is: count → duration → *what the duration is made of* → *over how large a window* (§1b). Four corrections, each invisible from the step before, and the fourth reversed the sign of the co-owner's original estimate. Whoever proposes the next CI remedy should assume there is a fifth question they have not asked yet.

MUST-4 survives as a MUST anyway. The 42-minute figure is a property of loom's workflow shape (a main-branch job that does little), not of the mechanism. Against a target whose main-branch job publishes, runs integration, or fans out a matrix, a burst of N merges destroys N−1 nearly-complete runs. Scope the clause to where it bites; do not carry loom's 42 minutes anywhere else as evidence that burst-merging is cheap.

## 3. The self-implication, measured rather than confessed

The three PR branches carrying four runs each in the sampled window:

```
feat/rule-corpus-growth-measurement-2026-08-12   4 runs  c c c s   213 cancelled-min
feat/gate1-usepy-2026-08-12                      4 runs  s c c c    97 cancelled-min
feat/extract-broadload-depth-2026-08-11          4 runs  s c c c    31 cancelled-min
```

The first is the branch of the session that commissioned this rule: three runs started and killed, **213 CI-minutes destroyed on a single PR**, by pushing to find out whether it passed rather than pre-flighting locally. On the consolidation half, `gh pr list` shows nine PRs opened between 01:05 and 02:17 on 2026-08-12, and three opened inside nine minutes at 10:43–10:52 — a wave fanned out to one PR per worktree.

The session that produced this evidence also described amending an already-queued PR as having "zero wall-clock cost". That phrase is in MUST-3's BLOCKED corpus verbatim, because it is the exact reasoning error the clause exists to intercept: the run had not started, so the cost was reasoned about as marginal when it was total.

## 4. The revert-safety decision procedure (MUST-2)

The question is NOT "are these changes related?" — relatedness is a judgment about topic, and topics are elastic enough to justify any bundling. The question is:

> **If this PR is reverted as a single commit, does the tree remain coherent, and does the revert remove exactly one decision?**

Work the test in this order:

1. **Does any part depend on another part to compile / pass / make sense?** If yes, they are jointly revert-safe by construction — they belong in one PR.
2. **Would reverting the whole leave a caller pointing at a removed symbol, a manifest naming an absent file, or a rule citing a deleted skill?** If yes, the pieces are coupled — one PR.
3. **Would a reviewer reverting this PR plausibly want to keep one half?** If yes, they are NOT jointly revert-safe — split, regardless of CI cost.
4. **Are they independent AND would nobody ever want them separately?** Then they may bundle, but the saving is real only if step 3 is honestly answered.

Worked cases:

| change set                                                       | verdict          | why                                                          |
| ---------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| three shards of one rule's audit fixtures                        | **one PR**       | revert removes one decision (the fixture set)                 |
| a rule + its paired skill + its manifest entry                    | **one PR**       | manifest names the file; reverting one alone breaks the other |
| an integrity-guard bug fix + a manifest re-tier                   | **two PRs**      | a reviewer may keep the fix and drop the re-tier              |
| a security fix + an unrelated doc typo                            | **two PRs**      | reverting the fix to drop the typo is a real hazard           |
| five worktrees each producing one independent rule               | **five PRs**     | independent; step 3 answers yes                               |
| five worktrees producing five slices of ONE rule's Wiring block  | **one PR**       | slices of one decision                                        |

**Splitting the REVIEW is not splitting the CI.** A large revert-safe PR can be reviewed commit-by-commit; commits are free and branches are not. Where a reviewer genuinely needs separate discussion threads, use review comments or a stacked-commit walkthrough, not separate PRs, unless step 3 says otherwise.

## 5. The pre-flight sets (MUST-1)

`git.md` § "Pre-FIRST-Push CI Parity Discipline — SCOPED By Default" owns these; they are reproduced here as a pointer only, not as an independent authority — on any disagreement `git.md` governs.

**The sets are SCOPED TO THE DIFF by default** — the selection derived from `git diff --name-only`, never chosen by judgment about relevance. The unscoped forms below are the EARNED-exception path (release · security surface · cross-SDK/binding parity · infra or shared config · an untrustworthy selection → fail closed to full).

- **Rust:** `cargo +nightly fmt --all --check` (whole-tree but seconds), then `cargo clippy $pkgs -- -D warnings` and `cargo nextest run $pkgs` where `$pkgs` is `-p <crate>` per crate the diff touches; `RUSTDOCFLAGS="-Dwarnings" cargo doc` at the earning junctures.
- **Python:** `pre-commit run --files $changed` (NOT `--all-files`), `ruff`/`mypy` over the changed `.py` files, `pytest` over the test dirs owning the changed packages (a repo with no root `.pre-commit-config.yaml` skips the pre-commit step — its configured `ruff`/`pyright` stand in; that is not a parity failure).
- **loom / COC artifacts:** `node .claude/bin/owed-suites.mjs` names the suites the diff touched — run exactly those; plus the always-cheap validators (`validate-xref-integrity.mjs`, `coc-manifest-integrity.mjs`, `detection-binding-check.mjs`, `validate-proximity-band.mjs`, `check-rule-injection-budget.mjs`, `check-clause-coverage.mjs`). The full `run-audit-fixtures.mjs` corpus (~253 suites) is an earning-juncture run, not the default.

The economics, stated in the right currency: a pre-flight costs [UNMEASURED — see `guides/rule-extracts/git.md` § "The local pre-flight cost figure is UNMEASURED"; that file OWNS this figure and no instrument has ever produced it] of **synchronous session time**, and a number was previously printed here in the grammar of a measurement. A re-push destroyed an average of **14.9 minutes** of elapsed run — mostly queue, since 13 of the cancelled runs executed zero steps — and bought a fresh wait with a p50 of **47 minutes** and a p90 of **183.5 minutes**. The pre-flight wins even when it catches nothing, because its cost is bounded and synchronous while the re-push's is unbounded and asynchronous — an ORDERING claim, which holds without a local duration and is the only claim made until one is measured. It does not win on runner minutes, and no argument here rests on that. It is bounded, however, **only in its scoped form**: an unscoped whole-repo pre-flight on every push prices the gate high enough that the session skips it, which is the same failure the clause exists to prevent.

## 6. Cross-repo mapping — build, use, downstream

The co-owner directive was explicit that this discipline reaches every repo class. The mechanism is manifest registration (`knowledge-cascade-routing.md` MUST-2), but the CLAUSES land differently per class:

| class                       | dominant cost                                         | clause that bites most                                   |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| **loom** (splitter)         | long artifact-eval runs; re-push on artifact PRs      | MUST-1, MUST-2                                            |
| **build** (kailash-py/rs)   | compile + test matrices; main-branch jobs do real work | MUST-1 (compile locally), MUST-4 (main runs are expensive) |
| **use** (templates)         | template validation; frequent small PRs               | MUST-2 (consolidate template edits)                        |
| **downstream** (consumers)  | project CI, often unconfigured concurrency            | MUST-4 (no queue → serialize), MUST-1                      |

**Re-measure per repo before importing a remedy.** Every figure in §1 is evidence about loom's configuration on 2026-08-12 and nothing else; carrying it to an adjacent repo is an unverified claim (`journal/0572`). The INSTRUMENT transfers; the NUMBERS do not.

## 7. Merge-queue variants (MUST-4)

- **GitHub merge queue available** → `gh pr merge <N> --auto`. The queue serializes and batches; bursting into it is fine because it is the queue's job.
- **No merge queue, shared concurrency group** → serialize merges, or batch them and accept one run. This is the common build/use/downstream case.
- **No merge queue, no concurrency group** → every merge starts a run that runs to completion. Bursting here is the most expensive variant of all, and the cancellation that made loom's burst cheap does not exist.

Read the workflow before assuming which variant applies; the concurrency stanza is the discriminator:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## 7b. Wave folding — the conditionality, and why it is not universal (MUST-5)

**Origin: a consumer's finding, not loom's.** A downstream BUILD sibling (kailash-rs) measured **~18 runs per PR** in its own repo (504 PR runs / 28 branches) and proposed folding a wave's shards onto one integration branch, so the wave costs one PR run instead of N. loom distributes to that repo via `/sync-to-build rs`, which makes it a **consumer of this artifact, not a peer**: declining the mechanism would have shipped it a gap for a problem it had measured correctly, delivered through the very gate that exists to serve it.

What loom contributed is the **conditionality**, because the mechanism does not generalize unconditionally:

**Precondition A — a branch push must be free.** Folding concentrates N shard pushes onto one branch. That is a saving only if pushing a non-default branch starts no run. It is a property of the workflow's trigger shape:

| trigger shape                                   | A     | folding                                          |
| ----------------------------------------------- | ----- | ------------------------------------------------ |
| `push: branches: [main]` + `pull_request:`      | TRUE  | saves runs (loom's shape, and the sibling's)     |
| `push: branches: ['**']`, or a bare `push:`     | FALSE | **INVERTS** — each shard push starts its own run |
| `push:` on tags only + `pull_request:`          | TRUE  | saves runs                                       |

Under ¬A folding is strictly *worse* than one PR per shard, because per-shard PRs at least get `cancel-in-progress` de-duplication while a shared integration branch accumulates a full run per push. This is the case the unconditional form would have shipped, and it lands hardest in repos whose CI is already worst — the ones most tempted to fold.

**Precondition B — runs-per-PR must be high enough.** Fold when `runs_per_PR × (shards − 1)` exceeds the coordination cost of an integration branch: one more branch to keep rebased, one shared review surface, and a revert that takes the whole wave rather than one shard.

Two anchors, deliberately NOT thresholds — loom **≈3.0** (a 3-shard wave saves ~6 runs; often not worth the branch) and the sibling **≈18** (the same wave saves ~36; decisive). No numeric cut-off is given because the coordination cost is local and unmeasured by this rule, and an invented constant is the failure mode this corpus keeps catching.

**Measure B with a large window.** At `--limit 100` loom's runs-per-PR reads 1.55 against a true ~3.0 (§1b). The error flatters *not* folding, so a lazy measurement produces a confidently wrong "not worth it".

**The generalizable lesson:** a consumer's measurement of its own repo is evidence about that repo. Rejecting it because loom's numbers are smaller would be the mirror of imposing loom's numbers on them. The resolution is neither — it is to ship the mechanism with the preconditions that decide it locally, so one artifact does the right thing in every repo class.

## 7c. The post-merge `push:` arm — 47% of a window, and the decision it is OWED to (MUST-4)

**Measured at loom 2026-09-01**, over 37 runs / 621 wall-clock minutes:

| slice                                          | minutes | share |
| ---------------------------------------------- | ------- | ----- |
| post-merge `push: main` runs                    | 291     | 47%   |
| ...of which the merge tree EQUALLED the PR head | ~145    | 23%   |
| everything else (PR runs, scheduled, dispatch)  | 330     | 53%   |

Instrument, with its falsifying result named first: had most merge commits produced a tree DIFFERING from their PR head, the `push:` arm would have been testing something new and the duplicate claim would have died on the spot.

```bash
gh run list --limit 400 --json event,headBranch,headSha,conclusion,status,startedAt,updatedAt
gh pr list --state merged --json number,mergeCommit,headRefOid   # then compare TREES, not SHAs
node .claude/bin/check-ci-config-invariants.mjs   # queue state, `merge_group:` arms, plan/visibility
```

**Both halves, because the second inverts the reading of the first.** Of 14 merges, 7 were tree-identical to the PR head — those 291 minutes bought nothing on that half. The other 7 were the OPPOSITE defect: base had moved, and most PR branches carried exactly ONE run, so **7 merged combinations had never been tested by anything** and main was the first surface to see them. The window recorded **zero** main-branch failures. That green is not evidence the gate works: it is equally consistent with a gate that was never asked a hard question, which is `instrument-discipline.md` MUST-1 exactly. Reporting "47% waste" alone would have been half the finding and the flattering half.

**Why a merge queue closes both halves.** A queue builds the POST-MERGE combination and tests it BEFORE the merge lands. That is precisely the run the `push:` arm was standing in for, arriving at the only moment a gate can still act. So `merge_group:` on, `push: main` off, is one change that removes the duplicate AND removes the untested-combination class.

**Why it is nevertheless an OWED DECISION and not a lane's to take.** The trade-off, stated in both directions so the decision is a real one:

| enabling the queue GIVES                          | and COSTS                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| the post-merge combination tested BEFORE merge     | merges SERIALIZE — throughput becomes queue-bound at high PR rate |
| ~23% of the window's minutes stop being duplicated | queue latency added to EVERY merge, including trivial ones        |
| the untested-combination class closes structurally | `--admin` merge BYPASSES the queue — the current landing habit silently defeats it, so adopting the queue means giving up admin-merge as the normal path |

None of the right-hand column is measured here. A recommendation built on the left column alone is a one-sided figure wearing the grammar of a decision, which is why the rule mandates SURFACING and forbids acting.

**A THIRD fact that the raw two-command check misses, and it may decide the whole question.** `check-ci-config-invariants.mjs` reports `plan / visibility`, and on GitHub a merge queue on a PRIVATE repo requires **Enterprise Cloud**; hosts other than GitHub (Azure DevOps, for one) have no equivalent primitive at all. Measured at loom 2026-09-01: `merge queue enabled false`, `plan / visibility  team / private`, with an unfiltered `merge_group:` arm present in the eval workflow. So the honest statement of loom's position is not "a switch is off" — it is *the wiring is done and the entitlement is unconfirmed*, and the tool itself flags entitlement as REPORTED, NOT PROBED. Reading "rulesets is empty" as "someone declined to turn it on" is `instrument-discipline.md` MUST-4: that command answers whether a queue EXISTS, never whether one MAY exist. Where the plan does not carry it, this stops being an operating-model decision and becomes a procurement one — a different question, for a different person.

**loom's own state, recorded and deliberately left alone:** `merge_group` is present in the workflow's `on:` block while `gh api repos/<owner>/<repo>/rulesets` returns `[]` — wired and switched off. Either half read alone misleads: the workflow line alone says "we have a queue" (false), and the empty rulesets alone says "there is no queue path" (also false — the wiring is already there, so the change is a settings decision, not an engineering one). That is the cheapest possible version of this decision to make, and it is still the owner's — and per the paragraph above, possibly not purchasable at the current plan.

## 7d. Reduce demand, do not spread it — fan-out against a bounded pool

From an authorized read of a BUILD sibling (kailash-rs), whose scale makes the arithmetic visible: its main workflow is ~3,291 lines / 17 jobs, carrying 42 test invocations across ~35 feature sets (19 `--all-features`, 16 `--no-default-features`). Its own measured lint figures: workspace pass **47.4 min**, feature-gated **41.9**, posture matrix **18.9**, a subsystem pass **9.2**. One PR there fanned out to **16 workflow runs / 33 jobs against a pool of 24 runners**, of which only **12** provided a required context.

The lever that does NOT work is sharding: splitting the 47-minute pass into six parallel jobs turns one runner claim into six simultaneous ones against the same 24, so the PR's peak demand rises while its wall-clock barely moves — and every OTHER repo sharing the pool pays for it. **Fan-out against a bounded pool is the actual scarcity**, and the pool is the one quantity a workflow author cannot change.

The lever that works is SCOPING the expensive pass to the units the PR changed. That sibling's own recorded go-forward states it in the right currency: scope the 47-minute workspace pass to the crates a PR actually changes, *"which REDUCES demand rather than spreading it."* Note what this is NOT: it narrows the gate's INPUT, never removes its OUTPUT. Deleting the pass, or moving it off the required set so the census fits the ratchet, is `ci-job-budget.md` MUST-1's three-state decision taken silently.

## 7e. BP-105 — why narrowing a TRIGGER is unavailable on a required context

The single most transferable constraint in this family, because the naive reading of every "cut CI that is not value-additive" brief is *add `paths:` filters*, and on a required context that BREAKS the repo rather than speeding it up.

| what the author intends | what GitHub does                                  | what branch protection sees          |
| ----------------------- | ------------------------------------------------- | ------------------------------------- |
| job skipped via `if:`   | check-run CREATED, terminal conclusion `skipped`   | REPORTED → requirement **SATISFIED**   |
| trigger did not match   | NO check-run created at all                        | nothing to report → **waits forever**  |

The PR then sits at "Expected — Waiting for status to be reported" with no failing check to point at, which reads as an infrastructure fault rather than an authoring mistake — that is why it is expensive to learn and why the mechanism is stated in the rule rather than left to be re-derived.

The sanctioned shape, and it is not theoretical: at that sibling, **13 of 29 PR-triggered workflows carry NO `paths:` filter deliberately**, and its heaviest workflow's FIRST job re-derives the changed-path set into an output that every downstream job gates on. The path set is still consulted — once, inside the run, where a skip still reports. Same saving, opposite gate behaviour.

The corollary that catches people going the other way: `paths-ignore:` is not a budget lever either. A workflow ignoring `**/*.md` still fires on every code-touching PR, so it reduces the doc-only tail and nothing else.

## 8. Searched for and NOT found

- **No evidence that shorter PRs merge faster in this corpus.** The 24 single-run branches span the full size range; run count tracks re-push behaviour, not diff size.
- **No matrix-reduction lever at loom.** Two workflows, no matrix; the "reduce the matrix" remedy that works in build repos has nothing to act on here.
- **No billing API cross-check was performed.** §1 figures are wall-clock from run timestamps; §1a adds a job/step-derived billed-EQUIVALENT (p50 14.3 min), which is a better proxy but still not the invoice. Anyone with billing access should re-derive.
- **The 78% queue share was measured on the heavy job only** (30 runs), not across all 92. Treating it as the corpus-wide split is an extrapolation, labelled as one.
- **Whether loom MAY enable a merge queue is UNCONFIRMED, not merely un-decided.** The repo is `team / private`; GitHub gates merge queues on private repos behind Enterprise Cloud, and `check-ci-config-invariants.mjs` reports plan/visibility rather than probing the entitlement. Nobody has tested it. Any plan that assumes the toggle is available is assuming the answer to an unasked question.
- **The COST of enabling a merge queue is UNMEASURED (§7c).** The 291/145-minute figures are the cost of NOT having one. Queue latency per merge, the throughput ceiling serialization imposes at loom's actual PR rate, and the operational cost of giving up `--admin` as the landing path were not measured and MUST NOT be assumed small. This is why §7c is written as a decision the owner is owed, not a recommendation.
- **The tree-identity comparison was run over 14 merges, not a year.** 7-of-14 is this window's ratio; it is not a rate, and a repo with a busier base will see fewer identical trees and more untested combinations — the SECOND defect, not the first.
- **The BUILD-sibling figures in §7d/§7e are THEIRS, read under authorization, and were not re-derived here.** They establish the shape of the fan-out problem at scale; they are not loom's numbers and loom has no 47-minute pass to scope.
- **No causal test that pre-flighting reduces re-pushes.** The 474-minute figure establishes the COST of re-pushes, not that pre-flighting eliminates them. The mechanism is straightforward, but it is an inference, labelled as one per `evidence-first-claims.md` MUST-4.
