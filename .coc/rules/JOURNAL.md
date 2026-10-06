---
id: "JOURNAL"
paths: ["**/journal/**"]
---

# Journal Rules

Depth companion — cited below as **the extract** — is `.claude/guides/rule-extracts/journal.md` (field semantics, worked examples, clause-2 evidence, sweep procedure, Wiring narrative, Origin).

## Naming & Format

Sequential naming: `NNNN-<display_id>-TYPE-topic.md` (per `rules/knowledge-convergence.md` MUST-2; why the token is in the filename: extract § Frontmatter Field Semantics). Acquire the slot via `reserveJournalSlot` (fold-accepted high-water), not an `ls journal/` scan. Check the highest existing number before creating.

### Citation convention — cite a journal from a CASCADING artifact by NUMBER ONLY

Recorded per loom#1495 Class B, applied to this rule's own citations. Deliberately a CONVENTION and not a new MUST clause: a MUST landing after the `trust-posture.md` MUST-8 SHA owes canonical-8-field Wiring, which this rule does not carry for it. That reasoning is unchanged by the detector now existing, and the convention is NOT promoted on the strength of it.

`<display_id>` is an operator handle BY MANDATE, so a full-filename citation inside a distributed artifact ships canon operator identity to every consumer. In `.claude/{rules,skills,agents,commands,guides,hooks,bin}/**` cite the NUMBER; keep full filenames in non-distributed surfaces (`journal/**`, `workspaces/**`, commit bodies, PR text), where they resolve by copy-paste and disclose nothing.

```markdown
# DO — number only; the entry is still findable by `ls journal/0230-*`

receipt-first `journal/0230` · (loom-internal reference)

# DO NOT — the handle rides the citation into 30+ consumer repos

receipt-first `journal/0230-<handle>-DECISION-382-journal-contract-reconciliation.md`
```

**Why:** the journal FILES do not distribute — no tier matches them — but the CITATIONS do, and the SYNC lane copies verbatim (only the public-fork projection scrubs identity tokens), so the citation is the whole leak path. Number-only is the corpus's existing majority convention and breaks no resolver: MEASURED 2026-09-12, 578 bare-number citations across 127 distributed files resolve today, against a handful of full-filename ones — the falsifying result would be a resolver reddening on a bare number, and none does. Scrubbing a handle out of a filename would break copy-paste resolution and still leave the coupling; dropping the segment from the CITATION removes it. Origin: #1495 Class B (`rules/artifact-flow.md` § Canon Neutrality — "scrubbing a tenant NAME does NOT fix a tenant-COUPLING").

**Reachability residual, named rather than implied:** this rule is path-scoped over `**/journal/**`, so it does not load for a session editing a RULE while citing a journal. The DETECTOR closes that — `bin/scan-synced-disclosure.mjs::SHAPES` carries `journal-citation-display-id` (landed 2026-09-13), a filename-SHAPE check holding zero secret tokens. It keys on CASE rather than a TYPE list, so the legacy `journal/NNNN-TYPE-slug.md` form stays clean, and its synthetic-handle exemption is built from `bin/lib/identity-scrub.mjs::SYNTHETIC_FIXTURE_USERS`, the shared authority — a teaching placeholder keeps working, a real handle does not.

**What the detector does NOT cover, stated so its silence is not read as absence.** It is path-scoped AWAY from `audit-fixtures/**`, where 31 filename-shape citations live — 10 of them on a real handle, and those 10 DO reach a consumer on the `cc` tier. That is a named residual, not a clean surface; gate-review remains the enforcement for that tree. Why rewriting those fixtures is the worse trade: extract § Citation Convention — Detector Reach and Residual.

```yaml
---
type: DECISION | DISCOVERY | TRADE-OFF | RISK | CONNECTION | GAP | AMENDMENT
date: YYYY-MM-DD
author: human | agent | co-authored
project: [project name]
topic: [brief description]
phase: analyze | todos | implement | redteam | codify | deploy
verified_id: [from reservation — authoritative attribution]
person_id: [from reservation — the authority unit]
display_id: [from reservation — also in filename for collision disambiguation]
tags: [list]
relates_to: [optional — NNNN-slug of the entry this amends/extends/references]
---
```

This is the **canonical contract** the `/journal` command (`.claude/commands/journal.md`) emits — the two MUST agree. `verified_id` is authoritative for attribution scans; `author:` is the orthogonal provenance claim, verified per `rules/journal-author-discipline.md`; `created_at`/`session_id`/`session_turn` are RETIRED. Field semantics: extract § Frontmatter Field Semantics.

**Author decision tree**: `human` — user stated conclusion before AI. `agent` — AI surfaced unprompted. `co-authored` — evolved through exchange (default when uncertain). Author claims are verifiable, not trusted — a `human`/`co-authored` claim is checked against the live per-session provenance ledger per `rules/journal-author-discipline.md`.

