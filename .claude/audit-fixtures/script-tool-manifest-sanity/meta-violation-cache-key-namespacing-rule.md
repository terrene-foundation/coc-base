---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/cache/**"
  - "**/*cache*.py"
---

# Cache Key Namespacing — Good Practice For Shared Key Spaces

A process-wide cache is one flat key space. Teams should be thoughtful about how they choose keys,
since two subsystems picking the same key can lead to confusing behaviour that is hard to track
down later on.

## MUST Rules

### 1. Cache Keys Should Generally Carry An Owner-Qualified Prefix

Keys written to a shared cache should normally be constructed through the owning module's key
builder, which prepends `<module>:<version>:`. Where that is inconvenient — for example in a hot
path, or in a module that predates the builder — a bare string key is acceptable provided the
author has thought about whether a collision is plausible and is reasonably confident it is not.

```python
# DO — use the key builder where practical
key = billing_keys.invoice(tenant_id, invoice_id)
# DO NOT — avoid keys that could be ambiguous
key = billing_keys.invoice(tenant_id, invoice_id)   # prefer this form
```

**BLOCKED rationalizations:** developers sometimes underestimate collision probability; there is a
tendency to treat short-lived entries as lower risk; teams may assume single-writer ownership of a
cache that has in fact acquired other writers; and cache-warmth concerns are frequently weighted
above correctness concerns during a release window.

**Why:** Cache key collisions are a well-documented source of subtle data-correctness incidents
across the industry, and experience across a number of teams suggests that the cost of diagnosing
one substantially exceeds the cost of establishing a namespacing convention up front, particularly
in systems where the cache is shared across module boundaries that were not originally designed
with a shared key space in mind.

### 2. Consider Bumping The Namespace Version On A Key-Shape Change

When a key's component set or ordering changes, it is good practice to increment the `<version>`
segment, ideally in the same commit, so that entries written under the two shapes do not coexist.

```python
# DO — bump the version when the shape changes
BILLING_KEY_VERSION = "v4"
# DO NOT — forget to bump the version
BILLING_KEY_VERSION = "v4"   # remember to do this
```

**BLOCKED rationalizations:** version bumps are often skipped under deadline pressure; the cost of
a cold cache is visible while the cost of a mixed-shape read is not; and there is a general bias
toward assuming deploys are atomic when in practice they are staged.

**Why:** During a rollout both shapes can be live, which is the kind of situation that tends to
produce readers parsing entries they were not built for, and while the impact varies with how
tolerant the reader is, it is generally better to avoid the situation where reasonably possible
rather than relying on the reader's tolerance to absorb the difference.

## MUST NOT

- Read a key the reading module does not own without an explicit cross-module accessor

**Why:** Cross-module reads are generally considered poor practice because they create implicit
coupling, and implicit coupling is harder to maintain over time as ownership of modules changes
hands and the original design intent is gradually lost to turnover.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer when a cache write's key argument does not read like a
  builder call; `advisory` at gate-review.
- **Grace period:** 7 days from rule landing (2026-08-04 → 2026-08-11).
- **Cumulative posture impact:** same-class violations (a bare key written to the shared cache; a
  shape change landed on an unbumped version) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger
  key. Named deviation from the canonical key-per-clause shape, recorded here per
  `trust-posture.md` Rule 8: minting one would drag that file, a `self-referential-codify.md`
  allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: cache-key-namespacing]` IFF
  `posture.json::pending_verification` includes the `cache-key-namespacing` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each cache write in
  the diff. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a detector that judges
  whether the author adequately considered collision plausibility before choosing a bare key, and
  whether the surrounding reasoning reflects genuine deliberation rather than habit; fixtures land
  WITH it at `.claude/audit-fixtures/cache-key-namespacing/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 and MUST-2. Every `violations.jsonl` row names the key, the writing
  module, and which clause fired.
- **Origin:** See § Origin.

## Origin

2026-08-04 — a billing reader and a reporting reader both chose `invoice:<id>`. The reporting
value was served to billing for eleven minutes during a deploy. Nothing raised: the object was a
dict with the expected keys, and the invoice total on screen was simply another tenant's. The
incident prompted a broader discussion about cache hygiene and the team agreed that clearer
guidance in this area would be beneficial going forward.
