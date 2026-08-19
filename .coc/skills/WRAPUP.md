---
id: "WRAPUP"
name: wrapup
description: "/wrapup depth: the next-session directive contract, the in-play branch + worktree inventory (enumerate unfiltered, rank by content), the free-for-the-next-session surfaces, and the forest-ledger gate."
---

# /wrapup — Session-Notes Depth

`commands/wrapup.md` carries the flow and the emitted format; THIS skill carries the depth it
references: (1) the per-surface detail of what the next session already gets for free, (2) what
`validate-forest-ledger.mjs` does and does NOT claim, (3) the **next-session directive contract**
— the one imperative surface in the notes, (4) the **in-play branch + worktree inventory** — the
locative surface, and (5) the reasoning behind two ledger-reconciliation steps. The
`.session-notes` layout, the reconciliation steps THEMSELVES, and the Hard rules are OWNED by the
command and are not restated here.

## 1. What the next session already has for free (per-surface)

The command's one-line list, expanded. Each of these is READ DIRECTLY by the next session, so
duplicating it into `.session-notes` spends the notes' bounded budget (§ 3's sizing subsection
carries it, from `rules/session-notes-continuity.md` MUST-3) on content that was already free:

- **Commits & diffs** — `git log`, `git status`, `git diff`. This is why the accomplishments-list
  ban exists: local work is recoverable, external work (`## Executed this session`) is not.
- **Outstanding work** — `workspaces/<project>/todos/active/`. Per-task itemization lives here;
  the notes carry only the FOREST ledger.
- **Decisions & discoveries** — `workspaces/<project>/journal/`. Journal BEFORE `/wrapup`; the
  notes are not a decision log.
- **Phase outputs** — `01-analysis/`, `02-plans/`, `03-user-flows/`, `04-validate/`.
- **Domain specs** — `specs/` (detailed domain truth, always current).
- **Project context** — `CLAUDE.md`.

## 2. The forest-ledger mechanical gate — what each form claims

`validate-forest-ledger.mjs` runs in CI / `/redteam`, **never inside the `/wrapup` runtime** (the
4-tool-call cap forbids it). Three forms, three different claims:

| Form                     | What it checks                                                                                                                                | What it does NOT claim                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<notes>` (bare)         | Intra-file conformance: section present, fence-balanced, non-vacuous; rows anchored; IDs unique; every close entry references an ID + a receipt SHAPE | Makes **NO** anti-vanish claim. A prior open ID can disappear and the bare form stays green.                        |
| `--git-prior`            | Diffs the prior COMMITTED `.session-notes`; flags any prior open **ID** absent from BOTH current rows and the "Closed this session" list       | Nothing about workspace-stranded rows (that is `--aggregate`)                                                      |
| `--aggregate`            | Cross-file twin (#669): flags any open workspace-ledger ID absent from the ROOT ledger (reconciliation step 6; `/sweep` Sweep 6)               | Nothing about intra-file conformance of either file                                                                |

Receipt AUTHENTICITY is out of scope for all three — a fabricated receipt is a
`verify-resource-existence.md` MUST-1 matter, not this validator's. The validator checks the
receipt's SHAPE, never that the PR/SHA/journal exists.

## 3. The next-session directive contract

### The gap this closes

Every other section of `.session-notes` is DESCRIPTIVE — `Where we are`, `In-flight state`,
`Executed this session`, `Traps`, `Outstanding ledger` all record what IS. None is imperative.
`rules/session-notes-continuity.md` MUST-1 nonetheless asserts the fragment's job is carrying
**standing directives** — what this operator was told to do and has not finished. The contract
existed; the section that produces it did not.

### The four properties

1. **Imperative, not narrative.** "Merge #1776 before any re-cut", not "we were merging #1776".
2. **≤5, hard cap.** A sixth directive means the sixth-most-important thing is competing for the
   next session's first action with the first.
3. **Every directive carries its own re-validation command** — the command a future session runs
   to learn whether the directive is STILL TRUE, plus what result means still-true.
4. **Admission test:** if you cannot write the check, it is NOT a directive. It is context, and it
   goes in `Traps`. This is the test that keeps the section at 5.

### Written from memory — the checks are for the NEXT session

`/wrapup` is verification-FORBIDDEN (memory-only, 4-tool-call cap, `commands/wrapup.md` § Hard
rules). The directives AND their checks are authored from conversation memory. Running the checks
during wrapup to "confirm" them is BLOCKED — it breaks the cap and converts wrapup into the
verification cascade the cap exists to prevent. Nor are these a counted burn-down:
`rules/burn-down-reporting.md` MUST-3 fences the three-quantity burn-down off this surface
entirely, and a directive's check is a COMMAND for later, not a measured figure for now.

```markdown
# DO — imperative, capped, each with the command that expires it