## Entry Types

- **DECISION** — Architectural, design, strategic, or scope choices
- **DISCOVERY** — Research/analysis reveals new understanding
- **TRADE-OFF** — Balancing competing concerns
- **RISK** — Stress-testing reveals vulnerabilities
- **CONNECTION** — Cross-referencing reveals relationships
- **GAP** — Missing data, untested assumptions, unresolved questions
- **AMENDMENT** — Amends/extends a prior entry (redteam dispositions, convergence receipts, gap-closures) — references the original via `relates_to:` and never overwrites it

## Requirements

- Analytical entries (DISCOVERY, TRADE-OFF, RISK, GAP, CONNECTION) and **substantive DECISION** entries (those weighing alternatives) MUST include `## For Discussion` with 2-3 probing questions (at least one counterfactual, at least one referencing specific data). Terse **coordination-receipt DECISIONs** AND **AMENDMENT** entries — entries whose body is a durable receipt (closure SHAs, criteria-met tables, redteam dispositions, convergence verdicts, wave-boundary captures per `rules/wave-loop.md` G2) — MAY omit `## For Discussion`; they MUST still be self-contained.

**Why:** Without discussion questions, ANALYTICAL entries become write-only artifacts that capture decisions but never challenge them; and forcing manufactured questions onto a terse closure receipt is the ceremony the `wave-loop.md` G2 lightweight-capture step exists to avoid. Worked example + the AMENDMENT receipt-class rationale: extract § Requirements — Receipt-Class Detail.

- Entries MUST be self-contained — readable without other context

**Why:** Entries referenced months later by a different agent are useless if they depend on session context that no longer exists.

- DECISION entries SHOULD include alternatives and rationale
- Entries SHOULD include consequences and follow-up actions

## MUST NOT

- Overwrite existing entries — immutable once created. New entry references the original.

**Why:** Overwriting destroys the audit trail of how decisions evolved, making it impossible to understand why a position changed.

- Create entries without frontmatter

**Why:** Entries without frontmatter cannot be filtered by type, phase, or date, making the journal unsearchable at scale.

## SessionEnd Auto-Capture & Pending-Journal Hygiene

### 1. Workspace `journal/.pending/` MUST Be Gitignored At Repo Root

Every repo running the SessionEnd auto-capture hook MUST carry a `**/journal/.pending/` ignore pattern in the repo-root `.gitignore`.

```gitignore
# DO — repo-root .gitignore carries the pattern
**/journal/.pending/

# DO NOT — pattern absent: every /wrapup sweeps session-local staging
# into the working tree; it leaks as dirty-tree noise into unrelated PRs
```

**Why:** `.pending/` is session-local auto-capture staging, not committed institutional knowledge. Without the root ignore pattern, a fresh consumer repo re-creates the un-ignored directory and the dirty-tree noise returns on the next sync.

### 2. SessionEnd Auto-Capture Routes By The Commit's Issue Trailer, Not The CWD Workspace

The SessionEnd auto-capture hook MUST write a commit's `.pending/` entry into the workspace whose issue number matches the commit's `Closes #N` / `Refs #N` trailer — NOT the session-CWD workspace. Commits with no trailer route to a shared `_unrouted/` staging area. The clause is the behavioral CONTRACT the hook must satisfy and MAY ship ahead of it.

```text
# DO — route by trailer
commit "fix(pool): close leak\n\nRefs #912" → workspaces/issue-912/journal/.pending/

# DO NOT — route by CWD
same commit captured into the issue-835 workspace because that was the session CWD
```

**Why:** CWD-routing diffuses institutional value away from the issue that earned it and concentrates triage cost in whichever workspace happened to be the CWD. Measured evidence + implementation status: extract §§ SessionEnd Clause 2.

**Trust Posture Wiring (clauses 1 + 2):**

