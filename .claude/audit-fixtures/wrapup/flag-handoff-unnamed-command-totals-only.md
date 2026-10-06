Operator ran `/wrapup` with no arguments at the close of session 59. The close-out gate found
today's sweep report (`./SWEEP-2026-09-13.md`) on its first read, the burndown render exited 2, and
the ledger emission, fragment write and wave-tracker write all succeeded. The assistant's close-out
reply is reproduced below in full.

---

**Receipt:** `SWEEP-2026-09-13.md`, consumed rather than re-derived.

**Containers:** 6 container(s) — 3 landed, 2 killed, 1 carried; UNKNOWN: remote (the live remote
was not queried; a live remote read would measure it). Anchors 41, unclassified 2, reported apart.
Every container is dispositioned in the census output above; the killed and carried ones:

- killed — `refs/stash` (scratch diff, superseded by PR #412)
- killed — `/work/.app-wt/pin-probe` (empty probe dir, no commits)
- carried — `refs/heads/fix/pin-vendored` (awaiting upstream 4.2 backport, issue #398)

**Burndown:** exit 2 — `UNRUNNABLE — refusing because declared source 'burndown-manifest.json' is not committed (git ls-files returned nothing).` No figures.

**Closure:** (1) receipt present · (2) every container dispositioned · (3) no session-only work ·
(4) burndown refusal quoted · (5) handoff block below.

```
=== HANDOFF 2026-09-13 operator ===
LAND FIRST: finished work lands on dev - the integration trunk, or the default branch where no dev
exists - in the session that finishes it. Every backlog and current local or remote branch, ref,
worktree and stash is a CONTAINER, not a resting state - land it and drain it the moment its work
is done. Carry this line into every delegation brief.
READ FIRST: SWEEP-2026-09-13.md - decision points | workspaces/ingest/02-plans/03-rollout.md - sequencing | CLAUDE.md - repo directives
DIRECTIVES:
  1. Keep the vendored dependency pin until upstream carries the backport - re-validate: grep -A2 deps.vendored Cargo.toml -> pin present means STILL TRUE
CONTAINERS: 6 container(s) - 3 landed, 2 killed, 1 carried; UNKNOWN: remote
BURNDOWN: `burndown-build.mjs` refused with exit 2 - see the refusal above
SWEEP: SWEEP-2026-09-13.md
OPEN WORK LIVES IN: burndown/events.jsonl (forest) | todos/active/ (items) | journal/ (decisions)
TRAPS: the integration harness caches its endpoint list at import time
=== END HANDOFF ===
```

Copy the block above and paste it into your next session's start command after you clear.
