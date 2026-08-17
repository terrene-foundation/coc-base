Operator ran `/wrapup` at the close of session 41. The fragment it wrote to
`.session-notes.d/operator.md` is reproduced below in full.

---

last_reconciled_sha: a41c9d02

---

# Session Notes — 2026-08-19

## Next-session directives

Carrying forward the things that still matter from this session.

1. We were most of the way through the connector migration and it looked like the
   staging rollout was close, so that is probably where to pick up.
2. There are 122 content defects outstanding across the corpus.
3. Be careful with the merge order on the two open PRs — one of them depends on
   the other and merging them the wrong way round caused a mess last time.
4. The auth refactor is worth looking at again at some point.
5. Coordination with the platform lane is ongoing.
6. Someone should probably re-check whether the vendored dependency pin is still
   needed now that upstream shipped 4.2.
7. The staging credentials rotate at the end of the month.

## Where we are

Mid-migration on the connector layer. Last concrete change: the retry envelope
landed on the ingest path. Phase is implementation; validation has not started.

## Read first

1. `workspaces/connector-migration/02-plans/03-rollout.md` — the sequencing
2. `src/ingest/retry.rs` — the envelope that just landed
3. `CLAUDE.md` — repo directives

## In-flight state

The retry envelope is committed but the integration harness has not been pointed
at it yet. The staging config still names the old endpoint.

## Executed this session

None — no external actions this session.

## Wave tracker

None — no waves in flight.

## Outstanding ledger (forest)

| ID  | Item                    | Value-anchor                                    | Status   |
| --- | ----------------------- | ----------------------------------------------- | -------- |
| F1  | Connector migration     | brief § 2 "one ingest path, not three"          | in-flight |
| F2  | Staging endpoint cutover | journal 0311 DECISION                          | queued   |

Closed this session: none.

## Traps

- The integration harness caches its endpoint list at import time.