## Next-session directives

1. **Merge #1776 before any Gate-2 re-cut** — the 5 open target PRs carry the pre-fix corpus.
   re-validate: `gh pr view 1776 --json state -q .state` → `MERGED` ⇒ this directive is DONE
2. **Get cross-repo authorization first** — the existing receipts are pinned to the old corpus.
   re-validate: read one receipt's `action:` → names the OLD SHA ⇒ it does NOT cover the new cut

# DO — the honest empty case

## Next-session directives

None — nothing carries forward.

# DO NOT — narrative, uncapped, uncheckable

## Next-session directives

1. We were partway through the Gate-2 re-cut and it seemed like the corpus was stale.
2. There are 122 content defects outstanding.        ← a figure, not a directive, and unverifiable
3. Be careful with the merge order.                  ← no check ⇒ this is a Trap, not a directive
4. …9 more…                                          ← past the cap; nothing is first any more
```

### Why the re-validation command is load-bearing

Directives decay silently between sessions, and a **stale directive is worse than none** because
the next session has no reason to doubt it — the notes are the one surface it treats as
authoritative before it has read anything else. Measured on the prototype session (2026-08-17,
loom session 38): the fragment carried a CORRECT directive (a load-bearing merge order) that saved
the session, AND a stale figure ("122 content defects", against a reviewer's measured 289
content-defect / 1425 distinct). Same file, same session, same register — **nothing in the text
distinguished them.** A paired check makes a directive self-invalidating: the next session runs
one command and learns which of the two it is holding, instead of inheriting both with equal
confidence. This is the same discrimination `rules/instrument-discipline.md` MUST-1 requires of
any check cited as evidence, moved one surface earlier — to the moment the claim is WRITTEN.

**BLOCKED rationalizations:**

- "The Traps section already covers it" (Traps is descriptive; a trap tells the next session what
  to avoid, a directive tells it what to DO — and only one of the two carries an expiry)
- "The next session can read the ledger" (the ledger is forest-level state, not an ordered
  instruction, and carries no expiry check either)
- "Writing checks is ceremony"
- "I will add the checks if someone asks"
- "Everything is a directive" (then nothing is — the ≤5 cap and the admission test are what make
  the section readable in the first 10 seconds of a session)
- "A directive with no check is still useful" (it is useful exactly until it goes stale, and it
  gives no signal when it does — that is the failure mode, not a residual risk)
- "I will verify the check now so the next session can trust it" (running it breaks the
  4-tool-call cap; the check is authored FOR the next session, not discharged by this one)
- "There is nothing to carry forward, so I will omit the section" (write the explicit sentinel —
  an absent section is indistinguishable from a forgotten one, the same reason the forest ledger
  writes "Forest empty")

### Sizing against the 300-line ceiling

`rules/session-notes-continuity.md` MUST-3 bounds every continuity artifact to a 150-line target
and a 300-line ceiling. A compliant directives section is 3 prose lines + ≤5 two-line entries ≈ 13
lines at maximum, ~4 lines in the common case, and 3 lines when empty. It is not what pushes an
artifact toward the ceiling; an unbounded `Where we are` narrative is.

## 4. The in-play branch and worktree inventory

### The gap this closes

`.session-notes` recorded what was DECIDED and what remains OPEN, but never WHERE the work
physically sits. After `/clear` the session's branches and worktrees are recoverable in principle
— they are in git — and unfindable in practice, because nothing names them and nothing says which
of the 155 refs in the repo are this session's. The forest ledger is the wrong home: a ledger row
is a workstream, not a location, and a branch with three unmerged commits is not a workstream.

**Sibling, not overlap, with § 3.** A next-session directive is an ORDER with an expiry check
("merge #1776 first"). An in-play row is a LOCATION with a durability check ("this branch holds
content nothing upstream has"). A directive tells the next session what to DO; the inventory tells
it what would be LOST. Content that is neither — advice, warnings — is still a Trap.

**Distinct from `/sweep`.** `/sweep` MEASURES the residual: Sweep 4 enumerates branches, Sweep 6
audits the worktree forest, both with live commands and no tool-call cap. `/wrapup` RECORDS what
was in play and where it lives, from memory, with the commands authored for someone else to run.
Collapsing them in either direction breaks one of the two: putting the measurement in `/wrapup`
breaks the 4-tool-call cap, and dropping the record because "`/sweep` will find it" leaves the
next session with 155 undifferentiated refs and no idea which three mattered.

### Enumerate UNFILTERED; `--no-merged` is a RANKER

`git branch -r --no-merged` excludes any ref whose tip is tip-equal to `origin/main` — which is
exactly what an ABANDONED mid-flight branch looks like once main catches up to it. Enumerate with
`git for-each-ref refs/heads` and use `--no-merged` only to RANK what the unfiltered pass found.
The full reasoning, and the harness-default `worktree-agent-*` orphan class this filter
historically hid, is `skills/sweep/SKILL.md` § 5 — it is stated once, there.

### Durability is decided by CONTENT, never by ahead-count

A branch is at risk only if it holds commits whose CONTENT is not upstream. `git cherry
origin/main <branch>` is the instrument: a `+` line is a commit with no upstream equivalent, a
`-` line is one already applied under a different SHA. `git rev-list --count` is NOT the
instrument — a rebased or cherry-picked branch still reads "ahead" long after its content landed,
so an ahead-count cannot discriminate at-risk from already-delivered
(`rules/instrument-discipline.md` MUST-1: name the result that would appear if the branch were
NOT at risk — an ahead-count has none).

Measured on the session that originated this section (2026-08-17, loom session 38): a branch
reading **8-ahead carried ONE genuinely unique commit**, and across the repo **182 apparently-
unpushed commits reduced to 3 content-absent** once `git cherry` replaced the count. Reporting the
raw figures would have sent the next session hunting 182 phantom commits.

### The at-risk set is the deliverable

A 155-branch dump is noise, and noise on this surface is worse than silence because the notes are
the one file the next session treats as authoritative before it has read anything else. Report
only branches that are BOTH content-absent AND carry no merged PR, each marked `pushed |
LOCAL-ONLY` with its PR state. **LOCAL-ONLY + content-absent is the only genuinely unrecoverable
class** — a pushed branch survives any local accident, and a merged PR means the content is
already upstream whatever the ref count says. It is called out separately for that reason, not
for emphasis.

### Worktrees: the count, the verdicts, and the load-bearing fact

Report the tree count and the reap verdicts from `node .claude/bin/worktree-reap.mjs` (KEEP /
ZERO-LOSS / TAG-FIRST). State inline that **removing a worktree deletes a DIRECTORY, never a
branch** — `rules/worktree-isolation.md` Rule 8 owns that fact and its evidence; the reason it is
repeated at the point of the record rather than merely cited is that an operator who believes
removal destroys work will not reap, and the forest grows to ENOSPC. A KEEP verdict is a decision
with a named reason, not what happens when nobody decides.

```markdown
# DO — the at-risk set only, durability by content, worktrees as counts + verdicts

