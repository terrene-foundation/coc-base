---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/todos/**"
  - "**/.wave-tracker*"
  - "**/.wave-tracker.d/**"
  - "**/.github/workflows/**"
---

# CI Cost Discipline — A Gate Run Is A Purchased Resource, And The Dominant Waste Is Re-Pushing

CI feels free at the moment of spending it: the agent pushes, the run starts elsewhere, and the session continues. Nothing in the loop reports the bill. Measured at loom over **793 completed runs**, that invisible bill was **11,308 minutes of WALL-CLOCK (~188 h)**, of which **1,208 minutes were destroyed by cancellation** — and **1,165 of those (96.5%) were killed on a PR branch by a subsequent push to the same open PR**, not by anything upstream.

**Measure over a large window; a recent-N sample lies about this in a specific direction.** The identical instrument at `--limit 100` reported 1.45 runs per PR branch and a 27% cancellation rate; at `--limit 800` the same repo reports **3.01** and **15%**. A fixed recent-N window truncates each branch's history — most branches appear holding only their newest run — so it biases runs-per-branch toward 1 and inflates the cancelled share. Every figure below is from the 793-run sample.

**Read those minutes as what they are — wall-clock, not runner time.** A companion profile of the job/step API (a DIFFERENT sample: 30 runs of the heavy job) measured **78% of a PR run's elapsed time as QUEUE WAIT** — 1,750.5 minutes queued against 492.9 executing, avg 134.7 queued vs **11.9 executing** — and **13 cancelled PR runs executed ZERO steps**, killed while still queued. So re-push discipline does **not** free much machine capacity, and this rule must not be justified as though it did. What a re-push destroys is an in-flight verdict, its author's own wait, and a position in the queue that dominates elapsed time. That is the honest cost, and it is the only one claimed here.

The intuition most agents carry — that burst-merging into a shared-concurrency `main` is the expensive half — is measurably wrong here: main-branch cancellations totalled **42 minutes across 41 runs** (avg ~1 min), because a main run is killed by the next merge almost immediately, against **1,165 minutes across 78 PR-branch cancellations**. The expensive half is the one that feels free.

Depth — the full measurement, the per-branch breakdown, the revert-safety decision procedure, the merge-queue variants, and the cross-repo (build / use / downstream) mapping — is `.claude/skills/30-claude-code-patterns/ci-cost-discipline-evidence.md`.

## MUST Rules

### 1. Do Not Push Again To An Open PR To Find Out Whether It Passes

Once a PR is open, every further push to its branch CANCELS the in-flight run and starts a fresh one from zero. The agent MUST establish locally that the change passes before each push — not only the first — using the project's CI-parity command set, which `git.md` § "Pre-FIRST-Push CI Parity Discipline" already specifies (cited, not restated, per `specs-authority.md` Rule 9); that clause governs the FIRST push, and this one extends the same obligation to EVERY subsequent push. Pushing a change whose local verification has not been run, in order to let CI report the answer, is BLOCKED.

```bash
# DO — verify locally, then push once
cargo +nightly fmt --all --check && cargo clippy -- -D warnings && cargo nextest run
git push                                   # one run, one answer

# DO NOT — push to ask CI the question
git push                                   # run starts
# …lint fails at minute 31…
git commit --fixup && git push             # kills that run, starts another from zero
```

**BLOCKED rationalizations:**

- "CI will tell me faster than running it locally" (heavy-job wall-clock p50 47 min, p90 183.5 min — it does not)
- "The run was going to fail anyway, so cancelling it costs nothing"
- "Cancelled runs cost nothing" (one cancelled mid-EXECUTION is billed for the wall-clock it consumed — `git.md`; one cancelled while QUEUED cost its author the entire wait and held a queue slot)
- "It is a one-line fix, not worth a local run"
- "I will push now and fix lint in a follow-up commit"
- "The reviewer is waiting, pushing is the responsive thing to do"
- "Pre-flighting is slower" (~5–10 min synchronous against a fresh full-run wait — 20.8 min average, p50 47 min on the heavy job)

