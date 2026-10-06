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

When a value written to a shared cache changes structure — a field renamed, a nested object
flattened, a type widened — the KEY MUST change in the same commit, by carrying a schema
version segment that is bumped alongside the shape. Shipping the new shape under the old key
is BLOCKED: entries written by the previous deploy are still live and will be read back by
the new code, which finds the field where it is no longer written.

```python
# DO — the version segment moves with the shape, in one commit

KEY = f"user:{uid}:profile:v4"        # v3 -> v4 in the same diff as the flattening
# old entries stay under v3, expire on their own TTL, are never read by the new code

# DO NOT — new shape, same key; the old entries are now landmines

KEY = f"user:{uid}:profile:v3"        # shape flattened, key untouched
# a v3 entry written 40 seconds ago returns `address` as a nested object
```

**Why:** A deploy is not atomic across a cache, so for the length of the longest TTL both
shapes are live under one key and the reader cannot tell which it got.

**BLOCKED rationalizations:**

- "The TTL is only five minutes, it will drain itself"
- "I will flush the cache as part of the deploy"
- "The new code handles both shapes defensively"
- "Staging has been fine for a week"
- "Nobody reads that field on the hot path"
- "Bumping the version doubles the memory until the old keys expire"

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
