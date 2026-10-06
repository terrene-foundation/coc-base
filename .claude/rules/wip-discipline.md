---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/.session-notes*"
  - "**/.session-notes.d/**"
  - ".claude/hooks/**"
  - ".claude/bin/**"
---

# WIP Discipline — Unlanded Work Is Inventory, And Inventory Is Waste

A branch or worktree carries no value; it is a CONTAINER for work whose value is realised only on
reaching the default branch. Forgetting a lane is not a memory failure, it is QUEUEING, so an
unbounded WIP count outlives anyone's memory of it and the work gets re-derived. **The control is a
LIMIT on inventory, not a better report of it.** Depth, derivation, measured evidence, full BLOCKED
corpora, drain protocol and consolidation record: `.claude/guides/rule-extracts/wip-discipline.md`
(**the extract**).

A **lane** is one unit of work: intent → branch → worktree → commits → push → PR → merge → cleanup.

> A lane has exactly TWO terminal states — **LANDED** (merged, branch AND worktree removed) and
> **KILLED** (abandoned, reason recorded, branch AND worktree removed). `unlanded` is TRANSIENT
> with a bounded lifetime. **It is never a resting state.**

## MUST Rules

### 1. A Lane Reaches LANDED Or KILLED — There Is No Third Resting State

Every branch and worktree MUST resolve to LANDED or KILLED. One that is neither, past the MUST-3
bound, is a DEFECT requiring disposition — not a status to carry forward. KILLED is first-class:
recorded with a reason, and it deletes branch AND worktree.

**DO:** merged → delete branch + remove worktree; “superseded by #N” → record reason and delete both. **DO NOT:** retain a merged branch or a `salvage/` lane nobody salvages.

**BLOCKED:** "it might be useful later" · "deleting it loses the work" (a branch ref is not the
work) · "I'll decide next session" · "the reflog has it". Full corpus: extract.

**Why:** With no KILLED state, abandoned and in-flight work are the same shape — a branch that exists — so no instrument can separate them and the count grows without bound.

### 2. The WIP Limit Is Enforced At OPEN — Pull, Never Push

An operator MUST NOT hold more than **5** concurrent open INVENTORY lanes. Opening at the limit is
REFUSED — `block` at **`PreToolUse:Bash`**, naming the limit, the confirmed count, and every open
lane with its age.

**The ceiling counts INVENTORY — unlanded worktrees and branches — never WORKERS.** An AGENT is a
worker: dispatching one creates no branch, no worktree, no unlanded commit. Finish a lane to start a
lane. Opening because work is available, rather than because capacity exists, is BLOCKED.
Depth: extract § MUST-2. **Never a dead end:** a one-line reason in `.claude/wip-authz/wip-limit-allow`
is honoured ONCE (consumed on use), or `COC_ALLOW_WIP_OVERRUN=1` for a run; both are recorded, not
silent. Mechanics, incl. the content-confirmed lower bound: extract § "Why MUST-2 takes the teeth".

**DO:** “5/5 open; oldest fix/x, 31h: land or kill one first.” **DO NOT:** open lane 6 because “they’re all small” or promise to close them at the end.

**BLOCKED:** "they're all small" · "the limit is for humans, agents are parallel" · "this one is
urgent" · "the parallel-dispatch default says fan out" (it does — WITHIN capacity). Full: extract.

**Why:** Every other clause here detects inventory AFTER it exists; this is the only one that stops it being created. **A ceiling that reports is not a ceiling.** Evidence: extract § "Why MUST-2 takes the teeth".

### 3. AGE Governs, Not COUNT — The Bound Is 24 Hours

Every WIP surface MUST report an AGE DISTRIBUTION and NAME the lanes past bound; a count alone does
not satisfy this. A lane older than **24 hours** is a defect requiring disposition. Age MUST derive
from CREATION (worktree reflog, branch first unique commit), NEVER directory mtime.
**Opening a lane while any lane is past bound is REFUSED** — a DOOR at OPEN, not only a report,
binding independently of MUST-2's count (two lanes at three days is under every count and still this
defect). Escape: MUST-2's one-shot receipt, never a second channel.

**DO:** “52 trees: p50 32.6h, p90 285h, max 477h; 9 past 168h: <named>.” **DO NOT:** report only “52 worktrees” or derive age from directory mtime.

