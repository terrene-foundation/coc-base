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
exceed a ceiling of 300. Content beyond the ceiling MUST move to a NAMED overflow file with an
explicit pointer from the notes; letting the artifact grow past the ceiling is BLOCKED.

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
DO: hand-authored notes point to named overflow; a projection generator refuses beyond its declared ceiling and retiring events shrink it.
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
  written past the 300-line ceiling with no named overflow pointer; a DERIVED PROJECTION
  hand-trimmed to fit a ceiling; a projection emitted past a declared ceiling instead of refused;
  an append-only log placed on a `.session-notes*` path) contribute to
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
  unwired. **What that detector does NOT cover, stated as gaps rather than implied covered:**
  `decideCeilingAdvisory` (`session-notes-guard.js`, PostToolUse `Edit|Write`) does not exempt or
  specially handle a projection, and it ADVISES rather than refuses; and nothing structurally
  prevents a log being created on a `.session-notes*` path — the placement is held by this rule and
  by `.claude/hooks/lib/burndown-events.js::EVENTS_REL` being a constant, not by a check. Both are
  gate-review-only at cc-architect `/codify`.
  **SUPERSEDED — a third clause stood here and is now false.** It read: "no generator today declares
  or refuses at a projection ceiling", and routed MUST-3's derived-projection bound to gate-review
  with the two above. That was TRUE when this block was written (`b815c620`) and is FALSE at the tip
  that ships: `5dee4a30` landed BOTH halves. The ceiling is DECLARED at
  `burndown-manifest.json::tracker.max_rows` (277 today), resolved by
  `session-notes-layout.js::_resolveProjectionCeiling`, which reports whether the value was declared
  or fell back. And the generator REFUSES past it: `regenerateForestLedger` returns
  `{ok:false, error:"projection ceiling exceeded", …}` when `folded.rows.size > ceiling.maxRows`,
  leaving the projection on disk UNCHANGED and truncating nothing, with the refusal citing this
  rule's MUST-3 by name in the source. It refuses in **BOTH** modes — the check arm is gated on the
  same branch, because an `in_sync: true` over an over-ceiling projection would certify the breach as
  healthy. `.claude/bin/forest-ledger-project.mjs` surfaces it as exit 2 (`REFUSED`), explicitly not
  a pass. So MUST-3's projection ceiling has a shipped structural tier; what remains gate-review-only
  is the hand-trim half and the log-placement MUST NOT named above. **Semantic tier: REGISTERED —
  `.claude/test-harness/probes/session-notes-continuity.probes.json`**, 10 rows in 5 bipolar
  `pair_id` pairs: one firing pair per derived clause (MUST-1, MUST-2, MUST-3, MUST NOT), each
  carrying BOTH a violation and a compliant pole, plus a surface-equalized meta-compliance pair.
  Candidates + answer-key sidecars sit at `.claude/audit-fixtures/session-notes-continuity/`,
  beside the structural runner already there. This is the tier `session-notes-guard.js` cannot
  reach: the guard decides ONE tool call, whereas a judge reads whether the SESSION carried the
  directive forward — whether a narrative was acted on before any root artifact was opened, and
  whether a standing directive was written off against a narrative's silence. MUST-2 is the
  exception and its pair is built to respect it: the truncation parameter is a structural fact
  off the call, so the violation pole IS the windowed read, not a judgment about one.
  Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes
  `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is
  NEVER evidence these probes passed — they execute only when an orchestrator dispatches
  `/test-harness-probe --artifacts` at gate-review.
- **Violation scope:** rule-corpus-wide (MUST-1 + MUST-2 + MUST-3, including MUST-3's
  derived-projection bound, and the three MUST NOTs, including the log-placement one). Each
  `violations.jsonl` row names the artifact path and which clause it breached, and for a
  projection row whether the failure was a hand-trim or an unrefused ceiling overrun.
- **Origin:** See § Origin.

Origin: 2026-08-12 — `/sync-from-use` Rust-template ingest of a downstream-relayed proposal.
First-hand read-order and truncation evidence: full examples companion § Initial Origin Evidence.
Prose alone was known-insufficient before this rule was written: the directive the offer protects
already existed at the relaying template and was still not read, which is the argument for the
paired structural hook rather than a fourth MUST clause.

**MUST-3 derived-projection bound + the log-placement MUST NOT — 2026-08-23**, per the
operator-ratified (loom-internal reference)
(C4, T5). MEASURED at ratification and re-measured here: `.session-notes.shared.md` is 291 lines /
269 rows against MUST-3's 300-line ceiling — 97% consumed, ~9 rows from breach — and
`decideCeilingAdvisory` does NOT exempt the ledger kind. MUST-2's `block` teeth are UNCHANGED and
deliberately not weakened; the log was placed off this namespace precisely so neither MUST-2 nor
MUST-3 fires on it, and the new MUST NOT is what keeps that placement a rule rather than a habit.
This rule is MEASURED OFF the `self-referential-codify.md` allowlist (zero hits for
`session-notes-continuity` there against a control that returned hits for `knowledge-convergence`
on the same tree), so it is Tier-2. `rule-authoring.md` Rule 10 does not fire — this rule is
`priority: 10` / `scope: path-scoped`, and Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` only.
