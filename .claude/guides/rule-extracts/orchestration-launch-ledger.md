# Orchestration Launch-Ledger — Depth

On-demand depth for the path-scoped rule `.claude/rules/orchestration-launch-ledger.md` (`priority: 10`, `scope: path-scoped`, `cli_delivery: skill-channel`, globbed to `**/workspaces/**`, `**/.session-notes*`, `journal/**`). The rule body carries the five MUST clauses, the MUST NOT list, both Trust-Posture-Wiring blocks with all eight canonical fields each, and every DO/DO-NOT block; this file carries the evidence, the measured narratives, the per-instance provenance, the cross-reference map, the length rationale and the extraction record. Each § below is the resolution target of a pointer in the rule body.

The executable checks and the full BLOCKED corpora for MUST-4 / MUST-5 live one file over, in `.claude/skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` §§ MUST-4 / MUST-5 — this extract does not duplicate them, it carries what the rule body itself shed.

Read it when authoring or auditing a launch-ledger row, a quota-pause liveness verdict, or a rescue checkpoint — and when a gate-review (reviewer at `/redteam`, cc-architect at `/codify`) adjudicates one.

## MUST-5 depth

The rule body mandates that a rescue checkpoint declare itself with the literal subject prefix `checkpoint(UNREVIEWED):`, so a merge gate can mechanically detect one reaching a PR. The evidential reason the body sheds:

**A negative-control pass that was interrupted mid-mutation leaves a deliberately-broken mechanism that reads as a normal edit.**

That is what makes the prefix load-bearing rather than cosmetic. The two failure modes MUST-5 prevents are asymmetric in visibility: an oversized blob announces itself the moment someone looks at the diff, and a live negative-control mutation does not — it is indistinguishable from work until something downstream depends on the mechanism it deliberately broke. The prefix is the only greppable signal that such a commit reached a PR at all.

The body also compresses one cross-reference: `worktree-isolation.md` Rule 8 owns WHEN a rescue is mandatory, and requires `git ls-remote` as the proof the checkpoint actually landed. Scan commands, the empty-range trap and the full BLOCKED corpus: `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` § MUST-5.

## Wiring depth — MUST-4 / MUST-5

### Why a separate clause-scoped Wiring block was required at all

The rule-wide block governs MUST-1/2/3 and is unchanged. A separate block is required for MUST-4/5 because the rule-wide block's grace window closed 2026-07-26, so it can supply no `regression_within_grace` teeth to clauses landing 2026-08-10. Same clause-scoped shape as `worktree-isolation.md` Rules 7 / 8 and `security.md` § Enforcement-Surface Parity.

### Why no probe suite arrived with the clauses

The originating repo registers one; loom's `.claude/test-harness/**` is never-synced, so that suite did not arrive with the clauses, and authoring a DISCRIMINATING one is real work this placement did not carry — the comparable in-corpus suite registered for `instrument-discipline.md` is 12 bipolar rows over a candidate-fixture corpus, and a suite authored below that bar would be a non-discriminating instrument banked as coverage, which `instrument-discipline.md` MUST-3 blocks outright.

The scope of the omission is exactly three prose artifacts: MUST-4, MUST-5, and `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md`. Per `coc-artifact-eval-coverage.md` MUST-1 this is an eval-coverage omission on new load-bearing clauses, recorded in the rule body rather than left to be inferred from the absent file.

### Why the probe PATH is deliberately unnamed (measured)

MUST-4 of that same rule also asks the Wiring block to NAME the probe file. That path is deliberately left unnamed until the suite exists, and the reason is measured, not assumed: `detection-binding-check.mjs` treats a probes path in a Detection block as a LIVE binding and reds its CRITICAL `dangling-probes-binding` on one that does not resolve (observed against an otherwise `VALID (score 100)` baseline), whereas an absent DEFERRED fixtures path is sanctioned as reported-not-fatal. The deferred sanction has a fixtures arm and no probes arm, so MUST-4's probe clause and its own does-not-resolve clause cannot both be satisfied before the suite lands; naming it is the strictly worse half of that trade.

