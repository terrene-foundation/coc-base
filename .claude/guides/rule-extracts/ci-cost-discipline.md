# CI Cost Discipline — Extended Examples and Evidence

Companion to `.claude/rules/ci-cost-discipline.md`. These spans are extracted verbatim, preserving their original measured dates, qualifications, commands and contract recap.

## Measurement context

CI feels free at the moment of spending it: the agent pushes, the run starts elsewhere, and the session continues. Nothing in the loop reports the bill. Measured at loom over **793 completed runs**, that invisible bill was **11,308 minutes of WALL-CLOCK (~188 h)**, of which **1,208 minutes were destroyed by cancellation** — and **1,165 of those (96.5%) were killed on a PR branch by a subsequent push to the same open PR**, not by anything upstream.

**Measure over a large window; a recent-N sample lies about this in a specific direction.** The identical instrument at `--limit 100` reported 1.45 runs per PR branch and a 27% cancellation rate; at `--limit 800` the same repo reports **3.01** and **15%**. A fixed recent-N window truncates each branch's history — most branches appear holding only their newest run — so it biases runs-per-branch toward 1 and inflates the cancelled share. Every figure below is from the 793-run sample.

**Read those minutes as what they are — wall-clock, not runner time.** A companion profile of the job/step API (a DIFFERENT sample: 30 runs of the heavy job) measured **78% of a PR run's elapsed time as QUEUE WAIT** — 1,750.5 minutes queued against 492.9 executing, avg 134.7 queued vs **11.9 executing** — and **13 cancelled PR runs executed ZERO steps**, killed while still queued. So re-push discipline does **not** free much machine capacity, and this rule must not be justified as though it did. What a re-push destroys is an in-flight verdict, its author's own wait, and a position in the queue that dominates elapsed time. That is the honest cost, and it is the only one claimed here.

The intuition most agents carry — that burst-merging into a shared-concurrency `main` is the expensive half — is measurably wrong here: main-branch cancellations totalled **42 minutes across 41 runs** (avg ~1 min), because a main run is killed by the next merge almost immediately, against **1,165 minutes across 78 PR-branch cancellations**. The expensive half is the one that feels free.

## Worked example or instrument 1

```bash
# DO — verify locally at DIFF SCOPE, then push once
pkgs=$(git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD \
       | sed -n 's|^crates/\([^/]*\)/.*|-p \1|p' | sort -u)
cargo +nightly fmt --all --check && cargo clippy $pkgs -- -D warnings && cargo nextest run $pkgs
git push                                   # one run, one answer

# DO NOT — push to ask CI the question
git push                                   # run starts
# …lint fails at minute 31…
git commit --fixup && git push             # kills that run, starts another from zero
```

## Worked example or instrument 2

```text
# DO — one PR: three shards of one rule's fixtures, revert removes one decision
PR: "log-triage-gate fixtures (shards A+B+C)"        → 1 run

# DO — still two PRs: a guard fix and a manifest re-tier are not jointly revertible
PR: "fix integrity-guard branch resolution"  ·  PR: "re-tier cli-orchestrator"

# DO NOT — one PR per shard when the shards revert as a unit
PR-A, PR-B, PR-C                                     → 3 runs, 2 avoidable
```

## Worked example or instrument 3

```text
# DO — batch the trivia, or leave it
hold the comment typo → fold into the next substantive push (or never)

# DO NOT — amend a queued PR for something not worth a fresh full-run wait
git commit --amend && git push --force     # queue position discarded, new one bought
```

## Worked example or instrument 4

```bash
# INSTRUMENT — use the landed reader; it answers all THREE questions at once.
node .claude/bin/check-ci-config-invariants.mjs   # reads `merge queue enabled`, the
# `merge_group:` arm's presence per workflow, AND `plan / visibility`.
# The falsifying result for "the queue is off": `merge queue enabled  true`.
```

## Worked example or instrument 5

```text
# DO — merge queue where available; otherwise serialize
gh pr merge <N> --auto        # queue handles the ordering
# DO NOT — burst-merge and rely on cancellation to sort it out
for n in 1639 1640 1641 1643; do gh pr merge $n --admin --merge; done
```

## Worked example or instrument 6

