---
name: lane-planning
description: "Lane planning — group todos into lanes (one worktree + branch each) and run each lane as a mini-orchestrator. Use when work queues behind the WIP limit while open lanes run one serial worker."
---

# Lane Planning — Pack Depth Into Each Lane

The depth behind `/todos` Step 3c and `/implement` Step 3. The contract itself — what a lane is, what
the WIP ceiling counts, and the partition rules inside one worktree — is `rules/wip-discipline.md`
MUST-2 and MUST-9; the owner's standing block in `commands/pickup.md` Step 0 carries it in the
words every lane brief uses (§ 5). This skill is the HOW: grouping todos into lanes, sizing them,
spotting an under-packed lane, and the brief each lane receives.

## 1. The two units, and which one is scarce

| Unit      | What it is                       | Bounded by                                          |
| --------- | -------------------------------- | --------------------------------------------------- |
| **Shard** | one todo, done by ONE agent      | `rules/autonomous-execution.md` capacity budget     |
| **Lane**  | one worktree + one branch        | the WIP ceiling, `rules/wip-discipline.md` MUST-2   |

The ceiling counts INVENTORY — unlanded branches and worktrees — never WORKERS, as
`rules/wip-discipline.md` MUST-2 defines it and every other surface cites it. An agent creates no
branch, no worktree and no unlanded commit, so adding agents to a lane costs nothing against the
ceiling. Lanes are the scarce unit; agents are not. **A shard is sized per agent; a lane packs many
shards.** Planning that treats agents as scarce (one serial worker per lane) and lanes as cheap (a
new worktree per agent) inverts this and queues work behind the limit while open lanes sit idle.

## 2. Grouping procedure at `/todos`

1. **Name each todo's write set** — the files it will create or change. Read-only work has no write
   set.
2. **Start from the wave.** A lane carries todos from ONE wave (`rules/wave-loop.md` MUST-1), because
   a lane lands as a unit and the inter-wave gate fires on landed work.
3. **Merge on overlap.** Todos whose write sets overlap go in the SAME lane, in a stated order. Split
   across lanes they conflict at merge; run concurrently in one lane they overwrite each other.
4. **Pack disjoint todos into lanes that already exist** — open lanes first, then lanes planned
   earlier in this pass — before planning a new lane.
5. **Open new lanes only into free ceiling capacity**, counted as `rules/wip-discipline.md` MUST-2
   defines it. Overflow is QUEUED onto an existing lane (`rules/wip-discipline.md` MUST-7(b)), never
   opened as an extra lane.
6. **Bind each todo to its lane** in the work ledger: a `lane: <branch>` key in the todo file's leading
   `---` frontmatter, naming the lane's branch exactly (`hooks/lib/todo-durable.js::LANE_KEY`). A
   missing key reads UNBOUND and a duplicated key or an invalid branch name reads MALFORMED — both are
   reported by the SessionStart lane-depth report (`hooks/lib/wip-lanes.js::laneDepth`), never folded
   into a clean total. That report and the turn-end under-packed check are Claude Code `SessionStart`
   and `Stop` registrations: on Codex and Gemini no hook reports lane depth, so there the binding is
   checked at gate-review.

## 3. How big a lane may get

A lane is bounded by what its orchestrator can partition and land, not by a count of todos:

- **Partition** — every concurrent writer holds a write set disjoint from every other concurrent
  writer in the lane.
- **Landing** — the lane lands as one convergence: its combined invariant surface fits one review
  pass (`rules/wave-loop.md`). Split a lane at an invariant boundary, never at an agent boundary.
- **Concurrency** — the number of agents RUNNING at once follows the throttle-aware launch
  discipline (`rules/worktree-isolation.md` Rule 4): cold-start around three and back off on the
  throttle signal. That paces dispatch inside the lane; it never justifies opening a second lane.

## 4. Under-packing signals

Any one of these means a lane is under-packed — repack before dispatching or opening anything:

- a lane runs as a single serial worker while work is queued — the verdict `hooks/lib/wip-lanes.js::laneDepth` reports as UNDER-PACKED (`rules/wip-discipline.md` MUST-9; journal/0607 decision 1)
- a new lane is planned while an existing lane of the same wave has partitionable todos left
- a worktree is opened per agent, or per todo, when the todos could share a lane
- a todo carries no lane binding, so no surface can count the lane's depth

## 5. The lane brief at `/implement`

The lane orchestrator receives ONE brief. It MUST carry every line below, and MUST pass the first
four into every agent brief it writes in turn:

