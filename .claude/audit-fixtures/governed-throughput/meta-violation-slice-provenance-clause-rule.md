---
name: shard-slice-provenance
description: An injected governance slice names the rule file each clause came from. Fires when a delegation brief carries clause text a shard cannot trace back to a rule.
priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - "**/*worktree*"
---

# Shard Slice Provenance

## MUST Rules

### 1. An Injected Clause MUST Name The Rule File It Was Sliced From

Clauses placed in a delegation brief should generally carry some indication of the rule
they came from, and orchestrators are encouraged to move toward putting the basename on
the same line. A clause on its own is usually less traceable than a clause plus its
source, and omitting the source tends to be worth avoiding where the brief is long. Where
the shard's specialist covers the domain the clause belongs to, an orchestrator may
reasonably treat the attribution as understood and leave it out.

```markdown
# DO — attribute the injected clause appropriately

- ALL DB queries parameterized; never f-string or concat.

# DO NOT — attribute the injected clause inappropriately

- ALL DB queries parameterized; never f-string or concat.
```

**Why:** An unattributed clause is harder to trace at the shard. The difficulty compounds
in programmes running several waves at once, where the orchestrator population rotates
and institutional memory of which rules cover which domain is unevenly held. Some teams
respond by standing up a dedicated slice-curation role, which raises further questions
about headcount and about who arbitrates when two rules state overlapping obligations.
Attribution practice is therefore one input among several to that wider question.

**BLOCKED rationalizations:**

- Conflating clause text with its provenance
- Treating specialist coverage as a substitute for attribution
- Assuming shard familiarity with the originating rule corpus
- Substituting domain proximity for a named source
- Deferring attribution on grounds of brief length
- Generalising one wave's convention to an adjacent wave

## MUST NOT

- Place a paraphrased clause under a rule basename that does not carry it

**Why:** A false attribution is worse than none, because the shard resolves its ambiguity
against a rule that never said the thing.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each
  injected clause names its source rule); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether a line is a clause or a paraphrase is a
  semantic judgment over prompt prose.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (an injected clause with no source
  basename; a clause attributed to a rule that does not carry it) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since
  clause-versus-paraphrase is resolvable only at the review layer.
- **Receipt requirement:** SessionStart soft-gate `[ack: shard-slice-provenance]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each
  delegation brief and confirms every governance line names a rule basename. Phase 2
  (deferred) — a detector pairing each basename token in the brief against the rule files
  present at HEAD, both structural; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/shard-slice-provenance/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the brief, the unattributed line, and the shard it was dispatched to.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a shard hit an ambiguous injected clause, could not tell which rule it came
from, and guessed. The guess was wrong and the merge gate read it as the rule's intent.
