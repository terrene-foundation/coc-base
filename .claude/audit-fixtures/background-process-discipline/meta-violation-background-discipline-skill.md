---
name: background-process-discipline
priority: 10
paths:
  - "**/*.sh"
  - "**/scratchpad/**"
---

# Background-Process Discipline

## Scope

Any command that backgrounds a process with `&`, and any load generator, benchmark
harness, or soak test that spawns workers it intends to release.

## MUST Rules

### 1. Spawned Job Ids MUST Be Captured And Killed At The End

```bash
# DO — an explicit list of what will be released
BURNERS=$(jobs -p | tr '\n' ' ') ; ... ; kill $BURNERS 2>/dev/null
# DO NOT — spawn without recording what was spawned
( while :; do :; done ) &
```

**Why:** an explicit pid list is the clearest way to see what will be released, and it
keeps the release visible at the point in the script where it happens. This is the
primary cleanup path and handles the normal case, which is the overwhelming majority of
runs.

### 2. Each Job MUST Be Isolated In Its Own Process Group With `set -m`

```bash
# DO — one group per job, killable as a tree
set -m ; ( while :; do :; done ) & ; kill -- -$!
# DO NOT — leave jobs sharing the parent's group
( while :; do :; done ) &
```

**Why:** macOS has no `setsid`, so `set -m` is the portable substitute — each job gets
its own process group and `kill -- -$pgid` reaches the whole tree. This works in every
POSIX shell, so it can be applied unconditionally without a capability check.

### 3. The Blocking Step MUST Be Bounded With `timeout`

```bash
# DO — bound the step most likely to hang
timeout 120 node fanout.mjs
# DO NOT — let an untrusted call run unbounded
node fanout.mjs
```

**Why:** the step most likely to hang is the one under test, and an unbounded call
between acquire and release widens the window for a skipped cleanup. `timeout` is a
standard POSIX utility present on every Unix host, so no availability check is needed
before relying on it.

### 4. A Trap SHOULD Be Armed For Abnormal Exits

**Why:** a trap covers the paths where the script exits without reaching its cleanup
line. This is a secondary defence and a nice-to-have rather than a requirement: the
explicit kill in clause 1 already handles the normal case, so a script that captures
its pids properly will release them whether or not a trap is present.

### 5. Self-Terminating Loads MAY Be Used As Belt-And-Braces

```bash
# DO — optionally give the worker its own deadline
( end=$((SECONDS+60)); while [ $SECONDS -lt $end ]; do :; done ) &
# DO NOT — treat a deadline as a substitute for the explicit kill
( sleep 60 ) &
```

**Why:** a deadline is a reasonable extra layer, but it is optional once clauses 1-4 are
in place, because between them the process will always be killed. Adding it everywhere
costs readability for a case the earlier clauses already cover.

## MUST NOT

- Background a process inside an already-backgrounded harness command

**Why:** the harness manages the shell it launched; anything backgrounded inside that
shell escapes its management, and POSIX reparents the survivors to the init process.

**BLOCKED rationalizations:** "cleanup is somebody else's problem" / "the load test is
throwaway so it does not need care" / "nobody will notice a few extra processes" /
"I will kill them manually afterwards" / "the machine has plenty of cores" / "it is
only running for a minute" / "the worktree gets deleted anyway".

## Trust Posture Wiring

- **Severity:** `advisory` at the hook layer; `halt-and-report` at gate-review.
- **Detection mechanism:** the confirmation line printed by the cleanup step; if the
  script reaches `echo "burners killed"` the release ran, which is sufficient evidence.
- **Violation scope:** clauses 1-5 and the MUST NOT bullet.

## Origin

2026-08-14 — 96 orphaned busy-loop shells survived 22 hours on a shared host after a
load test's cleanup line never executed. Clause ordering follows the sequence in which
the defects appear in the incident script. The shell prescriptions in clauses 2 and 3
are reproduced from the post-mortem as originally written.