### Regression-within-grace — the no-dedicated-key rationale and its precedent

A liveness-inference property is review-layer judgment over command history, and minting a key would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit. The same disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.

The rule body keeps in normative form the one clause this rationale does NOT cover: a pushed CREDENTIAL additionally routes to the pre-existing `critical` (secret leak → L1) trigger, unchanged, and this clause mints no second key for it.

### Detection mechanism — the Phase-1 confirmations in full

The rule body compresses the Phase-1 gate-review checklist against § Violation scope. In full, reviewer at `/redteam` + cc-architect at `/codify` inspect any session that relaunched, stood down, or marked a track `stopped` and confirm **(d)** a cwd-based process check ran with its positive control and its per-tool exit convention honored; and inspect any session that pushed a rescue branch and confirm **(e)** the staged set was inspected, the secret scan ran over a NON-EMPTY revision range, the branch is `recovery/<name>`, and the subject carries the literal `checkpoint(UNREVIEWED):` prefix.

## Wiring depth — rule-wide

The Phase-1 gate-review confirmations (a) / (b) / (c) stay in the rule body. The narrative around the two detector arms:

The probes path `.claude/test-harness/probes/orchestration-launch-ledger.probes.json` is NOT YET AUTHORED, and is declared with a graduation condition and a calendar expiry in `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals` — an **undeclared** absence would red `detection-binding-check.mjs`, which is why the declaration, not the silence, is the sanctioned exit.

The deferred Phase-2 detector is an advisory `Stop`/`PostToolUse` detector flagging a background-agent spawn with no adjacent durable-ledger write, paired with the review layer per `probe-driven-verification.md` MUST-4; audit fixtures land WITH that detector at `.claude/audit-fixtures/orchestration-launch-ledger/` per `cc-artifacts.md` Rule 9.

The rule-wide block's no-dedicated-key deviation follows the same disposition `wave-loop.md` MUST-6/7 and `agents.md` § Triad took.

## Cross-reference map

- **Distinct from** `wave-loop.md` MUST-6 (never idle-wait while independent in-budget work is launchable) — that governs WHETHER to launch more; this governs TRACKING what was already launched. MUST-7 (reconcile a pre-existing backlog item against ground truth before implementing) is the backlog-item analogue; this rule is the same reconcile reflex applied to SPAWNED AGENTS across a context boundary.
- **Distinct from** `agents.md` § The Default Execution Mode Is The Triad + § Worktree Orchestration — those govern HOW to parallelize (decompose, isolate, verify deliverables); this governs the durable LEDGER that survives compaction so the parallel launches are not lost.
- **Composes with** `knowledge-convergence.md` MUST-1 (`.session-notes` single-writer) — the ledger commonly lives in the workspace/session-notes surface that rule governs; this rule adds the launch-tracking CONTENT, not a second writer.
- **Same epistemic family as** `zero-tolerance.md` Rule 1c / `verify-claims-before-write.md` MUST-2 — a launch map carried across a context boundary is structurally unfalsifiable until re-derived; the durable ledger is the re-derivation surface.

## Origin depth — MUST-4 / MUST-5

**MUST-4 / MUST-5 — 2026-08-10, ingested from the BUILD stream.** A sixteen-track wave hit three account quota-limits in one session. Both clauses are orchestrator errors, both measured: ten tracks were relaunched into the SAME worktrees after the first limit, the originals resumed on the account swap, and one resulting commit swept in a sibling's in-flight edit while a negative control run minutes later went **vacuous** (a sibling's restore put back the very entry the control meant to remove — and a vacuous control reports SUCCESS). The same false premise then had an agent `kill` another's in-flight test run, truncating output at 120,867 bytes. Separately, a blanket `git add -A` rescue pushed two 16.6MB measurement binaries, a scratch probe, and unformatted mid-edit code that reddened a required format check. The checkpoint reflex itself was CORRECT — ~10,400 lines across twelve branches were preserved and nothing was lost; what the clauses add is the scan between staging and push, and the process check before relaunching.

