---
id: "SESSION-NOTES-CONTINUITY"
paths: ["**/.session-notes*", "**/.session-notes.d/**"]
---

# Session-Notes Continuity — The Directive Before The Narrative, And Whole

Full worked examples: `.claude/guides/rule-extracts/session-notes-continuity-examples.md`.

Session continuity has TWO artifacts and they are not interchangeable. The per-operator
fragment `.session-notes.d/<display_id>.md` — surfaced through the root aggregate — carries
STANDING DIRECTIVES: what this operator was told to do and has not finished. A workspace
`workspaces/<ws>/.session-notes` carries project NARRATIVE: what happened. An agent that reads
the narrative and skips the fragment inherits what happened while losing what it was told to
do, and **nothing in the narrative references the missing directive**, so the gap is
undetectable from the text it did read.

Composes with `knowledge-convergence.md` MUST-1, which established WHERE the fragment lives and
BLOCKS a single shared file. That rule governs LOCATION; `session-notes-incorporation-guard.js`
governs LAG (fragment behind HEAD). This rule governs the READ — its ORDER and its
COMPLETENESS — and bounds the artifact so a complete read stays affordable.

## MUST Rules

### 1. Read The Own-Operator Fragment Before Any Workspace Narrative

Within a session, the FIRST continuity artifact read MUST be a ROOT one — the operator's own
`.session-notes.d/<display_id>.md`, the root `.session-notes.aggregate.md`, the root
`.session-notes.shared.md` forest ledger, or a not-yet-migrated root `.session-notes`. Reading a
`workspaces/<ws>/.session-notes*` narrative and acting on it before any root artifact has been
read is BLOCKED. Where both are surfaced together, the fragment's directives govern; a narrative
that contradicts them is STALE until reconciled, never the other way round.

```text
DO: read the root operator fragment or aggregate first, then contextualize the workspace narrative.
DO NOT: act on a workspace 'finished' claim before reading the standing root directives.
```

**Why:** The narrative and the fragment are surfaced together (`findAllSessionNotes` returns
both, sorted by mtime — so a freshly-touched narrative outranks a stale-but-authoritative root
aggregate), and the narrative never cites the directive it omits, so an agent that stops after
the narrative has no signal that it is missing anything.

### 2. Never Truncate-Read A Continuity Artifact

A read of any continuity artifact MUST be WHOLE. Issuing the read with a `limit`, or with a
non-zero `offset`, is BLOCKED — including "just to check the top". An explicit `offset: 0` with
no `limit` is not a truncation and is permitted.

```text
DO: Read(.session-notes.d/<display_id>.md) with no limit; offset: 0 alone is allowed.
DO NOT: Read(notes, limit=50) or Read(notes, offset=200); each omits directives.
```

**Why:** A truncated read is indistinguishable at act-time from a complete one — the tool
returns content, not a signal that content was withheld — so every downstream decision inherits
the gap with full confidence. Only a tool-call-time check can tell the two apart.

### 3. A Continuity Artifact Stays Bounded — Target 150 Lines, Ceiling 300

Every HAND-AUTHORED continuity artifact MUST be written to a target of 150 lines and MUST NOT
exceed a ceiling of 300. Content beyond the ceiling MUST move to a NAMED overflow file under
`.session-notes.archive/<display_id>/` with an explicit pointer from the notes; letting the artifact
grow past the ceiling is BLOCKED. `.session-notes.d/` holds CURRENT fragments only — history left
there is excluded from the aggregate by name — and the aggregate carries a byte budget its generator
REFUSES past, naming the source, never truncating. The wave tracker likewise keeps current waves;
closed waves move to `.wave-tracker.d/archive/<display_id>.md`.

Archive tool: `node .claude/bin/session-notes-archive.mjs notes --apply` (CLI: `.claude/bin/session-notes-archive.mjs:42-61,74-77`).

**A DERIVED PROJECTION carries its OWN declared bound, and hand-trimming is never the remedy.**
The forest ledger `.session-notes.shared.md` is regenerated from the append-only event log per
`knowledge-convergence.md` MUST-1, so its length is a function of another file's bytes and the
overflow remedy above — relocate content, leave a pointer — would be silently reverted by the
next regeneration. A projection MUST therefore carry a ceiling DECLARED in its generator's
manifest, and the generator MUST REFUSE to emit past it rather than truncate. The only sanctioned
ways under it are an event in the log that retires the item, or a DECLARED narrowing of what the
projection renders. Deleting rows from a projection to bring it under a ceiling is BLOCKED —
that is `burndown-traceability.md` MUST-6's hand-removal, and it drops work with no diff.
**Fail-closed: until a ceiling is declared for a given projection, the 300-line ceiling above
applies to it unchanged.** MUST-2 is UNAFFECTED and applies to a projection exactly as to any
other continuity artifact — a projection is read WHOLE or not at all.

```text
DO: hand-authored notes point to named overflow in .session-notes.archive/; a projection generator refuses beyond its declared ceiling and retiring events shrink it.
DO NOT: append to a 900-line notes file or hand-trim projection rows; regeneration loses the edit.
```

**BLOCKED rationalizations:**

- "The projection is generated, so the ceiling does not apply to it"
- "I'll trim the oldest rows; they were stale anyway"
- "An append-only log has to be unbounded, so its projection must be too"
- "Move the overflow rows to a pointer file like any other continuity artifact"

**Why:** A no-truncate rule over an unbounded file only relocates the failure — it converts a
silently-partial read into a forced choice between violating MUST-2 and burning the context the
work needs. Bounding is what makes MUST-2 affordable. A projection needs a DIFFERENT bound for
the same reason it needs a different write path: the hand-authored remedy does not survive a
regeneration, so applying it produces a file that looks bounded until the generator next runs and
silently loses whatever was moved out.

## MUST NOT

- Cite a workspace narrative as evidence that a directive was discharged.

**Why:** The narrative records what happened, not what was mandated; absence of a directive from
it is absence of the artifact that carries directives, never evidence of completion.

- Treat a fragment that lags HEAD as authoritative without reconciling it first.

**Why:** `session-notes-incorporation-guard.js` fires precisely on this state; reading a lagging
fragment as current re-asserts standing directives that landed work has already discharged.

- Place an APPEND-ONLY LOG on any `.session-notes*` path.

**Why:** An append-only log is unbounded BY CONSTRUCTION, so it breaches MUST-3's ceiling outright
and makes MUST-2's no-truncate-read — which carries `block` teeth at `PreToolUse:Read` —
unaffordable: the reader would be required to read a file with no upper bound, whole, every
session. Both breaches are CONDITIONAL on the placement and the placement is ours, which is why
the ratified log lives at `.claude/hooks/lib/burndown-events.js::EVENTS_REL`
(`burndown/events.jsonl`), off this namespace, so neither clause ever fires on it. Relocating a
log onto `.session-notes*` "for discoverability" would silently re-open both.

Depth — the Trust-Posture Wiring and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/session-notes-continuity.md`, which every validator reads as part of this rule.
