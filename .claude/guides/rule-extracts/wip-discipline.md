# WIP Discipline — depth extract

Depth companion to `.claude/rules/wip-discipline.md`. The rule body carries the MUST clauses; this
file carries the derivation, the measured evidence, the BLOCKED corpora and the drain protocol.
Not baseline-emitted.

## The derived transition surface

Derived from the lane lifecycle, NOT enumerated from recollection — `adversarial-coverage.md`
MUST-1: a hand-listed roster of things that occurred to the author is not a surface. Each row is a
place a lane becomes waste. Counts are the origination baseline (`origin/main` = `fc216b96`,
2026-08-22T12:00Z).

| #   | Transition         | Leak                                          | Measured                       |
| --- | ------------------ | --------------------------------------------- | ------------------------------ |
| T1  | intent → OPEN      | branch opened with no issue/claim behind it   | not instrumented               |
| T2  | → OPEN             | opened while already at the WIP limit         | **no limit existed at all**    |
| T3  | WORK → PUSH        | commits never pushed; exist in one clone only | **18 branches**                |
| T4  | PUSH → PR          | pushed, no landing path opened                | majority of the 83             |
| T5  | PR → MERGE         | PR opened, never merged                       | 3 open, none stale             |
| T6  | MERGE → CLEANUP    | merged, branch/worktree left behind           | **16 noise + 210 merged refs** |
| T7  | any → ABANDON      | no KILLED state, so abandonment is invisible  | **class unrepresented**        |
| T8  | worktree → CLEANUP | worktree outlives its branch's terminal state | **53 trees, 34 over 24h**      |

## The four measured enforcement defects

A detector that misreads is worse than none: it consumes the attention a real signal needed and
certifies the state it failed to see. All four were MEASURED, not hypothesised.

- **E1 — detector scoped to the wrong subject.** `stranded-artifact-guard.js` sweeps `HEAD`, never
  the branch named in the destructive command. `git branch -D fix/s39-t1corr-gate2-correctness` —
  a branch carrying 11 unlanded governed artifacts — returned `{"continue":true}`, 18 bytes, fully
  silent. Fixed by MUST-5.
- **E2 — instrument misreads state.** `worktree-reap.mjs` counts a `--no-checkout` worktree's
  phantom staged deletions as real dirt: 6,917 "dirty paths" on a tree measuring 4.0K whose only
  entry is its `.git` file. A `--no-checkout` tree has NO index, so every path in `HEAD` reads as a
  staged deletion. Consequence: permanently un-reapable — KEEP even at `--min-age-hours 0` — so the
  unattended SessionEnd reaper can never clear it, and every crashed harness run leaves another.
  Fixed by MUST-6.
- **E3 — instrument measures the wrong quantity.** The same reaper derives age from directory
  mtime (reported 11.1h) rather than creation (reflog: ~44h). Any later touch resets rot to fresh.
  Fixed by MUST-3's age-from-creation clause.
- **E4 — report is noise, so its reader stops believing it.** loom#1885: _"63% of the standing
  total was noise. 12% held work worth landing."_ The surface was ignored FOR CAUSE. Fixed by
  MUST-3 (report only what is actionable: LOCAL-ONLY and aged, never raw reachability).

## Why age, not count — worked

53 lanes opened and closed inside a session is healthy flow. Six lanes at 477 hours is rot. A count
reports both identically, so a count-based surface cannot distinguish the system working from the
system failing — which is precisely how a reader learns to scroll past it.

Origination distribution: p50 32.6h · p90 285.0h · max 476.9h · 34 over 24h · 9 over one week.

## BLOCKED rationalizations — full corpora

**MUST-1 (two terminal states):** "it might be useful later" · "deleting it loses the work" (a
branch ref is not the work; a landed commit is) · "it's only a branch, it costs nothing" · "I'll
decide next session" · "it's already there, removing it is churn" · "salvage/ means someone will
salvage it" · "the reflog has it" · "it's evidence of what we tried" · "the worktree is cheap
disk".

**MUST-2 (WIP limit):** "they're all small" · "I'll land them together at the end" · "the limit is
for humans, agents are parallel" · "this one is urgent" · "I'm about to finish two of them" · "a
limit would refuse work I was told to do" · "the parallel-dispatch default tells me to fan out"
(it does — WITHIN capacity; `agents.md` § Triad fills the default posture, it never overrides a
gate).

**MUST-3 (age governs):** "53 is just a number, most are fine" · "the count went down, so it's
improving" · "mtime is close enough" · "sorting by size shows the same thing" · "the old ones are
obviously dead, no need to name them".

**MUST-4 (done means landed AND cleaned):** "the PR merged, that's done" · "cleanup is
housekeeping, not the work" · "the branch is harmless once merged" · "I'll reap them in a batch
later" (the batch is the 53) · "the agent reported success".

**MUST-5 (guard reads the target):** "HEAD is what the session is on" · "the target is usually
HEAD anyway" · "sweeping the target costs an extra git call".

**MUST-6 (empty vs dirty):** "porcelain says dirty, so it's dirty" · "failing closed is always
safe" · "6917 paths cannot be nothing" · "the reaper is conservative by design".

## The drain protocol — mechanism forces the decision, never makes it

18 local-only branches carry real work (12 unique commits in
`fix/1760-owned-surface-check-e-scope-2026-08-18` alone). Deleting them to reduce a number is how
`salvage/` branches were created in the first place.

1. **Content-diff pass** against the default branch for all candidates. `git cherry` compares
   PATCH-IDS: it detects rebases and cherry-picks but CANNOT see a squash-merge whose combined
   patch matches no single commit. Every unique-content figure is therefore an UPPER BOUND, and
   anything already landed under a different shape MUST be reclassified before any decision.
   **Skipping this step destroys landed work.**
2. **Classify** each survivor: LAND / KILL / genuinely-in-lane.
3. **Operator decides** the LAND-vs-KILL split. The mechanism executes; it does not adjudicate.
4. **Execute** through the shipped mechanism, so the drain is itself a test of it.
5. **Re-measure** and report the age distribution, never the count.

## Why this SHIPPED path-scoped, having been authored baseline

**SUPERSEDED — this section was titled "Why this is baseline and not path-scoped" and argued the
opposite of what shipped.** The rule's frontmatter is `priority: 10` + `scope: path-scoped`, in
every commit that ever touched it. What follows is the corrected record: the authoring argument, the
measurement that overturned it, and what the shipped classification costs.

**The authoring argument (why baseline was drafted).** The two moments that create WIP — opening a
lane, and declining to close one — touch NO artifact glob, so a path-scoped rule would not load at
either decision on rule text alone. Same reachability class that forced `issue-triage-routing.md` to
baseline. `artifact-stranding.md` reaches the opposite conclusion legitimately: it has a SHIPPED
hook firing inline at the destructive moment, carrying the instruction even when the rule text is
absent.

**What overturned it.** The baseline draft measured a `-1.55%` headroom-floor BLOCK on the codex and
gemini lanes (7567 B under floor). The operator RE-CLASSIFIED the rule to path-scoped on the
`artifact-stranding.md` precedent — and that precedent APPLIES here, which the authoring argument
had got wrong: this rule DOES have inline carriers. `.claude/hooks/wip-discipline-guard.js` is
registered at `PreToolUse:Bash` (MUST-2, the lane-OPEN moment — and, since 2026-09-06, MUST-3's
age door on the SAME arm) and at `SessionStart` (MUST-3's age-distribution REPORT), and
`.claude/hooks/stranded-artifact-guard.js` at `PreToolUse:Bash` carries MUST-5. This sentence said
`PreToolUse:Task|Agent` until 2026-09-06; that arm was REMOVED on 2026-08-29 (inventory, never
workers) and the claim had been stale since. The earlier sentence "this rule's MUST-2 has no such inline carrier at the moment a lane is
opened" was false against the shipped `settings.json`. The re-classification is operator-ratified
and disclosed at `.claude/rule-injection-budget.json::rules."wip-discipline.md"`, which charges the
`loom-bin-edit` and `workspace-note` profiles.

**What it costs, named rather than waved away.** MUST-1 (a lane reaches a terminal state) has no
inline carrier and no structural tier — a session that never touches `**/workspaces/**`,
`**/.session-notes*`, `.claude/hooks/**` or `.claude/bin/**` does not load this rule's text for it.
That clause is gate-review-only, permanently, and the Detection block records that as RETIRED rather
than deferred. MUST-4 is NOT in that position: hooks observe its remote refs, its local branches and
its worktrees, each only in part — map and gaps in § "Why MUST-1 gets no detector — and what
observes MUST-4". (CORRECTED 2026-09-12, twice: this paragraph first named MUST-4 whole as
detector-less, then its local half; both were wrong.)