The third-axis measurement MUST-4's mtime look-back rests on stays VERBATIM in the rule body (it is quoted inside the clause and again inside its DO-NOT block): measured 2026-08-14 on a worktree under active editing, `FREE exit=0` during ~1,100 lines of edits, after which a second agent was briefed into the same tree.

## Origin depth — landing + classification

Landed at loom via `/sync-from-build` Gate-1 classification of the `kailash-rs` proposal `ORCHESTRATION-QUOTA-PAUSE-AND-RESCUE-HYGIENE-2026-08-10`, classified **GLOBAL on both axes** — the quota-pause and rescue-scan contracts reference no language runtime and no CLI-native delegation primitive, so neither a language-axis nor a CLI-axis overlay is warranted. The originating repo's language-specific tooling names were genericized at placement per the sync-reviewer BUILD-internal-reference contract; the measured byte counts and the failure sequence carry verbatim because they are the evidence. Depth split to `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` under `rule-authoring.md` Rule 10 path (a): the `workspace-note` path-scoped injection profile carried 9,013 B of headroom against ~20 KB of authored clause text, so the executable checks and BLOCKED corpora live in the skill and the rule body carries the thin contract.

## Origin depth — 2026-07-19 (GH #1232)

2026-07-19 — GitHub issue #1232, filed from an orchestrator session in a downstream consumer repo where the failure and the fix were observed. Two background agents (an engine feature + a store-adapter) were launched, fell out of context after a compaction, and a DUPLICATE store-adapter agent was spawned before the collision surfaced; the self-launched, already-pushed branches were momentarily reasoned about as if another session had produced them. Landed at loom via `/sync-from-build` Gate-1 classification (Wave-1 of the sync-from-backlog follow-ups, journal/0552); the generic launch-tracking principle cascades, the downstream-consumer identifier stays in the local `/codify` receipt per `upstream-issue-hygiene.md` MUST-2. Authored `priority:10` + `scope:path-scoped` + `cli_delivery:skill-channel` under the measured saturated-baseline constraint (codex 10.13% / gemini 10.43% headroom, within the 15% proximity band) and scoped to the workspace / session-notes surfaces where the ledger lives — the same orchestration-surface path-scoping `wave-loop.md` uses; a genuinely-first spawn before any workspace file is touched is the one reachability edge (surfaced as a residual at land-time), bounded because a background-agent orchestrator is by construction doing plan-/workspace-anchored work that fires the glob early.

## Length rationale

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is ~155 lines, UNDER the 200-line guidance — recorded because the originating BUILD-side rule carries its own overage rationale at ~320 lines and a reader comparing the two would otherwise infer content was lost. It was not de-scoped: the depth was EXTRACTED to `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` under `rule-authoring.md` Rule 10 path (a), which is why loom's body is shorter while the contract is the same. This rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and Rule 10's proximity-band gate does NOT fire on it; the binding constraint here was the `workspace-note` path-scoped injection profile, measured at placement.

The "~155 lines" figure above is the measurement AT the 2026-08-10 placement and is preserved verbatim; the 2026-08-19 structural-cleanup extraction recorded below took the body lower still. Neither figure approaches the 200-line guidance, and the binding constraint remains the injection profile, not the line count.

## Extraction record

**2026-08-19 structural cleanup — ZERO de-scoping.** Every MUST clause, MUST NOT bullet, BLOCKED-rationalization entry, DO/DO-NOT block and the failure-mode statement of every `**Why:**` line stayed in the rule body verbatim. Both `## Trust Posture Wiring` blocks kept every canonical field LABEL they carried, each with its normative statement; only measured narrative inside a field moved, each leaving a resolving pointer to a § heading in this file. The MUST-4 third-axis clause ingested from the BUILD stream the same day stayed in FULL normative form — its three obligations (`-newermt` prohibition, numeric-guard, widen-the-window), its "three axes still do not make FREE proof of absence" paragraph and its DO/DO-NOT block were not touched, and neither was any other part of MUST-4. [**Superseded 2026-09-29 on obligation 1** — the `-newermt` prohibition was re-anchored to the silent-empty WALK class it was always about; the record of what THIS pass did stands. § "Re-anchoring — 2026-09-29: the silent-empty WALK class replaced the `-newermt` flag" below.]