- **Severity:** `advisory` (structural file-state signals; no block per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute per `trust-posture.md` MUST-4 (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart soft-gate `[ack: pending-journal-hygiene]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** clause 1 — a `git check-ignore` exit-0 check on the workspace `.pending/` path; clause 2 — the SessionEnd hook's `Closes`/`Refs #N` parser. **Probes: REGISTERED — `.claude/test-harness/probes/journal.probes.json`**, bipolar `pair_id` pairs — one firing pair per clause `check-clause-coverage.mjs::deriveClauses` returns for this file — with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/journal/`, registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses. An earlier revision of this field declared the suite NOT YET AUTHORED against a `phase2-deferrals.json::probe_authorship_deferrals` row; that row is deleted and the claim withdrawn. The suite is scoped to the three DERIVED clauses above, NOT to SessionEnd clauses 1 + 2, whose signals are structural and are carried by the `git check-ignore` and trailer-parse checks named earlier in this same field. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Row and pair counts, the exact invocation, and the withdrawn NOT-YET-AUTHORED revision of this field: extract § SessionEnd Wiring — Detection Runnable Detail.
- **Violation scope:** clauses 1 (gitignore pattern) + 2 (trailer routing contract).
- **Origin:** 2026-05-18 — issue #1086 candidates 2 + 4; full origin: extract § SessionEnd Wiring — Origin.

## Backfill / Grandfathering

Entries created BEFORE a frontmatter-or-section contract change are **grandfathered** — they MUST NOT be rewritten to match the new contract (the immutability MUST NOT above forbids overwriting). A contract change applies only to entries created AFTER it lands. The corpus is allowed to carry mixed shapes across a contract boundary; the boundary is the contract's land-date, not a backfill sweep.

**Why:** Immutability and "every entry matches the current contract" are in direct tension; immutability wins. Rewriting historical entries to satisfy a new frontmatter shape would destroy the audit trail the immutability rule protects — a self-defeating fix.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect / reviewer sweep at `/codify`). `block` at the hook layer ONLY for the structural `fs.existsSync` overwrite check in `.claude/hooks/journal-write-guard.js` per `rules/hook-output-discipline.md` MUST-2; the SECTION-shape check (`## For Discussion`) is judgment-bearing and stays `halt-and-report` at gate-review with no hook layer at all. The FRONTMATTER-shape check emits `advisory`. Why that is a RAISE and not a downgrade, and why it sits BELOW what MUST-2 would permit for a parsed-document signal: extract § Trust Posture Wiring — Field Narrative.
- **Grace period:** 7 days from this reconciliation landing.
- **Cumulative posture impact:** same-class violations (a new entry shipped without canonical frontmatter, or an analytical entry missing `## For Discussion`) contribute to `rules/trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days of landing routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated per-clause emergency-trigger key.
- **Receipt requirement:** SessionStart MUST require `[ack: journal]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** Phase 1 — review-layer at `/codify`, two layers per `rules/probe-driven-verification.md` MUST-1: **(a) mechanical** greps verify STRUCTURE; **(b) semantic** — whether `## For Discussion` is REQUIRED (analytical/substantive) or exempt (coordination-receipt DECISION / AMENDMENT) is the reviewer's judgment, never a grep. The structural file-overwrite half is enforced at PreToolUse(Write) by `.claude/hooks/journal-write-guard.js`. Sweep procedure: extract § Detection Mechanism — Phase-1 Sweep Detail. **The frontmatter-shape detector SHIPPED 2026-09-15, and its Phase-2 deferral row is deleted in the same change.** Predicates: `.claude/hooks/lib/journal-frontmatter-shape.js::inspectFrontmatterShape` (pure, no I/O), called from `.claude/hooks/journal-write-guard.js::shapeAdvisoryOrPassthrough`. **Severity `advisory`, under rule_id `journal/frontmatter-shape`** — deliberately NOT `journal-author-discipline/MUST-1`, which reads the SAME block in the SAME guard for a different obligation. It scopes to NEW entries only, sitting BELOW the `fs.existsSync` overwrite block — the population § Backfill / Grandfathering scopes a contract change to — and it carries NAMED blind classes whose silence MUST NOT be read as absence. Fixtures: `.claude/audit-fixtures/journal-frontmatter-shape/`; it reaches every lane this rule reaches, so no `detector-distribution-baseline.json` row is owed. What it fires on, the rule_id split, the symbol-anchor rationale, the blind-class enumeration, the single-parse delegation, the measured corpus divergence, the fixture inventory and the distribution measurement with its two controls: extract § Detection Mechanism — The Frontmatter-Shape Detector.
- **Violation scope:** the canonical-frontmatter requirement + the scoped `## For Discussion` requirement. The `author:`-verifiability half is scoped to `journal-author-discipline.md`, not this rule.
- **Origin:** See § Origin below. Per-field narrative for the bullets above: extract § Trust Posture Wiring — Field Narrative.

## Origin

Frontmatter-shape + format MUST clauses predate the `rules/trust-posture.md` MUST-8 SHA (grandfathered). 2026-06-07 reconciliation (GH #382), receipt-first `journal/0230`; what it changed + the self-referential-codify surface: extract § Origin — The 2026-06-07 Reconciliation (GH #382).

**Extraction record** — two passes (2026-08-19 structural cleanup, 2026-09-15 budget-driven), both ZERO de-scoping: every MUST, MUST NOT, DO/DO-NOT block and failure-mode `**Why:**` stayed in the body verbatim, and both Wiring blocks keep every canonical field label with its normative statement. Evidence, runnable detail, worked examples, measured narrative and per-instance provenance live in `.claude/guides/rule-extracts/journal.md`, whose §§ the pointers above name. Per-pass ledger, and why `rule-authoring.md` Rule 10 / Rule 11 do NOT fire on a `scope: path-scoped` rule: extract § Extraction Record.
