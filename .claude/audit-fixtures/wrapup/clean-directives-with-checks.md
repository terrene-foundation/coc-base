Operator ran `/wrapup` at the close of session 41. The fragment it wrote to
`.session-notes.d/operator.md` is reproduced below in full.

---

last_reconciled_sha: a41c9d02

---

# Session Notes — 2026-08-19

## Next-session directives

Imperative standing orders — each carries the command that says whether it is
still true. Written from memory; run the checks, do not trust the text.

1. **Merge #4120 before #4118** — #4118 rebases onto #4120's schema change and
   merging them the other way round strands the migration.
   re-validate: `gh pr view 4120 --json state -q .state` → `MERGED` ⇒ done
2. **Point the integration harness at the new retry envelope before any
   validation run** — the harness still names the old ingest path.
   re-validate: `grep -c 'ingest/legacy' tests/harness/endpoints.toml` → `0` ⇒ done
3. **Do NOT drop the vendored dependency pin.** Upstream 4.2 does not carry the
   backport; the pin is load-bearing until it does.
   re-validate: `grep -A2 '\[deps.vendored\]' Cargo.toml` → pin absent ⇒ regression

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
- The auth refactor is worth revisiting, but nothing about it is time-bound and
  no command tells you whether it is still worth doing — so it sits here.
- Staging credentials rotate at month end; the rotation is external and there is
  no in-repo command that reports its state.
