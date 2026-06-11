---
name: journal
description: "View journal status, create entries, or search the project journal."
---

Manage the project journal. The journal is the primary knowledge trail — it captures decisions, discoveries, trade-offs, risks, connections, and gaps across sessions.

Parse `$ARGUMENTS`:

- **Empty or "status"**: Show journal status
- **"new TYPE topic"**: Create a new journal entry (e.g., `new DECISION chose-event-driven`)
- **"search QUERY"**: Search existing entries by topic or tag

---

## Action: Status (default)

1. Determine the active workspace:
   - If working in a workspace, use it
   - Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/`)

2. In the workspace's `journal/` directory:
   - Count total entries
   - Count entries by type (DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP, AMENDMENT)
   - List the 5 most recent entries with their date, type, and topic (from frontmatter)
   - Show the highest entry number (for next entry reference)

3. Present as a compact summary.

---

## Action: New Entry

1. Parse the TYPE and topic from arguments. Valid types: DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP, AMENDMENT.

2. Reserve the next slot via `.claude/hooks/lib/journal-reserve.js::reserveJournalSlotSigned(repoDir, {dir, identity, type, topic})` — `dir` is the REPO-RELATIVE journal directory (`journal`, or `workspaces/<name>/journal`); `identity` is optional (defaults via `operator-id.js::resolveIdentity`). This computes the slot from `max(disk high-water, fold-accepted reservation high-water)` AND emits the signed `journal-slot-reservation` coordination-log record that `journal-write-guard.js` folds — without the record, the Write halt-and-reports "slot unreserved" even after a manual reservation. On `{ok: true}` it returns `{reservation: {slot, filename, verified_id, person_id, display_id, type, topic, slug}, record}`; the filename carries `<display_id>` to keep concurrent reservations on the same `seq` distinguishable, and frontmatter `verified_id` is authoritative for attribution scans. On `{ok: false}` surface `error` + `reason` verbatim and STOP — do not write the entry unreserved (the pure `reserveJournalSlot(dir, opts)` computation remains available for dry runs only).

3. Create the file at `journal/<filename>` (the reservation's `filename`) with this structure:

```markdown
---
type: [TYPE]
date: [today's date, YYYY-MM-DD]
author: [human | agent | co-authored — per the journal.md decision tree]
project: [workspace name]
topic: [topic description]
phase:
  [current COC phase: analyze | todos | implement | redteam | codify | deploy]
verified_id: [from reservation — authoritative attribution]
person_id: [from reservation — the authority unit]
display_id:
  [from reservation — appears in filename for collision disambiguation]
tags: []
relates_to:
  [
    optional — NNNN-slug of the entry this amends/extends/references; REQUIRED for AMENDMENT,
  ]
---

## [Section heading appropriate to type]

[Content — prompt the user for details if not provided]
```

This frontmatter is the canonical contract `rules/journal.md` documents — the two MUST agree. The `author:` value (`human` | `agent` | `co-authored`) is verified against the live per-session provenance ledger per `rules/journal-author-discipline.md`; default to `co-authored` when uncertain. Set it honestly — an unbacked `author: human` is flagged by `journal-write-guard.js`.

4. Type-specific structure:
   - **DECISION**: Sections for Decision, Alternatives Considered, Rationale, Consequences
   - **DISCOVERY**: Sections for What Was Discovered, Why It Matters, Follow-Up
   - **TRADE-OFF**: Sections for Trade-Off, What Was Gained, What Was Sacrificed, Acceptable Because
   - **RISK**: Sections for Risk Identified, Likelihood and Impact, Mitigation, Follow-Up
   - **CONNECTION**: Sections for Connection, Components Linked, Why This Matters
   - **GAP**: Sections for What Is Missing, Why It Matters, How to Resolve
   - **AMENDMENT**: Sections for What Is Amended (with `relates_to:` the original), What Changed, Why — extends a prior entry, never overwrites it

   **`## For Discussion`** (per `rules/journal.md` Requirements): append 2-3 probing questions (≥1 counterfactual, ≥1 referencing specific data) for analytical types (DISCOVERY, TRADE-OFF, RISK, GAP, CONNECTION) and substantive DECISIONs. A terse **coordination-receipt DECISION** or **AMENDMENT** (closure SHAs, criteria-met tables, redteam dispositions, convergence verdicts, wave-boundary captures per `rules/wave-loop.md` G2) MAY omit it — it must still be self-contained.

5. **On close** — when the entry is finalized (`/wrapup`-time, or explicit `/journal --anchor`), build the anchor partial via `.claude/hooks/lib/journal-body-anchor.js::buildAnchorRecord({journalPath, relPath, slotRecordRef})` and emit it via `.claude/hooks/lib/coc-emit.js::emitSignedRecord({repoDir, type: partial.type, content: partial.content})` — the emitter fills the per-emitter chain envelope (seq/prev_hash), signs the canonical bytes, and appends under the 2KB cap. The record pins the file's SHA-256 content hash; the fold predicate (default-registered in `coordination-log.js`) re-hashes at fold time and surfaces tamper-detected as a block-grade integrity advisory naming the original signer. Per architecture §5.2 extension (2026-05-20) this closes the journal-body crypto gap a bounded-trust insider with disk access could otherwise exploit unobserved.

6. After creating, confirm with the entry number and path.

---

## Action: Search

1. Search all `journal/*.md` files for the query string in:
   - Filename
   - Frontmatter `topic` and `tags` fields
   - Body content

2. Display matching entries with their number, type, date, and topic.

## Error Handling

- **No workspace detected**: Ask the user which workspace to use, or list available workspaces.
- **Journal directory missing**: Create `journal/` in the workspace and proceed.
- **Invalid TYPE**: Show the list of valid types (DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP, AMENDMENT) and ask the user to choose.
- **Numbering gaps**: Acceptable. Always use the highest existing number + 1, regardless of gaps.
