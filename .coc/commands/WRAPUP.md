---
id: "WRAPUP"
name: wrapup
description: "Write .session-notes so the next session resumes without re-discovering context."
---

The only deliverable is a `.session-notes` file that lets a fresh session start producing work within 2–3 minutes of reading it, without having to re-explore the codebase.

**Before running:** if significant decisions, discoveries, or risks from this session are not yet in `journal/`, run `/journal new DECISION|DISCOVERY|RISK <topic>` first. `.session-notes` is not a decision log.

**Release drift check (MUST — BUILD repos only):** Before writing `.session-notes`, run `node .claude/hooks/lib/release-drift.js` via a quick inline check (or inspect the `[RELEASE-DRIFT]` lines from session-start). If any packages have commits since their last tag, surface this to the user with a recommendation to run `/release` before ending the session. Record the unreleased package list in `.session-notes` under an "Unreleased packages" section so the next session sees the backlog. Silent on downstream repos / non-package repos.

## What the next session already has for free

Do NOT duplicate — the next session reads these directly: commits & diffs (`git log` / `status` / `diff`), outstanding work (`workspaces/<project>/todos/active/`), decisions & discoveries (`workspaces/<project>/journal/`), phase outputs (`01-analysis/` … `04-validate/`), domain specs (`specs/`), project context (`CLAUDE.md`). Per-surface detail: `skills/wrapup/SKILL.md` § 1.

## What ONLY wrapup can provide

Four things nothing else captures:

1. **Priority ordering** — out of everything in the repo, which files should the next session read first, and in what order
2. **In-flight state** — what's true RIGHT NOW that isn't yet committed, journaled, or filed as a todo
3. **Traps** — specific pitfalls the next session will walk into without warning
4. **Outstanding ledger (forest)** — the durable, cumulative forest-vs-trees record. Per `rules/value-prioritization.md` MUST-1+2: a running ledger of every forest-level outstanding workstream / blocked-item, reconciled at EVERY wrapup (grows on add, shrinks on close). This SUBSUMES the old one-shot forest-vs-trees reasoning: instead of re-deriving bearings from memory each session, the ledger IS the bearings — carried forward verbatim, closed only with a durable receipt. See § Outstanding ledger reconciliation.

If content doesn't fit one of those four, it belongs somewhere else. Put it there before running `/wrapup`.

## Where to write — M6 D split layout (root-canonical)

Per-operator fragment `<base>/.session-notes.d/<display_id>.md` + forest ledger `<base>/.session-notes.shared.md` (per-row `owner:`, merged by `coc-ledger`). **`<base>` is ALWAYS the repo ROOT** — never a workspace dir, even when a workspace is active. (`/wrapup` takes no workspace argument; the fragment target is unconditionally root.) Root is the single multi-operator READ surface: SessionStart regenerates ONLY the root aggregate (`session-notes-layout.js::regenerateAggregate` called with the repo root) and `workspace-utils.js::findAllSessionNotes` has its aggregate fallback ONLY on the root branch (the workspace branch reads the legacy `.session-notes` monolith name, with no `.session-notes.d/` awareness). So a fragment written under `workspaces/<ws>/.session-notes.d/` is invisible to the next session's read path — its body lands where nothing is surfaced (journal `0417`). Workspace locality is carried by the forest-ledger rows (workspace-attributed) + the "Read first" pointers into `workspaces/<project>/…`, NOT by the fragment's write location. Writes go through `.claude/hooks/lib/session-notes-layout.js`. Rows MUST carry a stable single-token `ID` + value-anchor per `rules/value-prioritization.md` MUST-1+2; owner stamps from identity. On journal-file close, emit a signed `journal-body-anchor` record via `.claude/hooks/lib/journal-body-anchor.js::buildAnchorRecord` — pins `{path, sha256_of_content_bytes, slot_record_ref}`; fold-time predicate re-hashes and surfaces tamper on mismatch.

## Format

Length is bounded by `rules/session-notes-continuity.md` MUST-3 — the target and ceiling live THERE and are deliberately not restated here, so the two surfaces cannot drift apart. Overflow means the content belongs in `todos/active/` or `journal/`, not here. Omit any section that would be empty — EXCEPT the six always-present sections, which write an explicit empty-sentinel rather than vanish: **Next-session directives** ("None — nothing carries forward"), **Read first** (the mandatory entry point), **In-play branches and worktrees** ("None — nothing in play"), **Outstanding ledger** ("Forest empty — …"), **Executed this session** ("None — no external actions this session"), and **Wave tracker** ("None — no waves in flight"). Absence of these six is indistinguishable from a forgotten section, so it must be explicit.

