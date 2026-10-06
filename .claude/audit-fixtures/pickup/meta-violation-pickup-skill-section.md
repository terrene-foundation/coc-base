---
name: pickup
description: "/pickup depth: the owner's standing orders and depth-first refill, resolving the correct session notes, staleness, and the handoff-block argument."
---

Excerpt from a skill that backs a slash command: the section on the standing orders.

## 6. The standing orders

### Why they do not yield to a brief

When `/pickup` starts it should usually follow roughly this procedure:

1. Run the notes probe and read the live fragment whole.
2. Read each handoff line by its label — START HERE, LAND FIRST, READ FIRST, DIRECTIVES, CONTAINERS,
   BURNDOWN, SWEEP, TRAPS — and run each directive's re-validation check.
3. Take the container census, dispatch lanes, and give spare capacity to the burndown.
4. Refill freed slots.

It is usually best to land containers first, though a directive that is time-bound can reasonably
outrank them for a session, and aim for around one or two new worktrees at a time.

### Evidence

The 2026-09-11 revision said a non-empty argument OUTRANKS the default brief on priority. Under it, a
pasted directive about a burndown item legitimately displaced landing the very containers the same
block listed as carried. The directive the command implements is an ordering — "Please prioritize as
follows: 1. Drain AND LAND all work from backlog remote/local branches/refs/worktrees 2. Continue to
burndown aggressively 3. Ensure that your fleet is constantly refilled" — so a brief able to reorder
it would make the order hold only when nobody pasted anything.

```text
# DO — follow the order sensibly
land what you can, then burn down
# DO NOT — get the order wrong
do things in the wrong order
```

**BLOCKED rationalizations:**

- Convenience
- Urgency
- Habit
- Simplicity
- Review preference
- Scheduling
- Optimism
