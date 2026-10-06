---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/cache/**"
  - "**/*cache*.py"
---

# Cache Key Namespacing — A Shared Key Space Is A Shared Blast Radius

A process-wide cache is one flat key space. Two subsystems that pick the same key do not collide
loudly; the second read returns the first writer's value with the right type and the wrong
meaning, and every assertion about it passes.

## MUST Rules

### 1. Every Cache Key Carries An Owner-Qualified Prefix

Every key written to a shared cache MUST be constructed through the owning module's key builder,
which prepends `<module>:<version>:`. Writing a bare string key, or interpolating one at the call
site, is BLOCKED.

```python
# DO — the builder owns the namespace, so the prefix cannot be forgotten
key = billing_keys.invoice(tenant_id, invoice_id)   # -> "billing:v3:invoice:<t>:<i>"
# DO NOT — a bare key that any other module may also choose
key = f"invoice:{invoice_id}"
```

**BLOCKED rationalizations:** "no other module uses the word invoice" / "it's a short-lived key,
it'll expire before anything collides" / "the tenant id makes it unique enough" / "we're the only
writer on this cache today" / "adding a prefix would invalidate the warm cache".

**Why:** A collision returns a structurally valid object of the expected type, so nothing raises
and no test fails — the two subsystems simply serve each other's data until someone notices a
figure that is wrong rather than missing.

### 2. A Key-Shape Change Bumps The Namespace Version

Any change to a key's component set or ordering MUST increment the `<version>` segment in the same
commit. Reusing a version across two key shapes is BLOCKED.

```python
# DO — the shape changed, so the namespace did too
BILLING_KEY_VERSION = "v4"   # was v3; invoice keys now include the currency
# DO NOT — new shape, same namespace, entries from both shapes alive at once
BILLING_KEY_VERSION = "v3"
```

**BLOCKED rationalizations:** "the old entries expire in an hour anyway" / "the deploy is atomic,
both shapes never coexist" / "bumping the version costs us a cold cache" / "the reader tolerates
the missing field".

**Why:** During any rollout both shapes are live, so a reader built for the new shape parses an
old entry and silently drops the component that was added.

## MUST NOT

- Read a key the reading module does not own without an explicit cross-module accessor

**Why:** An undeclared cross-module read makes the writer's key shape a public contract nobody
recorded, so the next owner-local refactor breaks a consumer it cannot see.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each cache
  write in the diff routes through its owning builder and that a shape change carries its version
  bump); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
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
  the diff. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory
  `PostToolUse(Edit|Write)` detector on a cache-client call whose key argument is a literal or an
  f-string rather than a builder call. That is an AST-decidable property of the call node, so the
  deferral names a structural signal and books enforcement that can arrive; fixtures land WITH it
  at `.claude/audit-fixtures/cache-key-namespacing/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 and MUST-2. Every `violations.jsonl` row names the key, the writing
  module, and which clause fired.
- **Origin:** See § Origin.

## Origin

2026-08-04 — a billing reader and a reporting reader both chose `invoice:<id>`. The reporting
value was served to billing for eleven minutes during a deploy. Nothing raised: the object was a
dict with the expected keys, and the invoice total on screen was simply another tenant's. The
incident is the reason this rule is phrased as a construction mandate rather than a review
checklist — a reviewer reading one call site cannot see the other module's key space.
