---
name: wrapup
description: "Write .session-notes so the next session resumes without re-discovering context."
---

The only deliverable is a `.session-notes` file that lets a fresh session start producing work within 2–3 minutes of reading it, without having to re-explore the codebase.

**Before running:** if significant decisions, discoveries, or risks from this session are not yet in `journal/`, run `/journal new DECISION|DISCOVERY|RISK <topic>` first. `.session-notes` is not a decision log.

**Release drift check (MUST — BUILD repos only):** Before writing `.session-notes`, run `node .claude/hooks/lib/release-drift.js` via a quick inline check (or inspect the `[RELEASE-DRIFT]` lines from session-start). If any packages have commits since their last tag, surface this to the user with a recommendation to run `/release` before ending the session. Record the unreleased package list in `.session-notes` under an "Unreleased packages" section so the next session sees the backlog. Silent on downstream repos / non-package repos.

## What the next session already has for free

Do NOT duplicate these — the next session reads them directly:

- **Commits & diffs** — `git log`, `git status`, `git diff`
- **Outstanding work** — `workspaces/<project>/todos/active/`
- **Decisions & discoveries** — `workspaces/<project>/journal/`
- **Phase outputs** — `01-analysis/`, `02-plans/`, `03-user-flows/`, `04-validate/`
- **Domain specs** — `specs/` (detailed domain truth, always current)
- **Project context** — `CLAUDE.md`

## What ONLY wrapup can provide

Four things nothing else captures:

1. **Priority ordering** — out of everything in the repo, which files should the next session read first, and in what order
2. **In-flight state** — what's true RIGHT NOW that isn't yet committed, journaled, or filed as a todo
3. **Traps** — specific pitfalls the next session will walk into without warning
4. **Outstanding ledger (forest)** — the durable, cumulative forest-vs-trees record. Per `rules/value-prioritization.md` MUST-1+2: a running ledger of every forest-level outstanding workstream / blocked-item, reconciled at EVERY wrapup (grows on add, shrinks on close). This SUBSUMES the old one-shot forest-vs-trees reasoning: instead of re-deriving bearings from memory each session, the ledger IS the bearings — carried forward verbatim, closed only with a durable receipt. See § Outstanding ledger reconciliation.

If content doesn't fit one of those four, it belongs somewhere else. Put it there before running `/wrapup`.

## Where to write — M6 D split layout

Per-operator fragment `<base>/.session-notes.d/<display_id>.md` + forest ledger `<base>/.session-notes.shared.md` (per-row `owner:`, merged by `coc-ledger`). `<base>` = `workspaces/$ARGUMENTS/` if specified, else the most recently modified workspace dir (excluding `instructions/`), else the repo root. Writes go through `.claude/hooks/lib/session-notes-layout.js`. Rows MUST carry a stable single-token `ID` + value-anchor per `rules/value-prioritization.md` MUST-1+2; owner stamps from identity. On journal-file close, emit a signed `journal-body-anchor` record via `.claude/hooks/lib/journal-body-anchor.js::buildAnchorRecord` — pins `{path, sha256_of_content_bytes, slot_record_ref}`; fold-time predicate re-hashes and surfaces tamper on mismatch.

## Format

Hard cap: **50 lines**. Overflow means the content belongs in `todos/active/` or `journal/`, not here. Omit any section that would be empty.

```markdown
# Session Notes — <YYYY-MM-DD>

## Where we are

One short paragraph (≤4 lines). Current work, current phase, last concrete
change. Just enough for the next session to orient — not a history.

## Read first

1. `path/to/file` — why it matters (one line)
2. `path/to/file` — why it matters
   (3–6 files, priority-ordered)

## In-flight state

- Uncommitted decisions, half-done refactors, mid-migration state.
- Facts that are true NOW but aren't in git/todos/journal yet.
  (omit if none)

## Outstanding ledger (forest)

The running forest — every open forest-level workstream / blocked-item
(NOT itemized todos; those live in `todos/active/`). Each row carries a
short single-token (whitespace-free), UNIQUE, STABLE **ID** (`F1`,
`F2` — never reused/renamed) + a value-anchor. The ID, not the prose
name, is what the anti-vanish gate reconciles on — rewording never
false-trips and two items can never collide. In the close list the
ID is backtick-wrapped per the template; the gate strips the backticks.

| ID   | Item         | Value-anchor (MUST-1 source)                               | Status                            |
| ---- | ------------ | ---------------------------------------------------------- | --------------------------------- |
| <id> | <workstream> | <why it matters, citing brief / spec § / journal DECISION> | BLOCKED on X / queued / in-flight |

Closed this session: `<id>` → receipt `<PR# / SHA / journal NNNN>`.

