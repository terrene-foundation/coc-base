---
priority: 10
scope: path-scoped
paths:
  - "journal/**"
  - "**/journal/**"
---

# Journal Rules

<!-- slot:neutral-body -->

## Naming & Format

Sequential naming: `NNNN-<display_id>-TYPE-topic.md` (the `<display_id>` token keeps concurrent same-`seq` reservations distinguishable per `rules/knowledge-convergence.md` MUST-2). Acquire the slot via `reserveJournalSlot` (fold-accepted high-water), not an `ls journal/` scan. Check the highest existing number before creating.

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

This is the **canonical contract** the `/journal` command (`.claude/commands/journal.md`) emits — the two MUST agree. The `verified_id`/`person_id`/`display_id` triple is the cryptographic operator identity per `rules/knowledge-convergence.md` MUST-2 (`verified_id` is authoritative for attribution scans). The `author:` field is the orthogonal provenance claim (WHO originated the decision, not which key signed it), verified per `rules/journal-author-discipline.md`. The single-operator-era fields `created_at`/`session_id`/`session_turn` are RETIRED — the per-session provenance ledger (`.claude/learning/provenance/<session>.jsonl`) supersedes them.

**Author decision tree**: `human` — user stated conclusion before AI. `agent` — AI surfaced unprompted. `co-authored` — evolved through exchange (default when uncertain). Author claims are verifiable, not trusted — a `human`/`co-authored` claim is checked against the live per-session provenance ledger; see `rules/journal-author-discipline.md`.

## Entry Types

| Type           | When                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DECISION**   | Architectural, design, strategic, or scope choices                                                                                                          |
| **DISCOVERY**  | Research/analysis reveals new understanding                                                                                                                 |
| **TRADE-OFF**  | Balancing competing concerns                                                                                                                                |
| **RISK**       | Stress-testing reveals vulnerabilities                                                                                                                      |
| **CONNECTION** | Cross-referencing reveals relationships                                                                                                                     |
| **GAP**        | Missing data, untested assumptions, unresolved questions                                                                                                    |
| **AMENDMENT**  | Amends/extends a prior entry (redteam dispositions, convergence receipts, gap-closures) — references the original via `relates_to:` and never overwrites it |

## Requirements

- Analytical entries (DISCOVERY, TRADE-OFF, RISK, GAP, CONNECTION) and **substantive DECISION** entries (those weighing alternatives) MUST include `## For Discussion` with 2-3 probing questions (at least one counterfactual, at least one referencing specific data). Terse **coordination-receipt DECISIONs** AND **AMENDMENT** entries — entries whose body is a durable receipt (closure SHAs, criteria-met tables, redteam dispositions, convergence verdicts, wave-boundary captures per `rules/wave-loop.md` G2) — MAY omit `## For Discussion`; they MUST still be self-contained. (AMENDMENT is receipt-class by construction: it extends a prior entry whose own `## For Discussion`, if analytical, already carries the open questions.)

**Why:** Without discussion questions, ANALYTICAL entries become write-only artifacts that capture decisions but never challenge them. A terse closure receipt ("F86 done: commits X+Y, criteria 1-8 met") has nothing to counterfactually challenge — forcing manufactured questions onto it is the ceremony the `wave-loop.md` G2 lightweight-capture step exists to avoid.

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

