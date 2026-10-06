---
name: pickup
description: "Resume after /clear — apply the owner's standing block, resolve THIS operator's notes, land every container into dev, burn down, refill."
---

Excerpt from a slash-command body: the standing-block step and the notes-resolution step.

## Step 0 — The owner's standing block and the landing slice

The block below is the owner's instruction. Apply it every session.

```text
Please remember always:
1. WIP ceilings explicitly bind worktrees and branches AND NOT AGENTS.
2. Ensure your work ledger is structured to maximally pack depth (more agents covering more tasks/issues) into each lane.
3. Each lane must be a mini-orchestrator rather than a single serial worker.
4. We are always on max throughput mode and land all backlog and work ledger into dev (no CI) as fast as possible. Only promotion from dev to main requires CI AND MY APPROVAL.

Prioritize as follows:
1. Drain AND LAND all work from backlog remote/local branches/refs/worktrees
2. Continue to burndown the work ledger aggressively
3. Ensure that your fleet is constantly refilled.
You have my approval to freely use agenttools and /autonomize in parallel safely.

For now, we are in forced march mode. DO NOT TALK ABOUT PROMOTION UNTIL ALL BACKLOG AND WORK LEDGER BURNDOWN ARE DONE! KEEP TOPPING UP FLEET AND LANDING!
```

It is generally a good idea to follow these priorities when there is time; a pasted directive that
looks urgent can reasonably go ahead of the containers, and a short summary of the block is usually
enough in a delegation brief. Why the block matters and depth-first refill: `skills/pickup/SKILL.md` § 6.

**BLOCKED rationalizations for omitting the landing slice:**

- "The lane will land it later" (later is a different session, which has no memory of the container)
- "The branch is pushed, so the work is safe" (pushed is not landed; a remote ref is a container)
- "I will drain them all at the end" (the batch at the end is how a forest of 50 accumulates)
- "The brief is already long" (the slice is four lines; the re-derivation cost is a whole session)

## Step 2 — Resolve the correct session notes

Run the resolver probe; the live fragment is the one path `fragmentPathFor` computes from the main
checkout. Read it whole.

| Surface                                 | Disposition                                                   |
| --------------------------------------- | ------------------------------------------------------------- |
| `fragmentPathFor(root, identity)`       | THE live fragment. Read WHOLE.                                |
| `.session-notes.d/<handle>.<suffix>.md` | Snapshot / overflow. Read ONLY if the live fragment names it. |
| `.session-notes.d/<other-handle>*.md`   | Another operator. Never read as your own.                     |
| `.session-notes.aggregate.md`           | Generated projection, over ceiling. Do NOT read.              |

The slug contains no dot, so the live fragment is the only file whose stem is exactly the slug;
`operator.handoff-s89.md` and `operator.next-session-s98.md` have longer stems. MEASURED 2026-09-11:
63 distinct write-days, p90 gap 1 day, maximum gap 5 days, zero gaps above 7 — so the threshold is
7 days. Ambiguous resolution ⇒ say so and ask. Decision table and staleness calibration:
`skills/pickup/SKILL.md` § 1–2.