**Why:** This is the dominant measured waste — **1,165 of the 1,208 destroyed wall-clock minutes (96.5%), across 78 re-pushes averaging 14.9 minutes each**. **Be precise about what it wastes:** those runs are largely cancelled while still queued, executing zero steps, so the saving is NOT runner capacity and claiming it would be an over-claim. What the re-push destroys is an in-flight verdict, a fresh wait for its author, and a position in the queue that is 78% of elapsed time on a saturated pool. A local pre-flight answers the same question synchronously in ~5–10 minutes.

### 2. One PR Per Wave, Bounded By REVERT-SAFETY — Not By A Count

A wave's changes MUST be consolidated into ONE PR **if and only if** the whole diff is independently revertible as a unit — reverting it leaves the tree coherent and removes exactly one decision. Changes that are NOT jointly revert-safe MUST still split, however many PRs that yields. Opening a PR per shard when the shards ARE jointly revert-safe is BLOCKED; bundling unrelated work to hit a PR count is equally BLOCKED. There is deliberately no numeric cap: a cap forces unrelated work together and makes the revert dangerous, which costs more than the CI it saves.

```text
# DO — one PR: three shards of one rule's fixtures, revert removes one decision
PR: "log-triage-gate fixtures (shards A+B+C)"        → 1 run

# DO — still two PRs: a guard fix and a manifest re-tier are not jointly revertible
PR: "fix integrity-guard branch resolution"  ·  PR: "re-tier cli-orchestrator"

# DO NOT — one PR per shard when the shards revert as a unit
PR-A, PR-B, PR-C                                     → 3 runs, 2 avoidable
```

**BLOCKED rationalizations:**

- "A separate PR is cleaner for review" (split the REVIEW with commits, not the CI with branches)
- "Each shard had its own worktree, so it gets its own PR"
- "Smaller PRs merge faster"
- "They are logically distinct" (the test is revert-safety, not conceptual tidiness)
- "Consolidating means one CI failure blocks everything" (it blocks one revert-safe unit, which is the point)
- "The wave plan listed them as separate items"

**Why:** Each additional PR is another entrant in the queue that dominates elapsed time. Measured WALL-CLOCK (queue + execution) is **20.8 minutes** for a successful `pull_request` run against **7.7 minutes** for a `push` run; the execution component alone averages ~11.9 minutes, so what an extra PR mostly buys is queue — exactly the scarce resource. Revert-safety is the correct boundary because it is the only property that makes a bundled PR SAFE to treat as one decision; a count would optimize CI at the cost of the thing CI exists to protect.

### 3. An Amendment To A Queued PR Must Be Worth A Full Run

Amending, rebasing, or force-pushing a PR whose run is queued or in flight discards that run and buys a new one. Before amending, the agent MUST judge whether the change justifies a full run at the measured PR-run cost; changes that do not (a typo in a comment, a reworded PR body line committed into the branch, a cosmetic reorder) MUST be batched with the next substantive push or dropped. Treating an amendment as free because a run was already queued is BLOCKED — the queued run was a purchased position, and the amendment spends it.

```text
# DO — batch the trivia, or leave it
hold the comment typo → fold into the next substantive push (or never)

# DO NOT — amend a queued PR for something not worth a fresh full-run wait
git commit --amend && git push --force     # queue position discarded, new one bought
```

**BLOCKED rationalizations:**

- "CI was queued anyway, so the amendment is free"
- "Zero wall-clock cost — the run had not started"
- "Amending keeps the history clean"
- "It is one character"
- "The maintainer will ask for it anyway"

**Why:** A queued run is a claimed position in the resource that dominates elapsed time — 78% of it — not a free option; discarding it re-queues behind everything that arrived since. The failure mode is that the cost is reasoned about as marginal *because* the run had not started, when the un-started run is precisely the one whose whole value was its queue position. "It had not started yet" is not mitigation; it is the loss.

### 4. Merge Cadence — Serialize Or Batch Merges Into A Shared-Concurrency Branch