```bash
# INSTRUMENT A — read your own on: block, structurally
grep -nE '^on:|^  (push|pull_request|schedule|workflow_dispatch):|^    branches:|^    tags:' .github/workflows/*.yml
# loom: every push arm is `branches: [main]` → A TRUE
# under `push: branches: ['**']` (or a bare `push:`) → A FALSE
```

## Worked example or instrument 7

```bash
# INSTRUMENT B — runs per PR head branch. Use a LARGE limit: --limit 100
# understates this roughly 2x (see § Origin), and the error flatters not-folding.
gh run list --limit 800 --json event,headBranch | \
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).filter(x=>x.event==="pull_request");
           const b=new Set(r.map(x=>x.headBranch)); console.log((r.length/b.size).toFixed(2))'
```

## Worked example or instrument 8

```text
# DO — measure both, then decide, and record what you measured
A: every push arm is `branches: [main]` → TRUE · B: 18.0 runs/PR → fold 5 shards onto one branch
A: FALSE (`push: ['**']`) → DO NOT FOLD, and say so: folding would cost 5 runs, not save 4

# DO NOT — fold because another repo folds, or because the wave "feels big"
"the sibling repo consolidates its waves, so we should too"   # their A and B, not yours
```

## Worked example or instrument 9

```text
# DO — measure the REQUESTED pool, surface the choice, name the cost both ways
0 of 16 idle on [self-hosted, kailash-linux] → this run will QUEUE, not start.
Queue locally (free, ~45-70min wait) or GitHub-hosted (starts now, billed minutes,
revert obligation on the runs-on edit)?

# DO NOT — push into a full pool and find out, or switch pools silently
git push   # 0 idle; run queues 69 minutes and never starts
- runs-on: [self-hosted, kailash-linux]
+ runs-on: ubuntu-latest      # landed on main; every future run now billed
```

## Worked example or instrument 10

```text
# DO — reproduce by forcing the budget; the same cases fail on every run, and nothing burns
<run the one failing fixture file, the budget it depends on forced to 1 ms>   → 2 of 286 red, each run
<same file, budget restored>                                                  → 286 of 286 green
uptime; sysctl -n hw.ncpu   # (Linux: nproc) — 1-min load 97 on 16 cores ⇒ the full gate WAITS
# the landing gate runs the whole set once; no early copy of it on dev

# DO NOT — manufacture the condition on a shared machine, then stack a heavy run on top
<have a sub-agent spin interpreter busy loops to a deadline>; <re-run the fixture "under load">
<start the final gate early on dev "for earlier warning">   # a second full run, on a loaded host
```

## MUST-7 — depth (no synthetic CPU load)

**Why a load reproduction proves nothing a forced budget does not.** A timing flake under load shows one fact: the code under test received less CPU time than the test assumed, and a deadline expired. Forcing the budget to its failing value shows the SAME fact, but deterministically — the same cases fail on every run, so the reproduction doubles as the regression test for the fix. The load reproduction is strictly weaker on every axis: a pass under load proves nothing (the scheduler may simply have favoured the test), a fail may be a DIFFERENT race than the one that reddened the gate, it cannot be replayed in CI, and its cost lands on every other session on the machine.

**The three determinism techniques, in the order to try them.**

1. **Force the budget.** Every timing flake has a number it races — a timeout, a ceiling, a poll interval. Drive that number to its failing value (1 ms, zero, one tick) through the seam the code already exposes. If the same cases fail every time, the flake is reproduced and the fix can be tested against it.
2. **Inject a clock.** Where the code reads wall-clock time, substitute a controllable clock (production-gated) and advance it past the deadline explicitly. `testing.md` § "Never Assert An UPPER Bound On Real Elapsed Time" owns the clock techniques and their limits — a paused clock cannot see a synchronous stall.
3. **Stub the slow call.** Where the delay comes from a dependency (a validator, a network read, a subprocess), replace that call with one that sleeps past the deadline, or never returns within it.

If none of the three can express the failure, the finding is that the code has no seam for its own timing — which is a design defect to report, never a licence to generate load.

