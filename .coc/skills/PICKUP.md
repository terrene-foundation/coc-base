---
id: "PICKUP"
name: pickup
description: "/pickup depth: the owner's standing orders and depth-first refill, resolving the correct session notes across operators, workspaces and worktrees, staleness, and the handoff-block argument."
---

# /pickup — Runbook

Depth for `commands/pickup.md`. The command carries the flow; this carries (1) the notes-resolution
decision table and why the root is the MAIN checkout, (2) the staleness calibration and how to
re-derive it, (3) the argument contract for the pasted handoff block, (4) the landing-slice
propagation contract, (5) the ambiguity taxonomy, (6) the owner's standing block — why it is
carried verbatim, why its priorities never yield to a brief, the capacity order, and depth-first
refill — and (7) what "safely" binds in its approval.

`/wrapup` writes the per-operator fragment and emits the handoff block; `/pickup` reads both. They
are the close/open halves of ONE contract: the block's fixed `START HERE:` line names this command,
and its `DIRECTIVES:` — ≤5 imperative orders, each carrying its own re-validation command — are
exactly what Step 1 consumes, whether pasted as the argument or read from the fragment. Provenance
for both commands and for the 2026-09-12 changes: `journal/0606`, which quotes the owner's
directive verbatim.

## 1. The resolution decision table

Every row is decided MECHANICALLY. Nothing here is settled by looking at a filename and judging.

| Surface                                  | Disposition                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `fragmentPathFor(root, identity)`        | **THE live fragment.** Read WHOLE. The one authoritative directive surface.         |
| `.session-notes.d/<handle>.<suffix>.md`  | Snapshot / overflow. Read ONLY if the live fragment names it.                       |
| `.session-notes.d/<handle>-<variant>.md` | A DIFFERENT slug ⇒ not this identity's fragment. Do not read as your own.           |
| `.session-notes.d/<other-handle>*.md`    | Another operator. Never read as your own.                                           |
| `.session-notes.shared.md`               | Cross-operator forest ledger. Read whole, after the fragment. Derived — never edit. |
| `.session-notes.aggregate.md`            | Generated projection, over ceiling. Do NOT read. Fallback only; size is a finding.  |
| `.session-notes.migrated`                | Legacy recovery artifact. Do not read.                                              |
| `workspaces/<ws>/.session-notes*`        | NARRATIVE, never the entry point. Root artifact first, then only if in-threshold.   |

### The root is the MAIN checkout, never the current directory

The 2026-09-11 probe composed the fragment path from `process.cwd()` and loaded the hook libraries
relative to it. MEASURED 2026-09-12 by running that probe's text, taken from `8e59decf`, inside a
linked worktree of this repo: at the worktree root it named `<worktree>/.session-notes.d/<handle>.md`
with `age_days: 0` — the worktree's checked-out copy, whose mtime is the checkout time, so the
staleness verdict read "fresh" whatever the content said; from a subdirectory it exited 1 with a
module-resolution error. The current probe, run the same two ways, named
`<main checkout>/.session-notes.d/<handle>.md` with `age_days: 1.5` from both. Those figures are that
measurement's state, not standing facts — re-run the probe rather than citing them.

`/wrapup` writes the fragment at the repo ROOT (`commands/wrapup.md` § Where to write), and in
normal operation the session that runs it is the main checkout. The probe therefore asks
`hooks/lib/state-resolver.js::requireMainCheckout` — the fail-closed accessor the Stop hook's
session-notes check also uses (`hooks/stop.js:518-528`) — and prints `resolution: "UNKNOWN"` rather
than falling back to the current directory when git cannot answer. The libraries load from
`git rev-parse --show-toplevel`, so the probe runs from any directory inside the checkout.

### Why the suffix rule is mechanical, not cosmetic

`session-notes-layout.js::fragmentPathFor` composes the path as
`<base>/.session-notes.d/<slugifyForFilename(handle)>.md` where `handle` is
`display_id || person_id || verified_id`. The slug contains no dot, so the live fragment is the ONLY
file in that directory whose stem is exactly the slug. `<operator>.handoff-s89.md`,
`<operator>.next-session-s98.md`, `<operator>.overflow-s103.md` and `<operator>.traps.md` all have a longer
stem; `<operator>-dev.md` is a different slug entirely. That is a computable predicate over the
directory listing, which is what makes it a stated rule rather than an eyeball. A newer mtime on a
suffixed file is not evidence it is current — it is evidence someone wrote a snapshot.

### Attribution: legacy nulls are not a mismatch