Where the target branch's workflow uses a shared concurrency group (`${{ github.workflow }}-${{ github.ref }}` or equivalent), merging N PRs in a burst starts N runs of which N−1 are cancelled. Where a merge queue exists, the agent MUST use it; where it does not — the usual case in build / use / downstream repos — merges MUST be serialized or batched rather than fired in a burst.

**Read your own triggers before applying any clause in this rule — do not inherit loom's.** Every cost claim here rests on a workflow trigger shape (`push:` constrained to the default branch, `pull_request` branch-general, a shared concurrency group with `cancel-in-progress`). That shape is a per-repo fact, not a constant, and where it differs the arithmetic differs — sometimes in sign, not just magnitude. MUST-5's **Instrument A** is the one-line check; run it in THIS repo before treating any figure below as yours.

```text
# DO — merge queue where available; otherwise serialize
gh pr merge <N> --auto        # queue handles the ordering
# DO NOT — burst-merge and rely on cancellation to sort it out
for n in 1639 1640 1641 1643; do gh pr merge $n --admin --merge; done
```

**BLOCKED rationalizations:**

- "Cancellation is the concurrency group working as designed" (it is the group limiting damage, not authorizing the burst)
- "The main-branch run is short" (true HERE — see Why; it is a property of this repo's workflow, not a general one)
- "Merging is instant, the runs sort themselves out"

**Why, stated at its MEASURED cost rather than its assumed one:** at loom this clause is nearly free — **41 main-branch cancellations totalling 42 minutes**, about a minute each, because loom's main runs are killed almost immediately by the next merge. It is a MUST anyway because that figure is a property of one repo's workflow shape, not of the mechanism: the same burst against a target whose main-branch job does real work (publish, integration, matrix) destroys N−1 near-complete runs. The clause is scoped to where it bites, and an agent MUST NOT generalize loom's 42 minutes into "burst-merging is cheap" anywhere else.

### 5. Fold A Wave Onto One Integration Branch Only When BOTH Preconditions Measure TRUE HERE

Where a wave's shards are jointly revert-safe (MUST-2), they MAY additionally be folded onto a single integration branch so the wave costs ONE PR run instead of N. The agent MUST evaluate BOTH preconditions **against this repo, by running the instruments**, before folding — and MUST NOT fold when either is false, because under ¬A folding actively costs MORE than not folding.

**Precondition A — is a branch push free here?** Read this repo's own workflow triggers. A is TRUE iff every `push:` arm is constrained to the default branch (or tags only) AND `pull_request` is the only branch-general trigger.

```bash
# INSTRUMENT A — read your own on: block, structurally
grep -nE '^on:|^  (push|pull_request|schedule|workflow_dispatch):|^    branches:|^    tags:' .github/workflows/*.yml
# loom: every push arm is `branches: [main]` → A TRUE
# under `push: branches: ['**']` (or a bare `push:`) → A FALSE
```

Under ¬A every shard push to the integration branch starts its own run, so folding **inverts** into a per-shard cost — strictly worse than one PR per shard, which at least gets `cancel-in-progress` de-duplication.

**Precondition B — is runs-per-PR high enough to be worth the coordination?** Measure it; do not assume it.

```bash
# INSTRUMENT B — runs per PR head branch. Use a LARGE limit: --limit 100
# understates this roughly 2x (see § Origin), and the error flatters not-folding.
gh run list --limit 800 --json event,headBranch | \
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).filter(x=>x.event==="pull_request");
           const b=new Set(r.map(x=>x.headBranch)); console.log((r.length/b.size).toFixed(2))'
```

**The decision rule is a comparison, not a constant:** fold when the runs you would SAVE (≈ `runs_per_PR × (shards − 1)`) exceed the coordination cost of carrying an integration branch — one extra branch to keep rebased, one shared review surface, and one revert that takes the whole wave. Two measured anchors for calibration, NOT thresholds: **loom ≈ 3.0** (folding is marginal — a 3-shard wave saves ~6 runs, and the integration branch is often not worth it), and a **sibling BUILD repo ≈ 18** (folding is decisive — the same wave saves ~36 runs). A bare numeric cut-off is deliberately not given: the corpus keeps catching unjustified constants, and the right cut-off depends on a coordination cost this rule cannot measure for you.

```text
# DO — measure both, then decide, and record what you measured
A: every push arm is `branches: [main]` → TRUE · B: 18.0 runs/PR → fold 5 shards onto one branch
A: FALSE (`push: ['**']`) → DO NOT FOLD, and say so: folding would cost 5 runs, not save 4

# DO NOT — fold because another repo folds, or because the wave "feels big"
"the sibling repo consolidates its waves, so we should too"   # their A and B, not yours
```

**BLOCKED rationalizations:**

- "The sibling repo measured this, so it holds here" (A and B are per-repo; that is the whole point of the clause)
- "Folding is always cheaper" (false under ¬A, where it inverts)
- "I'll assume runs-per-PR is high, it feels high" (measure it — and at `--limit 100` it will read ~2× low)
- "Precondition A is obviously true, every repo gates push to main" (it is not; unconstrained `push:` arms are common in consumer repos)
- "One integration branch is free coordination"

**Why:** the mechanism is real and was measured at a consumer, not here — a BUILD sibling at ~18 runs/PR, where folding a wave is decisive. But it does NOT generalize unconditionally: it rests on a branch push being free, which is a property of the workflow's trigger shape and false wherever `push:` is branch-general. Shipping it unconditionally would hand every consumer a change that silently inverts in exactly the repos whose CI is already worst. Both preconditions are cheap to evaluate, so making them mandatory costs one `grep` and one `gh run list` against a wave that would otherwise cost N full runs.

## MUST NOT

- Fold a wave onto one branch without having measured BOTH preconditions in THIS repo

**Why:** under ¬A folding inverts into a per-shard cost, and the repos most tempted to fold are the ones where that is most expensive.

- Push to an open PR without having run the project's CI-parity set locally on that push

**Why:** the measured dominant waste; the destroyed run is invisible from inside the session.

- Split a jointly revert-safe wave across multiple PRs, or bundle non-revert-safe work into one

**Why:** the first buys avoidable full runs; the second makes the revert unsafe, which is the cost CI exists to prevent.

- Reason about the cost of an amendment as marginal because a run was already queued

**Why:** a queued run is a purchased position; the amendment spends it in full.

- Cite a cancelled run as costless, OR cite this rule's savings as runner capacity

**Why:** a cancel mid-execution is billed for the wall-clock consumed, and a cancel while queued still burns its author's whole wait and a queue slot — **1,208 minutes** across the sample. The symmetric error is over-claiming: those runs largely executed zero steps, so the saving is wait and queue churn, never machine time.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm each push to an open PR was preceded by a local CI-parity run, that a multi-PR wave was split on revert-safety rather than shard boundaries, that no amendment to a queued PR was reasoned about as free, and that any folded wave cites both measured preconditions); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a given push was locally pre-flighted, and whether a diff is jointly revert-safe, are judgments over session history and diff semantics with no structural tool-call-time signal, so a lexical detector MUST NOT carry `block`.
- **Grace period:** 7 days from rule landing (2026-08-12 → 2026-08-19).
- **Cumulative posture impact:** same-class violations (a push to an open PR with no local pre-flight; a jointly revert-safe wave split across PRs; an amendment to a queued PR justified as free; a burst merge into a shared-concurrency branch where a queue was available; a wave folded without measuring Preconditions A and B here) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: whether a push was pre-flighted and whether a diff is jointly revert-safe are review-layer judgments that do not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. The universal trigger already covers it; same no-dedicated-key disposition `burn-down-reporting.md`, `completion-criterion.md`, `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: ci-cost-discipline]` IFF `posture.json::pending_verification` includes the `ci-cost-discipline` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session that opened or updated a PR and confirm (a) each push to an open PR names the local CI-parity command set it ran first, (b) a wave producing more than one PR states the revert-safety boundary that forced the split, (c) no amendment to a queued PR is justified as free, (d) burst merges used a queue where one exists, and (e) any wave folded onto an integration branch RECORDS the two measured preconditions — the workflow trigger read and the runs-per-PR figure with its `--limit` — rather than asserting them. **No probe suite and no audit fixtures ship with this rule** — stated explicitly rather than naming a path that does not resolve, which would red `detection-binding-check.mjs::dangling-probes-binding`. The semantic tier is therefore UNCOVERED at landing and is DECLARED, not silently omitted: `.claude/test-harness/probes/ci-cost-discipline.probes.json` is UNWRITTEN, and a dated entry for it — reason, graduation condition and an `expires` date — sits in `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals`, and `deferrals` carries the matching Phase-2 detector entry. Both are hard-failed past their dates by `phase2-deferral-integrity.mjs`, so the omission ages out rather than becoming permanent. Scanner: none — a lexical detector cannot see whether a local pre-flight ran, and building one that guessed would instance `instrument-discipline.md` MUST-1. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `PreToolUse` detector on `git push` to a branch with an open PR, flagging the absence of a same-session CI-parity invocation; its audit fixtures land WITH it per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (un-pre-flighted push to an open PR) + MUST-2 (revert-safe wave split, or non-revert-safe bundle) + MUST-3 (amendment to a queued PR reasoned as free) + MUST-4 (burst merge where a queue exists) + MUST-5 (folding without having measured BOTH preconditions in this repo, or folding under ¬A). Every `violations.jsonl` row names the PR and the clause.
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Extends** `git.md` § "Pre-FIRST-Push CI Parity Discipline" from the first push to every subsequent push on an open PR. That clause owns the per-language command sets; this one owns the obligation's scope.
- **Distinct from** `git.md` § "CI-check and merge are SEPARATE steps" — that governs whether a green was read against the right SHA; this governs how many runs were bought.
- **Bounded by** `autonomous-execution.md` § Per-Session Capacity Budget — sharding is decided on invariant count and call-graph depth, and MUST-2 here consolidates the DELIVERY of shards without merging the shards themselves. A wave correctly sharded into three implementation passes may still ship as one revert-safe PR.
- **Composes with** `agents.md` § Triad — parallelizing work is unaffected; what MUST-2 bounds is how many PRs the parallel wave lands as.

## Origin

2026-08-12 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination), verbatim in-session directive: _"i need you to /codify it such that we don't activate so many CIs. Consolidate into PRs before hitting CIs as the CIs are killing our productivity! … This discipline must go down to all build, use, downstream too! find a systematic way to manage this CI time sink issue. Also, half the gate runs are always repeat attempts and this is a massive waste."_

