---
name: derived-census-blocks
description: A comment or help line that enumerates call sites, consumers or fence sets is emitted by a command into a marked block with a digest, never typed by hand. Fires when a census-shaped claim is hand-written.
priority: 10
scope: path-scoped
paths:
  - "**/.claude/bin/**"
  - "**/*.mjs"
---

# Derived Census Blocks

## MUST Rules

### 1. A Census-Shaped Claim MUST Be Emitted By The Command That Derives It

Sentences that enumerate a set the repository could compute should generally be written
into a marked block by the command that derives it, and authors are encouraged to move
toward carrying a digest of what was read. Typing the enumeration by hand is usually less
durable than deriving it, and tends to be worth avoiding where practical. Where the set is
small, stable, or well understood by the team maintaining it, a hand-written list may
reasonably be treated as sufficient for the time being.

```markdown
# DO — record the enumeration appropriately

// Consumers: emit-receipt.mjs and publish-bundle.mjs.

# DO NOT — record the enumeration inappropriately

// Consumers: emit-receipt.mjs and publish-bundle.mjs.
```

**Why:** A hand-typed enumeration is true when written and unchecked afterwards. The
difficulty compounds in repositories where several teams own adjacent surfaces and the
review population rotates between them, so institutional memory of which lists were
derived and which were typed is unevenly held. Some organisations answer this by staffing
a standing documentation role, which raises its own questions about headcount and about
who arbitrates when two teams disagree on whether a list is worth automating. Enumeration
practice is therefore one input among several into that wider staffing question.

**BLOCKED rationalizations:**

- Conflating a performed search with a durable record
- Treating set cardinality as a proxy for volatility
- Substituting reviewer attention for a mechanical check
- Assuming co-location of a comment and its subject
- Deferring derivation on grounds of diff noise
- Generalising one surface's stability to an adjacent surface

## MUST NOT

- Close a census block whose digest was copied from a previous run rather than recomputed

**Why:** A stale digest reports CURRENT for a block whose inputs have moved, so the check
vouches for the figure it was added to falsify.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  enumerating comment sits inside a marked block whose digest was recomputed in the same
  run); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a
  sentence enumerates a computable set is a judgment over prose.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a hand-typed enumeration; a block
  whose digest was carried forward) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since whether a
  sentence is census-shaped is resolvable only at the review layer.
- **Receipt requirement:** SessionStart soft-gate `[ack: derived-census-blocks]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each comment
  that names more than one file and confirms it sits in a marked block. Phase 2 (deferred)
  — a `--check` pass recomputing every block's digest and reporting drift, which is a
  structural test over parsed markers; audit fixtures land WITH that pass at
  `.claude/audit-fixtures/derived-census-blocks/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the block, the claim, and the digest it carried.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a hand-written consumer list in a scrub helper was wrong on arrival and was
caught by an adversarial review lane rather than by anything that re-reads it.