What moved: the MUST-5 interrupted-negative-control evidence sentence and the `worktree-isolation.md` Rule-8 elaboration; the MUST-4/5 Wiring block's separate-block rationale, probe-suite-absence narrative, unnamed-path measured evidence, no-dedicated-key rationale and full Phase-1 confirmation checklist; the rule-wide Wiring block's detector-arm narrative and precedent tail; the four-entry cross-reference map; the three Origin narratives; and the length rationale.

Driver: the rule fires in the `workspace-note` path-scoped injection profile, which was over its ceiling. The extraction is budget-motivated structural cleanup with no change to the rule's normative surface.

`rule-authoring.md` Rule 10 and Rule 11 do **NOT** fire on this pass. Rule 10 § "Trigger scope" binds the proximity-band gate to `priority: 0` + `scope: baseline` rules ONLY, and this rule is `priority: 10` + `scope: path-scoped` — it contributes nothing to baseline emission. This is therefore a **STRUCTURAL-CLEANUP extraction**, not a Rule-10 paired extraction, and so is NOT Rule-11 recurrence input either (Rule 11 § "Recurrence-window scope" counts Rule-10-MANDATED invocations only, and explicitly discards structural-cleanup extractions on path-scoped rules as false positives). That is the disposition `journal/0148` § "Lesson learned" recorded for the identical case on `rule-authoring.md` itself; sibling precedent in the same shape: the extraction records in `recommendation-quality.md`, `multi-operator-coordination.md` and `user-flow-validation.md`.

# Structural-cleanup extraction — 2026-08-28 (rule-injection budget, `workspace-note` band)

Two changes, both funding this profile's band rather than narrowing any glob.

**A duplicated `**Why:**` was collapsed.** MUST-6 carried TWO consecutive `**Why:**`
paragraphs — a defect, not depth: `rule-authoring.md` MUST-4 mandates one per clause, and a
second one crowds the load-bearing clauses out of working memory exactly as its MUST NOT
describes. The surviving line keeps both failure-mode statements (invisible-to-pre-spawn-check,
and force-push-acceptance-selects-for-data-loss) plus the collision-`--author` clause from the
removed one. The removed paragraph is preserved verbatim here so nothing is lost:

**Why:** A returned writer is invisible to every pre-spawn check by construction, so without a revival disposition the default is two writers on one track under one git identity — the collision `--author` cannot untangle. And a force-push is accepted precisely when the remote holds commits the local does not, so acceptance selects FOR data loss rather than against it; the read-only-verifier disposition is also what lets the duplicate earn its keep, having caught a three-way resolver divergence and a deny-by-default regression neither implementing agent could see.

**MUST-4's third-axis mechanism detail moved to the paired skill's § MUST-4.** The three
obligations of THAT date stay in the rule as imperatives — never `-newermt`, numeric-guard every
counter, widen the window — with their consequence clauses intact; only the per-tool mechanics
(which `find` dialect rejects which stamp form, the helper-collapse instruction) moved, and the
skill already carried the runnable check they belong to. [**Amended 2026-09-29:** obligation 1 was
re-anchored from the `-newermt` FLAG to the silent-empty WALK class, the other two are unchanged,
and the axis still carries three. § "Re-anchoring — 2026-09-29" below.]

`rule-authoring.md` Rule 10 / Rule 11 do NOT fire: Rule 10 § "Trigger scope" binds `priority: 0`
plus `scope: baseline` rules only, and this rule ships `priority: 10` / `scope: path-scoped`.

The FIRST of the two, also preserved verbatim (the merged survivor is textually neither original, so both are recorded here rather than one):

