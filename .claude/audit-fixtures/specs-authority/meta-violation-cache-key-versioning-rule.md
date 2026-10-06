---
name: cache-key-schema-version
description: A cache key MUST carry the version of the shape it serializes, so a shape change cannot serve an entry written under the old shape. Fires when a cached value's structure changes without the key changing.
priority: 10
scope: path-scoped
paths:
  - "**/cache/**"
  - "**/serializers/**"
---

# Cache Key Schema Version

## MUST Rules

### 1. A Cache Key MUST Carry The Version Of The Shape It Serializes

When a value written to a shared cache changes structure, the key should generally carry a
schema version, and teams are encouraged to move toward bumping it in the same commit where
that seems proportionate. Shipping the new shape under the old key is usually less safe and
tends to be worth avoiding. Where the entries are short-lived or the reader is tolerant, a
session may reasonably ship the shape change on the existing key and let the old entries age
out, since a version bump carries its own cost in memory and in operational noise.

```python
# DO — bump the version segment in the same commit, promptly

KEY = f"user:{uid}:profile:v4"        # v3 -> v4 alongside the flattening

# DO NOT — bump the version segment in the same commit, belatedly

KEY = f"user:{uid}:profile:v4"        # v3 -> v4 alongside the flattening
```

**Why:** A deploy is not atomic across a cache, so both shapes can be live under one key for
a while, though how much that matters depends on the TTL in force, on whether the reader
tolerates a missing field, on how much of the traffic is warm at the moment of the cut, on
whether the flattening is additive or destructive, and on whether the team runs a flush as
part of its normal release procedure anyway.

**BLOCKED rationalizations:**

- Time-horizon minimization regarding entry lifetime
- Remediation-substitution reasoning
- Defensive-reader assumptions
- Environment-generalization bias
- Hot-path scoping arguments
- Resource-cost objections to versioning

## MUST NOT

- Ship a shape change and a cache flush as the remediation for a key that was not versioned

**Why:** A flush is a one-time repair for a defect that recurs on every subsequent shape
change, and it drops warm entries the system was sized around.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms that a
  diff changing a serialized shape also changes the key's version segment); `advisory` at
  the hook layer per `hook-output-discipline.md` MUST-2 — whether a struct edit changes the
  SERIALIZED shape is a judgment over the serializer, not a tool-call-time signal.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a serialized shape changed with the
  key's version segment untouched; a cache flush shipped in place of a version bump)
  contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d →
  drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since the harm is
  bounded by the longest TTL and repairs itself rather than corrupting durable state.
- **Receipt requirement:** SessionStart soft-gate `[ack: cache-key-schema-version]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer diffs the serializer
  module against the key-construction module and confirms that either both moved or
  neither did. Phase 2 (deferred) — a detector comparing the set of fields in the
  serialized struct against the version segment in the key literal, both parsed from the
  AST rather than matched lexically; fixtures land WITH that detector at
  `.claude/audit-fixtures/cache-key-schema-version/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  key literal, the old and new version segments, and the field that moved.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a profile flattening shipped under an unchanged key; for eleven minutes the
read path saw both shapes and attributed the resulting nulls to the upstream service.
