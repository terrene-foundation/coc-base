# Fleet Operations — Roles, Liveness, Stall Watchdog, Review Seating, Token Discipline

Depth for `commands/pickup.md` Step 0 (the fleet-mode bullet) and for the fleet pointer a seed
carries in STANDING (`skills/wrapup/cycle.md`). It binds from a session's FIRST turn whenever a repo
runs a FLEET — two or three sessions working one repo at once. A single-session repo skips §§ 1–4
and keeps §§ 5–10. Roles are named by duty, never by vendor, model or person.

This file does not restate what it cites: the lane contract is `skills/lane-planning/SKILL.md` and
`rules/wip-discipline.md`; the review rounds are `rules/agents.md` § Triad; the standing queue is
`rules/orchestrator-context-economy.md` MUST-10; the root-cause default is
`rules/autonomous-execution.md`. It adds who does what, how a quiet session is noticed, and how the
fleet spends tokens.

## 1. Resolve your role before the first dispatch (MUST)

| Role                                                | Owns                                                                                                                 | Never                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **ROOT** orchestrator                               | the forest, the plan, owner comms, verification, review seating — AND half the work, run through its own subagents  | seats a review with the author                                 |
| **Second orchestrator**, on a different CLI         | its share of the backlog, drained through its own subagents; the backup orchestrator when ROOT is absent            | reviews its own work; lands                                    |
| **Lander-builder** (optional), every launch at max  | landing, measuring, reaping — AND bounded fix and build shards, security fixes included, through its own subagents  | reviews its own work; sits the adversarial SECURITY seat       |

- The fleet is two or three sessions. No other session joins unless the owner adds one.
- ROOT and the second orchestrator SPLIT the backlog; both stay at forest level and let subagents
  do the details (`rules/orchestrator-context-economy.md` MUST-8).
- Owner comms are ROOT's alone. The ORCHESTRATOR escalation destination is ROOT — the second
  orchestrator only while it acts as backup.
- Every lander-builder build gets a PAIRED review that ROOT seats. The lander-builder MAY sit a
  CORRECTNESS seat on work it did not author; the adversarial security seat stays ROOT-seated.
- With no lander-builder, landing and reaping go to a max-effort lander subagent launch of an orchestrator —
  never into the second orchestrator's own work, never into a review seat.
- The seed ROLE token per role is `skills/wrapup/cycle.md` § The seed, ROLE bullet.

```text
# DO — orientation, first turn
"Role: second orchestrator. Share: lanes A and B. Reviews of my work: ROOT seats them."
# DO NOT — role resolved after work started
second orchestrator lands its own lane and counts its own self-review as Round 1
```

**Why:** two working orchestrators double throughput only when each knows its share and neither
marks its own work; a role resolved late is a review seated by its author.

## 2. Size each launch by duty, and set its effort explicitly (MUST)

Every subagent launch carries an explicit effort level (the EFFORT line, `skills/lane-planning/SKILL.md`
§ 5); a launch without one is a defect.

| Duty                                                                 | Seat                                   |
| -------------------------------------------------------------------- | -------------------------------------- |
| design, review, the adversarial security seat                        | ROOT's model, medium effort            |
| thoroughness over speed; standby backup orchestrator                 | second orchestrator, high effort       |
| fixes that need judgment                                             | second orchestrator, medium effort     |
| mechanical shards ONLY                                               | second orchestrator, low effort        |
| landing, measurement, bounded builds and fixes of the medium/high class | lander-builder, max effort          |

Design and security questions never go to a low-effort launch.

**Why:** a launch with no effort runs at whatever the harness defaults to, so the seat a duty needs
is decided by accident.

## 3. Workhorse liveness — a queue never sits idle (MUST)

A workhorse is the second orchestrator or the lander-builder.