**BLOCKED:** "most are fine" · "the count went down, so it's improving" · "mtime is close enough".

**Why:** 52 lanes opened and closed in a session is healthy flow; six at 477h is rot — a count reports both identically, which is how a reader learns to scroll past.

### 4. Done Means LANDED AND CLEANED — And CLEANED Includes The REMOTE Ref

A lane is NOT done when its agent reports success, when it commits, or when its PR merges — it is
done when the content is on the INTEGRATION TRUNK AND its branch AND its worktree AND **its remote
ref** are gone. Reap by CONTENT — every commit's PATCH-ID already present at the base
(`git cherry`) — never by ancestry and never by age. Ancestry (`git branch --merged`, `for-each-ref
--merged`) is NOT the content test and MUST NOT be used as one — a squash merge re-authors every
commit under a new sha. Measured: extract § "MUST-4 — the ancestry measurement and the protected-ref partition".

**THE TRUNK IS `dev`, AND THE TWO TRUNKS ARE ASYMMETRIC BY DESIGN.** Finished lane work merges
into `dev` the same session it is finished — no PR, no gate, no wave to wait for. `dev -> main` is
a SEPARATE deliberate promotion: one PR, one gate run, on a standing cadence. Every
landed/unlanded predicate MUST measure against the trunk via the ONE shared resolver
(`hooks/lib/trunk-ref.js`), never a per-surface copy.

Why: extract § "MUST-4 — why the trunk moved".

**The one honest cost, and it MUST be paid, not absorbed:** work in `dev` but not `main` stops
reading as unlanded. Two things keep it honest and BOTH are required — a
`git rev-list --count origin/main..origin/dev` counter on the close-out surface, and a STANDING
promotion cadence.

**A lane MUST land promptly, retire its source branch, and record the source identity on the
landed commit,** onto the integration branch; a hand `git merge` / `cherry-pick` / `rebase` there
is BLOCKED, whatever another rule's example shows. At loom this lands via
`<loom>/.claude/bin/land-lane.mjs` (loom-only; not distributed).
Landedness then asks that record FIRST (`.claude/hooks/lib/landed-map.js:618-671`): a decided
verdict is final, the content test runs only when it cannot decide, and an unknown is UNMEASURED.

**Why:** landing rewrites commit ids, so a link not written AT landing leaves the branch reading
unlanded — re-reviewed, re-queued, or re-landed over later fixes.

```text
# DO — merge → delete branch → remove worktree → reap the remote ref → done
# DO — land-lane.mjs land fix/x   (where it ships: one Landed-From trailer per source commit)
# DO NOT — "merged ✅" while the branch and its 75 MiB tree remain
# DO NOT — local forest drained to 3 branches while 526 landed remote refs stand
# DO NOT — git merge --no-ff fix/x onto dev by hand, or via a wave integration branch
```

**BLOCKED:** "the local branches are clean" · "nobody looks at remote refs" · "it fires no CI, so it
costs nothing" · "deleting on the remote is risky, leave them" (the reaper archives every tip first).

**BLOCKED:** "the PR merged, that's done" · "cleanup is housekeeping" · "I'll reap them in a batch
later" (the batch is the 52) · "a one-commit cherry-pick is the same" · "I'll type the trailer by hand".

**Why:** Merged-but-present branches dilute the signal for the ones that did NOT land, and the
remote half is worse because no routine operation reaps it at all. Measured forest: extract § "MUST-4 — the measured forest".

### 5. A Destructive-Command Guard Reads The COMMAND'S TARGET, Never `HEAD`

Any guard firing on a branch- or worktree-ending command MUST evaluate the object named IN THAT
COMMAND. Sweeping `HEAD` while the command names another branch is silent exactly when it matters.

**DO:** `git branch -D <X>` → assess X. **DO NOT:** assess HEAD while X holds unlanded artifacts.

**Why:** Measured — that exact command returned 18 bytes of silence because the guard assessed `HEAD`. The one command that destroys a lane irrecoverably was the one it could not see.

### 6. A Safety Predicate That Cannot Separate EMPTY From DIRTY Is Not Evidence

A predicate gating removal MUST distinguish "holds work" from "holds nothing". A `--no-checkout`
worktree has NO index, so every path in `HEAD` reads as a staged deletion; counting those as dirt
reports a 4 KB empty directory as 6,917 paths of work. No index + no unpushed commits ⇒ ZERO-LOSS.

