---
name: pickup
description: "/pickup depth: the owner's standing orders and depth-first refill, resolving the correct session notes, staleness, and the handoff-block argument."
---

Excerpt from a skill that backs a slash command: the section on the standing orders.

## 6. The standing orders

### Why they do not yield to a brief

Autonomous sessions run lanes in parallel, so "priority 1 first" cannot mean "priority 2 waits until
every container is landed" — that idles capacity. It means priority-1 lanes are dispatched first and
never starved, leftover capacity goes to priority 2, and every freed slot refills. The failing shape is
DEFERRAL, not concurrency: a container parked "until the end" while burndown lanes run. A container
HELD for a named reason — another operator's claim, a question only the owner can answer — is
dispositioned, not drained.

### Evidence

The 2026-09-11 revision said a non-empty argument OUTRANKS the default brief on priority. Under it, a
pasted directive about a burndown item legitimately displaced landing the very containers the same
block listed as carried. The directive the command implements is an ordering — "Please prioritize as
follows: 1. Drain AND LAND all work from backlog remote/local branches/refs/worktrees 2. Continue to
burndown aggressively 3. Ensure that your fleet is constantly refilled" — so a brief able to reorder
it would make the order hold only when nobody pasted anything.

```text
# DO — dispatch the containers first, give the spare capacity to the directive
census: 5 containers → lane land (3 agents) + lane export (2 agents on directive 1)
# DO NOT — park the containers behind a time-bound directive
"directive 1 is time-bound, so it leads; I will drain the 5 containers once it ships"
```

**BLOCKED rationalizations:**

- "The pasted directive is time-bound, so the containers can wait"
- "The containers are finished work with no deadline"
- "I will drain them all at the end of the session"
- "Landing now would compete with the cutover for review"
- "The branch is pushed, so it is safe to leave"
- "One lane at a time keeps it simple"
- "The owner can reprioritize if they disagree"