**Reading the machine before a heavy run.** The first figure `uptime` prints is the 1-minute load average; compare it against the core count (`sysctl -n hw.ncpu` on macOS, `nproc` on Linux). Above the core count, runnable work is already queuing for CPU, so a heavy run started now slows every session AND itself. A heavy run is a full suite, a gate, a mutation sweep, or anything that fans out across cores; one targeted test file is not. Hold the heavy run and do the targeted work; re-read the load before starting it.

**The duplicate pre-run.** A gate that must run again at landing buys nothing by running early except an earlier copy of the same answer, at the full price of a heavy run. The incident's early gate on dev was exactly this: it pre-ran the final gate and was stopped (exit 143).

**The incident (2026-09-12, receipt-first `journal/0609`).** A lane was told to reproduce a WIP-ceiling fixture flake — 2 of 286 cases failing only while a CPU-heavy validator ran — "under load". A sub-agent of that lane launched node busy loops with deadlines of 900, 1500 and 1800 seconds, in three groups under three parent processes. `uptime` at 14:41 read 319.88 / 314.59 / 254.53 on a 16-core machine shared by many concurrent sessions, and their work starved. No other session's process was killed; the load itself was the damage. Every loop carried its own deadline — the "self-terminating" shape `skills/30-claude-code-patterns/background-process-discipline.md` calls decisive for leak prevention — which is why a deadline sits on MUST-7's BLOCKED list: it bounds how long the harm lasts, not whether it lands. That skill records the first measured instance of this class (2026-08-14, a CPU-saturation load test that leaked 96 burners and peaked host load at 577 on 16 cores); its reaper governs whether a launched process is cleaned up, and MUST-7 governs whether the load is launched at all.

**Why prose was not enough, and what the hooks add.** The instruction passed orchestrator → lane → sub-agent, and no rule or hook stood at the moment a busy loop was launched. The PreToolUse guard stands at the tool boundary and sees the command; the PostToolUse backstop sees the processes a session actually spawned, including launches the guard did not see. That second claim is measured under Claude Code only: the backstop finds a session by walking up to its CLI process, and that walk was measured against the `claude` process alone. Its Codex and Gemini registrations are therefore a named residual — a Codex node-hosted CLI path does not match — not coverage, and on those CLIs it may stay silent. The rule clause cannot be the enforcement at that moment — launching a load generator touches none of its `paths:` globs.

## Prohibition recap — read with Rules 1–7

## MUST NOT

- Fold a wave onto one branch without having measured BOTH preconditions in THIS repo

**Why:** under ¬A folding inverts into a per-shard cost, and the repos most tempted to fold are the ones where that is most expensive.

- Push to an open PR without having run the project's CI-parity set locally on that push

**Why:** the measured dominant waste; the destroyed run is invisible from inside the session.

- Split a jointly revert-safe wave across multiple PRs, or bundle non-revert-safe work into one

**Why:** the first buys avoidable full runs; the second makes the revert unsafe, which is the cost CI exists to prevent.

- Reason about the cost of an amendment as marginal because a run was already queued

**Why:** a queued run is a purchased position; the amendment spends it in full.

- Push into a pool measured at ZERO idle without surfacing the choice, substitute an org-wide idle count for the REQUESTED pool's, or switch a job to a hosted runner without disclosing it and tracking the revert

**Why:** the session cannot see the queue from inside, so an unsurfaced push spends an hour invisibly; an org-wide count reads _capacity available_ off runners the job cannot use, which is silence on the exact state being checked; and an undisclosed `runs-on` change lands on the default branch and bills every future run.

- Enable or disable a merge queue, delete a default-branch `push:` arm, or change a repo's merge method on the agent's own judgment

**Why:** these are operating-model changes — a queue serializes merges and is defeated by the `--admin` habit — so they are envelope changes the OWNER decides, not the in-envelope root-cause fixes `autonomous-execution.md` authorizes a session to take unasked.

- Present a post-merge duplicate-run figure as a recoverable saving without the serialization cost beside it

**Why:** the wasted minutes are measured and the cost of the fix is not; a one-sided figure reads as a free win and forecloses the decision it was supposed to open.

- Generate synthetic CPU load on a shared machine for any purpose, including to prove a flake is load-related; start a heavy run while the load average exceeds the core count; or start a duplicate pre-run of a gate that must run again anyway

