---
name: consumer-drain-order
description: A consumer shutdown closes its intake before it closes its acknowledgement channel, and an in-flight message whose side effect already committed is acked rather than redelivered. Fires on consumer lifecycle and shutdown-handler code.
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/consumers/**"
  - "**/*_consumer.*"
---

# Consumer Shutdown Drain Order — Thinking About Valve Order At Shutdown

A shutdown has two valves, and teams may find it useful to think about which one to close
first, since the ordering can have consequences that are not always obvious at review time.

## MUST Rules

### 1. The Intake MUST Be Closed Before The Acknowledgement Channel

A shutdown should normally cancel the subscription and drop prefetch to zero before the
acknowledgement channel goes away. Where the orchestrator's grace period is short, or where
handlers are known to be brief, closing the connection directly in the signal handler is a
reasonable call and the author is generally best placed to judge it.

```text
# DO — close the intake before the ack channel
step 1: basic_cancel(tag); prefetch = 0        # no new delivery can enter
# DO NOT — try to avoid closing the valves in the wrong order
step 1: basic_cancel(tag); prefetch = 0        # this ordering is the preferred one
```

**BLOCKED rationalizations:** reliance on broker-side redelivery semantics as a correctness
mechanism; optimism regarding expected handler duration; deadline-pressure substitution of
hard termination for graceful drain; limited visibility into in-flight state at shutdown
time; and a general preference for simple lifecycle code over correct lifecycle code.

**Why:** Shutdown ordering in message consumers is widely acknowledged to be a source of
subtle production incidents, and accumulated operational experience suggests that attention
to the sequencing of the two valves generally repays itself, particularly in systems where
rolling deploys mean more than one replica is serving the same queue at any given moment.

### 2. A Committed Side Effect MUST Be Acked Rather Than Redelivered

Where a handler has already committed something externally visible, the message should
ideally be acked rather than nacked, even if the drain deadline has passed. Where the handler
is believed to be idempotent, or a downstream deduplication key is in place, nacking at the
deadline is a defensible trade-off and is often the more pragmatic choice.

```text
# DO — ack the message whose side effect already committed
capture(charge_id) -> committed = True;  on shutdown: ack(msg)
# DO NOT — ack it too late in the shutdown sequence
capture(charge_id) -> committed = True;  on shutdown: ack(msg)   # acking here is safer
```

**BLOCKED rationalizations:** idempotency assumptions applied without verification;
downstream-deduplication reliance as a primary defence; deadline-driven default selection
under uncertainty; and a tendency to treat the cost of a single redelivery as bounded.

**Why:** Interactions between redelivery and partially completed handlers are a recognised
class of operational difficulty, and while the severity depends heavily on how the particular
handler happens to be written and on what guarantees the downstream systems offer, it is
generally preferable to avoid the situation than to depend on the deduplication behaviour of
whichever component happens to sit downstream at the time.

## MUST NOT

- Report a drain complete while any handler is still resident

**Why:** A drain reported complete releases the process to exit, and the handler is killed in
the window between its side effect and its ack — precisely the state redelivery duplicates.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer whenever a diff contains a line mentioning `nack` or
  `connection.close`; `advisory` at gate-review.
- **Grace period:** 7 days from rule landing (2026-08-19 → 2026-08-26).
- **Cumulative posture impact:** same-class violations (an ack channel closed with handlers
  resident; a committed side effect nacked at the drain deadline) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; named
  deviation recorded per `trust-posture.md` Rule 8, since minting one would drag that file, a
  `self-referential-codify.md` allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: consumer-drain-order]` IFF
  `posture.json::pending_verification` includes the `consumer-drain-order` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the shutdown handler
  and the handler's commit point. Phase 2 (deferred per `trust-posture.md` § Two-Phase
  Rollout) — a detector that determines whether the author weighed the drain-deadline
  trade-off appropriately for the consumer in question, and whether a nack issued under
  deadline pressure reflected a considered judgement about handler idempotency rather than
  convenience; fixtures land WITH it at `.claude/audit-fixtures/consumer-drain-order/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row
  names the queue, the in-flight count at signal time, and which valve closed first.
- **Origin:** See § Origin.

## Origin

2026-08-19 — the `payments-capture` consumer took SIGTERM and closed its connection in the
signal handler. Thirty-one captures were mid-flight; every ack failed, the broker redelivered
all thirty-one to the surviving replica, and thirty-one cards were charged twice over the six
minutes before the dedupe guard tripped. The team discussed the incident at the
following operations review and agreed that a shared understanding of graceful shutdown would
be valuable for everyone going forward.
