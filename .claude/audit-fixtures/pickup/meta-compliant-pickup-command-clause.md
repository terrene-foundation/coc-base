---
name: pickup
description: "Resume after /clear — apply the owner's standing block, resolve THIS operator's notes, land every container into dev, burn down, refill."
---

Excerpt from a slash-command body: the standing-block step and the notes-resolution step.

## Step 0 — The owner's standing block and the landing slice

The block below is the owner's instruction, FIXED and VERBATIM. Apply it every session, before
anything else; a pasted brief supplies the work inside it, never a different order. Paraphrasing,
abridging or omitting it is BLOCKED.

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

- **The priorities are a CAPACITY order.** Priority-1 lanes are dispatched first and never starved;
  spare agent capacity goes to priority 2; refill packs depth into existing lanes before any new
  worktree or branch opens. A container held for a NAMED reason is dispositioned, not drained.
  Deferring an undispositioned priority-1 container to run priority-2 work is BLOCKED, including via:
  "the pasted directive is more urgent" / "I will drain them all at the end".
- **Propagation is mandatory.** Every delegation brief carries this block and the landing slice,
  both verbatim. Omitting either is BLOCKED.

Why the block is carried verbatim, why the order never yields to a pasted brief, and depth-first
refill: `skills/pickup/SKILL.md` § 6.

## Step 2 — Resolve the correct session notes

Multi-operator and multi-workspace, so the resolution is MECHANICAL, never by eyeballing filenames.
Run the resolver probe. It resolves the MAIN checkout, so a session opened inside a linked worktree
still reads the live fragment rather than that worktree's stale committed copy.

1. **Operator first.** Identity is the resolver's triple; never read a sibling operator's fragment as
   your own.
2. **The live fragment is the ONE path the resolver computes.** Every file with a suffix after the
   handle is a snapshot — read it ONLY when the live fragment names it.
3. **Read it WHOLE.** A truncated continuity read is indistinguishable at act-time from a complete one.
4. **Do NOT read `.session-notes.aggregate.md`** except as a fallback, surfacing its size first.

If resolution is AMBIGUOUS, SAY SO AND ASK; silently picking one is BLOCKED. Decision table, root
resolution and the staleness calibration: `skills/pickup/SKILL.md` § 1–2.