**Why:** the load is paid by every other session on the machine and is invisible from inside this one, and a forced budget reproduces the same failure deterministically at no cost to anyone.

- Cite a cancelled run as costless, OR cite this rule's savings as runner capacity

**Why:** a cancel mid-execution is billed for the wall-clock consumed, and a cancel while queued still burns its author's whole wait and a queue slot — **1,208 minutes** across the sample. The symmetric error is over-claiming: those runs largely executed zero steps, so the saving is wait and queue churn, never machine time.

## Origin and delivery evidence

## Origin

2026-08-12 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination), verbatim in-session directive: _"i need you to /codify it such that we don't activate so many CIs. Consolidate into PRs before hitting CIs as the CIs are killing our productivity! … This discipline must go down to all build, use, downstream too! find a systematic way to manage this CI time sink issue. Also, half the gate runs are always repeat attempts and this is a massive waste."_

Instrument: `gh run list --repo <org>/loom --limit 800 --json conclusion,event,status,startedAt,updatedAt,headBranch`, durations as `updatedAt − startedAt`, **793 completed runs**. Named falsifying result before reading: a cancellation share near zero with 1.00 runs per PR branch would have refuted the premise; measured 15% cancelled and 3.01 runs per branch.

**A third correction, in the same family as the first two: SAMPLE SIZE.** The first draft ran this instrument at `--limit 100` and reported 1.45 runs/branch and 27% cancelled. Both were windowing artifacts — a recent-N window truncates each branch's run history, so most branches appear holding only their newest run. Re-run at 100 / 400 / 800 the same repo reports **1.55 / 2.53 / 2.98** runs per branch, rising monotonically. The retracted figures are recorded here rather than silently replaced. The co-owner's "half the gate runs are repeat attempts" is **vindicated on the branch axis at the honest sample size**: **58% of PR branches carried more than one run** (103 of 177), against 15% of runs by conclusion. The first measurement made that estimate look wrong; it was the measurement that was wrong.

**A second instrument corrected what the first one's minutes MEAN, and the correction is load-bearing.** A companion profile of the job/step API (not the run list, which cannot see the queue/execution split) measured **78% of PR-run elapsed time as queue wait** — 1,750.5 min queued vs 492.9 min executing across 30 runs of the heavy job; avg 134.7 min queued, 11.9 min executing; wall-clock p50 47 min / p90 183.5 min / max 293.3 min against a billed-equivalent p50 of 14.3 min. Critically, **13 of the cancelled PR runs executed ZERO steps** — killed while still queued. The run-list minutes are therefore WALL-CLOCK, and every clause above labels them so. The first draft of this rule justified itself as saving 474 runner-minutes; that claim was FALSE and is not made. The saving is author wait and queue churn on a saturated pool, which is real and sufficient. Recording this rather than quietly restating the figure is the point: a rule justified by a saving it does not deliver is the over-claim this corpus keeps catching.

**Self-implicating, and the strongest single datum:** the branch of the session that commissioned this rule ran CI four times (three cancelled), destroying **213 CI-minutes on one PR**; two sibling branches did the same for 97 and 31 minutes. In the same session nine PRs were opened inside 72 minutes, and three inside nine minutes.

**MUST-4 amended 2026-09-01 (loom, gate-cost lane) — the post-merge duplicate-run half.** Instrument: `gh run list --limit 400 --json event,headBranch,headSha,conclusion,status,startedAt,updatedAt` over a 37-run / 621-minute window, cross-read against `gh pr list --state merged --json number,mergeCommit,headRefOid` to compare each merge commit's TREE against its PR head. Falsifying result named before reading: a post-merge run whose tree DIFFERED from the PR head on most merges would have shown the `push:` arm testing something new, and the duplicate claim would have died there. It did not — 7 of 14 merges were tree-identical. The SECOND half of the finding is the one that inverts the conclusion and is recorded because it survives the first: on the other 7, base had MOVED and most PR branches carried exactly one run, so those combinations reached main untested. The window's zero main-branch failures therefore establish NOTHING about the gate (`instrument-discipline.md` MUST-1 — a green consistent with both a working gate and an unexercised one carries no information).