```text
STANDING BLOCK: <the owner's standing block from commands/pickup.md Step 0, verbatim>
LAND FIRST: finished work lands on the trunk in the session that finishes it. Branches,
worktrees, stashes, tags and every other ref namespace are CONTAINERS, not resting
states - drain each on completion. Carry this line into every delegation brief.
ROOT-CAUSE: where a defect admits a symptom patch and a root-cause fix, implement the
root-cause fix without asking; a same-class gap inside your budget is fixed, not filed.
Carry this clause into every brief you write.
CONTAINMENT: every git call names its tree with an absolute path; any repo fixture lives in
its own temp dir. Writer agents run NO git write. Carry this clause into every brief you write.
WORKTREE: <absolute lane path>  BRANCH: <lane branch>
STEP 0: cd <absolute lane path>, then assert the resolved toplevel equals the resolved cwd; STOP on mismatch.
PARTITION: <todo> -> <agent> -> <write set>   (one row per writer; write sets disjoint)
COMMITTER: you, the lane orchestrator. Writers never commit.
LANDING: where the repo ships a provenance-recording landing script (loom:
.claude/bin/land-lane.mjs), you land this lane ONLY through it, straight onto the integration
branch - never a hand merge, cherry-pick or rebase.
READ-ONLY: dispatch analysis / review / verification agents as needed - unbounded.
BUILD DIRS: each compiling agent uses its own build/output dir inside this worktree.
BUDGET: <work budget>. Return: per todo, what landed, what did not, and why.
```

**Why each line is there.**

- **STANDING BLOCK** — a lane learns that WIP ceilings bind worktrees and branches, never agents,
  only from text in its own brief; a paraphrase is where that inverts into a cap on its agents
  (`skills/pickup/SKILL.md` § 6).
- **LAND FIRST** — a lane that never loads it leaves finished work in a container
  (`rules/wip-discipline.md` MUST-4).
- **LANDING** — landing rewrites commit ids, and only the script writes the source-to-landed link,
  so a hand-landed lane later reads as unlanded and is re-reviewed or re-landed over later fixes
  (`rules/wip-discipline.md` MUST-4). Straight onto the integration branch: re-landing strips the
  first hop's link (loom: `.claude/bin/land-lane.mjs:371-381`).
- **ROOT-CAUSE** — a sub-agent that never loads `rules/autonomous-execution.md` ships the symptom
  patch; the rule requires the orchestrator to carry the clause.
- **CONTAINMENT** — composes with the partition. Writers take `rules/worktree-isolation.md` Rule 10's
  FORBID form (no git writes); only the lane orchestrator commits, under the PIN form (every call
  names the lane worktree).
- **STEP 0** — the worktree path pin alone does not set an agent's working directory
  (`rules/agents.md` § Worktree Orchestration).
- **BUILD DIRS** — build contention is isolated by directory, not by worktree. Point each compiling
  agent's build output at its own subdirectory, for example a per-agent target, virtualenv or dist
  directory.
- **BUDGET** — an agent with no budget that wedges returns silence, and silence reads as progress
  (`rules/agents.md` § A Dispatched Agent's Result Is Not Received Until It Is DELIVERED).

## 6. Refill

When a writer finishes, the lane orchestrator commits its write set and refills the freed slot
depth-first, in the order `skills/pickup/SKILL.md` § 6 sets — agents on todos the lane carries, then
the next queued todo bound to the lane. When the lane lands, the freed capacity pulls from the queue
(`rules/wip-discipline.md` MUST-7(c)) — packed as depth into an existing lane first, a new worktree
or branch only when none can take it.

## 7. BLOCKED rationalizations

- "one worktree per agent is the safe isolation" — the isolation unit is the lane; disjoint write
  sets and per-agent build dirs isolate agents inside it
- "the lane is already running, adding agents risks conflicts" — conflicts come from overlapping
  write sets, which the partition rules out
- "the WIP limit is full, so the work waits" — it waits in a queue on an open lane, which dispatches
  more agents
- "one todo per lane keeps review simple" — review is gate-level at landing, not per todo
- "I'll bind todos to lanes when I dispatch" — an unbound todo makes lane depth unmeasurable at the
  moment it matters

## Origin

Co-owner-directed, 2026-09-12: `journal/0607` (lanes are mini-orchestrators; ceilings bind
worktrees and branches, never agents), amended by `journal/0608` (planning and resumption
commands group work into lanes and dispatch each as a mini-orchestrator).