**Why:** A returned writer is invisible to every pre-spawn check by construction, so absent a revival disposition the default is two writers on one track under one git identity. And a force-push is ACCEPTED precisely when the remote holds commits the local does not — acceptance selects FOR data loss, never against it. **Worked ledger example, the BLOCKED corpus, and the measured incident: `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` § MUST-6.**

# Structural-cleanup extraction — 2026-09-07 (rule-injection budget, `workspace-note` band)

Depth moved out of the rule body to fund the `workspace-note` profile band. **ZERO de-scoping:**
measured with `check-descoping.mjs`'s own `extractInventory` after every edit, NO normative class
FELL. Census at this commit: `must_clause` 5, `must_token` 86, `must_not_token` 6,
`blocked_token` 8, `why_line` 12, all eight canonical Wiring fields at 3. Against `origin/main`
(76 / 5 / 8 / 12) three classes ROSE and none fell, which is why `check-descoping.mjs` reports
CLEAN. An earlier revision of this line said `must_token` 83 and called the census "UNCHANGED";
both were wrong — 83 was a mid-edit reading, and two later edits added MUST references while
removing none. Nothing moved here is an obligation; every sentence below is narrative, provenance, or
registration bookkeeping. `rule-authoring.md` Rule 10 / Rule 11 do **NOT** fire (this rule is
`priority: 10` / `scope: path-scoped`, not a `priority: 0` baseline rule).

## Probe registration + dispatch bookkeeping (rule-wide Wiring, § Detection mechanism)

Removed verbatim; the rule keeps the registration fact, the DISPATCH-ONLY caveat and the
never-synced fact in compressed form:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, and declared in `clause-coverage-baseline.json` with ZERO deferred clauses. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. **Consumer note:** `.claude/test-harness/**` is never-synced (MEASURED `skip/exclude` on all six lanes this rule ships to), so no consumer receives this suite; the fixtures directory itself DOES ship (`copy/tier_match` on the same six).

## MUST-6(b) — why `PreToolUse:Bash`, and why the `pre-action` register

Moved from the MUST-6 Wiring `**Detection mechanism:**` bullet 2026-09-13 (same paired
extraction). The rule body keeps the registration fact and the severity, which are the
normative statements; these are the reasons behind them.

**The event.** `PreToolUse`, matcher `Bash`, is the event the guard's own `@hook-event` header declares, and the right one because the push IS the subject and that is the last instant at which the origin-only commits still exist; one moment later the rewrite is accepted and no local reflog names what the remote held.

**The register.** `pre-action` rather than `advisory` is the REGISTER — at `PreToolUse` the `advisory` head renders "the tool RAN", which is false before the call; loom#1715 H-1.

## Rule-wide Wiring — probe registration bookkeeping

Moved verbatim from the rule-wide `**Detection mechanism:**` bullet 2026-09-13 (same paired
extraction). The rule body keeps the probe path, the pair count, the clause enumeration and the
Phase-2 declaration; this is the registration bookkeeping around them.

Registered in `eval-manifest.json` (probe-only, `scanner: null`), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, ZERO deferred clauses.

DISPATCH-ONLY — no workflow invokes `coc-probe-dispatch.mjs`, so a green CI run is never evidence these probes passed — and never-synced, so no consumer receives the suite: the extract § "Wiring depth — rule-wide".

Detector shape + the undeclared-absence consequence: the extract § "Wiring depth — rule-wide".

## MUST-6(b) force-push detector — arming, fencing and fixture provenance

Moved verbatim from the MUST-6 Wiring `**Detection mechanism:**` bullet 2026-09-13, a
rule-injection-budget paired extraction (`rule-authoring.md` Rule 10 path (a)) discharging the
per-rule allowance this rule had exceeded. The rule body keeps every MUST, the detector and
predicate paths, the severity/register contract, the parsed-not-lexical signal statement, the
UNKNOWN-never-clean rule and the fixtures path; what follows is the narrative around them.

So AT LOOM that window is observed, and the guard's `@settings-registration: authored-unwired` marker is removed in the same change, since a registered hook carries none (control: registered siblings return zero occurrences).

**ARMED is not PROVEN EFFECTIVE:** no armed guard has been OBSERVED firing in a live session; registration and distribution state are all that is measured.

