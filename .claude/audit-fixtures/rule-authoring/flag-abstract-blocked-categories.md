---
name: vendor-lock-declaration
description: A dependency on a single vendor's proprietary surface is declared in the module header and paired with a named exit path before it ships. Fires on edits that import a vendor SDK.
priority: 10
scope: path-scoped
paths:
  - "**/src/integrations/**"
  - "**/src/**/vendor_*.py"
---

# Vendor Lock Declaration

## MUST Rules

### 1. A Proprietary Vendor Surface MUST Be Declared In The Module Header Before It Ships

Any module that imports a vendor SDK whose behaviour has no portable equivalent MUST carry a
`VENDOR-LOCK:` header naming the vendor, the specific surface depended on, and the named exit
path. Shipping the import without the header is BLOCKED, and a header naming the vendor but
leaving the exit path as "TBD" is BLOCKED for the same reason.

```markdown
# DO — the header names the surface and the exit, both specific

VENDOR-LOCK: acme-queue · ordered-delivery-within-partition ·
exit: re-shard onto the portable at-least-once path in `queue/portable.py`

# DO NOT — the import ships bare, or the exit is a placeholder

import acme_queue # no header at all
VENDOR-LOCK: acme-queue · ordered delivery · exit: TBD
```

**Why:** An undeclared vendor surface is discovered only when the vendor is being replaced, at
which point the exit has to be designed under migration pressure rather than at leisure.

### 2. A Vendor Surface With No Portable Equivalent MUST NOT Be Placed On A Request Path

A vendor surface that cannot be reproduced by any portable implementation MUST be confined to
a background or batch path. Placing it inline on a request path is BLOCKED, because the
outage of a single vendor then becomes the outage of the product.

```markdown
# DO — the vendor surface runs behind a queue, off the request path

enqueue(EnrichmentJob(order_id)) # the vendor call happens in the worker

# DO NOT — the vendor surface answers the request directly

return acme_enrich.lookup(order_id) # vendor down ⇒ this endpoint down
```

**Why:** A vendor with no portable equivalent on a request path converts that vendor's
availability into the product's availability, with no degradation path available.

**BLOCKED rationalizations:**

- Cost-deferral reasoning about migration effort
- Scope-boundary appeals concerning the current ticket
- Vendor-stability assumptions
- Reversibility overestimation
- Documentation-substitution patterns
- Prototype-exemption claims

## MUST NOT

- Record a vendor dependency in a design document instead of the module header

**Why:** A design document is not read at the moment the import is edited, so the declaration
never reaches the person who needs it.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  vendor import in the diff carries a `VENDOR-LOCK:` header with a named exit path, and that
  no such surface sits on a request path); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-19 → 2026-08-26).
- **Cumulative posture impact:** same-class violations (an undeclared vendor import; a header
  whose exit path is a placeholder; a vendor surface on a request path) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a missing header is repairable
  without touching the shipped behaviour.
- **Receipt requirement:** SessionStart soft-gate `[ack: vendor-lock-declaration]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each vendor import
  in the diff against the module header. Phase 2 — an import-graph walk over parsed import
  nodes, matched against the vendor package list in `pyproject.toml::tool.vendor-lock`, with
  the header parsed as a structured field; both the import node and the manifest entry are
  parsed structure, so the detector reads structure and not prose. Fixtures land with it at
  `.claude/audit-fixtures/vendor-lock-declaration/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the module, the vendor package and the surface.
- **Origin:** See § Origin.

## Origin

2026-08-19 — `journal/0402-INCIDENT-queue-vendor-migration.md` § 2: a two-week migration ran
to eleven weeks because four modules depended on ordered-delivery-within-partition and none
of the four said so anywhere.