At loom specifically, measured with `check-ci-config-invariants.mjs` on 2026-09-01: `merge queue enabled false`, an unfiltered `merge_group:` arm present in the eval workflow, and `plan / visibility  team / private` — so the wiring is done and the ENTITLEMENT is unconfirmed (a private-repo merge queue needs Enterprise Cloud, and that tool reports the plan rather than probing the entitlement). That state is left AS IS by this change. Turning it on is the OWED OPERATING-MODEL DECISION the clause describes, it is the repo owner's, and no lane may take it — which is why the clause codifies the surfacing obligation and the trade-off rather than a recommendation. Deliberately NOT claimed here: that enabling it would recover the 291 minutes. It would trade them for queue latency on every merge and for giving up `--admin` as the normal landing path, and neither of those has been measured.

**Gate status at landing, stated rather than implied:** `.claude/rules/**` is `self-referential-codify.md` TIER 1 and these amendments were authored by ONE lane. The multi-agent redteam round that tier requires is **UNSATISFIED** at this commit.

**MUST-5 is a consumer's finding, generalized — not loom's.** The folding mechanism originates in a downstream BUILD sibling (kailash-rs), which measured **~18 runs per PR** in its own repo and proposed folding a wave onto one integration branch. loom reaches that repo through `/sync-to-build rs`, so it is a CONSUMER of this artifact, not a peer being advised: declining the mechanism would have shipped it a gap for a problem it had correctly measured. loom's contribution is only the **conditionality** — the measurement showing the mechanism does not generalize unconditionally (loom's own ~3.0 makes folding marginal, and the whole thing INVERTS under a branch-general `push:` trigger) plus the two instruments that let any repo settle it locally. The sibling's rationale was right for the sibling; it was the unconditional form that was wrong.

Authored `priority: 10` + `scope: path-scoped` + `cli_delivery: skill-channel` under the measured saturated-baseline constraint — emission measured 54,078 B against a 15% proximity band allowing ≤55,706 B at the raised 65,536 cap, leaving ~1.6 KB, so a `priority: 0` baseline placement cannot land. Same disposition `burn-down-reporting.md`, `completion-criterion.md`, `handoff-completion.md` and `product-completion-first.md` took under identical saturation.

**Reachability residual, recorded rather than papered over.** The moment this rule most needs to fire — immediately before `git push` or `gh pr create` — is not a file-edit event, so no `paths:` glob can be TRIGGERED BY it (a glob reaches that moment only when the session happened to touch a matching file earlier, since injection is sticky-once — see the CLOSED paragraph below); this is the same reachability class `issue-triage-routing.md` names, and that rule answered it by going baseline, which the measured emission headroom forbids here. The globs cover the PLAN-time moment where PR count is actually decided (`**/todos/**`), the wave-close moment where PRs are opened and merged (`**/.wave-tracker*`), and the CI-config surface MUST-4 depends on (`**/.github/workflows/**`). `**/workspaces/**` was authored and then REMOVED for a measured reason: the `workspace-note` injection profile sat at 409,370 B against its 410,135 B ceiling (the snapshot's 390,605 B base × the guard's 5% tolerance) — 765 B of headroom, a fortieth of this rule — so including it would breach the guard. **Re-measured 2026-08-14: 409,646 B, so the headroom is now 489 B** against a 32,287 B rule body; the figure MOVES with every path-scoped rule in that profile, so re-measure it rather than citing this line. The honest consequence WAS that a session which edits only `src/` and pushes did NOT load this rule.

**CLOSED 2026-08-14 (T4) — by a hook, not by a glob, and the reason is COVERAGE rather than impossibility.** The T1–T6 plan named glob-widening as the PREFERRED fix. What is measured is narrower than the first version of this paragraph claimed, and the correction is recorded rather than quietly swapped in: a `paths:` glob cannot be TRIGGERED BY the push event, because path-scoped rules inject off a session's TOUCHED-FILE set and a `git push` touches no file. It does NOT follow that a glob could never REACH the push moment — injection is sticky-once per session (`check-rule-injection-budget.mjs`: "path-scoped rules inject their WHOLE body once per session, the first time a tool call touches a path matching the rule's `paths:` globs (sticky-once, verified 2026-06-27)"), so a broad glob left the rule loaded at push time in any session that happened to touch a matching file earlier. That is a coincidence, not a guarantee — the session that edits only `src/` and pushes still gets nothing — and it is separately blocked on the injection headroom measured above (489 B as re-measured 2026-08-14, against a 32,287 B rule body). The hook fires on every CI-spending command regardless of what the session touched, which is the property no glob can offer at any headroom, and that is why this is the surface. The alternative the same plan named was taken: `.claude/hooks/lib/ci-cost-reach.js`, delivered from `validate-bash-command.js` — the PreToolUse Bash hook that ALREADY reads the PCF category off `gh pr create`. The two halves of the co-owner's directive ("reduce CI time sink leaks" and "packing more into PRs aligned with PCF triaging") therefore now fire from one hook, on one command, rather than as two artifacts that never meet.

