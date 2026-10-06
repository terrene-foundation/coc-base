---
name: background-process-discipline
priority: 10
paths:
  - "**/*.sh"
  - "**/scratchpad/**"
---

# Background-Process Discipline

## Scope

Any command that backgrounds a process with `&` it intends to release — a dev server, a
file watcher, a readiness poll, a mock service stood up for one test run.

## MUST Rules

### 1. A Background Process MUST Carry Its Own Deadline

```bash
# DO — the poll expires with no killer involved
( end=$((SECONDS+60)); until curl -sf localhost:3000 >/dev/null || [ $SECONDS -ge $end ]; do sleep 1; done ) &
# DO NOT — lifetime depends entirely on someone else's kill
( while :; do curl -sf localhost:3000 >/dev/null; sleep 1; done ) &
```

**Why:** a loop with no exit condition of its own exits only by external kill, so the
moment cleanup fails the failure is PERMANENT. Every other clause here reduces the
probability that cleanup fails; only this one makes that failure survivable, which is
why it is first.

### 2. Cleanup MUST Be A Trap Armed BEFORE The First Spawn

```bash
# DO — fires on the abnormal paths too
trap 'command pkill -P $$ 2>/dev/null' EXIT INT TERM
# DO NOT — cleanup as the last statement, reached only on the happy path
... ; kill $PIDS 2>/dev/null
```

**Why:** release placed on the happy path is not release, it is a wish. `pkill -P $$`
needs no bookkeeping, avoiding the `PIDS=$(jobs -p)` defect: command substitution
runs in a subshell whose job table is not reliably the parent's, so the capture can come
back empty and degrade the kill to a bare usage error.

### 3. A Prescribed Binary MUST Be Probed Before It Is Relied On

```bash
# DO — establish the dependency exists on THIS host
command -v timeout >/dev/null || use_pure_shell_bound
# DO NOT — assume a GNU utility is present
timeout 120 node fanout.mjs
```

**Why:** `timeout` is GNU coreutils and is NOT in the macOS base system; on the incident
host it resolved only because coreutils happened to be installed. A bound that does not
exist and a bound that applied are indistinguishable in a transcript.

### 4. Process-Group Isolation MUST NOT Be Prescribed Where It Does Not Work

**Why:** `set -m` fails in zsh — the harness's own shell — at every pole tested
(`set -o monitor` and `setopt monitor` fail identically); it succeeds only under bash,
which served as the positive control proving the test itself works. macOS also ships no
`setsid`. Use `pkill -P $$`, which needs neither. Prescribing `set -m` would emit an
error into a script whose stderr is usually discarded.

### 5. Cleanup Verification MUST Be Able To Print Failure

```bash
# DO — an instrument capable of the opposite verdict
alive=$(pgrep -P $$ | wc -l | tr -d ' ')
[ "$alive" -eq 0 ] || { echo "CLEANUP FAILED: $alive survived"; exit 1; }
# DO NOT — an unconditional claim
kill $PIDS 2>/dev/null; echo "server stopped"
```

**Why:** `echo "server stopped"` prints whether or not anything died, so no output it
could produce would indicate failure — a non-discriminating instrument at the end of a
cleanup path, which a later session reads as proof that cleanup succeeded.

## MUST NOT

- Background a process inside an already-backgrounded harness command

**Why:** the harness manages the shell it launched; anything backgrounded inside that
shell escapes its management, and POSIX reparents the survivors to the init process.

**BLOCKED rationalizations:** "the kill is right there at the end" / "it worked when I
ran it by hand" / "the confirmation line printed, so cleanup ran" / "`set -m` is POSIX"
/ "`timeout` is on every Unix box" / "a self-limit is belt-and-braces once there's a
trap" / "the port looked free afterwards".

## Trust Posture Wiring

- **Severity:** `advisory` at the hook layer; `halt-and-report` at gate-review.
- **Detection mechanism:** structural — `.claude/hooks/orphan-forest-guard.js` reports
  at SessionStart and reaps the provably-inert at SessionEnd.
- **Violation scope:** clauses 1-5 and the MUST NOT bullet.

## Origin

2026-08-14 — 96 orphaned busy-loop shells survived 22 hours on a shared host after a
CPU load test's cleanup line never executed. That test's purpose is itself not permitted
on a shared machine; these clauses govern the legitimate background process. Clause
ordering puts self-termination first because it is the only layer that does not depend
on something else working. Clauses 3 and 4 record platform facts measured in the
authoring session rather than inherited.