```markdown
# Session Notes — <YYYY-MM-DD>

## Next-session directives

Imperative standing orders for the NEXT session — ≤5, each carrying the command
that says whether it is STILL TRUE. Written FROM MEMORY; the checks are for the
NEXT session to RUN, never for this one (running them here breaks the 4-tool-call
cap). If you cannot write the check, it is NOT a directive — it is context, and
it belongs in Traps.

1. **<imperative order>** — re-validate: `<command>` → `<result meaning STILL TRUE>`
   (write "None — nothing carries forward" if none; never omit silently)

## Where we are

One short paragraph (≤4 lines): current work, current phase, last concrete change
— enough for the next session to orient, not a history.

## Read first

1. `path/to/file` — why it matters (one line)
2. `path/to/file` — why it matters   (3–6 files, priority-ordered)

## In-flight state

- Uncommitted decisions, half-done refactors, mid-migration state — facts
  true NOW but not yet in git/todos/journal. (omit if none)

## In-play branches and worktrees

Where this session's work LIVES. Memory-sourced; the commands are for the NEXT
session to RUN. Report the AT-RISK set ONLY — branches holding commits whose
CONTENT is not upstream and with no merged PR — never a full branch dump.

- **At risk** — `<branch>` — `pushed | LOCAL-ONLY` — PR `<#N state | none>`.
  LOCAL-ONLY + content-absent is the only unrecoverable class; list it FIRST.
  re-check: `git cherry origin/main <branch>` → any `+` line ⇒ NOT upstream
- **Worktrees** — `<N>` trees; verdicts `<n KEEP / n ZERO-LOSS / n TAG-FIRST>`.
  Removal deletes a DIRECTORY, never a branch (`rules/worktree-isolation.md`
  Rule 8), so a KEEP is a decision, not a default.
  re-check: `node .claude/bin/worktree-reap.mjs`
  (write "None — nothing in play" if none; never omit silently)

## Executed this session

