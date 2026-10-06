---
name: cache-key-namespacing
description: Cache keys carry their tenant segment ahead of the entity segment, and any key built from user input is hashed rather than interpolated. Fires on cache-layer edits where a key is assembled.
priority: 10
scope: path-scoped
paths:
  - "**/src/cache/**"
  - "**/src/**/cache_keys.*"
---

# Cache Key Namespacing

## MUST Rules

### 1. A Cache Key Should Carry Its Tenant Segment Before Its Entity Segment

When a cache key identifies a tenant-scoped entity, the tenant segment should come first,
ahead of the entity segment. Teams are encouraged to prefer this ordering so that a prefix
scan, an eviction sweep and a key dump are each bounded to one tenant. Placing the entity
segment first is discouraged, because the tenant segment then sits at an unknown offset and
no prefix operation can reach it.

```markdown
# DO — tenant segment first; a prefix scan is bounded to one tenant

cache.set(f"t:{tenant_id}:order:{order_id}", payload)
cache.scan_prefix(f"t:{tenant_id}:") # evicts this tenant, and only this tenant

# DO NOT — entity first; the tenant segment is unreachable by prefix

cache.set(f"order:{order_id}:t:{tenant_id}", payload)
cache.scan_prefix("order:") # sweeps every tenant's orders at once
```

**Why:** A tenant segment at an unknown offset cannot be reached by any prefix operation, so
the first per-tenant eviction becomes a full-keyspace scan under load.

### 2. A Cache Key Built From User Input Should Be Hashed, Not Interpolated Raw

Where a key segment originates in user input, the author should consider hashing it to a
fixed width before it enters the key. Interpolating the raw value is discouraged: the
delimiter is part of the key grammar, and a value containing the delimiter is preferred to be
rejected or hashed rather than allowed to re-partition the key.

```markdown
# DO — hash the user-controlled segment to a fixed width

key = f"t:{tenant_id}:q:{sha256(query.encode()).hexdigest()[:16]}"

# DO NOT — interpolate it raw; a colon in the value re-partitions the key

key = f"t:{tenant_id}:q:{query}" # query = "x:t:other-tenant:q:y" lands in another namespace
```

**Why:** A delimiter inside an interpolated value re-partitions the key, so one tenant's query
can be written into another tenant's namespace with no error raised anywhere.

**BLOCKED rationalizations:**

- "The tenant id is already in the value, so the key order does not matter"
- "We only ever fetch by exact key, we never scan by prefix"
- "The query text comes from our own UI, it cannot contain a colon"
- "Hashing makes the keys unreadable when I am debugging"
- "I will normalise the ordering in a follow-up once the feature lands"
- "The cache is short-lived, a bad key expires in five minutes anyway"

## MUST NOT

- Build a cache key by concatenating segments whose count varies with the input

**Why:** A variable segment count makes the key grammar ambiguous, so two different inputs can
serialise to one key.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each key
  built in the diff places its tenant segment first and hashes any user-controlled segment);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a key whose tenant segment is not
  first; a raw-interpolated user segment) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since key-shape is repairable in
  place and corrupts nothing already written.
- **Receipt requirement:** SessionStart soft-gate `[ack: cache-key-namespacing]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads every key
  construction in the diff. Phase 2 — an AST visitor over f-string and format-call nodes
  whose target is a `cache.set` / `cache.get` argument, reading the literal segment order and
  flagging any interpolated node not wrapped in a digest call. Both the node kind and the
  argument position are parsed structure, so the detector keys on structure and not on prose;
  fixtures land with it at `.claude/audit-fixtures/cache-key-namespacing/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the key expression and its source line.
- **Origin:** See § Origin.

## Origin

2026-08-24 — `journal/0418-INCIDENT-cross-tenant-cache-read.md` § 3: an eviction sweep written
as `scan_prefix("order:")` cleared every tenant's order cache during a single-tenant
migration, because the tenant segment sat third in the key.