Instrument: `gh run list --repo esperie-enterprise/loom --limit 800 --json conclusion,event,status,startedAt,updatedAt,headBranch`, durations as `updatedAt − startedAt`, **793 completed runs**. Named falsifying result before reading: a cancellation share near zero with 1.00 runs per PR branch would have refuted the premise; measured 15% cancelled and 3.01 runs per branch.

**A third correction, in the same family as the first two: SAMPLE SIZE.** The first draft ran this instrument at `--limit 100` and reported 1.45 runs/branch and 27% cancelled. Both were windowing artifacts — a recent-N window truncates each branch's run history, so most branches appear holding only their newest run. Re-run at 100 / 400 / 800 the same repo reports **1.55 / 2.53 / 2.98** runs per branch, rising monotonically. The retracted figures are recorded here rather than silently replaced. The co-owner's "half the gate runs are repeat attempts" is **vindicated on the branch axis at the honest sample size**: **58% of PR branches carried more than one run** (103 of 177), against 15% of runs by conclusion. The first measurement made that estimate look wrong; it was the measurement that was wrong.

**A second instrument corrected what the first one's minutes MEAN, and the correction is load-bearing.** A companion profile of the job/step API (not the run list, which cannot see the queue/execution split) measured **78% of PR-run elapsed time as queue wait** — 1,750.5 min queued vs 492.9 min executing across 30 runs of the heavy job; avg 134.7 min queued, 11.9 min executing; wall-clock p50 47 min / p90 183.5 min / max 293.3 min against a billed-equivalent p50 of 14.3 min. Critically, **13 of the cancelled PR runs executed ZERO steps** — killed while still queued. The run-list minutes are therefore WALL-CLOCK, and every clause above labels them so. The first draft of this rule justified itself as saving 474 runner-minutes; that claim was FALSE and is not made. The saving is author wait and queue churn on a saturated pool, which is real and sufficient. Recording this rather than quietly restating the figure is the point: a rule justified by a saving it does not deliver is the over-claim this corpus keeps catching.

