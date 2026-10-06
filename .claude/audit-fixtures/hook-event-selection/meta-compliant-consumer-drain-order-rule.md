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

# Consumer Shutdown Drain Order — The Intake Closes Before The Ack Channel

A shutdown has two valves that look interchangeable and are not. Close the ack channel first
and every message still inside a handler becomes un-ackable, so the broker redelivers work
that already ran; close the intake first and the in-flight set can only shrink.

## MUST Rules

### 1. The Intake Is Closed Before The Acknowledgement Channel

A shutdown MUST first close the intake — cancel the subscription and set prefetch to zero —
and MUST NOT close, cancel or time out the acknowledgement channel until the in-flight set is
empty. Tearing down the ack path while handlers are still running is BLOCKED.

```text
# DO — intake closed first, ack path held open until the in-flight set reaches zero
step 1: basic_cancel(tag); prefetch = 0        # no new delivery can enter
step 2: await inflight.empty(); close the ack channel, then the connection
# DO NOT — close the connection on the signal and leave the broker to infer what happened
on SIGTERM: connection.close()                 # 14 handlers mid-flight, every ack now fails
```

**BLOCKED rationalizations:** "the broker will redeliver it, that is what redelivery is for" /
"SIGTERM means stop now, not stop politely" / "handlers are fast, nothing will be in flight" /
"I looked a moment ago and the queue was empty" / "closing early is safer than overrunning
the orchestrator's grace period".

**Why:** An undeliverable ack is indistinguishable at the broker from a consumer that died
mid-message, so it redelivers the whole in-flight set to whichever replica is still up.

### 2. An In-Flight Message Whose Side Effect Committed Is Acked, Never Redelivered

Once a handler has committed an externally visible side effect — a row written, a payment
captured, a mail handed to the relay — its message MUST be acked, including past the drain
deadline. Nacking it, or letting its lease lapse, is BLOCKED.

```text
# DO — the commit point is recorded and the ack follows it, deadline or not
capture(charge_id) -> committed = True;  on shutdown: ack(msg)   # overrun accepted
# DO NOT — nack whatever is still open when the drain timer fires
if drain_deadline_passed: nack(msg, requeue=True)   # captured charge redelivered, charged twice
```

**BLOCKED rationalizations:** "the handler is idempotent, a second run is free" / "the dedupe
key downstream will catch it" / "nacking is the safe default when I am not sure" / "one
redelivery is cheaper than a stuck shutdown" / "we cannot hold the drain past the deadline".

**Why:** Redelivery restarts the handler at its first line, so any side effect committed
before the shutdown is performed a second time by the replica that picks the message up.

## MUST NOT

- Report a drain complete while any handler is still resident

**Why:** A drain reported complete releases the process to exit, and the handler is killed in
the window between its side effect and its ack — precisely the state redelivery duplicates.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the intake
  is cancelled before the ack channel and that the committed-side-effect path acks); `advisory`
  at the hook layer per `hook-output-discipline.md` MUST-2.
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
  Rollout) — an advisory detector flagging a patch whose shutdown handler contains a channel
  or connection `close()` call with no `basic_cancel` or prefetch-zero assignment dominating
  it in the same function body, and a `nack(..., requeue=True)` reachable from a branch that
  post-dominates a committed-write call. Both are AST facts over one patch, so the deferral
  names a structural signal and books enforcement that can arrive; fixtures land WITH it at
  `.claude/audit-fixtures/consumer-drain-order/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row
  names the queue, the in-flight count at signal time, and which valve closed first.
- **Origin:** See § Origin.

## Origin

2026-08-19 — the `payments-capture` consumer took SIGTERM and closed its connection in the
signal handler. Thirty-one captures were mid-flight; every ack failed, the broker redelivered
all thirty-one to the surviving replica, and thirty-one cards were charged twice over the six
minutes before the dedupe guard tripped. The incident is why this rule fixes an ORDER
and a commit point rather than asking the author to judge whether a handler is idempotent —
idempotency was exactly what everyone believed.
