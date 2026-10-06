Operator ran `/wrapup` at the close of session 44. The fragment it wrote to
`.session-notes.d/operator.md` is reproduced below in full. For context, the
repository carries 148 local branches and 7 live worktrees.

---

last_reconciled_sha: 7b2ef410

---

# Session Notes — 2026-08-22

## Next-session directives

None — nothing carries forward.

## Where we are

Mid-migration on the connector layer. Last concrete change: the retry envelope
landed on the ingest path. Phase is implementation; validation has not started.

## Read first

1. `workspaces/connector-migration/02-plans/03-rollout.md` — the sequencing
2. `src/ingest/retry.rs` — the envelope that just landed
3. `CLAUDE.md` — repo directives

## In-play branches and worktrees

- **At risk** — `fix/retry-envelope-backoff` — LOCAL-ONLY — PR none.
  The only unrecoverable row: nothing upstream holds these commits and there is
  no remote copy.
  re-check: `git cherry origin/main fix/retry-envelope-backoff` → any `+` line
  ⇒ NOT upstream
- **At risk** — `feat/ingest-path-collapse` — pushed — PR #4131 open.
  re-check: `git cherry origin/main feat/ingest-path-collapse` → any `+` line
  ⇒ NOT upstream
- **Worktrees** — 7 trees; verdicts 2 KEEP / 4 ZERO-LOSS / 1 TAG-FIRST.
  Removal deletes a DIRECTORY, never a branch (`rules/worktree-isolation.md`
  Rule 8), so a KEEP is a decision, not a default.
  re-check: `node .claude/bin/worktree-reap.mjs`

## In-flight state

The retry envelope is committed but the integration harness has not been pointed
at it yet. The staging config still names the old endpoint.

## Executed this session

None — no external actions this session.

## Wave tracker

None — no waves in flight.

## Outstanding ledger (forest)

| ID  | Item                     | Value-anchor                            | Status    |
| --- | ------------------------ | --------------------------------------- | --------- |
| F1  | Connector migration      | brief § 2 "one ingest path, not three"  | in-flight |
| F2  | Staging endpoint cutover | journal 0311 DECISION                   | queued    |

Closed this session: none.

## Traps

- The integration harness caches its endpoint list at import time.
- The TAG-FIRST worktree sits on a detached HEAD; tag it before removing it.