**Self-implicating, and the strongest single datum:** the branch of the session that commissioned this rule ran CI four times (three cancelled), destroying **213 CI-minutes on one PR**; two sibling branches did the same for 97 and 31 minutes. In the same session nine PRs were opened inside 72 minutes, and three inside nine minutes.

**MUST-5 is a consumer's finding, generalized — not loom's.** The folding mechanism originates in a downstream BUILD sibling (kailash-rs), which measured **~18 runs per PR** in its own repo and proposed folding a wave onto one integration branch. loom reaches that repo through `/sync-to-build rs`, so it is a CONSUMER of this artifact, not a peer being advised: declining the mechanism would have shipped it a gap for a problem it had correctly measured. loom's contribution is only the **conditionality** — the measurement showing the mechanism does not generalize unconditionally (loom's own ~3.0 makes folding marginal, and the whole thing INVERTS under a branch-general `push:` trigger) plus the two instruments that let any repo settle it locally. The sibling's rationale was right for the sibling; it was the unconditional form that was wrong.

Authored `priority: 10` + `scope: path-scoped` + `cli_delivery: skill-channel` under the measured saturated-baseline constraint — emission measured 54,078 B against a 15% proximity band allowing ≤55,706 B at the raised 65,536 cap, leaving ~1.6 KB, so a `priority: 0` baseline placement cannot land. Same disposition `burn-down-reporting.md`, `completion-criterion.md`, `handoff-completion.md` and `product-completion-first.md` took under identical saturation.

