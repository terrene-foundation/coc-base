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

Every clause placed in a delegation brief MUST carry the basename of the rule it came
from, on the same line. Injecting clause text with no source is BLOCKED: a shard that
cannot name the rule cannot re-read it when the slice turns out to be ambiguous, and the
merge gate cannot tell a slice from an orchestrator's paraphrase.

```markdown
# DO — the clause and the file it was sliced from, on one line

- security.md: ALL DB queries parameterized; never f-string or concat.

# DO NOT — the clause alone, which the shard cannot re-read or verify

- ALL DB queries parameterized; never f-string or concat.
```

**Why:** An unattributed clause is indistinguishable at the shard from a rule, a
paraphrase, and an invention, so the shard cannot resolve an ambiguity by reading the
source.

**BLOCKED rationalizations:**

- "The shard has the whole corpus on disk, it can find the clause itself"
- "I wrote the slice from the rules, so the attribution is implied"
- "Adding filenames to every line makes the brief noisy"
- "The specialist already knows which rules cover its domain"
- "The merge gate will re-derive the sources anyway"
- "The clause text is verbatim, so the source adds nothing"

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