The SessionEnd auto-capture hook MUST write a commit's `.pending/` entry into the workspace whose issue number matches the commit's `Closes #N` / `Refs #N` trailer — NOT the session-CWD workspace. Commits with no trailer route to a shared `_unrouted/` staging area. This clause is the behavioral CONTRACT the hook must satisfy; the hook implementation lands separately (loom-side, per issue #1086 acceptance criteria) and the clause MAY ship ahead of it.

```text
# DO — route by trailer
commit "fix(pool): close leak\n\nRefs #912" → workspaces/issue-912/journal/.pending/

# DO NOT — route by CWD
same commit captured into the issue-835 workspace because that was the session CWD
```

**Why:** CWD-routing diffuses institutional value away from the issue that earned it and concentrates triage cost in whichever workspace happened to be the CWD — in the originating triage, 28 of 33 auto-captured entries were unrelated to the workspace they landed in.

**Trust Posture Wiring (clauses 1 + 2):**

- **Severity:** `advisory` (structural file-state signals; no block per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute per `trust-posture.md` MUST-4 (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart soft-gate `[ack: pending-journal-hygiene]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** clause 1 — `git check-ignore workspaces/<x>/journal/.pending/probe` exit-0 check; clause 2 — the SessionEnd hook's `Closes`/`Refs #N` parser (lands with the loom-side hook implementation).
- **Violation scope:** clauses 1 (gitignore pattern) + 2 (trailer routing contract).
- **Origin:** 2026-05-18 — issue #1086 candidates 2 + 4 (SessionEnd hook-noise audit; gitignore fix already landed BUILD-side but no rule made it durable across repos).

## Backfill / Grandfathering

Entries created BEFORE a frontmatter-or-section contract change are **grandfathered** — they MUST NOT be rewritten to match the new contract (the immutability MUST NOT above forbids overwriting). A contract change applies only to entries created AFTER it lands. The corpus is allowed to carry mixed shapes across a contract boundary; the boundary is the contract's land-date, not a backfill sweep.

**Why:** Immutability and "every entry matches the current contract" are in direct tension; immutability wins. Rewriting historical entries to satisfy a new frontmatter shape would destroy the audit trail the immutability rule protects — a self-defeating fix.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect / reviewer mechanical sweep at `/codify` confirms new journal entries carry the canonical frontmatter AND `## For Discussion` where the entry-type requires it). `block` at the hook layer only for the structural `fs.existsSync` overwrite check in `.claude/hooks/journal-write-guard.js` (file-already-on-disk is an irrefutable structural signal per `rules/hook-output-discipline.md` MUST-2); the frontmatter/section-shape checks are judgment-bearing and stay `halt-and-report`.
- **Grace period:** 7 days from this reconciliation landing.
- **Cumulative posture impact:** same-class violations (a new entry shipped without canonical frontmatter, or an analytical entry missing `## For Discussion`) contribute to `rules/trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days of landing contributes via the cumulative path above; no dedicated emergency-trigger key (the `author:`-claim half is already covered by `journal-author-discipline.md`'s `unbacked_author_claim` emergency trigger).
- **Receipt requirement:** SessionStart MUST require `[ack: journal]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** Phase 1 — review-layer at `/codify`, in two distinct layers per `rules/probe-driven-verification.md` MUST-1 (mechanical greps verify STRUCTURE; semantic judgment is the reviewer's, never a grep). **(a) Mechanical:** cc-architect greps new `journal/NNNN-*.md` entries for (i) frontmatter presence of `type/date/author/project/topic/phase/verified_id/person_id/display_id/tags`, (ii) a valid `type:` enum value, (iii) the PRESENCE-or-ABSENCE of a `## For Discussion` heading. **(b) Semantic (reviewer judgment, NOT greppable):** whether `## For Discussion` is REQUIRED for a given entry — i.e. whether the entry is analytical/substantive (required) vs a coordination-receipt DECISION or AMENDMENT (exempt) — is an irreducibly semantic classification the gate-level reviewer adjudicates against the entry body; the grep supplies the presence/absence signal, the reviewer supplies the required/exempt verdict. The structural file-overwrite half is enforced at PreToolUse(Write) by `.claude/hooks/journal-write-guard.js`. Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, tracked as a forest item alongside the other Phase-2 advisory detectors): a frontmatter-shape advisory detector + an audit-fixture dir; until then the journal-write-guard fixtures cover the structural half and the cc-architect sweep covers the rest.
- **Violation scope:** the canonical-frontmatter requirement + the scoped `## For Discussion` requirement. The `author:`-verifiability half is scoped to `journal-author-discipline.md`, not this rule.
- **Origin:** See § Origin below.

## Origin

Frontmatter-shape + format MUST clauses predate the `rules/trust-posture.md` MUST-8 SHA (grandfathered). The 2026-06-07 reconciliation (GH #382): retired `created_at`/`session_id`/`session_turn` in favor of the multi-operator triple + per-session provenance ledger, scoped `## For Discussion` to analytical/substantive entries (coordination-receipt DECISIONs exempt), stated the grandfather/backfill policy, and added this canonical-template Trust Posture Wiring. Receipt-first DECISION: `journal/0230-esperie-DECISION-382-journal-contract-reconciliation.md`. Self-referential-codify surface (this rule + `commands/journal.md` are codify-class output governors — added to the `self-referential-codify.md` allowlist in the same codify) → multi-agent redteam to convergence.

<!-- /slot:neutral-body -->