**Reachability residual, recorded rather than papered over.** The moment this rule most needs to fire — immediately before `git push` or `gh pr create` — is not a file-edit event, so no `paths:` glob can be TRIGGERED BY it (a glob reaches that moment only when the session happened to touch a matching file earlier, since injection is sticky-once — see the CLOSED paragraph below); this is the same reachability class `issue-triage-routing.md` names, and that rule answered it by going baseline, which the measured emission headroom forbids here. The globs cover the PLAN-time moment where PR count is actually decided (`**/todos/**`), the wave-close moment where PRs are opened and merged (`**/.wave-tracker*`), and the CI-config surface MUST-4 depends on (`**/.github/workflows/**`). `**/workspaces/**` was authored and then REMOVED for a measured reason: the `workspace-note` injection profile sat at 409,370 B against its 410,135 B ceiling (the snapshot's 390,605 B base × the guard's 5% tolerance) — 765 B of headroom, a fortieth of this rule — so including it would breach the guard. **Re-measured 2026-08-14: 409,646 B, so the headroom is now 489 B** against a 32,287 B rule body; the figure MOVES with every path-scoped rule in that profile, so re-measure it rather than citing this line. The honest consequence WAS that a session which edits only `src/` and pushes did NOT load this rule.

**CLOSED 2026-08-14 (T4) — by a hook, not by a glob, and the reason is COVERAGE rather than impossibility.** The T1–T6 plan named glob-widening as the PREFERRED fix. What is measured is narrower than the first version of this paragraph claimed, and the correction is recorded rather than quietly swapped in: a `paths:` glob cannot be TRIGGERED BY the push event, because path-scoped rules inject off a session's TOUCHED-FILE set and a `git push` touches no file. It does NOT follow that a glob could never REACH the push moment — injection is sticky-once per session (`check-rule-injection-budget.mjs`: "path-scoped rules inject their WHOLE body once per session, the first time a tool call touches a path matching the rule's `paths:` globs (sticky-once, verified 2026-06-27)"), so a broad glob left the rule loaded at push time in any session that happened to touch a matching file earlier. That is a coincidence, not a guarantee — the session that edits only `src/` and pushes still gets nothing — and it is separately blocked on the injection headroom measured above (489 B as re-measured 2026-08-14, against a 32,287 B rule body). The hook fires on every CI-spending command regardless of what the session touched, which is the property no glob can offer at any headroom, and that is why this is the surface. The alternative the same plan named was taken: `.claude/hooks/lib/ci-cost-reach.js`, delivered from `validate-bash-command.js` — the PreToolUse Bash hook that ALREADY reads the PCF category off `gh pr create`. The two halves of the co-owner's directive ("reduce CI time sink leaks" and "packing more into PRs aligned with PCF triaging") therefore now fire from one hook, on one command, rather than as two artifacts that never meet.