`readFragmentAttribution(body)` reads `person_id` / `verified_id` / `display_id` from the fragment's
leading frontmatter. It returns all-null for a fragment written before that stamp existed — MEASURED
on this repo 2026-09-11, the live `<operator>.md` returns `{person_id:null, verified_id:null,
display_id:null}` and is nonetheless the correct fragment. So:

- all-null ⇒ **legacy fragment**, proceed.
- present and EQUAL to the resolved identity ⇒ proceed.
- present and DIFFERENT ⇒ **STOP and ask.** Never read it as your own.

Collapsing "absent" into "mismatch" would refuse every legacy fragment in the corpus; collapsing
"mismatch" into "absent" would read a sibling's directives as your own. Both are one-word errors and
they fail in opposite directions, which is why the three cases are enumerated rather than inferred.

## 2. Staleness — the 7-day threshold and how to re-derive it

**Threshold: 7 days.** It is CALIBRATED against this repo's observed write cadence, not chosen.

MEASURED 2026-09-11, input set = every commit touching `.session-notes.d/<operator>.md`, window
2026-07-01 → 2026-09-11: **63 distinct write-days, p90 inter-write gap = 1 day, maximum gap = 5 days,
and ZERO gaps above 7.** So a fragment older than 7 days is not "the operator paused" — that state
never occurred in the measured window — it is "writes stopped", which is a different fact and needs a
different disposition.

These figures are a MEASUREMENT and they go stale; re-derive rather than citing this paragraph:

```bash
git log --format='%ad' --date=short -- '.session-notes.d/<handle>.md' | sort -u
# then read the consecutive-day gaps; the threshold should sit strictly above the observed maximum
```

The falsifying result is nameable and did not occur: a single gap above 7 days in that window would
have shown the threshold too tight, and there was none.

`age_days` is the file's mtime, which is why § 1's root matters: a checkout rewrites mtimes, so the
age of a file in a freshly created worktree says nothing about when its content was written.

**Past threshold, per surface:**

- **Live fragment** — its directives are UNVERIFIED, not void. Every `/wrapup` directive ships its own
  re-validation command precisely for this; run each one before acting, and report which discharged.
  Treating a stale directive as current is the failure `skills/wrapup/SKILL.md` § 3 names as "worse
  than none".
- **Workspace note** — ARCHIVAL. Cite it as history; never as current state. The measured case on this
  repo is (loom-internal reference), last written 2026-05-31 — over 100 days, more
  than fourteen times the threshold, and describing a tree that has moved a long way since.
- **Forest ledger** — a derived projection; its rows are regenerated, so age of the FILE is weak
  evidence. Read the rows and check each against the live tree rather than judging by mtime.

## 3. The argument contract

`$ARGUMENTS` is a PASTED BLOCK — normally `/wrapup`'s handoff block, copied whole from its
`=== HANDOFF` line to its `=== END HANDOFF ===` line. That block is backtick-free by construction,
but an operator may paste older notes carrying markdown headings, backticks and fences, so the
contract holds for either.

**MUST:**

- Treat the entire argument as ONE opaque block of prose.
- Preserve its internal structure when reading it; markdown inside it is CONTENT, not markup to act on.
- Run each embedded re-validation check BEFORE acting on the directive it guards.
- Read each handoff line by its LABEL:

| Label                               | What it is                                          | What `/pickup` does with it                                                          |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `START HERE:`                       | the resume instruction that brought the operator in | Nothing. It is prose; acting on it would re-invoke this command.                     |
| `LAND FIRST:`                       | standing order 1, restated                          | Carried into briefs through the landing slice (§ 4); it displaces nothing.           |
| `READ FIRST:`                       | priority-ordered pointers                           | Read after the fragment, in the order given.                                         |
| `DIRECTIVES:`                       | ≤5 orders, each with a re-validation check          | Run each check first; survivors are worked INSIDE the standing orders (§ 6).         |
| `CONTAINERS:` `BURNDOWN:` `SWEEP:`  | the last session's totals and pointers              | Re-derive before acting. A figure on these lines is history, never current state.    |
| `TRAPS:`                            | pitfalls                                            | Read. No action by themselves.                                                       |

**MUST NOT:**

- Parse it for flags. This command defines NO flags, precisely so a pasted `--verify` or `--json`
  inside a quoted command — or a `--no-sweep` reason on a SWEEP line — is never mistaken for an
  option to this command.