**DO:** no index + unpushed:0 → ZERO-LOSS. **DO NOT:** classify a 4 KB empty tree as 6,917 dirty paths and permanently KEEP it.

**Why:** A predicate that fails CLOSED on everything is not safe, it is inert — it stops being a decision, and the forest it bounds grows underneath it.

### 7. BURN-DOWN TAKES PRECEDENCE — Enqueue On Discovery, Pull On Free Capacity

MUST-2 bounds the COUNT of open lanes; it never orders PRIORITY between closing one and opening
another, so at 4 of 5 an operator is compliant opening a fifth. This supplies the ordering.

**(a) PRECEDENCE.** While >=1 lane is open, advancing an OPEN lane toward LANDED outranks opening a
new one. Opening while a cheaper close exists is BLOCKED — "cheaper" MEASURED: a lane one push, one
green check, or one merge from landed beats any lane not started.

**(b) ENQUEUE, DO NOT START.** A finding discovered inside a lane, whose fix would OPEN a lane, is
RECORDED as a queued row on the current lane — NOT started. The ONE exception to the corpus's
fix-now mandates, and it does not weaken them: they govern WHETHER a defect is fixed and forbid
dropping it; this governs WHEN. A queued row is not a deferral and not a follow-up issue.

**(c) PULL ON FREE CAPACITY.** A lane reaching a terminal state is a REFILL TRIGGER; the next action
comes FROM THE QUEUE. Ending a turn with capacity free and a non-empty queue is BLOCKED unless a
bound is NAMED (dependency, human gate, capacity, prudence, converged clean stop).

**DO:** enqueue D on A → finish A → land A → PULL D. **DO NOT:** open B for D immediately or land A then idle.

**BLOCKED:** "the corpus says fix it immediately" (it says fix it, not in a NEW LANE NOW) · "this is
small" · "I'll close them all at the end" · "the override exists, so using it is sanctioned".

**Why:** A pull system has two halves — bound WIP, and pull when capacity frees. Push-on-discovery and stall-on-completion look opposite and are one defect: **no queue.** Depth: extract § MUST-7.

### 8. The CENSUS Enumerates EVERY Container Class — One Class Is Not A Census

A WIP census MUST enumerate every container that can hold unlanded work, and every remote. Reading
one namespace as the whole forest is BLOCKED. The roster, all of which are UNDESIRABLE holding
places and none of which is a resting state:

Roster: local branches · remote-tracking refs across ALL remotes · registered worktrees · STRAY on-disk sibling worktree dirs (invisible to `git worktree list`, and `prune --dry-run` reports them as nothing to prune) · stashes · detached HEAD in any tree · other ref namespaces.

**The enumerator is `hooks/lib/wip-lanes.js::refCensus`**; a class it could not measure is listed in `census.unknown`, never folded into a clean total. Mechanism: extract § "The census roster".

**Landedness is decided by CONTENT, never ancestry, never name** — MUST-4 owns that test; this clause
owns only WHERE to look.

```text
# DO — every class, every remote, then content-test each candidate
git for-each-ref refs/heads refs/remotes refs/stash | wc -l   # then `git cherry <trunk> <ref>`
# DO NOT — one namespace, read as the whole forest
git for-each-ref refs/remotes/origin/   # answered 5 while refs/remotes held 1196
```

**BLOCKED:** "there are only N branches" (which class?) · "`git worktree list` showed none" · "the
sweep came back clean" · "PR refs are just a mirror, they do not count" (decide that by CONTENT, not
by namespace) · "it is only one remote".

**Why:** the census is the input to every other MUST here — the WIP limit, the age bound, the
burn-down — so a census short by a whole class silently relaxes all of them at once, and it fails
SILENTLY: a partial sweep and a genuinely clean forest emit the identical result.

### 9. A Lane Is A Mini-Orchestrator — Pack Depth Before Opening

The ceiling counts inventory as MUST-2 defines it, never the agents inside a lane. A lane MUST
dispatch as many agents as its item set supports, in parallel, inside its ONE worktree, under the
**partition contract**: writers take DISJOINT file sets; ONE committer — the lane orchestrator —
serializes commits; read-only analysis and verification agents are unbounded; build contention is
isolated by per-agent build/output directories, NEVER by opening another worktree. A lane carrying a
single serial worker while items are queued is UNDER-PACKED. Refill packs existing lanes — items AND
agents — BEFORE a new worktree or branch opens; MUST-7(c)'s pull lands on depth first.

