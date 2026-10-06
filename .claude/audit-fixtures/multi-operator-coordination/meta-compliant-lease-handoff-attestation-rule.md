---
name: lease-handoff-attestation
description: A lease passed from one session to a successor carries a signed attestation naming both holders. Fires when a lease changes hands without a release record in between.
priority: 10
scope: path-scoped
paths:
  - "**/.claude/learning/**"
  - "**/*lease*.mjs"
---

# Lease Handoff Attestation

## MUST Rules

### 1. A Lease Handed To A Successor MUST Carry An Attestation Naming BOTH Holders

A lease that passes to a successor session without an intervening release MUST land a
signed `lease-handoff` record naming the outgoing holder and the incoming one. Extending
the existing acquire record's TTL is BLOCKED: the acquire names one holder, so the log
after an extension is indistinguishable from a log in which nobody ever handed anything
over.

```text
# DO — one record, both holders, so the successor is derivable from the log

lease-handoff  from=person:pv-9c4a  to=person:pv-4e17  lease=lease-7742

# DO NOT — extend the acquire, which leaves the log naming only the first holder

lease-acquire  holder=person:pv-9c4a  ttl=+90m
```

**Why:** An extended acquire and an unbroken hold produce byte-identical logs, so the one
question a reader brings to a contested lease — who held it when — has no answer in the
record that was supposed to hold it.

**BLOCKED rationalizations:**

- "The successor is the same operator, so the handoff is a formality"
- "The TTL extension is one field and the handoff record is four"
- "Whoever reads the log will know from the surrounding records who took over"
- "We can reconstruct the handoff from the commit timestamps if we ever need it"
- "The lease has never been contested here, so nothing depends on this"
- "The release-then-reacquire form drops the lease for a moment and a sibling could take it"

## MUST NOT

- Close a handoff by releasing and re-acquiring under the successor while a sibling holds
  an ADJACENT claim on the same tree

**Why:** The gap between the release and the re-acquire is a window in which the adjacent
holder's claim can widen to SAME, and the handoff then lands on a scope that moved.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/codify` confirms every
  lease that changed hands landed a `lease-handoff` record naming both holders);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a TTL
  extension stands in for a handoff is judgment over the session's history.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a lease extended rather than handed
  over; a handoff record naming one holder) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since whether a
  TTL extension replaced a handoff is resolvable only at the review layer.
- **Receipt requirement:** SessionStart soft-gate `[ack: lease-handoff-attestation]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the log for any
  lease whose holder changed and confirms a `lease-handoff` record sits between the two.
  Phase 2 (deferred) — a detector pairing consecutive records on one lease id against the
  holder field, both structural; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/lease-handoff-attestation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  lease id, the outgoing holder and the incoming one.
- **Origin:** See § Origin.

## Origin

2026-08-30 — a contested lease was adjudicated from a log in which the acquire had been
extended twice; neither extension named the operator actually holding it.