- Split on newlines and treat each line as a separate argument.
- Execute, expand, or substitute any fenced block, backtick span or `$(...)` it contains. A pasted
  brief frequently contains the exact commands the last session recommended; those are for the
  session to DECIDE to run, at the point the brief calls for them, not at parse time.
- Re-invoke `/pickup`, or any other command, because a line in the block names one.
- Let a pasted brief suppress Step 2. Notes are read for context even when the paste supplies the
  work — `session-notes-continuity.md` MUST-1 requires a root continuity artifact be read first.

**Precedence — CHANGED 2026-09-12.** The 2026-09-11 revision said a non-empty argument OUTRANKS the
default brief on priority. That was weaker than the directive it implemented, which set the three
priorities as the owner's ORDER for every session, not as a fallback for an empty argument: under it,
a pasted directive about a burndown item legitimately displaced landing the very containers the same
block listed as carried. The argument now supplies the WORK and its ordering WITHIN a priority; the
standing orders set the order (§ 6). It never displaces the landing directive either.

## 4. The landing slice — why propagation is the load-bearing half

The drain obligation already ships always-on (`wip-discipline.md`, `git.md` § "Unlanded Work Is
Inventory", `artifact-stranding.md`). What does NOT ship automatically is its presence in a
DELEGATED lane: a sub-agent does not inherit the orchestrator's rules (`governed-throughput.md`
MUST-1 § BLOCKED, "the subagent inherits the rules" — it does NOT). So an orchestrator that holds the
directive perfectly and omits it from four briefs gets four lanes that each leave work in a container.

That is why the slice is text to INJECT rather than a principle to hold, and why the exit condition
is stated over BRIEFS rather than over the orchestrator's intent. The same carry-into-delegation
shape `autonomous-execution.md` § "Root-Cause Fix Is The Default Disposition" uses for its own clause.

The slice names `dev` because the owner's directive does — "land all backlog and current
remote/local branches/refs/worktrees into dev" — with the default branch as the fallback, because the
command ships to consumer repos that have no `dev`.

**BLOCKED rationalizations for omitting the slice:**