**DO:** lane `fix/ledger`, 4 items → writers A/B/C on disjoint files + 2 read-only verifiers, per-agent `--out` dirs, one committer. **DO NOT:** brief the lane as one worker with items 2–4 queued behind it, or open a worktree per agent “so they don't collide”.

**BLOCKED:** "one worker per lane is safer" · "agents in one tree will collide" (disjoint file sets
and one committer prevent it) · "the build needs its own worktree" · "I'll dispatch the rest after
this item lands" · "a new lane is cleaner than repartitioning this one". Full: extract § MUST-9.

**Why:** A ceiling on inventory leaves depth as the only throughput lever, so a lane run as one serial worker spends a whole slot of the limit on one agent while work queues behind it.

## MUST NOT

- Open a lane while an open lane is one push, one green check, or one merge from LANDED.

**Why:** That is the cheapest available close, and skipping it to start something new is the precise move that converts a bounded forest into a growing one.

- Report a WIP surface as a count without its age distribution and the lanes past bound.

**Why:** A count cannot distinguish flow from rot, so it trains its reader to ignore it.

- Carry a lane past the age bound with no recorded disposition.

**Why:** An undispositioned aged lane is indistinguishable from a forgotten one — the originating failure.

- Delete a branch or worktree carrying unique unpushed content to reduce a number.

