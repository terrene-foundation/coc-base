---
id: "SESSION-NOTES-CONTINUITY"
paths: ["**/.session-notes*", "**/.session-notes.d/**"]
---

# Session-Notes Continuity — The Directive Before The Narrative, And Whole

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
# DO — directive first, then the narrative it contextualizes
Read .session-notes.aggregate.md   → standing directives + open ledger rows
Read workspaces/<ws>/.session-notes → what happened, now correctly framed

# DO NOT — narrative first, act on it
Read workspaces/<ws>/.session-notes → "prior session finished the migration"
… and the fragment's "do NOT re-run the migration, it is superseded" is never read
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
# DO — whole file, no truncation parameters
Read(.session-notes.d/<display_id>.md)

# DO NOT — a windowed read of a directive surface
Read(.session-notes.d/<display_id>.md, limit=50)   # the 51st line is the directive
Read(workspaces/<ws>/.session-notes, offset=200)   # the carry-forward ledger is above it
```

**Why:** A truncated read is indistinguishable at act-time from a complete one — the tool
returns content, not a signal that content was withheld — so every downstream decision inherits
the gap with full confidence. Only a tool-call-time check can tell the two apart.

### 3. A Continuity Artifact Stays Bounded — Target 150 Lines, Ceiling 300

Every continuity artifact MUST be written to a target of 150 lines and MUST NOT exceed a
ceiling of 300. Content beyond the ceiling MUST move to a NAMED overflow file with an explicit
pointer from the notes; letting the artifact grow past the ceiling is BLOCKED.

```text
# DO — bounded, with a named pointer carrying the overflow
## Read first
- workspaces/<ws>/06-handoff/02-go-forward-plan.md  (the full plan; this file holds the pointer)

# DO NOT — a 900-line notes file
… every session appends; the next reader either truncates it (MUST-2) or spends the
context budget it needed for the work
```

**Why:** A no-truncate rule over an unbounded file only relocates the failure — it converts a
silently-partial read into a forced choice between violating MUST-2 and burning the context the
work needs. Bounding is what makes MUST-2 affordable.

## MUST NOT

- Cite a workspace narrative as evidence that a directive was discharged.

**Why:** The narrative records what happened, not what was mandated; absence of a directive from
it is absence of the artifact that carries directives, never evidence of completion.

- Treat a fragment that lags HEAD as authoritative without reconciling it first.

**Why:** `session-notes-incorporation-guard.js` fires precisely on this state; reading a lagging
fragment as current re-asserts standing directives that landed work has already discharged.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer for MUST-2 ONLY — a `limit`/`offset` parameter on a
  Read of a continuity artifact is read directly off the tool call, an irrefutable STRUCTURAL
  fact and not a lexical or heuristic inference, which is the narrow class
  `hook-output-discipline.md` MUST-2 reserves `block` for. `halt-and-report` at the hook layer
  for MUST-1 (read ORDER is inferred from per-session state, not a structural property of the
  call) and `advisory` for MUST-3 (blocking a write would strand the content being organised).
  `halt-and-report` at gate-review: cc-architect at `/codify` + reviewer at `/implement` confirm
  a session that acted on continuity notes read a ROOT artifact first and read it whole.
- **Grace period:** 7 days from rule landing (2026-08-12 → 2026-08-19).
- **Cumulative posture impact:** same-class violations (acting on a workspace narrative before
  any root continuity artifact was read; a truncated continuity read; a continuity artifact
  written past the 300-line ceiling with no named overflow pointer) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the
  GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1
  posture) — NO dedicated per-clause trigger key. Named deviation from the canonical
  key-per-clause shape, recorded here per `trust-posture.md` Rule 8: MUST-2 already carries a
  structural `block`, so a per-clause instant-drop key would double-count the one clause that
  cannot silently pass, while MUST-1 and MUST-3 are judgment-bearing and do not warrant one.
  Minting a key would additionally drag `trust-posture.md` — a `self-referential-codify.md`
  allowlist file — into a self-referential edit. Same disposition `security.md`
  § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: session-notes-continuity]` IFF
  `posture.json::pending_verification` includes the `session-notes-continuity` rule_id.
- **Detection mechanism:** structural, SHIPPED — nothing in this block is pending. The detector is
  `.claude/hooks/session-notes-guard.js`, registered at `PreToolUse:Read` (MUST-1 + MUST-2) and
  `PostToolUse:Edit|Write` (MUST-3); every branch fails OPEN and a `cc-artifacts.md` Rule 7
  timer bounds it. Its fixtures ship WITH it per `cc-artifacts.md` Rule 9 at
  `.claude/audit-fixtures/session-notes-continuity/`, one case per scope-restriction predicate,
  registered in `.claude/test-harness/ci-audit-fixtures.json` so they RUN in CI rather than sit
  unwired. Semantic tier: `.claude/test-harness/probes/session-notes-continuity.probes.json` is
  UNWRITTEN and its authorship is DECLARED and DATED in
  `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals` — MUST-1's read-order
  clause is a session-history judgment no structural fixture can substitute for, so until that
  suite exists this rule's semantic tier is UNCOVERED and stated as such rather than implied.
- **Violation scope:** rule-corpus-wide (MUST-1 + MUST-2 + MUST-3 and the two MUST NOTs). Each
  `violations.jsonl` row names the artifact path and which clause it breached.
- **Origin:** See § Origin.

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
