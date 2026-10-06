---
id: "WRAPUP"
name: wrapup
description: "/wrapup depth: the sweep-receipt gate, the emitted scaffold + paste-able handoff socket, the next-session directive contract, the in-play inventory, and the forest-ledger gate."
---

# /wrapup — Session-Notes Depth

`commands/wrapup.md` carries the flow and the emitted format; THIS skill carries the depth it
references: (1) the per-surface detail of what the next session already gets for free, (2) what
`validate-forest-ledger.mjs` does and does NOT claim, (3) the **next-session directive contract**
— the one imperative surface in the notes, (4) the **in-play branch + worktree inventory** — the
locative surface (including the **unlanded-shard** class and the **worktree-reclaim** dispositions),
(5) the reasoning behind two ledger-reconciliation steps, (6) **how to read the release-drift
output**, (7) the **chained `/sweep` gate** — why the sweep runs as its own step and is then gated
(2026-09-12, superseding the receipt-only refusal), its honest limit, and the measurement that fixed
its instrument — (8) the **emitted scaffold** and the **paste-able handoff socket**, and (9) the
**close-out display** — per-container backlog rows and the burndown chart. The section ORDER, the
eight always-present sentinels, the
reconciliation steps THEMSELVES, the closure refusals, and the Hard rules are OWNED by the command
and are not restated here; where the two could ever disagree, the command is authoritative.

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
closed tool-call allowlist forbids it). Three forms, three different claims:

| Form             | What it checks                                                                                                                                        | What it does NOT claim                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `<notes>` (bare) | Intra-file conformance: section present, non-vacuous, and in the STRICT GRAMMAR — only blank lines, table rows and plain text with no pipe, pipe lookalike, HTML comment, code fence, `# ` line, indented or empty `##`, setext underline or non-space/tab leading whitespace (and, in the shared form, no heading of any level); rows anchored; IDs unique; every close entry — a `- <id> → <receipt>` bullet under a line starting "Closed this session" (a deeper-indented line or sub-bullet belongs to the entry above it), the list ended by a blank line, unindented text or a `Label:` line — references an ID + a receipt SHAPE | Makes **NO** anti-vanish claim. A prior open ID can disappear and the bare form stays green. |
| `--git-prior`    | Diffs the prior COMMITTED `.session-notes`; flags any prior open **ID** absent from BOTH current rows and the "Closed this session" list              | Nothing about workspace-stranded rows (that is `--aggregate`), nor a vanish across a RENAME. Exits 3 (UNRUNNABLE, never a pass) when it cannot prove what the prior was: a shared-form ledger, a snapshot, or a run from outside the repo |
| `--aggregate`    | Cross-file twin (#669): flags any open workspace-ledger ID absent from the ROOT ledger (reconciliation step 6; `/sweep` Sweep 6)                      | Nothing about intra-file conformance of either file                                          |

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

`/wrapup` is verification-FORBIDDEN (memory-only, closed tool-call allowlist, `commands/wrapup.md` § Hard
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
2. There are 122 content defects outstanding. ← a figure, not a directive, and unverifiable
3. Be careful with the merge order. ← no check ⇒ this is a Trap, not a directive
4. …9 more… ← past the cap; nothing is first any more
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
  closed tool-call allowlist; the check is authored FOR the next session, not discharged by this one)
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

**Distinct from `/sweep`, and now GATED ON it.** `/sweep` MEASURES the residual: Sweep 4
enumerates branches, Sweep 6 audits the worktree forest, both with live commands and no tool-call
cap. `/wrapup` RECORDS what was in play and where it lives, from memory, with the commands
authored for someone else to run. Collapsing them in either direction breaks one of the two:
putting the measurement in `/wrapup` breaks the closed tool-call allowlist, and dropping the
record because "`/sweep` will find it" leaves the next session with 155 undifferentiated refs and
no idea which three mattered. Since the chained gate (§ 7) the two are SEQUENCED rather than
merged — `/sweep` keeps sole authority to measure, `/wrapup` runs it as its own step when the
receipt is missing and refuses to close without one — so neither command claims the other's
authority.

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

### Unlanded shards — the class no other line on this surface catches

An **unlanded shard** is a branch that exists on `origin`, is NOT merged into the default branch,
and carries NO open PR. It is invisible to every other instrument a next session reaches for: it is
not in `gh pr list` (no PR), not in `git status` (nothing local is dirty), not in the at-risk row
(it IS pushed, so it is not the LOCAL-ONLY unrecoverable class), and not in the forest ledger (a
branch is a location, not a workstream). It reads as done from every angle and is done from none.

Every CONTENT-UNLANDED entry carries a **disposition** — exactly four are available: `landed`,
`folded` (its commits reached the default branch under other SHAs), `branch removed`, or `issue
opened and branch removed`. **There is no fifth, and there is no age carve-out.** An earlier
revision of this paragraph and of the command surface said "every RECENT entry", which reads as an
exemption for everything else and is the mechanism by which a standing total becomes a digit nobody
acts on. **UNDETERMINED is a legitimate disposition and is recorded verbatim**; what is BLOCKED is
silently reporting "none", which is indistinguishable from having looked and found nothing.

The three-step re-check the command emits is ordered deliberately: enumerate unfiltered (`git
for-each-ref refs/heads` — `--no-merged` drops tip-equal abandoned refs, § "Enumerate UNFILTERED"
above), decide durability by CONTENT (`git cherry origin/<default> <b>`; a `+` line is a commit
with no upstream equivalent), and only then ask whether a PR already covers it (`gh pr list --head
<b> --state open`). Reversing the order makes the PR query the filter, which is exactly the
instrument the class is invisible to.

#### `merge-base --is-ancestor` is the WRONG instrument for a lost-work question

Ancestry answers *is this commit OBJECT on the trunk*. The question is *is this WORK on the trunk*,
and the two diverge constantly — a rebased, cherry-picked or single-commit-squashed branch carries
different SHAs and identical content. MEASURED at loom 2026-08-21: of **102** ancestry-unlanded
branches, **13 (12.7%)** held nothing new by patch-id — 9 fully matched upstream, 4 whose only
non-base commits were merges. A surface wrong one time in eight is one a reader learns to discount,
which costs the other 89 their audience. The session-start unlanded-work block computes its
headline by content for this reason (`hooks/lib/unlanded-work-surface.js` § Content equivalence).

**Escalate through three instruments, weakest first. Each sees something the one before it cannot.**

1. **Patch-id** — `git cherry <base> <branch>`. Catches rebase, cherry-pick, single-commit squash,
   merge-only tips. Cheap, and the minimum bar. **Blind to a MULTI-commit squash**: the squashed
   commit's patch equals neither original, so every commit still reports `+`. MEASURED on a
   known-answer fixture — 1-commit squash → `-`; 2-commit squash → `+ +`.
2. **Forward + reverse apply-check** — take the branch's cumulative patch (`git diff
   $(git merge-base <base> <b>) <b>`) and try it BOTH ways. `git apply` reads the CURRENT WORKING
   TREE, so this is only valid from a **clean checkout of the base** — run it in a throwaway
   worktree, never in a dirty tree, or the answer is about your uncommitted edits.
   `git apply --check <patch>` clean ⇒ the content is ABSENT. `git apply --check --reverse <patch>`
   clean ⇒ the content is already PRESENT under other SHAs. Neither applying is a THIRD answer —
   DIVERGED, needs a human read, never a silent default to either pole.
   MEASURED on a known-answer fixture, bipolar: for a 2-commit branch squash-merged into the base,
   `git cherry` reported `+ +` (blind) while reverse-apply reported clean (PRESENT); for a
   genuinely unlanded branch, forward-apply reported clean (ABSENT) and reverse did not. That is
   the case instrument 1 cannot see and this one can.
3. **Does the DEFECT still reproduce?** — the only instrument that outranks both, and the one
   neither of the above can approximate. A defect can be fixed on the trunk by a **DIFFERENT
   MECHANISM**, leaving the original commit genuinely ABSENT and genuinely UNNECESSARY. Recovering
   it then re-breaks whatever superseded it. Origin (loom#1775): exactly that happened — an
   absent-by-SHA commit was recovered, it had been deliberately superseded upstream, it re-broke a
   trunk guard, and it had to be reverted. **Absent commit ≠ unfixed defect.** Before restoring any
   commit on an absence finding, run the failing case; if it passes on the trunk, the commit is
   noise and the correct disposition is `branch removed`, not `folded`.

**Record the tip SHA before deleting anything.** A committed row of `branch | tip sha |
commits-vs-base | disposition + evidence` turns an irreversible-feeling act into a cheap one —
recovery is `git branch <name> <sha>`. It also forces a written justification per row, which is
where a branch that is actively HARMFUL to land gets caught. "Fold everything in" is unsafe as a
blanket policy: a branch can delete symbols the trunk now calls, or be a mutation-testing mutant
rather than a fix.

Memory-sourced like the rest of this surface: the commands are authored for the NEXT session to
run. Running them during `/wrapup` is BLOCKED by the closed tool-call allowlist.

### Worktree reclaim — every tree the wave created reaches one of three terminal dispositions

The command carries the count, the verdicts, and the load-bearing fact (removal deletes a
DIRECTORY, never a branch). What it references here is the **closure contract**
(`rules/worktree-isolation.md` Rule 8): a wave is not closed while it still holds worktrees, so
every tree the wave created MUST reach exactly one of —

1. **merged** — its branch landed; the tree is removed.
2. **rescued** — uncommitted work is checkpointed onto `recovery/<name>`, the push is VERIFIED
   with `git ls-remote --heads origin 'refs/heads/recovery/*'` (the push command's own output is
   NOT that proof), and only then is the tree removed.
3. **explicitly HELD with a named reason** — a KEEP verdict is a decision someone made, not what
   happens when nobody decides.

A tree in none of the three is a leak, and leaks are unbounded: an operator who believes removal
destroys work will not reap, and the forest grows until the volume fills — at which point the
shell commands needed to diagnose it fail too. `node .claude/bin/worktree-reap.mjs` is report-only;
`--apply` reaps ZERO-LOSS and TAG-FIRST and never touches a KEEP.

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
- `feat/x` is 8 commits ahead ← ahead-count; 7 of them are already upstream
- enumerated with `git branch -r --no-merged` ← hides every tip-equal abandoned ref
- 6 worktrees exist ← no verdicts, so no basis for reaping any of them
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
- "I'll run the commands now so the numbers are right" (running them breaks the closed tool-call allowlist;
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

**Since 2026-08-22, reconciliation is EMISSION, not transcription.** Per the operator-ratified
(loom-internal reference) and
`rules/knowledge-convergence.md` MUST-1, work-state transitions are append-only signed events at
`burndown/events.jsonl` and the forest ledger is a DERIVED PROJECTION regenerated from
`.claude/hooks/lib/burndown-events.js::foldEvents`. Three consequences the command states as rules
and this file explains:

- **Carry-forward became implicit, and that is a SIMPLIFICATION, not a relaxation.** The old
  protocol's step 1 read the prior notes and step 2 re-transcribed every unclosed row — a manual
  copy whose failure mode (a row silently dropped between sessions) is exactly what
  `validate-forest-ledger.mjs --git-prior` was built to catch. Under the fold an item persists
  until an event retires it, so the no-silent-vanish invariant holds BY CONSTRUCTION rather than by
  a gate catching a bad copy. The prior-notes read therefore lost its justification and was retired
  rather than re-spent; its tool-call slot funds the event emission, so that change cost the allowlist nothing. The allowlist's current size is `commands/wrapup.md` § Hard rules' to state, never this file's — a number restated in two places drifts in one of them.
- **Re-emitting an unchanged item is BLOCKED, not merely wasteful.** A live-weight event asserts
  that something was observed this session. Emitting one for an untouched item manufactures an
  observation, which is the authority-free-assertion class `kind: genesis` was fenced to prevent.
- **The empty-forest sentinel is GENERATED.** It is a property of a fold with no open rows, so
  hand-writing "Forest empty" while the fold holds open rows is a false claim about another file's
  contents — the same shape as the stale-snapshot trap the ledger exists to defend against.

**A refused append is LOUD.** `appendEvent` returns a typed refusal (oversize field, unknown
`kind`, `kind`/`weight` mismatch, an `authority: "agent"` transition carrying an owner status such
as `Signed off`). The caller surfaces it verbatim and does NOT proceed as though the transition
were recorded — a silently-lost refusal is the C6 failure the substrate was chosen to close.

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
tool-call cap. If no same-day `/sweep` report exists, `/wrapup`'s own sweep step (§ 7) produces one
BEFORE the write phase, so the `[AGG]` findings are in context by the time step 6 runs — never a
re-scan inside the capped phase.

## 6. Reading the release-drift output

`node .claude/hooks/lib/release-drift.js` runs at SessionStart and puts its `[RELEASE-DRIFT]` lines
into the session's context. `/wrapup` CONSUMES those lines; it does not invoke the checker, because
the closed tool-call allowlist (`commands/wrapup.md` § Hard rules) has no slot for it. If the
lines are absent, the disposition is UNKNOWN and the re-run belongs BEFORE `/wrapup` or at
`/sweep` — never inside it.

Three output readings that are routinely conflated, and each is a different fact:

| Output                               | What it means                                                                                                                                                                  | Notes line                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **no `[RELEASE-DRIFT]` line at all** | The check did NOT RUN. It always prints at least one line and always exits 0, so silence is a FAILED INVOCATION, never an all-clear (`rules/evidence-first-claims.md` MUST-3). | status UNKNOWN — never "clean"                     |
| **`0 manifests found`**              | The check RAN and did not APPLY — this is not a packaging repo.                                                                                                                | omit the line (it is silent here by design)        |
| **`<pkg>: N commits since <tag>`**   | The check RAN and found drift.                                                                                                                                                 | "Unreleased packages" line recommending `/release` |

**A count marked whole-repo-release-train belongs to the TAG, not to the package.** In a repo whose
packages ship under one shared tag, every package reports the same commit count — the count is a
property of the tag's distance from `HEAD`, not evidence that each package changed. Writing it
per-package inflates the backlog and sends the next session hunting releases nothing needs.

**BLOCKED rationalizations:**

- "No output means nothing drifted" (it means the check did not run — the two are opposite facts
  rendering identically, which is what `evidence-first-claims.md` MUST-3 blocks)
- "`0 manifests found` is a clean result" (did-not-APPLY is not did-not-DRIFT)
- "I'll just run the checker here to be sure" (a fifth tool call; the cap's allowlist is the
  operative bound, and the re-run belongs before `/wrapup`)
- "Every package shows 12 commits, so all twelve need releasing" (one tag, one distance)

## 7. The `/sweep` gate — chained, then gated

`commands/wrapup.md` § Gate owns the sweep step and the refusal; this section carries the reasoning
behind their shape, the measurement that fixed the gate's instrument, and the boundary it draws
with `/sweep`.

### The 2026-09-12 decision — run the sweep, then gate on its receipt

`journal/0606` records the co-owner directive ("incorporate this: /sweep and ensure that all open
work are durable in /wrapup") and the co-owner's choice between the two implementations offered:
run it automatically. The 2026-09-11 shape, kept below as superseded history, had turned
"incorporate" into a REFUSAL, which from the operator's side is two commands and a stop, the
opposite of incorporation. It refused the 2026-09-12 close-out.

The shape is a CHAIN of three steps, never an inline merge:

1. **The gate reads.** Control empty ⇒ UNKNOWN, stop. Receipt present ⇒ consume it.
2. **No receipt ⇒ the sweep step.** `/sweep` runs in full as its own step — its procedure, its
   report written and committed, its Decision points put in front of the operator.
3. **The SAME gate reads again.** Still no receipt ⇒ refuse, exactly as before.

Each of the four grounds the superseded design rested on is still met; none is waived:

| Ground             | How the chain still meets it                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-call cap      | The sweep step precedes the write phase. The cap governs the write phase, which gains only one bounded re-read of the gate (slot (e′)).                         |
| The human decision | The report is written, committed and its Decision points SHOWN before the session closes, so the judgment-bucket items still reach a human.                     |
| Skippability       | The receipt gate runs AFTER the sweep step, so a sweep step that produced no report still refuses. The failure mode stays loud.                                  |
| Authority          | `/sweep` alone measures; `/wrapup` consumes and gates. Running a command's procedure as its own step is not re-implementing it, and nothing is re-derived here. |

**The honest cost:** a longer close-out on any day the operator did not sweep, and the decision
report is first read at close-out rather than earlier in the session, when there was more time to
act on it. Running `/sweep` mid-session stays the better habit; the chain is the floor under it.

**Why "invoke it by name, otherwise read the command".** `/wrapup` ships to CC, Codex and Gemini
from one body. A CLI that exposes commands as invokable skills runs `/sweep` directly; one that does
not still reads `commands/sweep.md` and executes its Workflow, Output and Closure. Naming one CLI's
invocation primitive in the body would leak into the other two emissions
(`skills/command-authoring/SKILL.md` § "Neutral Phrasing — Cross-CLI Hygiene").

### SUPERSEDED 2026-09-12 — why a REQUIRED RECEIPT, and not an inline sweep

Kept as history, not deleted: the four grounds below are the ones the chain above still honors,
and the table's "inline" column describes a MERGE the chain does not perform. What 2026-09-12
reversed is only this design's conclusion — that a missing receipt should end in a refusal the
operator must act on. The reasoning as it stood on 2026-09-11:

`/sweep` was documented as "the end-of-cycle gate before `/wrapup`" and enforced by nothing —
a sequencing convention that held exactly as long as someone remembered it. Two ways to fix
that, and they are not equivalent:

| | Run `/sweep` inline inside `/wrapup` | REQUIRE a receipt, refuse without one |
| --- | --- | --- |
| Tool calls | 10 sweeps, dozens of live commands | ONE bounded query |
| The cap | Blown by an order of magnitude; `/wrapup` stops being write-only | Intact — one named slot |
| The human decision | `/sweep`'s report is a MANAGEMENT DECISION artifact whose judgment-bucket items go to the co-owner (`rules/product-completion-first.md` MUST-4). Inlining it makes that decision an agent-internal step nobody ratifies. | Preserved — the decision happens at `/sweep`, where a human reads the report |
| Skippability | An inline step inside a long command is skipped silently and looks identical to one that ran | A refusal is loud and leaves the operator holding the choice |

The receipt wins on all four, and the fourth is decisive: **a skippable inline step is weaker
than a required receipt**, because the failure mode of the inline form is indistinguishable
from success. So `/sweep` stays a separate command and keeps sole authority to MEASURE;
`/wrapup` becomes its CONSUMER and its gate. Neither claims the other's authority — the one
coherence risk of folding two commands together.

### The honest con — state it, do not bury it

The gate checks that a sweep report EXISTS and is same-day. It cannot tell whether the sweep
was substantive, whether its ten sweeps all ran, or whether its findings were adjudicated. A
shallow `/sweep` satisfies it. So the gate raises a FLOOR — no close-out over a session that
audited nothing — and buys no guarantee about sweep QUALITY, which remains
`rules/sweep-completeness.md` MUST-4's escalation and the gate-review's job. A second, smaller
cost: an operator wrapping up an exploratory session with genuinely nothing outstanding now
either sits through the sweep step or passes `--no-sweep <reason>`, and the reason lands in the
notes where the next session reads it.

`--no-sweep` exists because a gate with no escape gets routed around
(`rules/hook-output-discipline.md` MUST NOT § "Detectors that block work the agent has been
instructed to perform"). It is the corpus's standard shape: an override that is RECORDED, never
silent — the same contract as the one-shot `wip-limit-allow` receipt and
`COC_ALLOW_NESTED_WORKTREE`.

### The census enumerator is named by ROLE, not by path

`commands/wrapup.md` § Gate asks for "the repo's container-census enumerator" rather than a
literal invocation, and that is deliberate. `/wrapup` ships to every consumer; the census
enumerator does not. A shipped command that hard-codes a loom-only tool path hands 30+
consumers an obligation they have no way to discharge — the gap `in-force-check.mjs` exists to
find, and it FOUND exactly this when an earlier draft of this change named the tool inline.
Measured 2026-09-11, `registration-preflight.mjs` exit 1, two findings: relation
`artifact-names-tool`, one from `commands/wrapup.md` and one from this file, each
`[missing: use/base,build/base,use/py,build/py,use/rs,build/rs]` — six audiences holding an
obligation with no instrument. The tool PATH is elided from that quote on purpose: writing it
here would re-name the unreachable instrument in a shipped artifact and re-open the finding.

So the command names the OBLIGATION and `rules/wip-discipline.md` MUST-8 names the enumerator
where one ships. Where none ships, the by-hand enumeration in that same gate call — every ref
namespace, every remote, registered and stray worktrees, stashes — IS the census, with every
unreachable class recorded UNKNOWN. This is the same cross-audience shape `commands/sweep.md`
Sweep 3 already uses for issue-closure reconciliation ("where the repo ships a tool for this,
drive it; where it does not, do the walk by hand — the two finding classes are the deliverable
either way"). The alternative — shipping the enumerator by adding it to
`sync-tier-aware.mjs::ALWAYS_INCLUDE`, the route `worktree-reap.mjs` took for
`rules/worktree-isolation.md` Rule 8 — is a legitimate future fix and a strictly larger change:
it needs the tool's whole dependency closure to ship too, and that closure was NOT measured
here. Recorded as the open alternative rather than asserted as unnecessary.

### Why the ISO threshold, and why the control is not ceremony

MEASURED on this repo 2026-09-11: `find` here resolves to `bfs`, which REJECTS a relative
`-newermt "-16 hours"` with `Invalid timestamp` and prints its error to stderr. The fresh-set
query then returns EMPTY — byte-identical to "no sweep ran today" — so an unverified relative
form would have produced a confident wrong REFUSAL on every invocation, and no result it could
return would have distinguished the two (`rules/instrument-discipline.md` MUST-1). The ISO
form `-newermt "$(date +%F)"` fires on `bfs` and on GNU findutils alike.

That is also why the third command is not ceremony. It is the MUST-3(a) control: fired at a
known-answer case (78 historical reports exist in this repo), it shows the matcher CAN emit a
path here. Control empty ⇒ the instrument is broken ⇒ the verdict is **UNKNOWN**, which is a
third answer and is neither "a sweep ran" nor "no sweep ran". Collapsing UNKNOWN into either
pole is the failure the control exists to prevent.

**BLOCKED rationalizations:**

- "The sweep ran a couple of sessions ago, that is close enough" (the receipt is same-day by
  construction; a stale audit is what the gate exists to catch)
- "Nothing was outstanding, so the sweep would have found nothing" (that is the sweep's verdict
  to return, not the wrapup's to assume)
- "I will run `/sweep` after the notes are written" (the notes cite the receipt; writing them
  first makes the citation a forward promise)
- "The fresh query came back empty, so no sweep ran" (not until the control has fired — empty
  from a broken matcher and empty from a genuine absence are the same bytes)
- "`--no-sweep` without a reason is fine, the flag itself records it" (the flag records that
  the gate was skipped; the REASON is what the next session needs)
- "The sweep ran inside `/wrapup`, so its Decision points need no showing" (the showing IS the
  human decision the chain preserves; a report nobody read ratifies nothing)
- "The sweep step wrote a report, so the second gate read is ceremony" (the re-read is what makes
  a sweep step that produced nothing refuse loudly; skipping it re-opens the silent failure)
- "I ran the sweeps that looked relevant" (an abridged sweep writes a report that satisfies the
  gate while auditing less than it claims — the substitution `rules/sweep-completeness.md` blocks)
- "The operator can run `/sweep` themselves; refusing is simpler" (that is the 2026-09-11 shape
  the co-owner reversed — `journal/0606`)

## 8. The emitted scaffold

`commands/wrapup.md` § Format owns the section ORDER, the seven always-present sentinels, and
the `re-check:` obligation. This is the scaffold those obligations describe — render the notes
from HERE rather than from memory, and keep the command's roster authoritative where the two
could ever disagree.

````markdown
# Session Notes — <YYYY-MM-DD>

## Next-session directives

≤5 imperative standing orders, each carrying the command that says whether it is STILL
TRUE. Memory-sourced; the checks are for the NEXT session to RUN. No check ⇒ not a
directive ⇒ it is context, and belongs in Traps (§ 3).

1. **<imperative order>** — re-validate: `<command>` → `<result meaning STILL TRUE>`
   ("None — nothing carries forward" if none; never omit silently)

## Where we are

One paragraph (≤4 lines): current work, current phase, last concrete change.

## Read first

1. `path/to/file` — why it matters (3–6 files, priority-ordered)

## In-flight state

- Uncommitted decisions, half-done refactors, mid-migration state. (omit if none)

## Container census

Quoted VERBATIM from the close-out gate; every container dispositioned. The REPLY shows one row
per container (§ 9); this section keeps the totals plus the killed and carried rows.

- **Containers** — `<n>`; `<k>` landed / `<k>` killed / `<k>` carried, one line each for
  the killed and the carried, with the named reason.
- **Anchors / unclassified** — `<n>` / `<n>` (never counted as containers).
- **UNKNOWN** — `<classes>` + what would measure each ("none" ONLY when `complete: true`).
  re-check: re-run the close-out gate's census enumerator (§ 7)

## In-play branches and worktrees

Where this session's work LIVES. Memory-sourced; AT-RISK set ONLY, never a dump (§ 4).

- **At risk** — `<branch>` — `pushed | LOCAL-ONLY` — PR `<#N state | none>`. LOCAL-ONLY +
  content-absent is the only unrecoverable class; list it FIRST.
  re-check: `git cherry origin/main <branch>` → any `+` ⇒ NOT upstream
- **Unlanded shards** — on `origin`, unmerged, NO open PR. Every CONTENT-UNLANDED entry gets
  a disposition — land · fold · delete · open an issue and delete. No age carve-out.
  UNDETERMINED verbatim, never "none".
  re-check: `git for-each-ref refs/heads` → `git cherry origin/<default> <b>` →
  `gh pr list --head <b> --state open`
- **Worktrees** — `<N>` trees; verdicts `<n KEEP / n ZERO-LOSS / n TAG-FIRST>`. Removal deletes
  a DIRECTORY, never a branch (`rules/worktree-isolation.md` Rule 8), so KEEP is a decision.
  re-check: `node .claude/bin/worktree-reap.mjs`
  ("None — nothing in play" if none; never omit silently)

## Burndown

Quoted VERBATIM from the slot-(f) render (§ 9): the `--quote "ALL PAGES/Open"` line, tokens and
all, and the printed block's `generated_from_sha:` line. The full block goes in the REPLY, not here.
(Exit 2: the refusal line verbatim and no figures. Anything else: "UNKNOWN — the render did not run".)
re-check: `node .claude/bin/burndown-build.mjs --quote "ALL PAGES/Open"` → exit 0 ⇒ renderable

## Executed this session

- Consequential actions NOT in THIS repo's `git log` — PRs on other repos, releases cut,
  cross-repo syncs, external issues filed. One line each, by external pointer. SCRUB operator
  paths + private-org slugs (`rules/user-flow-validation.md` MUST-6).
  ("None — no external actions this session" if none)

## Wave tracker

→ `.wave-tracker.d/<display_id>.md` — <wave X/N, K agents in flight, M PRs merged>. Resume:
read the tracker BEFORE launching anything (`rules/wave-loop.md` MUST-6). Lean POINTER only —
COUNTS here, never live agent-ids/branches.
("None — no waves in flight" if none)

## Outstanding ledger (forest)

GENERATED, not authored — reproduce the shape here only as a POINTER. Each row's short,
UNIQUE, STABLE **ID** (`F1`, `F2` — never reused/renamed) and value-anchor render verbatim
from the event's `item_id` / `value_anchor` (§ 5).

| ID   | Item         | Value-anchor (MUST-1 source)                               | Status                            |
| ---- | ------------ | ---------------------------------------------------------- | --------------------------------- |
| <id> | <workstream> | <why it matters, citing brief / spec § / journal DECISION> | BLOCKED on X / queued / in-flight |

Closed this session: `<id>` → receipt `<PR# / SHA / journal NNNN>`.
(If empty: "Forest empty — every item closed or externally blocked." Never omit.)

## Traps

- Concrete pitfalls, one line each. Link to the fix location if known. (omit if none)

## Open questions for the human

(omit if none)

## Handoff

<the `commands/wrapup.md` § Handoff block, verbatim — fenced as plain text, no backticks inside>
````

### The handoff block is a SOCKET, not a summary

It is emitted twice on purpose — in the chat reply, where the operator can select it in one
action, and as the fragment's last section, where it survives the terminal. `/pickup` takes
free-form text as its argument, so the block is pasted straight in; that is the whole reason for
the shape constraints `commands/wrapup.md` § Handoff block states. Four of them are load-bearing
and are routinely violated by a well-meaning rewrite:

1. **No backticks, no code fences, no triple quotes INSIDE the block.** They terminate the
   fence that carries it and they fight with shell quoting when the block is passed as an
   argument. Plain paths, plain arrows.
2. **Self-contained.** Every line must be intelligible with zero surrounding conversation. A
   directive reading "finish what we discussed" is worthless in the socket.
3. **Fixed `START HERE:` line naming `/pickup`, always present.** Added 2026-09-12
   (`journal/0606`): the 2026-09-11 block said only "the next session's start command", `/pickup`
   occurred zero times in the command, and the next session was consequently started from a
   hand-typed paste. An operator cannot run a command the handoff never names. `/pickup` reads the
   line as the instruction that brought the operator in — prose, never a directive, never a reason
   to re-invoke itself (`skills/pickup/SKILL.md` § 3). The line also says `/pickup` applies the
   owner's standing block itself, and that is ALL the socket says about it: the block lives once, in
   `commands/pickup.md` Step 0, so the operator never pastes it by hand, and copying it into the
   socket would make a second copy that is neither short nor guaranteed backtick-free.
4. **Fixed `LAND FIRST:` line, always present, every mode.** It is not a reminder — it is the
   propagation mechanism. The next session reads it before anything else and carries it into
   every lane brief it writes (`rules/governed-throughput.md` MUST-1), which is how the
   landing directive reaches a sub-agent that never loads this corpus. It names `dev` because the
   directive does ("land all backlog and current remote/local branches/refs/worktrees into dev"),
   with the default branch as the fallback, because the command ships to repos that have no `dev`.

**BLOCKED rationalizations:**

- "The operator can read the fragment, the chat copy is redundant" (the fragment is a file the
  operator must find and open; the socket exists to remove that step)
- "`LAND FIRST` is obvious, it does not need repeating every time" (a line present only when
  someone judged it necessary is absent exactly when the session was too busy to judge)
- "Backticks make it prettier" (they break the paste, which is the one thing the block is for)
- "I will summarise the directives rather than copy them" (a summary is not a socket; the next
  session acts on what it was handed)
- "The operator knows which command resumes a session" (the 2026-09-12 session was started from a
  hand-typed paste precisely because the block never said)
- "I put the paste instruction right after the block" (outside the block it is not in what the
  operator pastes, and the next session never sees it)

## 9. The close-out display — backlog rows and the burndown chart

`commands/wrapup.md` § Container census and § Burndown chart own the obligations; this section
carries where the figures come from, why they are shaped this way, and what was measured.

### Why rows, not totals

The directive is "Show me the backlog of remote/local branches/refs/worktrees" (`journal/0606`). A
total answers how many; it cannot answer which, or what happens to each — the question the operator
is asking at close-out, and the only one that tells them whether a container they remember is in the
count. So the reply carries one row per container; the fragment and the handoff keep the totals plus
the killed and carried rows, because those are the ones the NEXT session has to act on.

**Where the row fields come from.** Read them from the census the gate already printed — never from
a second enumeration, which the cap forbids:

| Row field   | Census source                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| name        | each ref partition's `refs[].ref`; each tree's `path` in `trees.registered[]`, or the dir in `trees.stray.dirs[]`         |
| class       | the partition's namespace (`refs/heads`, `refs/remotes`, `refs/tags`, `refs/stash`, …) or the tree class                  |
| age         | the ref row's `ageHours`, as printed; trees carry no age field, so `unknown`                                              |
| disposition | this session's call — `landed` / `killed (<reason>)` / `carried (<named reason>)`, recorded against the row's `verdict`   |

Field names are those `hooks/lib/wip-lanes.js::refCensus` emits: the ref row is built by
`partitionRefs` at `.claude/hooks/lib/wip-lanes.js:1773-1780` (`ref`, `sha`, `objectType`, `ageHours`, `verdict`) and
the tree classes by `censusTrees` at `.claude/hooks/lib/wip-lanes.js:1882-1884` (`registered`, `detached`, `stray`,
each tree's `path` and `branch`). Where a repo enumerates by hand, the same four columns come from
`git for-each-ref` with each ref's creator date, `git worktree list` and `git stash list`.

**Grouping is allowed; dropping names is not.** A forest of hundreds of containers makes a flat
table unreadable, so rows may group by class and disposition — but a grouped row lists every name
it covers. A row reading "40 `worktree-agent-*` refs, killed" hides which forty, which is the
totals-only reply again.

### Why the chart is split across three surfaces

Each surface gets the form of the generator's output that is VALID there. MEASURED 2026-09-12 on
this repo at `8e59decf`, and figures that go stale — re-run rather than cite:

- **The reply carries the full printed block, markers included.** `--verify-quote` over the whole
  print output returned exit 0, `no tokenised counts found; nothing to validate`: the verifier
  excises the `BURNDOWN:BEGIN`…`BURNDOWN:END` region (`.claude/bin/burndown-build.mjs:395`) because
  a block is `--check`'s subject, not a quote. An EXCERPT of the table outside those markers is
  scanned as quotes instead, carries no digest of its own, and has no bucket-and-denominator slot
  beside each cell. In the measurement all 84 of an excerpt's tokens failed with `token '…' is not
  produced by the current block` — because projected membership had moved between the render and
  the check (below), and nothing in the excerpt could show which state it came from. Abridging the
  block inside its markers would be hand-editing it (`rules/burndown-integrity.md` MUST NOT), so the
  reply shows it whole.
- **The fragment carries the `--quote "ALL PAGES/Open"` line.** That is the form built to validate:
  it returned exit 0, `3 tokenised count(s) all valid`, and carries bucket, denominator and the
  from-original-register / arrived-since split (`rules/burndown-integrity.md` MUST-2 and MUST-3).
  The same line with one count changed returned exit 1 naming the certified value, so the check can
  fail. The fragment is a durable write the burndown write guard verifies, and a fifty-line block
  would also spend the fragment's `rules/session-notes-continuity.md` MUST-3 budget.
- **The handoff block carries the same quote with its backticks removed, plus
  `generated_from_sha:`.** The socket forbids backticks, and the `--quote` line wraps each bucket
  label in them. Removing them is the ONE change permitted, and only because it was measured not to
  change what validates: the stripped copy returned exit 0, `3 tokenised count(s) all valid`, the
  same verdict as the original — the verifier binds a token to the fact, not the typography, as its
  own doc comment on `verifyQuotes` in `.claude/bin/burndown-build.mjs` states. Any other edit —
  rounding, rewording, dropping the split — is re-typing a generated figure and stays BLOCKED.

**Two renders can disagree, so the figures shown come from one.** Between a print render and a
`--quote` render minutes apart on the same commit, projected membership moved by one — `Open: both
populations` 214 then 215, `arrived since` 188 then 189 — because projected sources re-derive their
membership on every build. Each render's tokens bind its own digest, so both validated; they were
simply two states. If the fragment's quote disagrees with the reply block's ALL PAGES row, say the
sources moved between the two commands; never pick one, and never reconcile them by hand.

**Rendered BEFORE the ledger emission.** The manifest's tracker is `burndown/events.jsonl`, and
its `_tracker_note` in `burndown-manifest.json` records that `assertCommittedAndUnmodified` holds the
tracker to the same standard as every declared source. Inferred from that note, NOT measured here
(measuring it would mean appending to the real log): after slot (b) appends, the generator refuses
until the log is committed. So the chart is rendered first, which is correct whether or not the
inference holds — it shows the committed state the session closes on, and its `generated_from_sha:`
says which. If the write guard verifying the fragment afterwards meets that refusal,
`rules/burndown-integrity.md` names a refusing generator as UNKNOWN, never clean.

**A consumer with no manifest gets a refusal, and that is the expected shape.** MEASURED in a fresh
temporary git repo with no `burndown-manifest.json`: exit 2, `UNRUNNABLE — refusing because declared
source 'burndown-manifest.json' is not committed`. The command's exit-2 arm quotes that line and
shows no figures; reading a refusal as "no open work" is the failure `rules/burndown-integrity.md`
MUST NOT names.

**BLOCKED rationalizations:**

- "The stored block in the target file is the chart" (on the measured tree `--check` exited 1,
  STALE, while the print render was current)
- "I will paste just the ALL PAGES row, it is the part that matters" (an excerpt outside the markers
  is scanned as quotes, and a bare row does not carry its denominator)
- "The two renders differ by one, I will use the bigger number" (that is reconciling by hand)
- "The generator refused, so there is nothing open" (a refusal emits no block; UNKNOWN is the answer)
- "Twelve rows is plenty; the rest are the same kind" (then group them and list every name)