Four properties are load-bearing, and each is pinned by a check that could return the opposite verdict. **(1) It delivers the CONTRACT, never a verdict** — it renders no judgment about whether a push is wasteful; that remains the deferred Phase-2 detector. **(2) The delivery path SPAWNS nothing.** A network read here would hang every push in the repo (`lib/open-pr-surface.js`: "execFileSync blocks the event loop, so the hook's own setTimeout cannot preempt them" — a `cc-artifacts.md` Rule 7 timer cannot bound a synchronous network call), and an "is a run in flight?" signal is consistent with BOTH a wasteful and a legitimate push, so no output it produced could falsify anything (`instrument-discipline.md` MUST-1). Stated precisely, because the loose form ("makes NO subprocess call") was measured FALSE at the module-load level: the module does transitively LOAD `child_process`, through the shared `git-command-parse.js` → `violation-patterns.js` chain. A `require` allocates no process; what would hang a push is a CALL, and the test intercepts all seven spawn primitives and records zero calls across the whole exported surface. **(3) Delivery is ONCE PER SESSION**, which IS the discrimination: an advisory that speaks on every push becomes wallpaper — the failure that made `wrapup-after-landing.js` dismissible, a discrimination disease with a frequency symptom. Falsifying result, named and pinned: an already-delivered session is delivered to again. **(4) The head states a fate that is TRUE at PreToolUse — and ONLY there.** The delivery closes "no check has judged your push. Read it and decide", so a head reading "the action ALREADY RAN" would leave the agent no decision to make; `instruct-and-wait.js` gained a `pre-action` register for exactly this. That register is GATED on the hook event, not applied globally, because one renderer serves two moments whose truth conditions are OPPOSITE: at PostToolUse the action genuinely HAS run, so "ALREADY RAN" is the CORRECT head there and rewriting it would trade one false head for a worse one. Measured over the full 7-event × 6-severity matrix against the pre-fix renderer: **41 of 42 cells byte-identical, the single changed cell being `PreToolUse|pre-action`**; ungated the same diff showed SEVEN changed cells, which is the hazard the gate closes.

Pinned by `.claude/test-harness/tests/ci-cost-reach.test.mjs` (16 cases, registered in `ci-suites.json`). Its REDs are mutations carrying both a reach proof (the mutated source no longer contains what was excised) and a RAN proof (the mutated hook still reaches its default verdict) — the second added after loom#1715 found the first version writing its mutant to a bare temp dir, where the hook's ten `./lib/*` requires cannot resolve, so it crashed and the crash was being read as the RED. **Residuals, stated rather than implied.** (a) This closes the `git push` / `gh pr create` moment ONLY; a session that edits only `src/` and reasons about PR SIZING without reaching a CI-spending command still does not load the rule, and `**/workspaces/**` remains the correct fix for that half, still BLOCKED on injection headroom. (b) The corrected head reaches `git push` but NOT `gh pr create`, and this was measured rather than assumed: `gh pr create` always co-fires the PCF-category finding, which is registered `halt-and-report`, so the merge collapses and the delivery inherits the false head there. Every deferred finding in that PreToolUse hook carries the same mis-registration — nothing has run when it speaks — and the general repair is to re-register them; it is not done here because those findings ship from other lanes, and changing a delivered head fleet-wide is a wider blast radius than this fix is scoped to carry. (c) A `--dry-run` push is excluded (it buys no run); an id-less session falls back to a per-process marker, which OS pid reuse could cost one delivery — both are improvements on, not eliminations of, the underlying uncertainty.