**Staged because firing volume is measured on loom's corpus and nowhere else, and a consumer's corpus is a different population.** PROMOTION is deleting this guard's `loom_only:` entry TOGETHER WITH its `LOOM_ONLY_TIER_CARVEOUTS` twin — removing either alone is a defect.

Its `hook_delivery` lane is `mcp-guard`, a DERIVED fact rather than a judgment: `extract-policies.mjs` builds the mirrored set entirely from `settings.json::hooks.PreToolUse` and maps `Bash` to shell+unified_exec, so arming MOVED this guard into that set (MEASURED 11 → 13 with its sibling), and de-arming would require flipping the label back to `cc-only` in the same change.

What the parsed signal buys, illustratively — the statement itself stays in the rule body, this is
the worked consequence: because the force flags and the destination are read from argv TOKENS rather
than matched against the raw command string, a force-push named in a commit-message body or a shell
comment is not a command and the guard stays silent on it.

It was armed only AFTER two fixes this round, and the second is why the fixture count alone was never evidence it worked: the predicate was NARROWED from a branch-NAME matcher to the divergence MEASUREMENT this clause always named, and its CALLER was WIRED — previously the guard supplied no resolver, so production returned `unknown/no-divergence-resolver` for EVERY push while its fixtures passed.

MEASURED 229/229 fixtures.

An earlier revision of this passage recorded the detector as AUTHORED-but-UNWIRED, which was true when written and is now false at loom while remaining exactly true at every consumer; it is corrected rather than left, because a Detection field claiming an absent instrument is the same absence-reads-as-clean shape this rule governs.

What follows describes what it does AT LOOM, and what it WOULD do at a consumer if ever promoted.

Fixtures: `.claude/audit-fixtures/force-push-recovery-scope/` — 25 bipolar pairs plus end-to-end and real-git arms, each pair asserting its two poles SEPARATE — registered in `.claude/test-harness/ci-audit-fixtures.json`, and registration in THAT registry is what runs them (an unregistered runner fails the closure; a registered one is executed by `run-audit-fixtures.mjs` in the aggregate CI step).

**Relocated 2026-09-13 (citation-restoration paired extraction).** Why the `pre-action` register is
capped where it is: it is capped by the CONTRACT rather than by the signal — a force-push to a
`recovery/<name>` branch the operator owns is LEGITIMATE, so the same command shape is compliant or
not on a reviewer's judgment. (The `**Severity:**` field of the MUST-6 Wiring block states the same
`advisory` ceiling and the same `recovery/<name>` reason, so the rule body was carrying it twice.)
The force flags the parsed signal reads are `--force`, `-f` including short clusters,
`--force-with-lease`, and a `+`-prefixed refspec. And on the revival half: a returned writer is
invisible to every tool-call-time check by construction, which is the whole reason MUST-6 exists —
so gate-review over a transcript is not a weaker backstop there, it is the only instrument.

The fixture directory is a DEPTH-1 slug rather than the `orchestration-launch-ledger/revival-and-force-push/` path this clause previously named: `audit-fixture-runners.mjs::discoverRunners` enumerates `.claude/audit-fixtures/<dir>` non-recursively, so a nested runner is neither executed nor reported missing — measured on a synthetic tree, where a depth-1 runner resolved and a depth-2 one returned neither a dir nor a problem.

**Relocated from the rule body 2026-09-29** (`rule-authoring.md` Rule 10 path (a) — funding the widened MUST-4 third-axis clause in the same change). The fixture-registration and DEPTH-1 narrative above carries the fixture half; the rule keeps a compact citation-bearing line, because `check-descoping.mjs` credits a move only into a STEM-MATCHED paired surface (`<rule>.md` → `rule-extracts/<rule>.md`, or a skill named `<rule>-<suffix>.md`). The paired skill `quota-pause-and-rescue-hygiene.md` is under an unrelated name, so it is NOT an auto-detected destination — measured, twice: the first pass red on `citation_descoping_to_uninjected` (guides do not load), and the second still red after the text was moved into that skill.