- A workhorse NEVER ends its turn while work is queued: it reports a milestone or names a blocker.
- It holds a DEEP standing queue it can drain without waiting on ROOT, and decides by the standing
  principles (`rules/orchestrator-context-economy.md` MUST-10).
- Messages to ROOT carry decisions, blockers, landing requests, final results, QUEUE-LOW signals and ALWAYS-ESCALATE findings, batched into
  ONE message — never acks, progress or FYI.
- The handover threshold is a CHECKPOINT, not a stop: write the seed, then keep working; with no
  owner present to clear, autocompaction carries the queue (`skills/wrapup/cycle.md` § After the
  line). This binds ROOT and every workhorse, and ROOT carries this line into every workhorse brief.

```text
# DO — "Milestone: lane A landed at <sha>; draining item 3 of 5. Blocker: none."
# DO NOT — "Done with item 2, standing by." — then idle with three items queued
```

**Why:** every message wakes the receiver's whole context, and an idle workhorse with queued work is
the one state ROOT cannot tell apart from a busy one.

## 4. ROOT stall watchdog — re-created in EVERY ROOT session (MUST)

At session start ROOT schedules a recurring check every ~20 minutes, off the :00 and :30 marks, with
the CLI's recurring-schedule primitive (Claude Code: `CronCreate`; the job dies with the session so each new ROOT session re-creates it). Where the CLI has no such primitive,
ROOT runs the same check at every turn end. Prompt shape:

```text
Snapshot each workhorse's surfaces — lander-builder: the integration-trunk HEAD and its durable
train dirs; second orchestrator: its worktree HEADs and scratch dirs. Diff against the previous
snapshot. A workhorse with queued work and no commit, run or report since then gets ONE wake ping.
Never take its work over.
```

A stall seen between checks gets the same single ping at once. Taking the stalled work over is
BLOCKED — the ping is the whole remedy.

**Why:** from ROOT's chair a stalled workhorse looks exactly like a busy one; only a diff of its
surfaces tells them apart, and a schedule that died with the previous session watches nothing.

## 5. Review seating (MUST)

The rounds are `rules/agents.md` § Triad (R1 full and paired on trust surfaces; R2 on fixes and their
blast radius; no Round 3; an open CRITICAL/HIGH goes to the owner). The fleet adds the seating:

- The reviewer is a separate session or agent, NEVER the author. A self-review is not a round.
- NEVER review a moving branch: pin the SHA the review reads; a new commit voids the pin.
- An errored or empty reviewer is not a clean round; re-run it
  ([canonical review-dispatch evidence](../../../.claude/skills/30-claude-code-patterns/redteam-dispatch-evidence-gate.md)).

**Why:** an author reviewing its own work shares the blind spot that produced the defect, and a
review of a moving branch reports on a tree that no longer exists.

## 6. The workhorse brief (MUST)

A build or fix brief to a workhorse is: ONE bounded task + the named files + a pinned base SHA + a
`done =` line + a hard stop, with this paragraph pasted verbatim:

```text
Review rounds are mine; your self-reviews don't count, don't run them. Scope is frozen; new
findings go to the ledger, not commits. When done, FREEZE and report once in plain sentences:
SHA, commits, tests + pass lines. ROOT's GO sequences on-task steps only inside the owner's recorded
standing grant. Without that grant, landing, deletion and installs require HUMAN approval.
```

**Why:** an unbounded brief grows its own scope, and a workhorse that self-reviews and lands has
removed both gates it was supposed to pass through.

## 7. Landing and reaping (the lander-builder's duty)

- Verified, reviewed work lands within the owner's recorded standing grant; without it, ask the HUMAN.
  An idle worktree is not permission to land or delete it. Deletion requires the owner's grant or
  HUMAN approval, a clean-tree check and a recorded KILLED reason (`rules/wip-discipline.md` MUST-1).
- Land only verified, reviewed work. Unverified work goes back to its owner, never onto the trunk to
  empty a tree. Copy a worktree's gitignored evidence out before removing it.