**Consequence for `rule-authoring.md` Rule 10.** Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` ONLY, so it does not fire on the shipped rule. The extraction into this file still
happened and still stands as a sizing choice; it is NOT a Rule-10 path-(a) disposition and owes no
Rule-10 byte-recovery accounting.

## Cascade

Distribution needs no new work and was verified, not assumed: `.claude/hooks/**` and
`.claude/hooks/lib/**` are `sync-tier-aware.mjs::ALWAYS_INCLUDE` globs; `worktree-reap.mjs` is
enumerated in the same list; the rule is registered on the `coc-core` tier. **CORRECTED 2026-09-12:**
this read "which build and use both subscribe. The capability therefore reaches every consumer on the
next `/sync`." Measured, the rule reaches six of the seven lanes while the hooks reach all seven, and
whether an arm FIRES depends on each CLI's registrations — § "Consumer residual".

## Detection tiers

Depth for the rule's `**Detection mechanism:**` field. The per-clause split is the point: a
rule-wide "structurally enforced" claim would credit MUST-1, which no shipped instrument observes, and
would over-credit MUST-4, whose local-branch component the post-merge report never sees for a lane
landed by a direct `dev` merge — only the next `SessionStart`'s REPORT-ONLY reap candidates do —
MUST-6's failure mode committed by the rule's own Wiring. (This sentence named MUST-4 whole, then its
local half, as unobserved until 2026-09-12.)

### Pair → clause binding, read from the runner not from recollection

Derived by reading the `// PAIR n` headers in `.claude/audit-fixtures/wip-discipline/run.mjs`, then
confirming each pair's assertions name the clause they claim. Measured 2026-09-06: the runner
reports `243 pass, 0 fail`, matching `ci-audit-fixtures.json::wip-discipline.min_cases = 243`. (This
line read `54` from a 2026-08-22 measurement, which many later pairs had already overtaken — a
figure kept past its tree, which is why it is re-measured here rather than cited.) The table below
is the ORIGINAL nine pairs plus pair 21. Pairs 1b–1d, 10–20 and 22–28 were added later (there is no
pair 16, and two separate headers carry the number 18) — read them from the runner itself: a
`// PAIR n` TITLE line names its clause only for pairs 1, 1b, 2–6, 10 and 21; the comment blocks
under pairs 14 (MUST-2) and 24–26 (MUST-7) name one in their body; every other pair binds by its
assertions. The current binding sits below the table; it left the rule's Detection row 2026-09-12.

| Pair | Clause | What the RED pole establishes                                           |
| ---- | ------ | ----------------------------------------------------------------------- |
| 1    | MUST-2 | a sixth lane at the limit fires, advisory cites `wip-discipline/MUST-2` |
| 2    | MUST-2 | an UNKNOWN count is not a violation (no silent-clean zero)              |
| 3    | MUST-3 | aged lanes at SessionStart fire with an age DISTRIBUTION                |
| 4    | MUST-3 | an unmeasurable age is not evidence of youth                            |
| 21   | MUST-3 | the OPEN-time AGE DOOR: a past-bound lane REFUSES lane creation         |
| 5    | MUST-6 | EMPTY is not DIRTY                                                      |
| 6    | MUST-6 | UNKNOWN is KEEP, and CLEAN is not UNKNOWN                               |
| 7    | —      | wrong-event fall-through (`Agent` fires like `Task`; others silent)     |
| 8    | —      | the severity register as the agent receives it (neither arm blocks)     |
| 9    | —      | fail-open: every error path yields `{continue:true}`                    |

MUST-5 is NOT in this table because its detector is a different hook. It is covered by the
`stranded-artifacts` runner (`.claude/audit-fixtures/stranded-artifacts/run.mjs`), whose case set
includes the target-vs-`HEAD` distinction MUST-5 names.
Measured 2026-09-02: `stranded-artifacts` reports `117 pass, 0 fail`, matching its `min_cases: 117`.

**Current binding** (re-derived from the runner 2026-09-12; moved out of the rule's Detection row the
same day): MUST-2 ← pairs 1–1d, 2, 10–15, 17–19 and 23; MUST-3 ← 3–4 and 21; MUST-4 ← 22 and 28;
MUST-6 ← 5–6; MUST-7 ← 24–27; 7–9 and 20 bind no clause (20 hardens the write sink of the override
ledger MUST-7's debt reads); there is no pair 16; 15 is an adversarial-review regression set per
`coc-artifact-eval-coverage.md` MUST-2. This binding covers MUST-2..7 ONLY: it was not re-derived for
MUST-8 or MUST-9, whose surfaces were changing in parallel lanes on 2026-09-12 — re-derive it rather
than read their absence here as "no pair".

#### The remote-ref third door and its reaper (2026-09-05)

Moved from the rule body 2026-09-07 (loom budget-residual lane). **REPAIRED 2026-09-12**, and the
repair is NOT purely verbatim — stated so the heading above is not read as a guarantee. (1) The
2026-09-07 move kept this passage from its middle ("binds here too. Because"), dropping the opening
sentences; the opening below is restored verbatim from `7f8b4f9d^:.claude/rules/wip-discipline.md`.
(2) That source itself read "binds here too. Because" — a fragment introduced by `9b7265bf`, whose
parent read "…fails OPEN with no remote or base), because a pushed branch nobody PR'd…". The words
"The door exists because" below are an EDIT that restores that parent clause as a sentence; every
other word is verbatim. It is DATED 2026-09-05 wording — the door then keyed on ancestry
(`for-each-ref --merged`); the rule's MUST-4 now keys it on content (`git cherry`), which is the
current contract.

The same Bash arm carries a THIRD door for MUST-4 (2026-09-05): creation is refused while any
REMOTE ref whose tip is already an ancestor of the remote's DECLARED default branch remains
un-reaped (`wip-lanes.js::landedRemoteRefs`, one `for-each-ref --merged` spawn — content, never
age; base read from `refs/remotes/<remote>/HEAD` so the door and the reaper measure the same
thing; fails OPEN with no remote or base). It is consulted for lane-creating COMMANDS only, never
for an agent dispatch — MUST-2's "inventory, never workers" binds here too. The door exists because
a pushed branch nobody PR'd is reaped by no merge and the local forest was drained to 3
branches while 526 landed remote refs stood. The remediation it names is
`.claude/bin/remote-ref-reap.mjs`: report-only by default; `--apply` writes a LOCAL recovery ref
`refs/archive/remote/<stamp>/<branch>` — in THAT clone only, never pushed, and the remote keeps no
reflog — before deleting on the remote; it never touches an open PR's head, the remote's declared
default branch, or a `--protect` glob; it refuses when the PR list is unreadable; and it reaps the
patch-id heuristic class only under `--include-content-landed`, never the CONTENT-UNMEASURED class
(a merge commit carries no patch-id, so an empty `git cherry` measured nothing rather than
confirming everything landed). Suites: `.claude/test-harness/tests/wip-remote-landed-gate.test.mjs`
(bipolar) + `.claude/bin/remote-ref-reap.test.mjs`. Consumer note: neither suite ships to
use/base, build/base, use/py, build/py, use/rs or build/rs (MEASURED: `skip` on all six), so no
consumer receives them and at those targets the suites are not a live gate — what DOES reach every
lane is the guard's third door and the reaper itself, both on `ALWAYS_INCLUDE`.

(**REPAIRED 2026-09-12:** the 2026-09-07 move cut this passage off mid-sentence at "reach every"; the
tail above is restored from `7f8b4f9d^:.claude/rules/wip-discipline.md`, where it read in full.)

### Why MUST-1 gets no detector — and what observes MUST-4

The falsifying result was named before the sweep: had MUST-1, MUST-4 or MUST-5 carried a structural pair, a
`/usr/bin/grep -nE "wip-discipline[/ ]?MUST-[145]|MUST-4"` over the runner would have printed a hit,
exactly as the same matcher class printed hits under the runner's `// PAIR 1`, `// PAIR 3` and
`// PAIR 5` blocks (whose assertions cite `wip-discipline/MUST-2`, `wip-discipline/MUST-3` and the
MUST-6 empty-vs-dirty precondition respectively). It printed none for MUST-1, MUST-4 or MUST-5 when
this was written, so the absence then read as a measured true negative.

**CORRECTED 2026-09-12, twice — that grep answers the wrong question for MUST-4; do not cite it.** It
reads the fixture RUNNER, so it can say which test pairs assert a clause but never which shipped HOOKS
enforce it (`instrument-discipline.md` MUST-4). Re-run at `27011a42` it printed 4 hits (control
`wip-discipline[/ ]?MUST-2`: 7), two of them pair 28's assertion of `wip-discipline/MUST-4`
(`.claude/audit-fixtures/wip-discipline/run.mjs:3391-3392`). The instrument that answers "what observes
MUST-4" reads the REGISTRATIONS in `.claude/settings.json` and each registered hook's actual git and
`gh` calls — never which hooks CITE MUST-4. A citer grep is not that census, and it has a blind spot of
its own. Re-run on the reap-trunk merge (`41d0b11b7`), `git grep -nE 'wip-discipline(\.md)?[/ ]*MUST-4'
-- .claude/hooks` prints 4 hits — the two `wip-discipline/MUST-4` `why` strings in
`wip-discipline-guard.js` (the remote-landed door and its honoured-override advisory),
`reap-on-landing-guard.js:287` (the report's `why`) and `hooks/lib/lane-completion.js:263`
(`reportLines`) (control, the same pattern for MUST-2: 5 hits) — while a backtick-tolerant variant,
``wip-discipline(\.md)?`?[/ ]*MUST-4``, prints 9. **The pattern cannot match a BACKTICK-QUOTED
citation** (`` `wip-discipline.md` MUST-4 ``): the closing backtick sits between `.md` and the space.
The five it misses are comments — `reap-on-landing-guard.js:4` and `:44`, `hooks/lib/reap-on-landing.js:4`,
`hooks/lib/unlanded-work-surface.js:28` and `:401`. None adds an observer the table lacks, and that last
module's RENDERED report cites no MUST-4 at all, so a citer grep over agent-visible text misses that
observer entirely. In the other direction, one of the 4 hits is not an observer at all
(`lane-completion-guard.js`, below), and the worktree row cites a different rule. A citer count
therefore over- and under-states coverage at once; the table is built from registrations.

Line citations below were re-derived on `41d0b11b7` and go stale; the symbols do not.

| MUST-4 component                                       | Observer                                                                                                                                                                                                                                                           | Event and trigger                                                                                                                                                                                                                                                      | Severity                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| remote refs                                            | `wip-discipline-guard.js::runSpawnGuard`, the remote-landed door over `wip-lanes.js::landedRemoteRefs` — `git cherry` patch-ids against the trunk (§ "Where each surface resolves its base"), remote `origin` by default, refusing above `REMOTE_LANDED_FLOOR` (0) | `PreToolUse:Bash`, a lane-CREATING command only (`laneCreationIntent`; `remoteDoor: true` on the Bash arm alone)                                                                                                                                                       | `block`; `advisory` once an override is honoured                                                                             |
| local branches and remote refs, at the merge           | `reap-on-landing-guard.js` — the LOCAL half by `git cherry` against `trunk-ref.js::resolveTrunk` (`:180`, base `:188`); the REMOTE-only half through `landedRemoteRefs`; the report names each half's base (`reap-on-landing.js::basesSentence`)                   | `PostToolUse:Bash`, a LEXICAL trigger — `isLandingCommand` (`:104-108`): the merge subcommand at the start of a command segment, `--help`/`-h` excluded; no fetch, no kill switch                                                                                      | `halt-and-report` (report block `:250-297`)                                                                                  |
| local branches and the promotion gap, at session start | `session-start.js:178-179` → `hooks/lib/unlanded-work-surface.js::computeUnlandedState` — REPORT-ONLY reap candidates (`computeReapCandidates`) and the promotion gap (`computePromotion`, over `trunk-ref.js::promotionGap`)                                          | `SessionStart`, every session; local git only, zero network calls                                                                                                                                                                                                      | advisory, REPORT-ONLY (`session-start.js:175`); its rendered text cites no MUST-4                                            |
| worktrees                                              | `worktree-forest-guard.js` over `hooks/lib/worktree-forest.js` and `worktree-reap.mjs`                                                                                                                                                                             | `PreToolUse:Bash` on `worktree add`, reporting once reapable trees reach `COC_WORKTREE_REAPABLE_FLOOR` (`DEFAULT_REAPABLE_FLOOR` 4); `SessionEnd` reaps ZERO-LOSS trees idle ≥ 12 h (`:98`), TAG-FIRST excluded (`:100`), off under `COC_WORKTREE_AUTOREAP=0` (`:110`) | `halt-and-report` at `PreToolUse`, `advisory` at `SessionEnd` (`:252`) — under `worktree-isolation.md` Rule 8, not this rule |

**Not a MUST-4 observer: `lane-completion-guard.js`.** Registered at `Stop`, it reads FORGE state only
— open PRs and the operator's identity through `gh` (`readLanes`, `readOperator`) — and nudges the
operator to land a PR that is green and mergeable, citing MUST-4
(`hooks/lib/lane-completion.js::reportLines`, `:263`). Its conflict remedy (`:280-292`) names the PR's
OWN `baseRefName` first (fetched in `lane-completion-guard.js::readLanes`, `:142`), the strictly
resolved trunk only when the row carries none (`lane-completion-guard.js:214`), and otherwise no ref at
all. It reads no branch, worktree or remote ref. It is off under `COC_LANE_COMPLETION=0`, never reports
a PR listed in `COC_LANE_COMPLETION_HELD`, and is silent when `gh` is missing or unauthenticated
(fail-open); `halt-and-report` (`lane-completion-guard.js:239`). Earlier revisions listed it as
observing local branches; that was false. Local branches are otherwise seen at `SessionStart` by the
unlanded surface (table above) and, INDIRECTLY, by `wip-discipline-guard.js::runSessionStart`, which
names lanes past the 24 h bound under MUST-3.

Gaps follow from the map and are recorded rather than hidden. Every surface now measures against the
trunk; where each resolves its base, and how strictly: § "Where each surface resolves its base" below.

- **The post-merge trigger is LEXICAL.** A web-UI merge, a merge queue, `gh api …/merge`, or a direct
  merge-and-push to `dev` never trips `isLandingCommand`, and an auto-merge request trips it at queue
  time rather than at merge. So a lane landed by a direct `dev` merge, with no PR, exactly as MUST-4's
  trunk design prescribes, is invisible to the post-merge report: its local branch surfaces only at the
  NEXT `SessionStart`, as a REPORT-ONLY reap candidate, and is never proposed while a worktree holds it.
- **The remote-ref door fires only on lane CREATION.** `git worktree add <path> <existing-branch>`
  passes through before the door is consulted (an attach adds a worker, not inventory), `git push`
  never reaches it, and its one-shot override, `.claude/wip-authz/wip-limit-allow`, is a file the
  agent itself can write.
- **`origin` is hardcoded and nothing fetches.** `landedRemoteRefs` defaults its remote to `origin`,
  `reap-on-landing-guard.js` reads `refs/remotes/origin` and resolves the trunk on `origin`, and the
  SessionStart surface makes zero network calls; no observer fetches, so remote-tracking refs may be
  stale.
- **A crash or kill fires no `SessionEnd`,** so the unattended worktree reap does not run. No
  `SessionStart` hook reports leftover worktrees or remote refs as such — the unlanded surface names
  landed LOCAL branches only — and a forest below the reapable floor is never reported.
- **The remote half resolves its base LENIENTLY.** `landedRemoteRefs` uses `trunkRef`, not
  `resolveTrunk`, so an unresolvable `COC_TRUNK_REF` reaches it as a git failure rather than an
  `undetermined` verdict — still unmeasured, never main. `wip-lanes.js` also defaults `baseRef` through
  `trunkRef` at five further sites; those were not traced here.
- **Registrations, not files, decide whether an arm fires off CC** — § "Consumer residual" below.

MUST-5's detector is a different hook (`stranded-artifact-guard.js`).

Why MUST-1 stays detector-less, PERMANENTLY rather than pending: it asks whether a lane reached a
terminal state, which is only decidable once the lane is over — after a merge or a recorded kill — and
that is not a moment any tool call occupies. A detector would have to infer from an adjacent proxy —
branch age, worktree presence — and report a verdict about lifecycle it never saw. That is precisely
the instrument MUST-6 refuses. (An earlier revision argued the same for MUST-4, on the ground that a
hook "cannot observe a conjunction whose terms are separated by session boundaries". The map above
refutes that: each observer reads CURRENT git-object state at an event it CAN see — the post-merge
report at the merge command, the remote door at the NEXT lane creation, the worktree reap at session
end — so the argument now covers MUST-1 only. A prior wording said the hooks read that state "at the
moment each component comes due"; that was false for the remote door, which fires at creation rather
than when a ref becomes reapable, and false for `lane-completion-guard.js`, which reads forge state.) `hook-output-discipline.md` MUST-5(b) BLOCKS
booking teeth that cannot arrive, and `trust-posture.md` § "Every Phase-2 Deferral Carries A DATED
Declaration" BLOCKS an undated deferral — so no row is booked in `phase2-deferrals.json` and none
should be. Gate-review IS the enforcement layer here, permanently, which is the honest form
`hook-event-selection.md` sets and the disposition `instrument-discipline.md` and
`autonomous-execution.md` § Root-Cause Fix each took for their own unobservable clauses.

#### Where each surface resolves its base

Re-derived on `41d0b11b7`, the reap-trunk merge. The literal-`origin/main` gap an earlier revision
recorded above — the post-merge report measuring against `origin/main` rather than the trunk — is
CLOSED. Every surface now goes through `hooks/lib/trunk-ref.js` (`origin/dev` where it exists, else
`origin/main` with basis `main-fallback`, or a probed `COC_TRUNK_REF`), though not all through the
strict resolver:

- **Post-merge report, local half** — strict `resolveTrunk` (`reap-on-landing-guard.js:180`, base
  `:188`). An override that does not resolve leaves the local half NOT RUN and says so
  (`reap-on-landing.js::coverageLines`); it is never swapped for main.
- **Remote half — the post-merge report and the OPEN-time door alike** — `wip-lanes.js::landedRemoteRefs`
  (`:446-450`): lenient `trunkRef`, composed with `remoteDefaultBase` where it yields `<remote>/main`.
  An unresolvable override fails the ancestry read and returns `{ok:false}` (`:479`), rendered
  "REMOTE-only half NOT RUN" in the report and failing OPEN at the door.
- **SessionStart unlanded surface** — strict, via `unlanded-work-surface.js::resolveLandingBase`
  (`:415-434`), with the same `main-fallback` composition; an unresolvable override renders
  "Unlanded-Work Check: UNDETERMINED" (`formatUnlandedBlock`). Local `main` is re-measured against
  `origin/main`, its own landing target (`excludeLandedPromotionTarget`, `:482-489`).
- **Reap candidates** — `computeReapCandidates` (`:547-578`) fences the branch the trunk names and the
  protected floor (`reap-on-landing.js::NEVER_REAP`: `main`, `master`, `dev`, `HEAD`), so `dev` is
  never proposed; a landed branch checked out in a worktree is counted in `heldByWorktree`, never
  proposed. The post-merge report fences the same two classes (`reap-on-landing-guard.js:185-190`).
- **Promotion gap** — `computePromotion` (`:586-597`) over strict `trunk-ref.js::promotionGap`; an
  unanswerable count renders "unmeasured, not zero", and a `main-fallback` base renders nothing.
- **Lane-completion conflict remedy** — the PR's own base first, then the strict trunk (paragraph above).
- **Worktree reap** — `worktree-reap.mjs` (`:767-774`), strict; `main-fallback` defers to `origin/HEAD`,
  then `origin/main`; undetermined ⇒ null ⇒ never counted upstream, fail-closed for a tool that removes
  trees.

**The promotion counter MUST-4 requires is now OBSERVED.** The rule's "one honest cost" names two
required halves. The counter — commits on the trunk not yet on `main` — renders at every `SessionStart`
(`session-start.js:178` → `unlanded-work-surface.js::formatUnlandedBlock` → `::formatTrunkTail`, "Promotion gap"). The
STANDING-CADENCE half has no observer.

**The post-merge report's budget.** Registered at 5 s under `PostToolUse` `Bash` (`.claude/hooks/dispatch-registry.json:264-265`, behind `dispatch.js PostToolUse`).
`DECISION_BUDGET_MS` 4000: `LOCAL_BUDGET_MS` 1500 (`CHERRY_CALL_CAP_MS` 1000 per call), then
`REMOTE_BUDGET_MS` 2000, with `PRE_READ_TIMEOUT_MS` 1000 on each pre-read. `COC_REAP_BUDGET_MS` only
LOWERS the local share, and a malformed value is named (`reap-on-landing.js::resolveLocalBudget`). On
exhaustion it still reports, naming each unmeasured branch or ref UNKNOWN (`coverageLines`). Two limits,
stated: the fallback timer cannot preempt a git call already running (synchronous `execFileSync`), and
`landedRemoteRefs`' `for-each-ref` reads run under that module's own timeout, outside this budget.

**Knobs, across the surfaces:** `COC_TRUNK_REF`; `COC_REAP_BUDGET_MS` (lower-only);
`COC_UNLANDED_CONTENT_CHECK=0` (`classifyByContent`) and `COC_UNLANDED_RATCHET_CHECK=0`
(`computeCarrySpans`); `COC_LANE_COMPLETION=0` and `COC_LANE_COMPLETION_HELD`. The post-merge report
has NO kill switch — its only environment reads are `COC_REAP_BUDGET_MS` and `CLAUDE_PROJECT_DIR`.

#### Consumer residual

Measured 2026-09-12 by a read-only census through the distributor's own classifier
(`sync-tier-aware.mjs::buildLaneClassifier`) over the lanes `parseRepos` derives — use/base,
build/base, build/prism, use/py, build/py, use/rs, build/rs. The rule's Detection row carries the
compact form.

- **Files.** The rule, this extract and `.claude/audit-fixtures/wip-discipline/` reach the SIX
  use/build lanes (`copy/tier_match`) and skip build/prism (`skip/no_tier_match`). The hooks —
  `wip-discipline-guard.js`, `reap-on-landing-guard.js`, `hooks/lib/trunk-ref.js`,
  `dispatch-contract-guard.js`, `delegation-default-guard.js`, `todo-durable-guard.js` — reach all SEVEN
  (`copy/always_include`). **build/prism therefore receives the guard WITHOUT the rule**: tier-blind
  hook shipping, an OPEN distribution-policy residual named here and not resolved by this rule. The
  probe suite reaches NO lane (`skip/exclude` on all seven).
**Current Codex status (2026-09-28).** The dated census below describes the earlier
MCP-only path. The delivered native `PreToolUse` bridge now selects the expanded
registration inventory, including Bash policies and `spawn_agent` projected to
`Agent`. This establishes registration reach, not measured semantic parity for every
policy or activated trust in a consumer. Other event arms still need their own native
registration; the bridge does not imply SessionStart/Stop parity.

- **Codex.** The `PreToolUse:Bash` arm — MUST-2 count, MUST-3 age door, MUST-4 remote-landed door — is
  mirrored ONLY through the `codex-mcp-guard` fallback: `wip-discipline-guard.js` sits in
  `.claude/codex-mcp-guard/policies.json` under both `shell` and `unified_exec`, produced by
  `extract-policies.mjs`, and binds only on calls routed through that server's wrapped tools. The native
  `.claude/codex-templates/hooks.json` does not register it. The census classifies `policies.json`
  itself `skip` on every lane, so its route to a Codex consumer is the CLI-emit path, which this census
  did not measure.
- **Gemini.** No arm of this guard is registered (`.claude/gemini-templates/settings.json`).
- **CC-only.** This guard's `SessionStart` report, `reap-on-landing-guard.js`,
  `lane-completion-guard.js`, `dispatch-contract-guard.js` (`Task|Agent`), `delegation-default-guard.js`
  (`Stop`) and `todo-durable-guard.js`: none appears in `policies.json`, `codex-templates/hooks.json` or
  `gemini-templates/settings.json`. The SessionStart unlanded surface differs in kind: it rides
  `session-start.js`, which both CLI templates register natively — whether that render reaches either
  runtime was not measured.

The reason once given for the Codex gap — that its Bash-only surface lacked a `Task|Agent` counterpart —
is withdrawn wherever it stood. It came from an in-force-baseline row since rewritten, and that arm was
removed 2026-08-29.

### What probe registration buys

`.claude/test-harness/probes/wip-discipline.probes.json` carries bipolar pairs — `wip-limit-firing`,
`aged-lane-disposition-firing`, `census-surface-firing` (MUST-8), `MUST-9-firing` (MUST-9) and the
meta pair — every row a `candidate_fixture` (the shape the adapter reads); read the suite for counts. Registration buys DISPATCHABILITY and
nothing more. Measured against a fired control rather than asserted: `/usr/bin/grep -rnE
"coc-probe-dispatch|test-harness-probe|--artifacts" .github/workflows/` returns three hits and all
three are COMMENTS, never a `run:` step — and the control (`runs-on`) fired on the same tree, so
the matcher works here and the absence is a true negative. The loom↔csq boundary additionally keeps
CI LLM-free. **A green CI run is therefore NEVER evidence these probes passed.** What CI does gate
is REGISTRATION and hygiene: `detection-binding-check`, `coc-manifest-integrity` and
`probe-suite-integrity.test.mjs` (whose `PINNED_SUITES` includes this suite once `eval-manifest.json`
types it `rule`).

#### Registration inventory, verbatim from the rule body (moved 2026-09-07)

**Probes: REGISTERED** — `.claude/test-harness/probes/wip-discipline.probes.json`, 6 rows in 3
bipolar `pair_id` pairs (`wip-limit-firing`, `aged-lane-disposition-firing`,
`wip-discipline-meta` — efficacy + no-false-positive + meta-compliance), each row a
`candidate_fixture` under `.claude/audit-fixtures/wip-discipline/`. Registered in
`eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
`probe-suite-integrity.test.mjs::PINNED_SUITES`. **Registration buys DISPATCHABILITY, never
automatic execution:** no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary
keeps CI LLM-free, so **a green CI run is NEVER evidence these probes passed** — they run only on
a gate-review `/test-harness-probe --artifacts`. Case counts are MEASURED AT LANDING and go stale;
re-run the runners rather than citing them. **Consumer residual:** the probe suite reaches none of
the six use/build lanes, and the MUST-2 guard's registration does not reach Codex or Gemini — so on
those runtimes the limit does not bind at all. What does reach every consumer is the structural tier's
hooks.

(**REPAIRED 2026-09-12:** the 2026-09-07 move cut this passage off mid-sentence at "reaches none of";
the tail above is restored from `7f8b4f9d^:.claude/rules/wip-discipline.md`, where it read in full.
**CORRECTED 2026-09-12, so no longer verbatim:** a parenthetical reason for the Codex and Gemini gap —
a Bash-only surface lacking a `Task|Agent` counterpart — is deleted, stale since that arm's 2026-08-29
removal. The residual itself is superseded: Codex mirrors the Bash doors through the `codex-mcp-guard`
fallback, the probe suite reaches no lane at all, and the hooks reach build/prism too. Current
statement: § "Consumer residual".)

#### Moved from the rule body 2026-09-12 — `RULE_DELTA_OVER` burn-down

`check-rule-injection-budget.mjs` reported the rule 6164 B over its accepted 18223 B, past the 6000 B
per-rule allowance. The Detection-row passages below left the rule body VERBATIM, except the
probe-inventory entry, which is a pointer to text § "Registration inventory" above already carries
verbatim. Three further passages moved, verbatim, to the sections the rule's own pointers name: the
Severity-row history to § "Why MUST-3 took the teeth (2026-09-06)", MUST-7's `**Why:**` pointer tail to
§ "MUST-7 — depth", and MUST-8's enumerator paragraph to § "The census roster". Each clause reference
the moved text carried survives in the rule in compact form, so `check-descoping.mjs`'s per-class
inventory (MUST / MUST NOT / BLOCKED tokens, `**Why:**` lines, the eight Wiring fields) fell in NO
class — measured with that tool's own exported `extractInventory`, base `31c2059a` (the landing
commit's parent) against the landing commit `eaa11eae`, where every class was EQUAL, after that
instrument was shown to report a DROP on a copy with one MUST line and one `**Why:**` line removed.
The follow-up review-fix commit `931ed97c` then RAISED the MUST-token count 72 → 74 by adding clause
references to the rule's pair→clause binding, and `480913ed` to 75 with one more; no class has fallen
at any point.

From the Detection-mechanism row, the fixture counts (dated, stale by construction):
Fixtures: `.claude/audit-fixtures/wip-discipline/` (286 cases, MEASURED 2026-09-10) and
`.claude/audit-fixtures/stranded-artifacts/` (87), both `mode:"run"` in `ci-audit-fixtures.json`
(`min_cases` **286** and 117; re-measured 2026-09-10 — these go stale, so re-run the runner rather
than citing this line).

From the Detection-mechanism row, the pair→clause binding in full — DATED: it omits pairs 1b–1d,
17–20 and 22–28, which the rule's current binding lists, re-derived from the runner's pairs on
2026-09-12:
Pair→clause binding, measured from the runner's own `// PAIR n` headers: MUST-2 ← pairs 1–2, 10–13
and 14–15 (the teeth, the upper-vs-lower-bound pole, the one-shot receipt, the env channel and the
fail-open poles), MUST-3 ← 3–4 (the SessionStart report) **and 21 (the OPEN-time door — RED pole
built UNDER the count limit so it cannot be the count door firing)**, MUST-6 ← 5–6; pairs 7–9 bind
no clause. Pair 14 is the LANE-OPENING CAPABILITY predicate (the ceiling is consulted for dispatches
that can open a lane, not for every dispatch) and pair 15 is its adversarial-review regression set,
one named case per finding per `coc-artifact-eval-coverage.md` MUST-2. Counts are MEASURED AT
LANDING and go stale — re-run the runner rather than citing them.

From the Detection-mechanism row, the MUST-4 correction record:
**CORRECTED 2026-09-10:** this row previously named MUST-4 here and declared its detector
RETIRED-never-to-be-built. That was FALSE against shipped code — `wip-discipline-guard.js` emits
`rule_id: wip-discipline/MUST-4` and DENIES a lane-creating call over `landedRemoteRefs`, keyed on
`git cherry` patch-ids, a git-object fact that `hook-output-discipline.md` MUST-2 permits to carry
`block`. A rule declaring a shipped detector retired is the absence-reads-as-clean shape this corpus
governs, so it is corrected rather than left.

From the Detection-mechanism row, the probe inventory: the "6 rows in 3 bipolar `pair_id` pairs"
sentence, the duplicate "Case counts are MEASURED AT LANDING" reminder, and the Codex/Gemini
parenthetical — all three are carried verbatim by § "Registration inventory" directly above.

#### Moved from the rule body 2026-09-12 — MUST-9 funding

`check-rule-injection-budget.mjs` put the rule at +5099 B of its 6000 B per-rule allowance before
MUST-9, and MUST-9 plus its Wiring block would have taken it over. The passages below left the rule
body VERBATIM; the rule keeps a compact pointer or form of each. They are DATED — three claims in the
Detection row are corrected by § "Why MUST-1 gets no detector — and what observes MUST-4":
`lane-completion-guard.js` does NOT observe local branches (it reads forge state); "what does reach
every consumer is the structural tier's hooks" holds for the hook FILES, not their registrations; and
the post-merge report no longer measures a literal `origin/main` (§ "Where each surface resolves its
base").

From the Detection-mechanism row, the whole row as it stood:

- **Detection mechanism:** structural + review, and the split below is per-clause because a rule-wide claim would credit clauses no shipped instrument can see. **Structural.** `.claude/hooks/wip-discipline-guard.js` over `.claude/hooks/lib/wip-lanes.js` carries MUST-2, **MUST-3 and MUST-4** at `PreToolUse:Bash` ONLY — inventory, never workers (lane count vs the limit, and lane AGE vs the 24 h bound, both at OPEN — the Bash arm routes `git worktree add` / `switch -c` / `checkout -b` / `branch <name>` through the SAME verdict ladder via `wip-lanes.js::laneCreationIntent`, which consumes the shared `git-command-parse.js` rather than a private regex; the lexical match selects only WHICH question to ask, and the answer comes from measured git state, which is what permits `block` here under `hook-output-discipline.md` MUST-2). **MUST-3 is no longer `SessionStart`-only** (2026-09-06): its DOOR is `confirmAgedLane`, run BEFORE the count's under-limit early return; its REPORT stays `halt-and-report`. No `Task|Agent` arm — it charges no WORKER. MUST-5 is a DIFFERENT detector — `.claude/hooks/stranded-artifact-guard.js` over `.claude/hooks/lib/stranded-artifacts.js`, `PreToolUse:Bash` destructive arm, which assesses the COMMAND'S TARGET rather than `HEAD`. Fixtures: `.claude/audit-fixtures/wip-discipline/` and `.claude/audit-fixtures/stranded-artifacts/`, both `mode:"run"` in `ci-audit-fixtures.json` — counts go stale, so re-run the runners rather than citing a figure. Pair→clause binding, from the runner — a `// PAIR n` header names its clause only for pairs 1, 1b, 2–6, 10 and 21, and every other pair is bound by its assertions (re-derive it rather than cite it): MUST-2 ← pairs 1–1d, 2, 10–15, 17–19 and 23; MUST-3 ← 3–4 and 21; MUST-4 ← 22 and 28; MUST-6 ← 5–6; MUST-7 ← 24–27; 7–9 and 20 bind no clause (20 hardens the write sink of the override ledger MUST-7's debt reads); there is no pair 16; 15 is an adversarial-review regression set per `coc-artifact-eval-coverage.md` MUST-2. Per-pair detail: extract § Detection tiers. **Gate-review ONLY, permanently — MUST-1.** It has no structural tier and will not get one: whether a lane reached a terminal state — a merge or a recorded kill — is a lane-LIFECYCLE judgment made across sessions, with no tool-call-time signal, so a detector could only guess from an adjacent proxy and would report a verdict it cannot see, which is MUST-6's own failure mode. Recorded as RETIRED, not deferred, and NO row is booked in `phase2-deferrals.json`: `hook-output-discipline.md` MUST-5(b) BLOCKS booking teeth that cannot arrive, and `trust-posture.md` § "Every Phase-2 Deferral Carries A DATED Declaration" BLOCKS an undated one — so the honest form is to name gate-review as the permanent enforcement layer. **MUST-4 is observed PER COMPONENT, each in part** (CORRECTED 2026-09-12 — earlier revisions called MUST-4, then its local half, detector-less, reading the fixture runner, which shows what test pairs assert and never what hooks enforce): remote refs — the remote-landed door refuses a Bash lane-creation call while landed remote refs exceed its floor (`wip-discipline-guard.js:827-866`, `block` on `git cherry` patch-ids, which `hook-output-discipline.md` MUST-2 permits), and `reap-on-landing-guard.js` reports them after `gh pr merge` (`:110-138`, `halt-and-report`); local branches — that post-merge report, plus `lane-completion-guard.js` at `Stop` for a PR lane still open and mergeable (`hooks/lib/lane-completion.js:257`); worktrees — `worktree-forest-guard.js`, under `worktree-isolation.md` Rule 8. So a lane landed by a direct `dev` merge has its local branch observed by no hook citing MUST-4, and the post-merge report measures a literal `origin/main` (`reap-on-landing-guard.js:110`), not MUST-4's trunk resolver. Reviewer at `/implement` + cc-architect at `/codify` confirm each closed lane shows a merge or a recorded kill, and that its branch AND worktree are both gone. **Probes: REGISTERED** — `.claude/test-harness/probes/wip-discipline.probes.json`, a probe-only `eval-manifest.json` entry (`scanner: null`) pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. **Registration buys DISPATCHABILITY, never automatic execution:** no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so **a green CI run is NEVER evidence these probes passed** — they run only on a gate-review `/test-harness-probe --artifacts`. **Consumer residual:** the probe suite reaches none of the six use/build lanes, and the MUST-2 guard's registration does not reach Codex or Gemini — so on those runtimes the limit does not bind at all. What does reach every consumer is the structural tier's hooks. Derivation, the pair-by-pair map, the measured skip lanes, the MUST-1 no-signal argument and the MUST-4 per-component hook map: extract § Detection tiers.

From the Severity row:
**MUST-2 AND MUST-3 TAKE IT; MUST-5 does not.** The prior refusal ("whether a lane should open or land is the operator's judgment") is **WITHDRAWN for MUST-2 and MUST-3, RETAINED for MUST-5**: it conflated should-a-lane-LAND (no pending action to refuse) with may-one-more-OPEN against a measured bound, and was refuted in practice.

**Changed 2026-09-06, stated not silently edited:** this row read `halt-and-report` for MUST-3 until the age door landed; `block` rests on MUST-2's exact ground — extract § "Why MUST-3 took the teeth (2026-09-06)".

From MUST-2's body and `**Why:**`:
The removed `Task|Agent` arm, why its agent-spawn-as-proxy was measurably wrong, and the subagent-propagation residual: extract § MUST-2.
It stops it by REFUSING, which it did not do until 2026-08-23: the surface shipped with zero deny paths and only NOTIFIED.

From MUST-4's body:
The remote ref is the half nothing else reaps: `gh pr merge --delete-branch` reaps only a branch that HAD a PR, `git branch -d` reaps only the local ref, and a CI doctrine that makes a wave affordable — a pushed branch with no open PR fires zero CI and is free — manufactures exactly the refs no merge will ever clear.
Ancestry-vs-content measured on this forest, the `isProtectedName` demotion, and the near-miss cases: the extract § "MUST-4 — the ancestry measurement and the protected-ref partition".
Why the trunk had to move at all, with the measured zero-CI and 61-stale-ref figures: the extract § "MUST-4 — why the trunk moved".

From MUST-7's `**Why:**`:
Evidence, the override-as-debt mechanism, and why (c) is review-layer: extract § MUST-7.

From MUST-8:
Roster, with the enumerator for each and why a branch-only sweep misses it: [the roster, unchanged] Per-class enumerators and misses: the extract § "The census roster".
Mechanism, verdicts, policy file and the loom-only dashboard that renders it: the extract § "The census roster".

#### Moved from the rule body 2026-09-12 — length-rationale funding

`rule-authoring.md` MUST NOT § "Rules longer than 200 lines" asks this rule for a named length
rationale at Origin. Before that paragraph was added, `check-rule-injection-budget.mjs` measured the
rule at 23976 B, `+5753 B within allowance` over the accepted 18223 B, on the tree at `c50347abb`.
The passages below left the rule body VERBATIM to pay for it; the rule keeps a compact pointer or
form of each. The resulting measurement is § "Byte ledger — how MUST-9 was funded".

From MUST-2's body (reasoning: § "MUST-2 — the ceiling counts INVENTORY, never WORKERS"; mechanics:
§ "Why MUST-2 takes the teeth"):
Charging workers to an inventory ceiling throttles the delegate-first posture `agents.md` § Triad mandates, making the correct move cost the same as the costly one.
The refusal reads a content-confirmed LOWER bound, never the ancestry upper bound, and fails OPEN on an underivable count — so a rebased branch never costs you a lane.

From MUST-4's body (§ "MUST-4 — why the trunk moved"):
`dev` optimises THROUGHPUT and serves the dev server; `main` optimises QUALITY and serves production.

From MUST-8 (§ "The census enumerator — mechanism"):
**The enumerator EXISTS** — `hooks/lib/wip-lanes.js::refCensus`, surfaced by `laneSurvey({census:true})`, both of which every consumer receives; read the census from `refCensus` directly.

From MUST-9's `**Why:**` (2026-09-12, funding the length rationale): the clause's throughput argument
ends "…while work queues behind it"; the provenance tail it used to carry belongs here — the failure
was **observed in the session that received this clause's directive, with MUST-2 loaded**, which is
why the clause is a directive rather than a projection.

Rewritten, not moved: MUST-9 opened "The worktree + branch is the unit the ceiling counts; MUST-2
charges it no WORKER." That restated the ceiling in a narrower unit than MUST-2 defines and the
owner's standing block states (`commands/pickup.md` Step 0: WIP ceilings bind worktrees and
branches, not agents). It now cites MUST-2, which carries the ceiling's one definition; `/todos`
Step 3c and `skills/lane-planning/SKILL.md` § 2 cite it the same way.

### The type-flip ordering, tested rather than assumed

`probe-suite-integrity.test.mjs::"every probed rule's Detection block cites its own probe file"`
scopes itself with `if (spec.type !== "rule") continue;`, so a suite typed `hook` is skipped.
Flipping `eval-manifest.json::wip-discipline` to `type:"rule"` BEFORE this Detection block was
filled was measured to RED that exact test — the experiment was run on this tree and reverted — for
a reason unrelated to coverage. Filling the block is what makes the flip safe, which is why the two
edits ship in ONE commit.

## Consolidation record — what this capability REPLACES

The operator's directive included removing what contradicts, duplicates or is obsoleted by this
capability. Audited at origination:

- **`worktree-reap.mjs` (946 lines, verdicts ZERO-LOSS/TAG-FIRST/KEEP) and `worktree-triage.mjs`
  (1028 lines, verdicts SALVAGE/PUSHED/UNPUSHED/LOST)** answer ONE question — "is this tree safe
  to remove?" — in two vocabularies. Two answers to one question is how an operator learns to
  trust neither. CONSOLIDATION TARGET.
  **RESOLVED 2026-08-22 — vocabulary consolidated, capability preserved.** The defect was
  concrete and structural, not stylistic: BOTH tools emitted their words into a field literally
  named `verdict`. `worktree-triage.mjs` now emits the SHARED word there (`ZERO-LOSS` / `KEEP`,
  the spelling `worktree-reap.mjs` and `hooks/lib/wip-lanes.js::classifyTree` already use),
  derived at ONE seam (`withSharedVerdict`) from a DEMOTED `recoverability` field carrying the
  four recovery classes unchanged. Fail-closed mapping: SALVAGE + UNPUSHED ⇒ `KEEP`;
  PUSHED + LOST ⇒ `ZERO-LOSS`; `TAG-FIRST` is not minted by a tool that removes nothing.
  NOTHING was traded for the reduction — `--capture <dir>`, the submodule-incompleteness
  reporting (`capture_complete: false`, the `INCOMPLETE` manifest section, exit 2), the pinned
  `--untracked-files=all --ignore-submodules=none` status invocation, the ABSENT-vs-UNREADABLE
  distinction, and exit codes 0/1/2/3 are all unchanged, so Rule 4a obligation (2) is served
  exactly as before. Five new fixture checks pin the mapping (88 pass / 0 fail, up from 83).
  **STILL OPEN — the BINARY merge.** Folding `--capture` into `worktree-reap.mjs` and deleting
  `worktree-triage.mjs` outright was considered and DEFERRED with reasons, not forgotten:
  (a) `worktree-triage.mjs` is on `sync-tier-aware.mjs::ALWAYS_INCLUDE` and ships to five
  audiences, so deleting it is a public-surface removal owing a deprecation cycle under
  `zero-tolerance.md` Rule 6a — which cannot complete inside one session by construction; and
  (b) the port is ~490 lines of load-bearing logic plus an exit-code contract reconciliation
  (the reaper returns 0/1 and is invoked unattended at SessionEnd with
  `--apply --zero-loss-only`; triage returns 0/1/2/3) plus retargeting a 1224-line fixture runner —
  past the `autonomous-execution.md` § Per-Session Capacity Budget Rule 1 thresholds on both
  the LOC and the simultaneous-invariant axis. Half-migrating was BLOCKED, so it was not begun.
- **`worktree-lifecycle.mjs` (792 lines)** ships `open`/`retire`/`gate`/`invariant` with NO
  caller — and is cited in `artifact-stranding.md` itself as that rule's canonical example of a
  mechanism with no producer. OBSOLETE.
  **RESOLVED 2026-08-22 — DELETED.** Re-measured with a control that fires (74 files carry the
  sibling token `worktree-reap`; the mechanism's own bin path had exactly ONE reference and it was
  the tool's own `--help` text). Removed: the tool (792), its pure core under bin/lib (755) and its
  test file (715), plus the `ci-suites-bin.json` row and the `git-env-regrowth-guard-1471`
  un-helpered-git-site pin (54 sites/27 files → 52/26). It is NOT on `ALWAYS_INCLUDE`, so no
  consumer received it and Rule 6a does not bite. The `artifact-stranding.md` MUST-3 and extract
  citations were rewritten to read as HISTORY with a resolvable SHA
  (`git show d0c3d64d:.claude/bin/worktree-lifecycle.mjs`) rather than a live path.
- **`orphan-forest-guard.js` vs `worktree-forest-guard.js`** are NOT redundant despite the similar
  names: the first governs orphaned CPU-burning harness shells, the second worktree teardown.
  Verified by reading both, not inferred from the names. KEEP BOTH. **Re-confirmed 2026-08-22;
  no change made to either.**

## Origin — acceptance-first sequencing (2026-08-22)

2026-08-22, co-owner-directed. The operator's framing was Lean/Kanban and it was correct: WIP is
inventory, inventory is waste, and a lane's value is realised only at landing. The prior framing —
mine — treated this as a detection problem and proposed three better detectors. That is a better
warehouse inventory system for a problem whose fix is to stop stockpiling.

The acceptance criteria were written and operator-ratified BEFORE implementation
((loom-internal reference)), with the
three thresholds (WIP limit 5, age bound 24h, halt-and-report at spawn) selected by the operator
from stated trade-offs. **The third of those was SUPERSEDED 2026-08-23**: the spawn arm now carries
`block`, because the ratified `halt-and-report` was measured failing at exactly the moment it
existed for — an orchestrator acknowledged the notice on every one of six-plus dispatches past the
limit and proceeded, taking the forest 109 → 112 while the guard was firing. The threshold's
AUTHORSHIP is unchanged and still the operator's; what changed is the enforcement register, and it
changed against measured evidence that the softer register does not bind. The operator's judgment
is preserved as an explicit act rather than an ignorable banner by the one-shot override receipt
`.claude/wip-authz/wip-limit-allow` and the `COC_ALLOW_WIP_OVERRUN=1` env channel, mirroring
`worktree-isolation.md` Rule 7. The block is taken on a CONTENT-CONFIRMED lower bound
(`wip-lanes.js::confirmAtLimit`), never on the ancestry upper bound, so a rebased branch reading
open can never manufacture a refusal. `completion-criterion.md` MUST-1 requires exactly that: the party who will
SATISFY a list must not AUTHOR its thresholds. The sequencing is the fix for this area's recurring
failure — E1 through E4 were every one of them found AFTER shipping, because each was verified
against what had been built rather than against a list written first.

## Why MUST-2 takes the teeth (2026-08-23)

The rule shipped 2026-08-22 with `halt-and-report` on all three hook surfaces and this reasoning:
all three are structural so `hook-output-discipline.md` MUST-2 would PERMIT `block`, but it "is
refused because whether a lane should open or land is the operator's judgment, and blocking would be
that rule's own MUST NOT". **That is WITHDRAWN for MUST-2 (2026-08-23) and for MUST-3's OPEN-time
door (2026-09-06); it is RETAINED for MUST-5 and for MUST-3's SessionStart REPORT.** The line read
"WITHDRAWN for MUST-2 and RETAINED for MUST-3/5" until 2026-09-06 and is corrected here rather than
left, because the age door falsified its MUST-3 half the moment it landed.

**What it conflated.** Two different questions wear the same words. Whether a lane should LAND is a
judgment about standing inventory, and at `SessionStart` there is no pending action to refuse — so
advisory is correct there and stays. Whether ONE MORE may OPEN past a measured limit is a different
question, asked at a moment when there IS a pending action, and it has a defensible answer.

**How it was refuted — measured, not argued.** Within twenty-four hours of landing, the advisory was
observed failing at exactly the moment it existed for. The most rule-aware actor in the system — an
orchestrator with the rule loaded — acknowledged the `halt-and-report` on every one of six-plus
consecutive dispatches past the limit and proceeded each time. The open-lane count moved **109 → 112
while the guard was firing**. Against origination evidence of 53 worktrees and 306 branches
accumulated with no limit at all, the advisory register has now been measured failing twice: once by
absence, once by presence-and-override.

**Why the MUST NOT is answered rather than dismissed.** `hook-output-discipline.md` MUST NOT forbids
"detectors that block work the agent has been instructed to perform". The override receipt is what
resolves it: `.claude/wip-authz/wip-limit-allow` carries a one-line reason, is CONSUMED as it is
honoured (so one override cannot disarm the gate for later calls), and echoes the reason back as an
`advisory`; `COC_ALLOW_WIP_OVERRUN=1` serves operators and CI for a whole run. The operator's
judgment is not removed — it is converted from a silently-ignored banner into an explicit recorded
act. Same two-channel shape `worktree-isolation.md` Rule 7 specifies for the nested-worktree guard.

**Why the refusal reads a LOWER bound.** `laneCountFast` is ancestry-unmerged and therefore an UPPER
bound — a rebased or squash-landed branch reads open when its content has landed. That is right for
a REPORT and wrong for a REFUSAL: no operator should lose a dispatch to a branch that is already in.
`wip-lanes.js::confirmAtLimit` therefore counts only lanes whose unlanded content `git cherry`
MEASURED, and early-exits at the limit, so the common case costs `WIP_LIMIT` git calls whether the
forest holds 6 branches or 600. `confirmed >= limit` implies the true count does, unconditionally;
the converse is never claimed. Upper bound at the limit with content unconfirmed ⇒ the report fires
and the teeth do not. Every unknown — unresolvable base ref, unreadable repo, exhausted budget —
fails OPEN.

**Residual, stated rather than implied.** Adding teeth did not change where the guard is registered.
**CORRECTED 2026-09-12:** this read that the registration reaches neither Codex nor Gemini "and Codex's
Bash-only tool surface" lacks a `Task|Agent` counterpart. The reason was stale — the `Task|Agent` arm
was removed 2026-08-29 — and the Codex half is wrong as measured: `in-force-baseline.json` now records
the `PreToolUse:Bash` doors mirrored on Codex through the `codex-mcp-guard` fallback, binding only on
calls routed through that server's wrapped tools. On Gemini the limit still does not bind. Current
statement: § "Consumer residual".

## Why MUST-3 took the teeth (2026-09-06)

Depth for the rule's `**Severity:**` and `**Detection mechanism:**` rows, which were corrected in
place on this date. Until 2026-09-06 the Severity row read "`halt-and-report` for MUST-3" and the
Detection row described MUST-3's structural tier as `SessionStart` ONLY. Both were TRUE when written
and became FALSE the moment the age door landed at `PreToolUse:Bash`.

Moved verbatim from the rule's Severity row 2026-09-12 (`RULE_DELTA_OVER` burn-down; see § "Detection
tiers"), where it stood until then:
**THIS ROW CHANGED 2026-09-06, stated not silently edited:** it read `halt-and-report` for MUST-3 and
Detection said `SessionStart` ONLY — true when written, FALSE once the door landed. `block` is
permitted on MUST-2's exact ground: `confirmAgedLane` fires only on `git cherry`-MEASURED unlanded
commits whose OLDEST carries a readable COMMITTER DATE, a git-object fact. Depth: extract § "Why
MUST-3 took the teeth (2026-09-06)".

### The measured trigger — the third instance of the same finding

MEASURED by grepping the guard for `severity: "block"`: `wip-discipline-guard.js` carried TWO
refusals on the `PreToolUse:Bash` arm and neither was the age axis — the COUNT ceiling (MUST-2) and
the override-DEBT refusal (MUST-7). Sibling guards sit on the SAME arm — `worktree-forest-guard.js`
(MEASURED: zero `block` sites, it REPORTS a reapable worktree backlog) and
`stranded-artifact-guard.js` (MUST-5). AGE, the axis this rule's own MUST-3 title says GOVERNS, had
a report at `SessionStart` and no door anywhere. The age door is the THIRD refusal inside this guard, which is why its mutation had
to be read as a DOUBLE mutation — see § "The double mutation" below.

MEASURED: `chore/handbook-authz-receipt` was named in that SessionStart report at every session
start for three days and dispositioned at none. The rule had already recorded the same finding twice
— once for the origination surface (53 worktrees / 306 branches behind a report that refused
nothing) and once for the count door (an orchestrator acknowledged the notice every time while the
forest went 109 → 112). "A ceiling that reports is not a ceiling" held for a third time, on the axis
the rule says is the governing one.

### Why `block` is permitted, on MUST-2's exact ground

`hook-output-discipline.md` MUST-2 reserves `block` for a structural fact a regex cannot misread and
forbids it on a lexical signal. The age door satisfies that in the same two-part shape the count
door does:

- the LEXICAL half selects only WHICH QUESTION to ask — `wip-lanes.js::laneCreationIntent` over the
  shared `git-command-parse.js`, so `echo "git switch -c foo"` opens nothing and trips nothing;
- the ANSWER is git-object facts — `git cherry` patch-ids (WHICH commits are genuinely unlanded) and
  the COMMITTER DATE on the oldest of them (HOW OLD that work is). No prose is read, no shell string
  expanded, and no paraphrase of a lane-opening command evades either.

### The basis is the OLDEST UNLANDED COMMIT — and the refuted alternative

MUST-3 requires age from CREATION and names the failure it exists to prevent: the reaper read a tree
as 11.1 h from `stat().mtime` whose reflog showed 44 h. mtime can ONLY make rot look fresh.

The first draft of `confirmAgedLane` used the TIP committer date as a free PREFILTER, on the
argument that "the tip is the newest commit, so a lane whose tip is inside the bound holds no
unlanded commit outside it". **The inequality runs the other way**, and the draft was refuted by
firing it at a known-answer case before it was trusted (`instrument-discipline.md` MUST-3(a)).
MEASURED on the loom tree, 2026-09-06: `chore/handbook-authz-receipt` had a TIP age of **0.025 h**
and an oldest-unlanded-commit age of **73.19 h** — the very lane the door exists to refuse on,
silently excluded by its own prefilter. `tipAge` is a LOWER bound on the content age, so
`tipAge > bound` PROVES a blocker while `tipAge <= bound` proves nothing. The tip date is therefore
kept ONLY to order the scan (proven blockers first) and every lane is measured.

The cost of dropping the prefilter is named rather than hidden: each candidate costs two git spawns,
so a forest large enough to exhaust the 1500 ms budget returns `decided:false` and the age door does
not fire. That blind spot is bounded to exactly the population the COUNT door already refuses.

### One override channel, and fail-open on every unknown

The age refusal routes through the EXISTING one-shot receipt (`.claude/wip-authz/wip-limit-allow`,
consumed as it is honoured) and the EXISTING `COC_ALLOW_WIP_OVERRUN=1` env channel. No second
channel was minted: two ways out of one ceiling split the audit trail, and the receipt is already
the thing that answers `hook-output-discipline.md`'s MUST NOT about blocking instructed work.

It FAILS OPEN on an unanswerable `git cherry`, on unlanded content whose committer date will not
read, on an exhausted scan budget, and on the whole lane model being underivable (no `origin/main`).
Each of those lowers the chance of a refusal, which is the only direction that cannot refuse work
the operator is entitled to start — the asymmetry `confirmAtLimit` is already built on. A lane whose
content has LANDED (cherry-picked away) never ages into a block however old its tip.

### INVENTORY, never WORKERS

No `PreToolUse:Task|Agent` arm was reintroduced. The arm removed on 2026-08-29 stays removed: an
agent dispatch creates no branch, no worktree and no unlanded commit, so charging it would throttle
the delegate-first posture `agents.md` § Triad mandates. The fixture pins this at the REGISTRATION
level (`settings.json` carries no `Task|Agent` matcher for this guard) rather than only in code,
because registration is what the harness reads.

### Pair 21 — the poles, and what each one separates

| Pole                                    | What it establishes                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| past-bound lane, count UNDER the limit  | the door fires on AGE alone — a RED pole at the limit would be indistinguishable from the count door |
| lanes inside the bound                  | silence; the door does not refuse healthy flow                                                       |
| fresh TIP over old CONTENT              | the tip-prefilter regression, hermetic                                                               |
| mtime touch on the working tree         | the verdict does not move — a re-implementation on mtime reds here                                   |
| landed (cherry-picked) content, old tip | fail-open: zero unlanded commits never ages into a block                                             |
| unanswerable ref / exhausted budget     | fail-open on both instrument channels                                                                |
| null TIP date on a genuinely aged lane  | an unreadable tip date sorts a lane last, never DROPS it                                             |
| receipt + env channels, and `VAR=0`     | the shared override reaches this door, one-shot, literal-"1"                                         |
| read-only vs Bash-holding dispatch      | inventory, never workers — with a control that the predicate still discriminates                     |

### The double mutation, because three doors share one arm

An empty red-set on this arm would be an INERT mutation, not a vacuous case: a sibling door can
absorb the mutation and keep the fixture green. Measured 2026-09-06 (`instrument-discipline.md`
MUST-5(b)), each mutation proven to REACH the code by a stderr marker read off the guard's own
output before any result was read:

| Mutation                         | Red set                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| age door disabled                | 16 cases, ALL pair-21                                               |
| age door AND count door disabled | 54 cases — the same 16 plus 38 count-door cases, no NEW pair-21 row |
| count door disabled, age door on | 38 cases, ZERO pair-21                                              |
| tip prefilter re-introduced      | 2 cases — exactly the two that pin the refutation                   |

The second row is the finding: dropping the count door surfaced no ADDITIONAL age case, so the count
door was absorbing nothing. The third row completes the attribution in the other direction.

## MUST-7 — depth

Moved verbatim from the tail of the rule's MUST-7 `**Why:**` line 2026-09-12 (`RULE_DELTA_OVER`
burn-down; see § "Detection tiers"). The rule now points here with "Evidence, the override-as-debt
mechanism, and why (c) is review-layer":
Measured asymmetry (19 rules say "immediately", 0 said close-before-open), the four-override
reproduction, the override-as-debt mechanism, and why (c) is review-layer — the SIGNAL is semantic,
NOT because `Stop` cannot act (it can: `instruct-and-wait.js` § STOP HAND-BACK REFUSAL, opt-in):
extract § MUST-7.

### The measured corpus asymmetry

Across `.claude/rules/`: **19** files carry an "immediately" obligation, **13** carry "deferring is BLOCKED", **12** carry "same session" — and **ZERO** carried a close-before-open obligation. The corpus supplies ~19 forces pushing START and none pushing FINISH, so an agent obeying every rule faithfully increases WIP monotonically. That is an incentive gradient, not a judgment failure.

### The reproduction

Against the most rule-aware actor available: **four overrides in one session while the forest went 19 → 21.** Three structural facts drove it — MUST-2 bounds COUNT never PRECEDENCE; the rule is path-scoped to globs a lane-open decision never touches (`workspaces/**`, `.session-notes*`, `.claude/hooks/**`, `.claude/bin/**`), so it does not load where the decision is made; and the override had no cost function, being one line, always available, never accumulating. At the moment of maximum motivation to proceed, the COMPLIANT path (land a lane — unbounded, needs a CI cycle) was strictly MORE EXPENSIVE than the BYPASS. A guard whose bypass is cheaper than its remediation is a suggestion.

### The override becomes a debt

Each honoured override records the lane named as landing FIRST (`land-first: <ref>` in the receipt body); the NEXT override is REFUSED while that lane is still open. The escape is not more prose — it is landing the lane already promised, which is the same act that removes the need to override. The first override in a session is unchanged in cost; the price appears on the second, where the pattern starts. FAILS OPEN: an absent, unreadable or malformed ledger honours the receipt exactly as before — this prices a bypass, it must never become a second way to lose one.

### Why (c) is review-layer — the word PERMANENTLY withdrawn 2026-08-31

(a) and (b) are enforceable at `PreToolUse` — the opening door, which already carries `block`. (c) is NOT, and no future detector will make it so: `Stop` cannot block at any SEVERITY (MEASURED — the STOP_LIKE branch of `instruct-and-wait.js` returns `{continue:true}` / exit 0 even for `block`). CORRECTED 2026-08-31: that measurement is right and the INFERENCE drawn from it was wrong. Severity is not the only lever — the SAME branch returns `{decision:"block", reason}` when passed a REFUSAL (`instruct-and-wait.js:436-445`, § STOP HAND-BACK REFUSAL, opt-in, default OFF), and `lane-completion-guard.js` uses it in production. So an end-of-turn detector CAN prevent the miss, by refusing the hand-back rather than by raising a severity. Per `hook-event-selection.md`, booking enforcement at an event that cannot act on its subject is BLOCKED. (c) is therefore declared review-layer + rule-layer, not deferred to a Phase 2 that cannot arrive — but the word PERMANENTLY is withdrawn along with the inference above. A `Stop` detector for (c) is now known to be POSSIBLE (via refusal); it is not built because the judgment (c) rests on is semantic, which is a claim about the SIGNAL, not about the event's power to act. If a structural signal for (c) is ever identified, the event will not be what blocks it.

### On raising the limit

Cycle time = WIP / throughput. Raising the limit without raising throughput raises cycle time proportionally: same output, more rot. Raise it only when landings-per-session sustainably exceed the current limit's implied cycle time.

## MUST-2 — the ceiling counts INVENTORY, never WORKERS (2026-08-29)

The guard originally fired at `PreToolUse:Task|Agent` ONLY, using agent-spawn as a PROXY for
lane-opening. The proxy was measurably wrong: **33 worktrees and 43 branches accumulated against a
limit of 5 while the ceiling refused nothing**, because lanes are overwhelmingly opened with `git
worktree add` / `git switch -c` / `git checkout -b` / `git branch <name>` — none of which is an
agent spawn. The `Bash` arm was added later and IS the ceiling. The `Task|Agent` arm was left in
place and, having never caught inventory, only ever refused WORKERS.

That is why removing it costs no inventory coverage: it is not an inference, it is the arm's
measured record across 33 worktrees and 43 branches.

**Why it mattered beyond ineffectiveness.** Every refused worker dispatch pushed the orchestrator
back toward doing the work in the main agent — the opposite of `agents.md` § Triad and of the
standing operator directive to reserve the main agent for discussion and delegate by default. The
ceiling was, in effect, penalising delegation.

**Residual, stated rather than implied.** A SUBAGENT that opens a lane does so through its own Bash
call and is caught by the `Bash` arm exactly as the orchestrator's is — PROVIDED hooks propagate
into that subagent's tool calls. Where they do not, an agent-opened lane is ungated. That is a
`hook-event-selection` question about subagent hook propagation, and the honest disposition is to
name it here rather than to re-charge every worker against the inventory ceiling to cover it.

**What did NOT change:** the `Bash` arm (the real ceiling), the `SessionStart` age-distribution
report (MUST-3 — still `halt-and-report`; what changed on 2026-09-06 is that MUST-3 gained a SECOND
surface, a DOOR on the `Bash` arm, not that the report grew teeth), and `dispatch-contract-guard.js`
on `Task|Agent` (a delivery-contract guard with no WIP role).

## MUST-9 — depth

Receipts: `journal/0607` (a lane is a mini-orchestrator; ceilings bind worktrees and branches, never
agents) and `journal/0608` (the contract is delivered durably through hooks and COC artifacts). The
rule carries the obligation, a compact BLOCKED corpus, the `**Why:**` and a clause-scoped Wiring
block; this section carries the reasoning behind each term, the full corpus and the probe pair.

### What was already true, and what was not

MUST-2 already said the ceiling counts INVENTORY, never WORKERS, and the `Task|Agent` arm that charged
dispatches to the limit was removed 2026-08-29 (§ "MUST-2 — the ceiling counts INVENTORY, never
WORKERS"). That made depth FREE against the ceiling — and obliged nothing. In the session that
received 0607's directive, lanes were briefed as single serial workers while work queued behind the
five-lane limit, with MUST-2 loaded. Knowing the rule was not the failure: no clause made depth an
obligation, and nothing delivered it at the moment of dispatch (0608).

### The partition contract, term by term

- **Writers take DISJOINT file sets.** Two writers on one file race each other's edits, and a
  post-edit formatter can rewrite the file under the other. Disjointness is what makes one tree safe,
  not a low agent count.
- **ONE committer — the lane orchestrator.** A worktree has ONE index, so concurrent `git add` /
  `git commit` contend on it. Agents edit and never stage; the orchestrator commits in sequence.
  Serializing COMMITS is the contract; serializing the WRITERS to get there is the defect.
- **Read-only agents are unbounded.** Analysis and verification write nothing to the tree or the
  index, so they consume no partition.
- **Build contention → per-agent build/output directories.** The contention is over OUTPUT paths, so
  giving each agent its own output directory resolves it. Opening another worktree for it creates a
  branch and a tree — inventory the ceiling counts — to solve a file-path problem.
- **Refill packs before it opens.** A free agent slot inside an open lane costs nothing against the
  ceiling; a new worktree or branch costs a slot, counted as MUST-2 defines it. MUST-7(c) says WHEN to pull; MUST-9 says WHERE the pull lands
  first.

What MUST-9 deliberately does NOT restate: MUST-2's inventory-not-workers sentence (cited), and the
isolation guidance 0607 decision 5 reconciles so the unit of isolation is the LANE
(`worktree-isolation.md`, `skills/30-claude-code-patterns/worktree-orchestration.md`, `agents.md`
§ Worktree Orchestration).

### BLOCKED rationalizations — full corpus

"one worker per lane is safer" · "agents in one tree will collide" (disjoint file sets and one
committer prevent it) · "the build needs its own worktree" (per-agent output directories) · "I'll
dispatch the rest after this item lands" · "a new lane is cleaner than repartitioning this one" ·
"the limit is five, so five agents is the limit" (it counts inventory) · "one committer means one
worker" · "a serial worker keeps history linear" (one committer does) · "the items might touch the
same file" (then partition around it, and serialize only the writers that share it) · "the lane is
under the limit, so it is fine" (the limit bounds inventory; it is not a depth target).

### Durable delivery (0608)

Each surface is named in the rule's MUST-9 Detection row with its symbol and fixtures: SessionStart
injection of the contract and per-lane depth, a dispatch-time `advisory` on a lane brief with no
partition, a turn-end `halt-and-report` on an under-packed lane, the ledger's lane binding
(a `lane: <branch>` key in the todo file's leading YAML frontmatter, `todo-durable.js::LANE_KEY`; no key
reads UNBOUND, a duplicated key or a value that is not a valid branch name reads MALFORMED) with UNBOUND
items reported rather than folded into a clean total, and the planning
commands. None carries `block`: decomposability is judgment. On Codex and Gemini the hook arms are
not registered and the contract arrives as rule and command text only.

### The probe pair `MUST-9-firing`

| Pole      | Fixture                                     | What it establishes                                                                                                                                     |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| violation | `flag-lane-run-as-serial-worker.txt`        | four disjoint items, ONE serial worker; every neighbour (MUST-2/3/4/7) satisfied, and the serial worker justified in the partition contract's own words |
| compliant | `clean-lane-fanned-out-under-partition.txt` | the same forest, items and landing; four writers + a read-only verifier in one tree, one committer, per-agent output dirs                               |

Surface-equalized at 46 lines each and a 1.008 byte ratio. The compliant pole's traps: five agents
against a limit of five, commits made in sequence, and several writers in one tree.

### Byte ledger — how MUST-9 was funded

Measured with `node .claude/bin/check-rule-injection-budget.mjs`, which charges this path-scoped rule
its RAW body against a 6000 B per-rule allowance over the accepted 18223 B. Before MUST-9: 23322 B,
`+5099 B within allowance`. With MUST-9 and its Wiring block added and nothing moved: 25563 B,
`+7340 B OVER ALLOWANCE` — the gate red. After the moves recorded in § "Moved from the rule body
2026-09-12 — MUST-9 funding": 23997 B, `+5774 B within allowance`. What moved: the rule-wide Detection
row's pair→clause binding, `:NNN` citations, MUST-4 per-component text and MUST-1 retirement argument
(now § Detection tiers and § "Why MUST-1 gets no detector — and what observes MUST-4"); the Severity
row's withdrawn-refusal history and its 2026-09-06 note; and six depth-pointer tails. No obligation
left the rule: measured with `check-descoping.mjs`'s exported `extractInventory`, before → after, MUST
tokens 75 → 77, MUST NOT 4 → 4, BLOCKED 12 → 13, `**Why:**` lines 12 → 13, each Wiring field 1 → 2.
**RE-MEASURED 2026-09-12, later the same day — the two figures above are that pass's measurement and
no longer describe this tree.** The lane afterwards rewrote MUST-9's opening to cite MUST-2 rather
than restate the ceiling, added the § Origin **length rationale** `rule-authoring.md` MUST NOT
§ "Rules longer than 200 lines" asks of a 200-plus-line rule, and moved MUST-9's `**Why:**`
provenance tail here to pay for it. Measured on that tree with the same command over the same input
set (`.claude/rules/*.md`, this rule charged its RAW body against 6000 B over the accepted 18223 B):
the rule is **24084 B, `+5861 B within allowance`**, rc 0, `✓ within budget` — **139 B of headroom**,
narrower than the 226 B the superseded sentence claimed. Freshness predicate, recomputing nothing:
re-run `node .claude/bin/check-rule-injection-budget.mjs` and read this rule's row; any other value
means the figure here is STALE and the verdict is UNANSWERED until re-run, never "still current".
The conclusion is unchanged and now sharper — the next clause landing in this rule needs its own
extraction, and there is less than one paragraph of room to land it in.

## Compact-rule example originals — 2026-09-07

The seven original examples below are preserved verbatim; the rule retains compact DO/DO NOT cases beside each unchanged obligation.

### Original example — MUST-1

```text
# DO — merged → delete branch + remove worktree · "superseded by #N" → delete both, reason recorded
# DO NOT — branch survives its merge · "leave it, we might come back to it" · salvage/ nobody salvages
```

### Original example — MUST-2

```text
# DO — "5/5 open (oldest fix/x, 31h). Land or kill one first."
# DO NOT — spawn lane 6 · "they're all small" · "I'll close them all at the end"
```

### Original example — MUST-3

```text
# DO — "52 trees: p50 32.6h, p90 285h, max 477h. 9 past 168h: <named>."
# DO NOT — "52 worktrees." · ageHours from stat().mtime (a touch makes rot look fresh)
```

### Original example — MUST-4

```text
# DO — merge → delete branch → remove worktree → reap the remote ref → done
# DO NOT — "merged ✅" while the branch and its 75 MiB tree remain
```

### Original example — MUST-5

```text
# DO — git branch -D <X> → assess X
# DO NOT — git branch -D <X> → assess HEAD → {"continue":true} while X holds 11 unlanded artifacts
```

### Original example — MUST-6

```text
# DO — no index + unpushed:0 → ZERO-LOSS
# DO NOT — 6917 "dirty paths" on a tree measuring 4.0K → KEEP, permanently un-reapable
```

### Original example — MUST-7

```text
# DO — enqueue D on lane A → finish A → land A → PULL D
# DO NOT — open lane B for D now (push) · land A then idle (stall)
```

## The census roster

Moved verbatim from the rule's MUST-8 enumerator paragraph 2026-09-12 (`RULE_DELTA_OVER` burn-down;
see § "Detection tiers"). The rule keeps the enumerator's name, the read-it-directly instruction and
the `census.unknown` obligation; the loom-only dashboard note lives only here:
**The enumerator EXISTS** — `hooks/lib/wip-lanes.js::refCensus`, surfaced by
`laneSurvey({census:true})`, both of which every consumer receives. loom additionally renders that
survey on a LANE axis in its own activity dashboard; that renderer is loom-only tooling and is NOT
distributed, so read the census from `refCensus` directly rather than looking for a dashboard you do
not have. A class it could not measure is listed in `census.unknown`, never folded into a clean
total. This clause states the CONTRACT those satisfy; it is no longer describing an unbuilt one.
Mechanism — namespace partitioning, the `container` | `anchor` | `unclassified` verdicts, the
declared policy file: the extract § "The census roster".

### The census enumerator — mechanism

`refCensus` (`hooks/lib/wip-lanes.js`) partitions an UNFILTERED `for-each-ref` by DERIVED
namespace — an unanticipated namespace becomes its own partition rather than being dropped —
and classifies each ref `container` | `anchor` | `unclassified` against the declared
`hooks/lib/ref-namespace-policy.json`. `laneSurvey({census:true})` reuses the ref read it has
already spawned rather than issuing a second one. Trees are enumerated in three classes:
registered, detached, and STRAY on-disk sibling dirs.

Three distinctions the render holds, because collapsing any one makes the number wrong in a
way that reads as clean: CONTAINER vs ANCHOR (a release or provenance tag holds no unlanded
work, so the census total can never be misread as a backlog count); `unclassified` as a THIRD
verdict, folded into neither total; and UNKNOWN-is-not-ZERO per class — each partition carries
its own `status`, `census.unknown` names each unmeasured class with its reason, and
`containerTotal: null` renders UNMEASURED rather than 0. The default census reads the
remote-tracking CACHE, not the live remote, so `remote` comes back unmeasured and is reported
that way instead of as a clean remote.

Extracted from `rules/wip-discipline.md` MUST-8 2026-09-10 as the PAIRED half of the Rule-10
extraction funding that clause. The OBLIGATION — enumerate every class and every remote, decide
landedness by content — stays in the rule; only the per-class enumerator table moved.

| Class                        | Enumerator                                    | Why a branch-only sweep misses it                                                                                     |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| local branches               | `git for-each-ref refs/heads`                 | —                                                                                                                     |
| remote-tracking refs         | `git for-each-ref refs/remotes` (ALL remotes) | a sweep scoped to `refs/remotes/origin/` sees one remote of N                                                         |
| worktrees, registered        | `git worktree list`                           | —                                                                                                                     |
| worktrees, STRAY on disk     | `ls -d <repo-parent>/.<repo-slug>-wt/*`       | a disconnected dir is invisible to `git worktree list`, and `worktree prune --dry-run` reports it as nothing to prune |
| stashes                      | `git for-each-ref refs/stash`                 | no branch-shaped surface reports it                                                                                   |
| detached HEAD (any worktree) | `git symbolic-ref -q HEAD` per tree           | carries commits reachable from no branch                                                                              |
| other ref namespaces         | `git for-each-ref` unfiltered                 | `refs/notes`, vendor namespaces, ad-hoc mirrors                                                                       |

## MUST-4 — the ancestry measurement and the protected-ref partition

Extracted from `rules/wip-discipline.md` MUST-4 2026-09-10 (Rule 10 path (a)) to fund the
MUST-8 addition. Every MUST, BLOCKED entry and `**Why:**` stayed in the rule body; what moved
is dated measurement and mechanism narrative the rule itself marks as history.

Measured on loom 2026-09-10,
88 refs on origin: content 18 landed, ancestry 0 — a door keyed on ancestry had never fired.
That figure is DATED HISTORY, not the predicate the door runs today: since the
protected-ref partition landed, a ref matching `isProtectedName` is DEMOTED out of
the blocking count and reported separately, so over that same forest the blocking
number would be lower. Re-measure rather than citing this line. The predicate is
also WIDER than the four prefixes — it covers `main`/`master`/`HEAD` and fails
CLOSED on an unnameable ref — which at the door buys exactly ONE non-redundant
case: `main`/`master` when the base is some OTHER branch, since `nameOf` already
drops `HEAD` and the base. Near-misses fail OPEN and stay reapable: `WIP/x` is
case-sensitively NOT protected.

## MUST-4 — why the trunk moved

Extracted from `rules/wip-discipline.md` MUST-4 2026-09-10 (Rule 10 path (a)) to fund the
MUST-8 addition. Every MUST, BLOCKED entry and `**Why:**` stayed in the rule body; what moved
is dated measurement and mechanism narrative the rule itself marks as history.

**Why the trunk had to move at all:** while "landed" meant "on main" and the gate fired on
`pull_request` to main, closing a branch ALWAYS cost a CI run on a shared pool, so every session
rationally deferred. The guards were not being ignored — they gated an exit with nowhere cheap to
go. MEASURED on loom 2026-09-10: a push to `dev` fires ZERO workflow runs (runs API, controls 50 on
main and 1 on a PR branch), and 61 remote refs stood unlanded at a median age of 28 days.

## Origin — full narrative

Extracted from `rules/wip-discipline.md` § Origin 2026-09-10 (Rule 10 path (a)) to fund the
MUST-8 addition. Provenance narrative only; no MUST, BLOCKED entry or `**Why:**` moved.

2026-08-22 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination).
Verbatim: _"WIP is a waste… There is 0 reason why we have unlanded branches and worktrees, which
means they are nothing but waste"_ and _"This is the MOST CRITICAL problem we need to fix at root
cause… I need to cascade this capability down to all use and build."_

Measured at origination (`origin/main` = `fc216b96`): 53 worktrees (p50 32.6h, p90 285.0h, max
476.9h; 34 over 24h, 9 over a week), 306 branches, 99 ahead-by-reachability, 83 with unique patches
(UPPER BOUND — `git cherry` cannot see a squash-merge), **18 LOCAL-ONLY and genuinely at risk**.

Acceptance criteria were operator-ratified BEFORE implementation per `completion-criterion.md`
MUST-1: § "Origin — acceptance-first sequencing (2026-08-22)" above.

**`rule-authoring.md` Rule 10 does NOT fire** — this file is `path-scoped`, and Rule 10 binds
baseline rules ONLY. It is instead budgeted per-profile at `.claude/rule-injection-budget.json`, and
the 2026-09-06 age-door Wiring correction was funded by extracting this paragraph's own depth. Full
record, including the withdrawn earlier Rule-10 booking: extract § "Why this SHIPPED path-scoped,
having been authored baseline".

## Relocated 2026-09-13 — rule-body depth (paired-extraction lane)

Moved VERBATIM out of `.claude/rules/wip-discipline.md` by the 2026-09-13 paired-extraction lane
(`rule-authoring.md` Rule 10 path (a)). Every `MUST` / `MUST NOT` / `BLOCKED` token and every
`**Why:**` line stayed in the rule body; what moved is derivation, mechanism detail and provenance.

### Preamble — the Little's Law derivation

> Forgetting a lane is not a memory failure, it is QUEUEING — Little's Law, cycle time =
> WIP ÷ throughput — so an unbounded WIP count guarantees a cycle time longer than anyone's memory,
> and the work gets re-derived.

### MUST-2 — the definitional gloss and the override's echo

> this is its ONE definition, which every other surface cites. Inventory is value not yet on the
> default branch, the quantity Little's Law bounds.

> both echo back an `advisory`, so an override is recorded, not silent. Mechanics, incl. the
> content-confirmed lower bound: extract § "Why MUST-2 takes the teeth".

### MUST-4 — the remote-ref reaping gloss

> The remote ref is the half nothing else reaps: a merge's `--delete-branch` reaps only a PR'd
> branch, and `git branch -d` only the local ref.

### MUST-4 — the measured forest

Extracted from MUST-4's `**Why:**` 2026-09-13 (paired extraction funding the citation-restoration
pass). The rule keeps the failure mode; the figures live here.

> 210 local branches are fully merged and still present, each diluting the signal for the ones that
> did not land — and the remote half is worse, because no routine operation reaps it at all:
> measured on this repo, local drainage took branches 10 → 3 and left 616 remote refs standing, 526
> of them already on the default branch.

### MUST-4 — the trunk paragraphs' derivation tails

> Where no trunk exists the resolver falls back to `<remote>/main`, so a repo that has not adopted
> `dev` is unchanged; adoption is creating the branch, never a flag day.

> surfaces that disagree about what "landed" means is the parity defect

> so the promotion gap goes invisible to the tooling that surfaced it. Without the cadence `main`
> rots and the first promotion after a long gap is a large, hard-to-review merge: the same
> bottleneck relocated, which is not a fix.

### MUST-8 — the composition gloss

> **Landedness is decided by CONTENT, never ancestry, never name** — MUST-4 owns that test; this
> clause owns only WHERE to look. The two compose: a content-correct test run over a partial
> surface reports a clean forest.

### Trust Posture Wiring (MUST-1..8) — Severity and Detection narrative

> All three hook surfaces are structural, so `hook-output-discipline.md` MUST-2 PERMITS `block` on
> each — a lane count and a committer date are both git-object facts, not lexical inferences. Its
> MUST NOT is ANSWERED by the consumed override receipt. Depth: extract § "Why MUST-2 takes the
> teeth"; this row's 2026-09-06 change: extract § "Why MUST-3 took the teeth (2026-09-06)".

> `laneCreationIntent` selects WHICH question, measured git state answers it, which is what permits
> `block` under `hook-output-discipline.md` MUST-2 — and MUST-3's report at `SessionStart`. No
> `Task|Agent` arm: it charges no WORKER.

> **MUST-4 is observed PER COMPONENT, each in part** — observers, the base each resolves, events and
> gaps: extract § "Why MUST-1 gets no detector — and what observes MUST-4". Reviewer at
> `/implement` + cc-architect at `/codify` confirm each closed lane shows a merge or a recorded
> kill, and that its branch, its worktree AND its remote ref are gone.

> pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. **Consumer residual:** rule, extract
> and fixtures reach the six use/build lanes, the hooks all seven — build/prism gets the guard
> WITHOUT the rule. The earlier MCP-only Codex census is superseded by the native
> bridge registration described above; consumer trust and semantic parity remain separate
> measurements. Gemini registers no arm; the probe suite reaches no lane. Depth:
> extract § "Consumer residual".

### Trust Posture Wiring (MUST-9) — Detection narrative

> `hooks/wip-discipline-guard.js::runSessionStart` injects the lane contract and a per-lane depth
> report from `hooks/lib/wip-lanes.js::laneDepth`. **Dispatch** —
> `hooks/lib/dispatch-contract.js::detectLaneBriefWithoutPartition` via
> `hooks/dispatch-contract-guard.js` at `PreToolUse:Task|Agent`, `advisory` (prose signal).
> **Turn end** — `hooks/lib/delegation-default.js::detectUnderPackedLane` via
> `hooks/delegation-default-guard.js` at `Stop`, `halt-and-report`. **Ledger** — every item records
> its lane through `hooks/lib/todo-durable.js`'s binding, a `lane: <branch>` frontmatter key; an
> item without one is reported UNBOUND, never folded into a clean total. **Planning** —
> `commands/todos.md`, `commands/implement.md`. **Codex/Gemini residual:** the SessionStart,
> `Task|Agent` and `Stop` arms are CC `settings.json` registrations not mirrored to Codex or
> Gemini; there the contract arrives only as rule and command text.

### Origin + length rationale tails

> Full provenance chain, the measured instances and the per-extraction record: the extract
> § "Origin — full narrative".

> **MUST-9** — 2026-09-12, co-owner-directed; receipts `journal/0607` (the contract) and
> `journal/0608` (durable delivery). Depth, corpus, probe pair and byte ledger: extract § MUST-9.

> Named rationale: **single-lifecycle scope** — the nine clauses are ONE lane's lifecycle (open ·
> age · land · clean · guard-reads-target · empty-vs-dirty · burn-down · census · depth), each
> carrying the DO/DO-NOT + `**Why:**` + BLOCKED corpus + clause-scoped Wiring the meta-rule
> mandates; splitting them scatters one decision across files an operator reads at one moment.
> Depth is EXTRACTED to `guides/rule-extracts/wip-discipline.md` to hold the per-rule injection
> allowance. Precedent: `security.md` + `artifact-flow.md` length rationales.

### Distinct From / Cross-References — the full map

> **Distinct from** `artifact-stranding.md` — that governs whether an AUTHORED ARTIFACT is in force
> (reachability); this governs whether a LANE is finished (inventory). **Composes with**
> `worktree-isolation.md` Rule 8 (this sets WHEN a tree ends, Rule 8 sets HOW) and
> `orchestration-launch-ledger.md` MUST-1 (that records the launch; this bounds how many may be
> live and for how long).

## Relocated 2026-09-28 — landing-provenance lane (MUST-4 funding + depth)

MUST-4 gained one clause on 2026-09-28, re-scoped 2026-09-28 to keep the tool-name loom-local: a
lane MUST land promptly, retire its source branch, and record the source identity on the landed
commit; **at loom** that runs through `<loom>/.claude/bin/land-lane.mjs` (loom-only, not distributed), and
landedness asks that record FIRST. The clause was FUNDED inside the rule — the path-scoped injection ratchet derives a 0 B
aggregate cap while any surface sits above target — by moving the measured-evidence sentences
below out of their `**Why:**` lines and folding two duplicate depth pointers into one. No MUST,
MUST NOT, BLOCKED token or `**Why:**` line left the rule; each moved sentence is reproduced here
verbatim with the clause it supported.

### Moved evidence sentences, verbatim

- **MUST-2 `**Why:**`** — "the corpus had no ceiling anywhere — 53 worktrees and 306 branches
  accumulated against no limit at all." and the "— measured twice" tail of "**A ceiling that reports
  is not a ceiling**" (the principle itself stays in the rule).
- **MUST-3 `**Why:**`** — "Measured: the reaper read a tree as 11.1h from mtime whose reflog showed
  44h."
- **MUST-7 `**Why:**`** — "The corpus shipped the bound and never the pull. With no queue to
  enqueue INTO, every finding becomes a lane; with no queue to pull FROM, a freed lane yields no
  next action and the turn ends idle."
- **MUST NOT (open while a cheaper close exists)** — "measured at 19 → 21 in a single session,
  across four recorded overrides."
- **MUST NOT (count without age distribution)** — "measured at 63% noise, after which the surface
  was correctly ignored."
- **MUST-4 (landing-provenance clause, re-scoped 2026-09-28)** — the trailer detail that used to sit
  inline: "At loom the landing script writes one `Landed-From` trailer per source commit." Moved out
  to FUND the re-scope that made the tool-name loom-local; the obligation ("record the source
  identity on the landed commit") stays in the rule, only the mechanism's detail moved here.
- **MUST-4 (ancestry-vs-content)** — the mechanism explaining WHY ancestry is not the test: "so a
  fully-landed branch is not an ancestor of the base." The MUST NOT ("Ancestry … is NOT the content
  test and MUST NOT be used as one") stays in the rule; only its explanation moved here.

The two folded pointers — "MUST-9's per-surface guard/lib wiring" and "the full Distinct-From map,
incl. how `rules/orchestration-launch-ledger.md` MUST-1 composes with this rule" — pointed at the same
§ "Relocated 2026-09-13" as the Wiring-block pointer; that one pointer now names both topics.

### Why landing through the script, and why straight onto the integration branch

Landing rewrites commit ids — a rebase, squash, conflict fix or reformat — so every after-the-fact
test (ancestry, patch-id / `git cherry`, file content) answers a different question from "was this
branch landed?", and misreads in both directions. The fix is to WRITE the link at landing, not to
compare more cleverly afterwards: the loom script replays each source commit onto the integration
branch with a `Landed-From: <branch>@<40-hex>` trailer, or `Landed-Partial` +
`Landed-Outstanding` for a subset (`<loom>/.claude/bin/land-lane.mjs:452-460`), and the push gate
`scripts/ci/landing-trailer-gate.mjs` refuses an untrailered commit past the recorded cutover.

**Straight onto the integration branch, never through an intermediate one.** Re-landing a commit
strips every existing `Landed-*` trailer before writing its own
(`<loom>/.claude/bin/land-lane.mjs:371-381`), so a shard landed onto a wave integration branch and then
re-landed onto `dev` records the integration branch as its source and the shard as UNLANDED — the
exact misreport the script exists to prevent. This is why the clause overrides the hand-merge
examples in `deployment.md` (obligation 1) and `wave-loop.md` (MUST-9) wherever the script ships.

**The consumer policy the clause names** (`.claude/hooks/lib/landed-map.js:618-671`): a decided
verdict (`landed`, `partial`, `not-landed`) is final and no content comparison runs; the fallback
statuses (`predates`, `ancestry`, `no-config`) — and ONLY those — license the legacy
content test; `unknown` and `no-map` (the config exists but its map could not be built) are
UNMEASURED and are never read as landed. A consumer repo with no
landing-provenance config reads `no-config`, so its behaviour is the unchanged content test.
