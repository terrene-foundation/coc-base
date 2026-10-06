# session-notes-continuity — Full Rule Examples

These examples are preserved from canonical `a19f76aa`; the governing clauses
remain in `.claude/rules/session-notes-continuity.md`. The rule carries compact examples and links here for the full forms.

## Example 1

```text
# DO — directive first, then the narrative it contextualizes
Read .session-notes.aggregate.md   → standing directives + open ledger rows
Read workspaces/<ws>/.session-notes → what happened, now correctly framed

# DO NOT — narrative first, act on it
Read workspaces/<ws>/.session-notes → "prior session finished the migration"
… and the fragment's "do NOT re-run the migration, it is superseded" is never read
```

## Example 2

```text
# DO — whole file, no truncation parameters
Read(.session-notes.d/<display_id>.md)

# DO NOT — a windowed read of a directive surface
Read(.session-notes.d/<display_id>.md, limit=50)   # the 51st line is the directive
Read(workspaces/<ws>/.session-notes, offset=200)   # the carry-forward ledger is above it
```

## Example 3

```text
# DO — bounded, with a named pointer carrying the overflow
## Read first
- workspaces/<ws>/06-handoff/02-go-forward-plan.md  (the full plan; this file holds the pointer)

# DO — a projection: declared ceiling, generator refuses, retire via an event
burndown-manifest.json  tracker.max_rows: <N>   → generator exits 2 at N+1
burndown/events.jsonl   append a retiring event → the fold, then the projection, shrinks

# DO NOT — a 900-line notes file, or a hand-trimmed projection
… every session appends; the next reader either truncates it (MUST-2) or spends the
context budget it needed for the work
… rows deleted from .session-notes.shared.md "to get under the ceiling" ← reverted on
  the next regenerate; the work they recorded is gone with no diff to show it
```

## Initial Origin Evidence

Origin: 2026-08-12 — `/sync-from-use` kailash-coc-rs Gate-1 ingest (relayed from a downstream
upflow inbox; hop-level provenance only). The offer's premise was corroborated FIRST-HAND at the
relaying template during its own ingest session — a workspace `.session-notes` advertised at
SessionStart was stale and needed a hand-authored "SUPERSEDED, read the operator fragment
instead" banner, i.e. exactly the two-artifact confusion, resolved only because a human happened
to put the redirect there. Re-verified at loom before landing: READ-ORDER and NO-TRUNCATE-READ
each returned ZERO hits against a control matching 17 files in `.claude/hooks/` and 11 in
`.claude/commands/`, and no hook in the corpus inspected `tool_input.limit`/`offset` against a
control of 31 hooks that read `tool_input` at all — so the gap was measured, not inherited.
Prose alone was known-insufficient before this rule was written: the directive the offer protects
already existed at the relaying template and was still not read, which is the argument for the
paired structural hook rather than a fourth MUST clause.