## In-play branches and worktrees

- **At risk** — `fix/ledger-anchor-2026-08-16` — LOCAL-ONLY — PR none.
  Only unrecoverable row; nothing upstream holds these commits.
  re-check: `git cherry origin/main fix/ledger-anchor-2026-08-16` → any `+` ⇒ NOT upstream
- **Worktrees** — 6 trees; verdicts 2 KEEP / 3 ZERO-LOSS / 1 TAG-FIRST.
  Removal deletes a DIRECTORY, never a branch (`rules/worktree-isolation.md` Rule 8).
  re-check: `node .claude/bin/worktree-reap.mjs`

# DO — the honest empty case

## In-play branches and worktrees

None — nothing in play.

# DO NOT — a dump, an ahead-count, a filtered enumeration, a bare tree count

## In-play branches and worktrees

- 155 branches: feat/a, feat/b, … ← noise; nothing says which three matter
- `feat/x` is 8 commits ahead      ← ahead-count; 7 of them are already upstream
- enumerated with `git branch -r --no-merged` ← hides every tip-equal abandoned ref
- 6 worktrees exist                ← no verdicts, so no basis for reaping any of them
```

**BLOCKED rationalizations:**

- "The branches are in git, nothing is lost" (recoverable ≠ findable — the next session cannot
  distinguish this session's three live refs from 152 dead ones, and an uncommitted worktree has
  no reflog at all)
- "`git branch --no-merged` is the obvious enumeration" (it is the one enumeration guaranteed to
  drop abandoned tip-equal refs — the exact class this section exists to catch)
- "Ahead-count is close enough" (8-ahead vs 1 unique, measured; it cannot return a
  not-at-risk answer for a rebased branch, so it discriminates nothing)
- "Listing 155 branches is thorough" (it is thorough and useless; the deliverable is the at-risk
  set, and an unranked dump hides the three rows that matter)
- "The next session can run `/sweep`" (it can — after it knows something is missing; the record
  is what tells it to look, and `/sweep` measures the residual rather than recovering what this
  session knew)
- "Worktrees are disposable so they need no record" (disposable is the CONCLUSION of a reap
  verdict, not an assumption — a TAG-FIRST tree holds a detached SHA no ref reaches)
- "Removing the worktree would delete the work" (it deletes the directory; every committed commit
  survives on its branch — `rules/worktree-isolation.md` Rule 8)
- "I'll run the commands now so the numbers are right" (running them breaks the 4-tool-call cap;
  the commands are authored FOR the next session, exactly as § 3's checks are)
- "This duplicates the forest ledger" (a ledger row is a workstream with a value-anchor; an
  in-play row is a location with a durability verdict — closing a workstream does not tell you
  whether its branch was ever pushed)

### Sizing

A compliant section is 3 prose lines + 2 bullets ≈ 12 lines at maximum and 3 lines when empty —
bounded by construction, because the at-risk set is small by definition. If it is not small, the
finding is that the session left too much unmerged, and that belongs in the forest ledger as a
workstream, not here as forty rows.

## 5. Two ledger-reconciliation steps, and why they are shaped that way

The steps themselves are OWNED by `commands/wrapup.md` § Outstanding ledger reconciliation. Two
carry reasoning the command references rather than restates.

**Step 2/4 — the gate reconciles on the ID, not the prose name.** Rewording an item is routine and
must never look like a vanish; two items must never collide. A stable single-token ID gives the
anti-vanish gate an identity that survives rewording, so `--git-prior` can assert "this prior open
ID appears in neither the current rows nor the close list" without false-tripping on an edit. In
the close list the ID is backtick-wrapped per the template; the gate strips the backticks before
comparing.

**Step 6 — a TRANSITION guard, not an ongoing sweep.** The wrapup base is always the repo ROOT, so
new wrapups create no workspace ledger at all; step 6 exists only for LEGACY rows stranded in
workspace ledgers written before that change (#669). It CONSUMES the `[AGG]` findings `/sweep`
Sweep-6 `--aggregate` already put in context — it does NOT re-scan, because a scan would break the
tool-call cap. If `/sweep` was skipped, run it (or `validate-forest-ledger.mjs --aggregate`)
BEFORE `/wrapup`, not during it.