The arming-scope measurement, verbatim, kept here with its control: Arming is CC-only — MEASURED zero occurrences of the guard basename in `.claude/codex-templates/hooks.json` and `.claude/gemini-templates/settings.json`, against a sibling-guard control that fires in both.

Also relocated 2026-09-29, from the same clause's Origin and extraction-record lines (the rule keeps the dates, the landing path, the `upstream-issue-hygiene.md` MUST-2 citation and a pointer here): the sixteen-track wave that hit three account quota-limits in one session, with both MUST-4/MUST-5 clauses orchestrator errors and both measured; the 2026-07-19 GH #1232 failure-and-fix observation in a downstream consumer repo, where the measured headroom constraint behind the `priority:10` / `path-scoped` / `skill-channel` authoring sits; and the one reachability edge. Those narratives are above, in § "Origin depth — 2026-07-19 (GH #1232)" and § "Origin depth — MUST-4 / MUST-5".

## MUST-6 probe pole design (MUST-6 Wiring, § Detection mechanism)

Removed verbatim; the rule keeps the suite's existence, both fixture paths, and the
`instrument-discipline.md` MUST-3 discrimination requirement:

> The two-writer revival transcript corpus the original placement did not carry was authored as the `MUST-6-firing` pair in `.claude/test-harness/probes/orchestration-launch-ledger.probes.json`, both poles at `.claude/audit-fixtures/orchestration-launch-ledger/`: they run the SAME revival and separate only on whether the returned agent's row survived, whether exactly one of the pair was demoted to a read-only verifier before either wrote again, and whether the origin-only commits were measured before any recovery. The compliant pole discusses a leased force-push at length IN ORDER TO REFUSE IT, so a judge keying on the token's presence flags the clean pole — the discrimination `instrument-discipline.md` MUST-3 asks for, rather than a suite banked as coverage.

## MUST-4 third-axis mechanism (§ MUST-4 body)

The obligation ("A THIRD axis is REQUIRED, and it is not process-based") and all three of its
imperatives stay in the rule. The mechanism and the negative-control reasoning moved:

> The argv sweep and the cwd sweep are BOTH process observations, and an agent driven by a harness has neither: editing through ABSOLUTE paths keeps its cwd in the main checkout and spawns nothing carrying the worktree slug, so `ps` matches nothing, the cwd sweep returns zero hits, the positive control PASSES, and the check reports FREE while the tree is being written. This is an instrument-SCOPE failure (`evidence-first-claims.md` MUST-6), not a capability one — the negative control cannot catch it, because the instrument CAN return OCCUPIED and simply cannot SEE this class.

Its measured instance, also removed from the rule body:

> Measured 2026-08-14 on a worktree under active editing: `FREE exit=0` during ~1,100 lines of edits, after which a second agent was briefed into the same tree.

And the quiet-agent illustration from § "Three axes still do not make FREE proof of absence"
(the normative kernel — OCCUPIED-only-as-EVIDENCE, and the PERISHABLE verdict — stays in the rule):

> waiting on a model response or on CI, or writing only into build-output directories the sweep skips

### Re-anchoring — 2026-09-29: the silent-empty WALK class replaced the `-newermt` flag

The clause named the right symptom class from the day it landed and pinned it to the WRONG
mechanism. It read: "Never `-newermt`, in ANY spelling — no portable form exists, and BOTH
rejections are silent to the counter (zero paths emitted reads as 'nothing was written' → FREE)."
MEASURED 2026-09-29 on Darwin 25.6.0, each direction carrying a firing control:

