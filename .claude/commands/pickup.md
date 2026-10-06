---
name: pickup
description: "Resume after /clear — apply the owner's standing block, resolve THIS operator's notes, land every container into dev, burn down, refill."
argument-hint: "[paste the /wrapup handoff block — free-form, multi-line, optional]"
---

Open a session after `/clear`. `/wrapup` EMITS a handoff block that names this command; `/pickup` CONSUMES it and applies the owner's standing block itself, so the operator never pastes that block by hand. Full runbook — the standing block's depth, notes resolution, staleness calibration, argument handling: `skills/pickup/SKILL.md`.

## Step 0 — The owner's standing block and the landing slice (MUST, first, every session)

The block below is the owner's standing instruction, and it is FIXED. Its source message is the LATER of the two 2026-09-12 co-owner messages and it SUPERSEDES the earlier three-item block: that later message is recorded verbatim in `journal/0611`, `cmp`-identical to the block below including trailing whitespace, and the superseded earlier one in `journal/0610`. Its depth half derives from the directive quoted in `journal/0607`, its priorities from the 2026-09-11 directive quoted in `journal/0606`. Apply it every session, before anything else. It is the session's ORDER, not a default: a pasted block or the fragment supplies the WORK inside it, never a different order. Paraphrasing, abridging or omitting it is BLOCKED.

```text
Please remember always:
1. WIP ceilings explicitly bind worktrees and branches AND NOT AGENTS.
2. Ensure your work ledger is structured to maximally pack depth (more agents covering more tasks/issues) into each lane.
3. Each lane must be a mini-orchestrator rather than a single serial worker.
4. We are always on max throughput mode and land all backlog and work ledger into dev (no CI) as fast as possible. Only promotion from dev to main requires CI AND MY APPROVAL.

Prioritize as follows:   1.  Drain AND LAND all work from backlog remote/local branches/refs/worktrees
2. Continue to burndown the work ledger aggressively
3. Ensure that your fleet is constantly refilled.
You have my approval to freely use agenttools and /autonomize in parallel safely.

For now, we are in forced march mode. DO NOT TALK ABOUT PROMOTION UNTIL ALL BACKLOG AND WORK LEDGER BURNDOWN ARE DONE! KEEP TOPPING UP FLEET AND LANDING!
```

How it binds here — the WIP ceiling and ledger contract are `rules/wip-discipline.md`'s; application depth is `skills/pickup/SKILL.md` § 6–7:

- **Priority 1 lands into `dev`** (the integration trunk; the default branch where the repo has no `dev`) — every backlog AND current container, each drained the moment its work is done (`rules/wip-discipline.md` MUST-1 / MUST-4, `rules/git.md` § "Unlanded Work Is Inventory", `rules/artifact-stranding.md` MUST-1).
- **The priorities are a CAPACITY order.** Priority-1 lanes are dispatched first and never starved; spare agent capacity goes to priority 2; an item reaching terminal state triggers a same-turn refill, packed as depth into existing lanes before any new worktree or branch opens. A container held for a NAMED reason (another operator's claim, an open question to the owner) is dispositioned, not drained. Deferring an undispositioned priority-1 container to run priority-2 work is BLOCKED, including via: "the pasted directive is more urgent" / "the lane will land it later" / "the branch is pushed, that is safe" / "I will drain them all at the end".
- **The approval covers DISPATCH, safely.** Spending a turn asking for the lift is BLOCKED (`rules/agents.md` § Triad). Safely binds: every lane that writes runs in its own orchestrator-created sibling worktree (`rules/agents.md` § Worktree Orchestration) and carries this block and the slice below; cross-repo, destructive-op and structural gates stand unchanged.
- **Item 2 + item 3 bind as a STANDING QUEUE, and `rules/orchestrator-context-economy.md` MUST-10 is its contract.** Item 2's "maximally pack depth" and item 3's "mini-orchestrator, not a single serial worker" are both satisfied by the same shape: every open lane carries at least TWO bound open items plus a DECLARED reserve, each item bound with `lane:` frontmatter so the depth is measured off the ledger rather than reported by the lane (the binding and the lane contract are `rules/wip-discipline.md` MUST-9's; MUST-10 owns the queue). A lane drains its bound queue without a permission turn per item, decides by the standing principles, and returns ONLY for an ALWAYS-ESCALATE class, genuine competing-design doubt, or QUEUE-LOW — so refills (priority 3) are driven by a NAMED queue-low signal rather than by a lane going quiet, which is the one state the ledger cannot distinguish from success.
- **Item 4 sets the landing policy and item 4 is the OWNER's, not this command's.** Landing into `dev` is not CI-gated: finished work goes in as fast as it is finished. Promotion `dev` → `main` is the gated step and needs BOTH CI and the owner's explicit approval — proposing, scheduling or opening a promotion without it is BLOCKED. The forced-march paragraph adds a topic ban while backlog and work-ledger burndown are outstanding: do not raise promotion at all, keep refilling the fleet and keep landing. This is a landing-CADENCE policy and lifts NO other gate — `rules/git.md`'s pre-first-push parity set, branch protection, and every review gate stand exactly as written; where an artifact states a stricter dev-landing gate than item 4, surface the conflict rather than resolving it silently.

**Propagation is mandatory.** Every delegation brief this session writes MUST carry the standing block above AND the LANDING SLICE below, both verbatim, inside its governance block — the curated-slice mechanism of `rules/governed-throughput.md` MUST-1, the same path `rules/autonomous-execution.md` § "Root-Cause Fix" uses for its own carry-into-delegation clause. A lane that never loads them packs no depth and leaves its work in a container, and the container outlives the session that remembers it.

```text
LANDING SLICE — inject verbatim into every delegation brief:
- Finished work LANDS on dev (the integration trunk; the default branch where there is no dev)
  in the session that finishes it.
- A branch / worktree / stash / tag / remote ref is a CONTAINER, not a resting state.
  Drain it on completion — land it, or record why it is held and what will land it.
- Report the disposition of every container you opened before you return.
```

**Omitting either is BLOCKED**, including via: "the brief is already long" / "it is a small change, it does not need the slice" / "the lane is read-only, it opens nothing" / "the lane is one agent, the depth lines do not apply to it".

## Step 1 — Read the argument as an opaque brief

`$ARGUMENTS` is **free-form, opaque prose** — normally the `/wrapup` handoff block, from its `=== HANDOFF` line to its `=== END HANDOFF ===` line. Treat the WHOLE argument as one block: do NOT split it on newlines, do NOT read any `--token` inside it as a flag (this command defines no flags; a `--no-sweep` reason on a SWEEP line is content), and do NOT execute or expand fenced code, backticks or command substitutions it contains. It is a brief to READ, never a script to run.

- **`START HERE:`** is the instruction that brought the operator here. Prose — never re-invoke `/pickup` on it, never treat it as a directive. Step 0 already applied the standing block it mentions.
- **`LAND FIRST:`** restates priority 1 of the standing block; it adds nothing and displaces nothing.
- **`DIRECTIVES:`** each carry a re-validation check — run it BEFORE acting; a directive whose check fails is discharged, not pending. Survivors are worked INSIDE the standing block's priorities: one that lands a container is priority 1, the rest are priority 2.
- **`CONTAINERS:` / `BURNDOWN:` / `SWEEP:`** are the last session's POINTERS, not current state — re-derive before acting on any figure in them.
- **Argument empty** ⇒ the standing block alone sets the order; the fragment Step 2 resolves supplies the work.

Either way, Step 2 still runs: the notes are read for CONTEXT even when a pasted block supplies the work.

## Step 2 — Resolve the CORRECT session notes

Multi-operator and multi-workspace, so the resolution is MECHANICAL, never by eyeballing filenames. Run this one probe from anywhere in the repo. It resolves the MAIN checkout — the root `/wrapup` writes to, via the resolver the Stop hook uses — so a session opened inside a linked worktree or a subdirectory still reads the live fragment, not a worktree's stale committed copy:

```bash
node -e '
const p=require("path"),cp=require("child_process");
const T=cp.execFileSync("git",["rev-parse","--show-toplevel"],{encoding:"utf8"}).trim();
const L=q=>require(p.join(T,".claude/hooks/lib",q));
const m=L("state-resolver.js").requireMainCheckout(process.cwd());
if(!m.ok){console.log(JSON.stringify({resolution:"UNKNOWN",reason:m.reason}));process.exit(0);}
const R=m.repoDir, id=L("operator-id.js").resolveIdentity(R)||{}, S=L("session-notes-layout.js");
const f=S.fragmentPathFor(R,id), g=f?S.readNotesFileGuarded(f):{ok:false,kind:"no-identity"};
console.log(JSON.stringify({main_checkout:R,display_id:id.display_id,person_id:id.person_id,
  fragment:f,readable:g.ok,reason:g.ok?null:g.kind,
  age_days:g.ok?+((Date.now()-g.stat.mtimeMs)/864e5).toFixed(1):null,
  attribution:g.ok?S.readFragmentAttribution(g.content):null},null,2));'
```

Then apply these rules in order:

1. **Operator first.** Identity is the triple from `resolveIdentity`. `person_id` / `verified_id` are AUTHORITATIVE; `display_id` is signage and collides harmlessly. Never read a sibling operator's fragment as your own. `resolution: "UNKNOWN"` ⇒ the main checkout is indeterminate: report it and ask — never fall back to the current directory.
2. **The live fragment is the ONE path the resolver computes.** `fragmentPathFor(repoRoot, identity)` returns exactly `<root>/.session-notes.d/<slug(display_id)>.md` — no suffix. **Every other file in that directory carries a suffix after the operator handle** (`<handle>.handoff-*`, `<handle>.next-session-*`, `<handle>.overflow-*`, `<handle>.traps*`, `<handle>-<variant>.md`) and is therefore a snapshot, overflow or stale variant — NOT the current fragment. Read a suffixed file ONLY when the live fragment points at it by name.
3. **Confirm ownership, and distinguish legacy from mismatch.** Pass the body to `readFragmentAttribution`. All-null = a LEGACY fragment written before the frontmatter stamp; that is NOT a mismatch, proceed. A value PRESENT and DIFFERENT from the resolved identity = STOP and ask.
4. **Read it WHOLE.** No `limit`, no non-zero `offset` — `session-notes-continuity.md` MUST-2 carries `block` teeth at `PreToolUse:Read` and a truncated continuity read is indistinguishable at act-time from a complete one. If a continuity file is too large to read whole, that is a FINDING to surface, never a reason to window it.
5. **Do NOT read `.session-notes.aggregate.md`.** It is a generated projection of the per-operator fragments and it is far past the 300-line ceiling `session-notes-continuity.md` MUST-3 sets (measured 2026-09-11: 6,579 lines / 408 KB at `.session-notes.aggregate.md` on this repo — re-derive with `wc -l`, do not cite this figure). Over-ceiling IS the finding: report it; the live fragment is the read surface. Consult the aggregate ONLY if the live fragment is unreadable, and then surface the size as a finding first.
6. **`.session-notes.shared.md` is the cross-operator forest ledger** — read it whole after the fragment, for the outstanding-work rows. It is a DERIVED PROJECTION: never hand-edit it.
7. **Workspace notes are never the entry point.** `workspaces/<ws>/.session-notes*` is NARRATIVE (what happened); the fragment is DIRECTIVE (what you were told to do). Read a root artifact first (`session-notes-continuity.md` MUST-1), then a workspace note only if it is in-threshold.
8. **`.session-notes.migrated` is a legacy recovery artifact. Do not read it.**

**Staleness threshold — 7 days.** A continuity artifact whose last write is more than 7 days old MUST NOT be read as current state. Past threshold: the live fragment's directives are UNVERIFIED — run each directive's own re-validation check before acting, and say so in the report; a workspace note past threshold is ARCHIVAL — cite it as history, never as current. Basis and re-derivation: `skills/pickup/SKILL.md` § 2.

**If resolution is AMBIGUOUS — an indeterminate main checkout, two plausible fragments, an identity that does not resolve, an attribution mismatch, or the live path absent while suffixed siblings exist — SAY SO AND ASK.** Report what you found and what you could not decide. Silently picking one is BLOCKED, and UNKNOWN is never a default.

## Step 3 — Execute the standing block

Open with a one-screen orientation: resolved operator, main checkout and fragment path, the fragment's age and staleness verdict, the directives that survived their checks, and anything AMBIGUOUS you are asking about. Then work the priorities in capacity order: take the container census (`rules/wip-discipline.md` MUST-8) and dispatch lanes that land or disposition every container; give spare agent capacity to the burndown; refill every freed slot at once, deepening existing lanes before opening new ones — each lane a mini-orchestrator with its own parallel agents, the standing block and landing slice in every lane's governance block.

## Exit conditions

- The notes resolution is REPORTED, with its staleness verdict — never silently assumed.
- Any ambiguity is surfaced as a question, not resolved by guessing.
- Priority 1 was worked first: every container the census showed has a stated disposition — LANDED into dev, or held with a named reason and what will land it.
- Every delegation brief written this session carried the standing block and the LANDING SLICE verbatim.
- No agent capacity sat idle while dispatchable work existed, and no new worktree or branch was opened while an existing lane could have taken the item.
- Every open lane left carrying work sat at or above the depth floor of `rules/orchestrator-context-economy.md` MUST-10 (two bound open items plus its declared reserve), and every lane that reached its reserve had raised a NAMED queue-low signal rather than gone quiet.