- Split the train: a lane that is not clean never blocks lanes that are.
- Verify every claimed SHA, hash and pass line yourself before acting on it
  (`rules/evidence-first-claims.md`).

## 8. Reporting and deciding

- Print the burndown table at every report — forest | description | owner | state | ETA in sessions
  — beside the movement report of `rules/orchestrator-context-economy.md` MUST-9.
- Proceed autonomously and adopt the root-cause, long-term fix without asking, balancing release
  speed against investment in the near future (`rules/autonomous-execution.md` § Root-Cause Fix).

## 9. Token discipline (every session and every workhorse)

1. **Lean briefs** — exact files plus pasted excerpts; never "explore".
2. **Fresh, short agents** — one task, then exit; never grow one long-lived agent.
3. **Read once** — pass the diffs and snapshots already held; N agents must not each re-read the same
   large files.
4. **Freeze, then test** — one qualification run on the frozen SHA; never discard a run.
5. **While fixing**, run only the failed test plus the touched modules. **At sign-off**, run the FULL
   owed union, every band, once — never a hand-picked suite list, which is how regressions get through.
6. **Never edit a test to match a bug** — fix the source.
7. **Terse returns** — SHA, pass lines, findings; big output goes to a file and the path is passed.
8. **Kill loops** — when the diff keeps growing or findings keep coming, freeze, review what exists,
   and ledger the rest.
9. **A guard time-out under load is a BUDGET REFUSAL, not a deny** — retry once, wait 2 minutes and
   retry once more, then hold that one action and continue. Never bypass the guard.
10. **Measure each wave** — tokens read per unit of finished output; when it is high, find the
    broken rule.

## 10. Release cadence — done means users can use it

- **DONE = users can use the feature end to end**: released to the main branch AND delivered to the
  users who run it. "On the trunk", "landed" or "reviewed" is never reported as done.
- **Usable slice first.** For every epic, define the smallest piece a user can run end to end and
  ship it before any hardening; report ETA-to-usable separately from ETA-to-full-epic.
- **Triage every finding by category before it gets work** (`rules/product-completion-first.md`):
  a BUG on the slice rides the slice; INVEST-NOW goes next, ahead of features; INCREMENTAL goes to
  the backlog and never joins an epic being closed.
- **Scope freeze**: once a slice is chosen, new findings go to the backlog, never into the slice.
- **Ship small and often**: land each item the moment it is reviewed within § 7; no lane lives past 24 hours;
  no big trains. Promotion cadence defers to the standing policy in `commands/pickup.md`: during
  its forced march, do not raise promotion while backlog and work-ledger burndown remain outstanding;
  otherwise promotion still needs CI and the owner's approval.
- **Two epics in flight at most**: a main track (ROOT + lander-builder) and a parallel track (second
  orchestrator) on files that do not overlap.
- **Delivery to templates or downstream projects is a separate, owner-gated lane.** ROOT prepares it
  — what each target gets, the hook switch-over, the rollback — and reports it READY; nothing is
  delivered before the owner's go, and each target needs the owner's yes plus its receipt.
- **Report every turn, per epic**: the usable slice, its state, ETA-to-usable, then the next release
  roadmap.

## BLOCKED rationalizations

- "ROOT is busy, so the second orchestrator can review this one itself"
- "the watchdog was scheduled last session"
- "the workhorse is probably still running, no need to look"
- "pinging it is not enough, I'll just finish its item"
- "it's the handover threshold, so I'll stop and wait for a /clear"
- "the effort default is fine for this launch"
- "the lander-builder already reviewed it for correctness, so the security seat is covered"

## Origin

Owner-directed fleet operating instructions, 2026-10-16 to 2026-10-20 (roles, liveness, stall
watchdog, review seating, token discipline, never idle at the handover threshold, release cadence),
adopted into canon by the EP-3 fleet-mode shard.