- Consequential actions whose state is NOT in THIS repo's `git log` — PRs on
  OTHER repos, releases cut, cross-repo syncs, external issues filed. One line
  each, by external pointer (repo#PR, tag). SCRUB operator paths + private-org
  slugs per `rules/user-flow-validation.md` MUST-6. Test + rationale: Hard rules.
  (write "None — no external actions this session" if none; never omit silently)

## Wave tracker

→ `.wave-tracker.d/<display_id>.md` — <wave X/N, K agents in flight, M PRs merged>.
Resume: read the tracker BEFORE launching/re-launching anything (`rules/wave-loop.md`
MUST-6). Lean POINTER only — COUNTS here (K, M), never live agent-ids/branches; wave
DETAIL lives in the GITIGNORED tracker file, NOT these TRACKED/synced notes (length-bounded; see Format + Hard rules).
(write "None — no waves in flight" if none; never omit silently)

## Outstanding ledger (forest)

The running forest — every open forest-level workstream / blocked-item
(NOT itemized todos; those live in `todos/active/`). Each row carries a
short single-token (whitespace-free), UNIQUE, STABLE **ID** (`F1`, `F2`
— never reused/renamed) + a value-anchor. Why the gate reconciles on the
ID and not the prose name: `skills/wrapup/SKILL.md` § 5.

| ID   | Item         | Value-anchor (MUST-1 source)                               | Status                            |
| ---- | ------------ | ---------------------------------------------------------- | --------------------------------- |
| <id> | <workstream> | <why it matters, citing brief / spec § / journal DECISION> | BLOCKED on X / queued / in-flight |

Closed this session: `<id>` → receipt `<PR# / SHA / journal NNNN>`.

(If the forest is empty: "Forest empty — every item closed or externally
blocked." Never omit — an absent ledger reads as a forgotten one.)

## Traps

- Concrete pitfalls the next session will hit.
- One line each. Link to the fix location if you know it.
  (omit if none)

## Open questions for the human

(omit if none)
```

## Outstanding ledger reconciliation (MUST — every wrapup)

The ledger defends against the stale-snapshot trap (a closed item resurfacing, or an open one vanishing — `journal/0089`). Reconcile every wrapup:

1. **Read the prior `.session-notes` once** (the single bounded read
   the carve-out below permits) to recover the existing ledger.
2. **Carry forward** every prior row whose work is not yet delivered,
   KEEPING ITS ID UNCHANGED (the item text MAY be reworded; the ID
   MUST NOT). A prior open ID MUST NOT silently disappear.
3. **Close with receipt** — move each item delivered this session into the
   "Closed this session" list, referenced **by its ID**, WITH a durable
   receipt (PR #N / bare #N / commit SHA / journal NNNN) per
   `verify-resource-existence.md` MUST-4. No ID or no receipt → NOT closed.
4. **Grow** — add any new forest-level workstream / blocked-item with a
   FRESH UNIQUE ID and a value-anchor citing a `value-prioritization.md`
   MUST-1 user-anchored source (brief / spec § / journal DECISION / user
   quote). No value-anchor → request it from the user, never invent one.
   Never reuse a retired ID, never renumber.
5. **Empty forest** still writes the section explicitly ("Forest empty — …");
   absence ≠ done. Sentinel and open rows are mutually exclusive.
6. **Roll LEGACY workspace ledgers up to root (#669)** — every OPEN
   workspace-ledger ID the latest `/sweep` Sweep-6 `--aggregate` flagged STRANDED
   MUST be carried into the root ledger WITH its value-anchor
   (`value-prioritization.md` MUST-2) OR referenced in "Closed this session".
   CONSUMES the `[AGG]` findings already in context; re-scanning is BLOCKED by
   the tool-call cap. Why it is a transition guard: `skills/wrapup/SKILL.md` § 5.

**Mechanical gate (CI / `/redteam`, NOT the wrapup runtime).** `validate-forest-ledger.mjs <notes>` — intra-file conformance; `--git-prior` is the ONLY form enforcing the no-silent-vanish invariant (step 2), `--aggregate` its cross-file twin (step 6). What each flag does and does NOT claim: `skills/wrapup/SKILL.md` § 2.

## Hard rules

- **Write, not verify (closed allowlist — EXACTLY these four tool calls, nothing else).** **(a)** one optional `ls workspaces/` — ONLY to orient the "Read first" pointers; the fragment write target is the root split (§ Where to write), so no base resolution is needed; **(b)** one read of the immediately-prior `.session-notes` — that exact file, no other path — for ledger carry-forward; **(c)** one write of the new `.session-notes`; **(d)** one write of `.wave-tracker.d/<display_id>.md` — memory-sourced, NO read (the running-agent roster + per-wave state come from THIS session's memory, not from re-reading the tracker). **Tool call cap: 4.** ANY other tool call — including any additional read of any other file, any grep / git / gh / pytest / find — is BLOCKED. The allowlist is the operative bound; this is not a denylist with examples. The cap-3→4 raise adds a memory-sourced WRITE, NOT a verification READ — it does not open the door to the verification cascade the cap blocks (the two bounded reads (a)/(b) are unchanged). The single bounded prior-`.session-notes` read is the carry-forward source, categorically not the verification cascade.
- **Memory only.** Produce the notes from conversation memory. If you're unsure whether a claim is still true, omit it — the next session can discover it from git.
- **No LOCAL accomplishments list — but the "Executed this session" external-signal IS required.** The next session reads `git log` for LOCAL work, so do NOT describe what happened in THIS repo this session. The carve-out: consequential EXTERNAL actions (distribution PRs on other repos, releases, cross-repo merges, filed issues) are NOT in this repo's `git log`, so the next session cannot recover them there — capture those, and only those, under "## Executed this session". The test: "is this action's state visible in `git log` of THIS repo?" — yes → omit (accomplishments-list ban); no → it belongs in the execution-signal. **RUNNING background agents fall under the SAME carve-out:** an agent still executing at wrapup time is in-flight state absent from `git log` (its branch/PR may not exist yet), so a `/clear`-resumed session cannot recover it and would re-launch the same wave. Document running agents (id/name, task, branch/PR, deliverable) in the **Wave tracker** file per `rules/wave-loop.md` MUST-6 — the tracker, not the accomplishments ban, owns them.
- **No itemized-todo list — but the forest ledger is REQUIRED.** The next session reads `todos/active/` for per-task itemization; do NOT reproduce that here. The Outstanding ledger is the deliberate, scoped exception: it is **forest-level only** (workstreams / blocked-items, typically 2–6 rows), explicitly distinct from per-task todos. Every ledger row MUST carry a value-anchor per `rules/value-prioritization.md` MUST-1+2. Itemizing individual todos in the ledger is BLOCKED (that defeats forest-vs-trees); omitting the ledger entirely is BLOCKED (that is the stale-snapshot trap).
- **Every next-session directive ships its own re-validation check — no check, no directive.** The directives section is the ONE imperative surface in the notes (`rules/session-notes-continuity.md` MUST-1: the fragment carries STANDING DIRECTIVES; every other section here is descriptive). Each directive MUST name the command a future session runs to learn whether it is STILL TRUE, and what result means still-true. Cap **5**. "None — nothing carries forward" is a VALID and expected answer, not a box to fill. Un-checkable content is context → **Traps**, never a directive. Memory-sourced like everything else here: the check is authored for the NEXT session to run, and running it now is BLOCKED by the 4-tool-call cap — which also means these are NOT a counted burn-down (`rules/burn-down-reporting.md` MUST-3 fences that off this surface entirely). DO / DO-NOT + BLOCKED corpus: `skills/wrapup/SKILL.md` § 3.
- **The in-play inventory records WHERE the work LIVES — enumerate UNFILTERED, rank by CONTENT, report only the at-risk set.** `git branch --no-merged` MUST NOT be the enumeration source: it excludes any ref tip-equal to main, which is exactly what an abandoned mid-flight branch looks like once main catches up. Enumerate with `git for-each-ref refs/heads` and use `--no-merged` only to RANK (`skills/sweep/SKILL.md` § 5). Durability is decided by CONTENT — `git cherry origin/main <branch>` (`+` lines) — NEVER by ahead-count, which still reads "ahead" for a rebased or cherry-picked branch. Report ONLY branches with content-absent commits AND no merged PR, each marked `pushed | LOCAL-ONLY`; a full-forest dump is BLOCKED, and LOCAL-ONLY + content-absent is called out separately as the sole unrecoverable class. Worktrees get a COUNT plus reap verdicts, with the load-bearing fact inline: removal deletes a DIRECTORY, never a branch (`rules/worktree-isolation.md` Rule 8). Memory-sourced, and the commands are authored for the NEXT session to run — running them here is BLOCKED by the 4-tool-call cap. This surface RECORDS what was in play; `/sweep` (Sweeps 4 and 6) is what MEASURES it, so neither replaces the other. DO / DO-NOT + BLOCKED corpus: `skills/wrapup/SKILL.md` § 4.
- **No decision log.** Journal decisions with `/journal` before running `/wrapup`, not in session notes.
- **No quantitative claims.** Do not write "N tests passing", "3 files changed", or "27 todos remaining". Numbers must be verified; verification is forbidden here. Point at the source of truth instead. The mandated POINTER-scale counts are the scoped exception and MUST NOT be dropped by citing this rule: the Wave-tracker line's `K`/`M` (`rules/burn-down-reporting.md` MUST-3 § Scope) and the in-play worktree tree-count + reap verdicts. Branch COMMIT counts are NOT exempt — they are the ahead-count this surface forbids outright.
- **No oversight checklist.** Verification commands belong in the next session's task list, not session notes.
- **Bounded output — the budget is `rules/session-notes-continuity.md` MUST-3's, not restated here.** Overflow belongs in `todos/` or `journal/`. The ledger is part of that budget but bounded by construction (forest-level rows only); if the ledger is what pushes the notes past MUST-3's ceiling, the items are too granular — collapse to workstreams, push detail to `todos/active/`.
- **Overwrite** existing `.session-notes`. Only the latest matters.
- **The "Read first" list is the one section that MUST be present.** Without it, the next session has no entry point. If you can't produce a useful list, point at `CLAUDE.md` as the sole entry and say why.

`.session-notes` is a pointer file, not a report — its job is to save the next session's discovery time. Don't make claims that could go stale; write "see `todos/active/`" instead of a count.