**Why:** Draining inventory by destroying it is how `salvage/` branches were created; the disposition is land-or-kill DECIDED, never discarded.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer for MUST-2 (limit at OPEN) **and, since 2026-09-06, MUST-3 (age bound at OPEN)**; `block` at the hook layer for **MUST-4 (the remote-landed door at OPEN)** as well; `halt-and-report` for MUST-5, for MUST-3's SessionStart REPORT, for MUST-4's post-merge report (`reap-on-landing-guard.js`, `PostToolUse:Bash`), and at gate-review for MUST-1/6; MUST-9 has its own block below. All three hook surfaces are structural, so `hook-output-discipline.md` MUST-2 PERMITS `block` on each. Its MUST NOT is ANSWERED by the consumed override receipt. Depth: extract § "Why MUST-2 takes the teeth"; this row's 2026-09-06 change: extract § "Why MUST-3 took the teeth (2026-09-06)".
- **Grace period:** 7 days from rule landing (2026-08-22 → 2026-08-29).
- **Cumulative posture impact:** same-class violations (a lane opened past the limit; a lane past the age bound with no disposition; a merged lane whose branch or worktree survives; a WIP surface reported as a bare count) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key. Named deviation per `trust-posture.md` Rule 8: the loss is non-corrupting and recoverable (commits exist and remain landable), and minting a key would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: wip-discipline]` IFF `posture.json::pending_verification` includes the `wip-discipline` rule_id.
- **Detection mechanism:** structural + review, split per clause. **Structural.** `.claude/hooks/wip-discipline-guard.js` over `.claude/hooks/lib/wip-lanes.js` carries the MUST-2 count, MUST-3 age and MUST-4 remote-ref doors at `PreToolUse:Bash`, at OPEN only, plus MUST-3's `SessionStart` report; measured git state answers each, which is what permits `block` under `hook-output-discipline.md` MUST-2. MUST-5 is `.claude/hooks/stranded-artifact-guard.js`, which assesses the COMMAND'S TARGET. Fixtures: `.claude/audit-fixtures/wip-discipline/`, `.claude/audit-fixtures/stranded-artifacts/`. **Gate-review ONLY, permanently — MUST-1:** a lane-LIFECYCLE judgment with no tool-call-time signal, so RETIRED rather than deferred, with no `phase2-deferrals.json` row. **Probes: REGISTERED** — `.claude/test-harness/probes/wip-discipline.probes.json`, pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; **a green CI run is NEVER evidence these probes passed**.
- **Violation scope:** MUST-1 (no terminal state) + MUST-2 (WIP limit) + MUST-3 (age bound, age-from-creation) + MUST-4 (landed AND cleaned) + MUST-5 (guard reads the target) + MUST-6 (empty-vs-dirty predicate) + MUST-7 (burn-down) + MUST-8 (census). Every `violations.jsonl` row names the lane and the clause. MUST-9: own block below.
- **Origin:** See § Origin.

Depth — the `laneCreationIntent` mechanics, the no-`Task|Agent`-arm rationale (the guard charges no WORKER, so it measures only what MUST-2 counts), the per-component MUST-4 observer split, the MUST-1 gate-review procedure, the Codex/Gemini/build-prism consumer residual, MUST-9's per-surface guard/lib wiring and the full Distinct-From map — lives in `.claude/guides/rule-extracts/wip-discipline.md` § "Relocated 2026-09-13 — rule-body depth (paired-extraction lane)".

## Trust Posture Wiring — MUST-9 (lane depth)

Applies to **MUST-9** ONLY (added 2026-09-12, co-owner-directed); canonical-8-field per `trust-posture.md` MUST-8. The block above keeps MUST-1..8.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm each lane with queued items fanned out under the partition contract, and refill packed an open lane before a new one opened); at the hook layer `halt-and-report` is the CEILING and the dispatch check is `advisory` — NEVER `block`: whether an item set decomposes is judgment, which `hook-output-discipline.md` MUST-2 keeps off `block`.
- **Grace period:** 7 days from clause landing (2026-09-12 → 2026-09-19).
- **Cumulative posture impact:** same-class violations (a lane run as one serial worker while items queue; a worktree opened to isolate an agent or a build; a lane opened while an open lane could take the item) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key. Named deviation per Rule 8, on this clause's own ground: an under-packed lane loses throughput, never content, and decomposability resolves only at review; a key would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: wip-discipline]` IFF `posture.json::pending_verification` includes the `wip-discipline` rule_id (one ack covers MUST-1..9).
- **Detection mechanism:** **SessionStart** — `hooks/wip-discipline-guard.js::runSessionStart` + the per-lane depth report from `hooks/lib/wip-lanes.js::laneDepth`; fixtures `.claude/audit-fixtures/wip-discipline/run.mjs`. **Dispatch** — `hooks/lib/dispatch-contract.js::detectLaneBriefWithoutPartition` via `hooks/dispatch-contract-guard.js` at `PreToolUse:Task|Agent`, `advisory` (prose signal); fixtures `.claude/audit-fixtures/dispatch-contract/`. **Turn end** — `hooks/lib/delegation-default.js::detectUnderPackedLane` via `hooks/delegation-default-guard.js` at `Stop`, `halt-and-report`; fixtures `.claude/audit-fixtures/delegation-default/`. All three arms are CC `settings.json` registrations, unmirrored at Codex/Gemini. **Ledger** — every item records its lane through `hooks/lib/todo-durable.js`'s `lane: <branch>` binding; an item without one is reported UNBOUND, never folded into a clean total. **Planning** — `commands/todos.md`, `commands/implement.md`. **Probes: REGISTERED** — pair `MUST-9-firing` in `.claude/test-harness/probes/wip-discipline.probes.json`; a green CI run is NEVER evidence it passed.
- **Violation scope:** MUST-9 ONLY. Every `violations.jsonl` row names the lane, its queued items, the agents dispatched, and which half failed — fan-out, partition, or refill-before-open.
- **Origin:** See § Origin (MUST-9).

## Distinct From / Cross-References

**Distinct from** `artifact-stranding.md` — that governs whether an AUTHORED ARTIFACT is in force
(reachability); this governs whether a LANE is finished (inventory). **Composes with**
`worktree-isolation.md` Rule 8 and `orchestration-launch-ledger.md` MUST-1.

## Origin

Full provenance chain, the measured instances and the per-extraction record: the extract § "Origin — full narrative". **MUST-9** — 2026-09-12, co-owner-directed; receipts `journal/0607` + `journal/0608`.

**Length rationale (per `rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Body exceeds 200 lines. Named rationale: **single-lifecycle scope**; depth is EXTRACTED to `guides/rule-extracts/wip-discipline.md` to hold the per-rule injection allowance.

Depth — the rationale body, the nine-clause enumeration (each carrying its DO/DO-NOT, `**Why:**`, BLOCKED corpus and clause-scoped Wiring) and the sibling precedents — lives in `.claude/guides/rule-extracts/wip-discipline.md` § "Relocated 2026-09-13 — rule-body depth (paired-extraction lane)".
