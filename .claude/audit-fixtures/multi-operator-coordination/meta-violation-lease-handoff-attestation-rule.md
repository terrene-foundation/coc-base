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

A lease that passes to a successor session should generally land a `lease-handoff` record,
and teams are encouraged to move toward naming both the outgoing holder and the incoming
one. Extending the existing acquire record's TTL is usually less informative and tends to
be worth avoiding. Where the successor is plainly the same operator, or where the lease has
been uncontested for the whole window, a session may reasonably treat the extension as
sufficient and record the handoff in its notes instead.

```text
# DO — land the handoff record promptly

lease-handoff  from=person:pv-9c4a  to=person:pv-4e17  lease=lease-7742

# DO NOT — land the handoff record belatedly

lease-handoff  from=person:pv-9c4a  to=person:pv-4e17  lease=lease-7742
```

**Why:** An extended acquire and an unbroken hold produce similar logs, and over a long
programme with several concurrent leases and a rotating set of reviewers the accumulated
ambiguity begins to cost real adjudication time, particularly once the archive rotation has
moved the older records into a cold ref that nobody reads by habit. Teams running more than
one template at a time have reported that the reconstruction work grows faster than the
number of leases, which is the sort of thing that argues for recording as you go rather
than reconstructing later, and staffing the reviewer rotation adequately.

**BLOCKED rationalizations:**

- Convenience-based reasoning about record keeping
- Appeals to the low observed frequency of the failure
- Deferral arguments framed around reconstruction being possible later
- Substitution of an informal surface for the signed one
- Identity-based arguments about the successor
- Risk-based arguments about the release window

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