(If the forest is empty: "Forest empty — every item closed or
externally blocked." Never omit this section — an absent ledger is
indistinguishable from a forgotten one.)

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
3. **Close with receipt** — for each item delivered this session, move
   it to the "Closed this session" list (one entry per line / bullet),
   referenced **by its ID**, WITH a durable receipt (`<id>` → PR #N /
   bare #N / commit SHA / journal NNNN) per `verify-resource-existence.md`
   MUST-4. No ID or no receipt → it is NOT closed; carry it forward.
4. **Grow** — add any new forest-level workstream / blocked-item with a
   FRESH UNIQUE ID and a value-anchor citing a `value-prioritization.md`
   MUST-1 user-anchored source (brief / spec § / journal DECISION /
   literal user quote). No value-anchor → request it from the user, do
   not invent one. IDs MUST be unique within the ledger and stable
   across sessions — never reuse a retired ID, never renumber.
5. **Empty forest** still writes the section explicitly ("Forest empty
   — …"). Absence ≠ done. The sentinel and open rows are mutually
   exclusive — asserting "Forest empty" with rows present is a defect.

**Mechanical gate (CI / `/redteam`, NOT the wrapup runtime).**
`validate-forest-ledger.mjs <notes>` checks intra-file conformance
(section present + fence-balanced + non-vacuous; rows anchored; IDs
unique; every close entry references an ID + cites a receipt SHAPE —
shape not existence; a shaped-but-fake receipt is a
`verify-resource-existence.md` MUST-1 gate-review matter, not this
validator's). The no-silent-vanish invariant (step 2) is enforced
ONLY by the `--git-prior` form, which diffs the prior committed
`.session-notes` and flags any prior open **ID** absent from both
current rows and the "Closed this session" list. Exact ID-set
reconciliation — no prose parsing, no collision, deterministic, zero
residue. Run `--git-prior` in CI / `/redteam`; the bare form makes NO
anti-vanish claim.

## Hard rules

- **Write, not verify (closed allowlist — EXACTLY these three tool calls, nothing else).** **(a)** one workspace resolution (`ls workspaces/`) if needed; **(b)** one read of the immediately-prior `.session-notes` — that exact file, no other path — for ledger carry-forward; **(c)** one write of the new `.session-notes`. **Tool call cap: 3.** ANY other tool call — including any additional read of any other file, any grep / git / gh / pytest / find — is BLOCKED. The allowlist is the operative bound; this is not a denylist with examples. The single bounded prior-`.session-notes` read is the carry-forward source, categorically not the verification cascade.
- **Memory only.** Produce the notes from conversation memory. If you're unsure whether a claim is still true, omit it — the next session can discover it from git.
- **No accomplishments list.** The next session reads `git log`. Do not describe what happened this session.
- **No itemized-todo list — but the forest ledger is REQUIRED.** The next session reads `todos/active/` for per-task itemization; do NOT reproduce that here. The Outstanding ledger is the deliberate, scoped exception: it is **forest-level only** (workstreams / blocked-items, typically 2–6 rows), explicitly distinct from per-task todos. Every ledger row MUST carry a value-anchor per `rules/value-prioritization.md` MUST-1+2. Itemizing individual todos in the ledger is BLOCKED (that defeats forest-vs-trees); omitting the ledger entirely is BLOCKED (that is the stale-snapshot trap).
- **No decision log.** Journal decisions with `/journal` before running `/wrapup`, not in session notes.
- **No quantitative claims.** Do not write "N tests passing", "3 files changed", or "27 todos remaining". Numbers must be verified; verification is forbidden here. Point at the source of truth instead.
- **No oversight checklist.** Verification commands belong in the next session's task list, not session notes.
- **50-line output cap.** Overflow belongs in `todos/` or `journal/`. The ledger is part of this budget but bounded by construction (forest-level rows only); if it pushes past 50 lines the items are too granular — collapse to workstreams, push detail to `todos/active/`.
- **Overwrite** existing `.session-notes`. Only the latest matters.
- **The "Read first" list is the one section that MUST be present.** Without it, the next session has no entry point. If you can't produce a useful list, point at `CLAUDE.md` as the sole entry and say why.

`.session-notes` is a pointer file, not a report — its job is to save the next session's discovery time. Don't make claims that could go stale; write "see `todos/active/`" instead of a count.