Four properties are load-bearing, and each is pinned by a check that could return the opposite verdict. **(1) It delivers the CONTRACT, never a verdict** — it renders no judgment about whether a push is wasteful; that remains the deferred Phase-2 detector. **(2) The delivery path SPAWNS nothing.** A network read here would hang every push in the repo (`lib/open-pr-surface.js`: "execFileSync blocks the event loop, so the hook's own setTimeout cannot preempt them" — a `cc-artifacts.md` Rule 7 timer cannot bound a synchronous network call), and an "is a run in flight?" signal is consistent with BOTH a wasteful and a legitimate push, so no output it produced could falsify anything (`instrument-discipline.md` MUST-1). Stated precisely, because the loose form ("makes NO subprocess call") was measured FALSE at the module-load level: the module does transitively LOAD `child_process`, through the shared `git-command-parse.js` → `violation-patterns.js` chain. A `require` allocates no process; what would hang a push is a CALL, and the test intercepts all seven spawn primitives and records zero calls across the whole exported surface. **(3) Delivery is ONCE PER SESSION**, which IS the discrimination: an advisory that speaks on every push becomes wallpaper — the failure that made `wrapup-after-landing.js` dismissible, a discrimination disease with a frequency symptom. Falsifying result, named and pinned: an already-delivered session is delivered to again. **(4) The head states a fate that is TRUE at PreToolUse — and ONLY there.** The delivery closes "no check has judged your push. Read it and decide", so a head reading "the action ALREADY RAN" would leave the agent no decision to make; `instruct-and-wait.js` gained a `pre-action` register for exactly this. That register is GATED on the hook event, not applied globally, because one renderer serves two moments whose truth conditions are OPPOSITE: at PostToolUse the action genuinely HAS run, so "ALREADY RAN" is the CORRECT head there and rewriting it would trade one false head for a worse one. Measured over the full 7-event × 6-severity matrix against the pre-fix renderer: **41 of 42 cells byte-identical, the single changed cell being `PreToolUse|pre-action`**; ungated the same diff showed SEVEN changed cells, which is the hazard the gate closes.

Pinned by `.claude/test-harness/tests/ci-cost-reach.test.mjs` (16 cases, registered in `ci-suites.json`). Its REDs are mutations carrying both a reach proof (the mutated source no longer contains what was excised) and a RAN proof (the mutated hook still reaches its default verdict) — the second added after loom#1715 found the first version writing its mutant to a bare temp dir, where the hook's ten `./lib/*` requires cannot resolve, so it crashed and the crash was being read as the RED. **Residuals, stated rather than implied.** (a) This closes the `git push` / `gh pr create` moment ONLY; a session that edits only `src/` and reasons about PR SIZING without reaching a CI-spending command still does not load the rule, and `**/workspaces/**` remains the correct fix for that half, still BLOCKED on injection headroom. (b) The corrected head reaches `git push` but NOT `gh pr create`, and this was measured rather than assumed: `gh pr create` always co-fires the PCF-category finding, which is registered `halt-and-report`, so the merge collapses and the delivery inherits the false head there. Every deferred finding in that PreToolUse hook carries the same mis-registration — nothing has run when it speaks — and the general repair is to re-register them; it is not done here because those findings ship from other lanes, and changing a delivered head fleet-wide is a wider blast radius than this fix is scoped to carry. (c) A `--dry-run` push is excluded (it buys no run); an id-less session falls back to a per-process marker, which OS pid reuse could cost one delivery — both are improvements on, not eliminations of, the underlying uncertainty.