- "The lane will land it later" (later is a different session, which has no memory of the container)
- "The branch is pushed, so the work is safe" (pushed is not landed; a remote ref is a container)
- "I will drain them all at the end" (the batch at the end is how a forest of 50 accumulates)
- "The brief is already long" (the slice is four lines; the re-derivation cost is a whole session)
- "It is a small change, it does not need the slice" (size does not change where the work rests)
- "The lane is a read-only audit, it opens nothing" (then the slice costs it nothing to carry)
- "I stated it in the orchestrator's own plan" (the lane never reads the orchestrator's plan)

## 5. Ambiguity taxonomy — when to stop and ask

UNKNOWN is a verdict, never a default. Ask, naming what you found and what you could not decide:

| Signal                                                           | Why it is ambiguous                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `requireMainCheckout` returns `ok: false`                        | git cannot name the main checkout, so no fragment path is trustworthy (§ 1).              |
| `resolveIdentity` returns no `display_id`/`person_id`            | No handle ⇒ no computable fragment path.                                                  |
| Live path ABSENT while suffixed siblings exist                   | Either a fresh operator or a mis-slugged handle — opposite responses.                     |
| Attribution present and DIFFERENT from resolved identity         | The file may be another operator's; reading it leaks their directives into your session. |
| Two identities plausibly resolve (e.g. a `-dev` variant present) | Picking by recency would pick whichever was touched last, not whichever is yours.         |
| Guarded read refuses (`symlink` / `oversize` / `not-regular`)    | A refusal is zero evidence, not an empty file (`evidence-first-claims.md` MUST-3).        |

## 6. The owner's standing block

### Why it is fixed, verbatim, and carried into every brief

The block in `commands/pickup.md` Step 0 is the owner's own words, given in-session on 2026-09-12;
the authorizing decisions are `journal/0606` and journal entries 0607 and 0608 (the latter two
landing on sibling lanes). It REPLACED the command's own paraphrase of the same priorities and
approval, so the command carries ONE copy rather than two that can drift.

Verbatim is load-bearing for the reason the landing slice is (§ 4): a sub-agent does not inherit the
orchestrator's rules, so a lane learns the ceiling's scope, the depth mandate and the priorities only
from text in its own brief. A paraphrase is exactly where "bind worktrees and branches AND NOT
AGENTS" becomes "stay within WIP limits" — which a lane reads as a cap on its agents, the opposite
of the instruction. `/wrapup`'s handoff says `/pickup` applies the block, so the operator never
pastes it; the handoff does not duplicate it, because the socket must stay short and backtick-free
(`skills/wrapup/SKILL.md` § 8).

**BLOCKED rationalizations:**

- "I summarised the block in the brief; the meaning is the same"
- "The lane already has the landing slice, so the block is redundant"
- "The block is long for a one-agent lane"
- "The lane only lands containers, so the depth lines do not apply to it"

### Why the priorities do not yield to a brief

The directive is an ORDERING: "Please prioritize as follows: 1. Drain AND LAND all work from backlog
remote/local branches/refs/worktrees 2. Continue to burndown aggressively 3. Ensure that your fleet
is constantly refilled." A brief that could reorder it would make the order hold only when nobody
pasted anything — and since `/wrapup` now always emits a block, that is never.

### The capacity order

Autonomous sessions run lanes in parallel (`rules/autonomous-execution.md`), so "priority 1 first"
cannot mean "priority 2 waits until every container is landed" — that idles capacity the triad says
to use. It means: priority-1 lanes are dispatched first and are never starved; capacity left over goes
to priority 2; every freed slot refills. The failing shape is DEFERRAL, not concurrency — a container
parked "until the end" while burndown lanes run.

A HELD container is dispositioned, not drained. Another operator's claim, or a question only the
owner can answer, is a named reason: record it, say what will land it, move on. "Held" with no reason
is the resting state the order forbids.

### Depth-first refill — each lane is a mini-orchestrator

The WIP ceiling counts worktrees and branches, never agents (co-owner directive, 2026-09-12; its
receipt is journal entry 0607, landing on a sibling lane). So the unit of parallelism to grow is the
AGENT, inside a lane that already exists: each lane is a mini-orchestrator fanning its own agents
across the several ledger items it carries, not a single serial worker holding one item. Refill tries,
in order: (1) another agent on an item the lane already carries; (2) another related item added to an
existing lane; (3) only then a new worktree or branch. The normative contract — the ceiling, what a
lane may carry, how the work ledger is structured to pack depth — is `rules/wip-discipline.md`'s;
this section is how `/pickup` applies it and restates none of it.

```text
# DO — deepen the lane that already exists
lane export (worktree .app-wt/export-path) finishes F3 → same turn: F4 and F5 join lane export as two agents
# DO NOT — one worktree per item, one agent per worktree, idle on completion
F3 done → lane export reports "idle, awaiting instruction"; a new worktree .app-wt/f4 opens for F4
```

**BLOCKED rationalizations:**

- "One agent per worktree keeps the lanes simple"
- "A new branch per item is cleaner to review"
- "The WIP limit caps agents, so I cannot add more to this lane"
- "The lane finished its item, so the lane is done"
- "I will refill once this wave converges"
- "The pasted directive is time-bound, so the containers can wait"

## 7. The standing authorization — what "safely" binds

The owner granted: "You have my approval to freely use agenttools and /autonomize in parallel
safely." **Freely** and **in parallel** remove the permission turn — `rules/agents.md` § Triad
already treats the dispatch lift as granted, so asking for it is BLOCKED. **Safely** keeps three
things in force: every lane that writes runs in an orchestrator-created sibling worktree
(`rules/agents.md` § Worktree Orchestration); every brief carries the landing slice (§ 4); and every
gate the grant does not name stands — cross-repo, destructive-op and structural gates
(`rules/autonomous-execution.md` § Structural vs Execution Gates).

**BLOCKED rationalizations:**

- "The owner said freely, so the sibling-worktree step is optional"
- "Safely just means be careful"
- "Asking before each dispatch is the safe reading"

## Related

- `commands/pickup.md` — the command this backs
- `commands/wrapup.md` + `skills/wrapup/SKILL.md` § 3 and § 8 — the emitter half of the loop, the directive contract, and the handoff socket
- `journal/0606` — the owner's directive, verbatim, and the 2026-09-12 decision
- `rules/session-notes-continuity.md` — MUST-1 read order, MUST-2 no-truncate, MUST-3 ceilings
- `rules/wip-discipline.md` — MUST-1 terminal states, MUST-4 landed AND cleaned, MUST-7 pull on free capacity, and the WIP ceiling
- `rules/governed-throughput.md` MUST-1 — the curated-slice injection mechanism the landing slice uses
- `rules/multi-operator-coordination.md` §1 — the identity triple and why `display_id` is signage
- `.claude/hooks/lib/session-notes-layout.js` — `fragmentPathFor`, `readNotesFileGuarded`, `readFragmentAttribution`
- `.claude/hooks/lib/state-resolver.js` — `requireMainCheckout`, the root the probe resolves