- **`-newermt` is NOT the silent class.** `find` on the authoring host's PATH is a shell function
  routing to `bfs 4.1.1` and `/usr/bin/find` is BSD — and their argument grammars DIFFER: BSD `find`
  accepts BOTH forms at rc 0 (absolute AND relative, each returning the correct hit — measured),
  while bfs accepts the ISO-8601-like absolute form (`-newermt '2026-09-29 00:00'` → the correct hit
  at rc 0) and REJECTS the relative form (`-newermt '-45 minutes'` → `bfs: error: Invalid
  timestamp`, rc 1). The rejection is LOUD: rc 1 on stderr, silent only to a counter that discards
  stderr (the paired skill's § MUST-4 carries the `2>/dev/null` measurement). The prohibition was a
  PORTABILITY hazard, not this one.
- **The SILENT class is the START POINT.** `ls -ld /tmp` → `/tmp -> private/tmp`;
  `find /tmp -maxdepth 1 -name 'loomfindprobe'` → EMPTY, rc 0, no stderr; `find /tmp/ …` → lists it;
  `find "$(realpath /tmp)" …` → lists it. Reproduced on BOTH the shell's `bfs` and `/usr/bin/find`:
  a symlinked start point written without its trailing slash (and without `-H`/`-L`) is read as a
  FILE, so the walk never descends — zero paths at a clean rc, byte-identical to a true negative.
  The class is `find`/`bfs`-SCOPED, and scoped by a control in the other direction: `ls -R`,
  `python3 os.walk` and `node fs.readdirSync(..., {recursive:true})` all DO descend that same bare
  symlink (measured), so "any equivalent walk goes silent" is FALSE.
- **What it cost, in the incident the re-anchoring came from:** a complete, verified 1,833-line
  implementation was declared LOST because a gate searched a symlinked `/tmp` start point and saw
  nothing; a duplicate agent was briefed onto the same track and ~40 minutes of agent time
  re-derived work that had sat on disk for over an hour. (The mechanism was measured here; the
  incident figures are the orchestrator's.)

The obligation is now the WALK class that actually goes silent — `find` / `bfs` on a bare symlinked
start point — not "any recursive enumeration"; the remedy (`realpath` the root, or a trailing slash)
and the firing control (prove the enumeration finds a file you KNOW is there before reading a zero as
absence) stay as GENERAL safe practice, because they are sound where the walk would have descended
too.
The other two obligations are unchanged. The distinction the clause must not lose, because
conflating the two directions is what made the original text wrong: a rejection at rc 1 is a
failure you can SEE; a symlinked start point is a success you CANNOT — only the second is ZERO
EVIDENCE under `evidence-first-claims.md` MUST-3.

Same change, three dependents: the paired skill gained the class (walk paragraph in § MUST-4, plus
`realpath` anchoring and a sweep-rc fail-closed in its runnable check), and the `MUST-4-firing`
probe candidate `clean-three-axis-liveness-then-standdown.txt` was corrected with its `.expected`
sidecar so the corpus stops teaching the superseded mechanism.

## Origin + extraction-record provenance

Removed verbatim from § Origin; the rule keeps the pointer to
§ "Origin depth — landing + classification":

> Landed via `/sync-from-build` Gate-1 classification of the `kailash-rs` proposal `ORCHESTRATION-QUOTA-PAUSE-AND-RESCUE-HYGIENE-2026-08-10`, **GLOBAL on both axes**; reasoning, genericization record and the measured Rule-10-path-(a) depth split: the extract § "Origin depth — landing + classification".

And the Rule-10/11 non-firing reasoning, now carried in the rule as a parenthetical:

> `rule-authoring.md` Rule 10 / Rule 11 do **NOT** fire — Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is `scope: path-scoped`, so this is STRUCTURAL CLEANUP, not Rule-10 paired extraction and therefore not Rule-11 input (`journal/0148`).

## Receipt-requirement de-duplication (MUST-6 + rule-wide Wiring)

Three Wiring blocks carried near-identical `Receipt requirement` bodies. All three keep the
canonical field label and a normative statement; the second and third now state it by reference.
The full prior texts:

> - **Receipt requirement:** SessionStart soft-gate `[ack: orchestration-launch-ledger]` IFF `posture.json::pending_verification` includes this rule_id (one ack covers MUST-1..6).
> - **Receipt requirement:** SessionStart soft-gate `[ack: orchestration-launch-ledger]` IFF `posture.json::pending_verification` includes this rule_id.
