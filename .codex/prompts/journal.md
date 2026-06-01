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
   - Count entries by type (DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP)
   - List the 5 most recent entries with their date, type, and topic (from frontmatter)
   - Show the highest entry number (for next entry reference)

3. Present as a compact summary.

---

## Action: New Entry

1. Parse the TYPE and topic from arguments. Valid types: DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP.

2. Reserve the next slot via `.claude/hooks/lib/journal-reserve.js::reserveJournalSlot(dir, {identity, type, topic})`. Under N concurrent operators, scanning `ls journal/` races; the helper returns `{slot, filename, verified_id, person_id, display_id, type, topic, slug}` where the filename carries `<display_id>` to keep concurrent reservations on the same `seq` distinguishable. Frontmatter `verified_id` is authoritative for attribution scans.

3. Create the file at `journal/<filename>` (the reservation's `filename`) with this structure:

```markdown
---
type: [TYPE]
date: [today's date, YYYY-MM-DD]
project: [workspace name]
topic: [topic description]
phase:
  [current COC phase: analyze | todos | implement | redteam | codify | deploy]
verified_id: [from reservation — authoritative attribution]
person_id: [from reservation]
display_id:
  [from reservation — appears in filename for collision disambiguation]
tags: []
---

## [Section heading appropriate to type]

[Content — prompt the user for details if not provided]
```

4. Type-specific structure:
   - **DECISION**: Sections for Decision, Alternatives Considered, Rationale, Consequences
   - **DISCOVERY**: Sections for What Was Discovered, Why It Matters, Follow-Up
   - **TRADE-OFF**: Sections for Trade-Off, What Was Gained, What Was Sacrificed, Acceptable Because
   - **RISK**: Sections for Risk Identified, Likelihood and Impact, Mitigation, Follow-Up
   - **CONNECTION**: Sections for Connection, Components Linked, Why This Matters
   - **GAP**: Sections for What Is Missing, Why It Matters, How to Resolve

5. **On close** — when the entry is finalized (`/wrapup`-time, or explicit `/journal --anchor`), emit a signed `journal-body-anchor` record via `.claude/hooks/lib/journal-body-anchor.js::buildAnchorRecord({journalPath, relPath, slotRecordRef})`. The record pins the file's SHA-256 content hash; the fold predicate re-hashes at fold time and surfaces tamper-detected as a block-grade integrity advisory naming the original signer. Per architecture §5.2 extension (2026-05-20) this closes the journal-body crypto gap a bounded-trust insider with disk access could otherwise exploit unobserved.

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
- **Invalid TYPE**: Show the list of valid types (DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP) and ask the user to choose.
- **Numbering gaps**: Acceptable. Always use the highest existing number + 1, regardless of gaps.
