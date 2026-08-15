# Background-Process Discipline — a leaked process must be impossible, not merely unintended

**The contract is documentation. The FENCE is `.claude/hooks/orphan-forest-guard.js`.**
Read that sentence first, because this corpus already carried
`instrument-discipline.md` MUST-1 when the incident below happened, and the leaked
script still shipped `echo "burners killed"` — an unconditional success claim with no
nameable falsifying result. Prose did not prevent it and would not prevent the next
one. What follows is the shape to write; the reaper is what catches you when you
don't.

## The incident (measured, 2026-08-14)

A CPU-saturation load test left **96 orphaned `/bin/zsh` processes** on a shared
host — two cohorts of 48, one per worktree — busy-looping at 7–15% CPU each,
PPID 1, for **22 hours**. Host load peaked at **577 on 16 cores**. Zero task-output
files on the host contained the string the cleanup line would have printed: it never
executed in any invocation. They were found and killed by hand a day and a half later.

```bash
# THE SCRIPT THAT LEAKED — the intent is fine, the construction is not
for i in $(seq 1 48); do (while :; do :; done) & done   # unbounded, no self-limit
BURNERS=$(jobs -p | tr '\n' ' ')                        # subshell job table — may be EMPTY
sleep 2; uptime
node .../fanout.mjs 2>&1 | tail -20                     # unbounded blocking step, no trap
kill $BURNERS 2>/dev/null                               # the one error that mattered, discarded
echo "burners killed"                                   # prints whether or not anything died
```

**The burners destroyed no work and blocked nothing.** What they did was silently
corrupt every timing-sensitive measurement taken on that host for 22 hours —
including a `spawnSync ETIMEDOUT` that was nearly recorded as a structural property
of a validator with nothing wrong with it. A leaked load generator is an **invisible
confounder**: no owner, no log, no failing check, and it degrades every subsequent
measurement without appearing in any of them.

## The five layers, in the order that actually saves you

Ranked by what removes the dependency on something else working — **not** the order
the defects appear in the script.

### 1. Self-terminating load — the decisive one (MUST)

A background process MUST carry its own deadline. This is worth more than the trap
and more than every other layer, because it makes the incident self-heal regardless
of whether cleanup, the trap, the shell, or the session survives.

```bash
# DO — the burner dies on its own, with no killer involved at all
( end=$((SECONDS+60)); while [ $SECONDS -lt $end ]; do :; done ) &
# DO NOT — lifetime depends entirely on someone else's kill
( while :; do :; done ) &
```

**Why:** `while :; do :; done` exits only by external kill, so the moment cleanup
fails the failure is PERMANENT. Everything else on this list reduces the probability
that cleanup fails; only this one makes cleanup's failure survivable.

### 2. Unconditional cleanup via `trap`, armed BEFORE the first spawn (MUST)

```bash
# DO — armed before anything is spawned; fires on abnormal exit too
trap 'command pkill -P $$ 2>/dev/null' EXIT INT TERM
# DO NOT — cleanup as the last STATEMENT, reached only on the happy path
... ; kill $BURNERS 2>/dev/null
```

**Why:** resource release placed on the happy path is not release, it is a wish. Any
abnormal exit — parent dies, session closes, harness sends SIGTERM, the step under
test hangs — strands every child at once. **Measured on macOS/zsh: the trap DOES fire
on SIGTERM**, so this layer is real and not theoretical.

`pkill -P $$` needs no bookkeeping, which sidesteps the `BURNERS=$(jobs -p)` defect
entirely — command substitution runs in a SUBSHELL whose job table is not reliably
the parent's, so that capture can come back empty and degrade `kill $BURNERS` to a
bare `kill` usage error. Use `command pkill` (not bare `pkill`): the harness installs
a `pkill` shell FUNCTION, and while its guard is inert where `/proc` is absent, going
through `command` makes the behaviour the same everywhere.

### 3. Bound every blocking step between acquire and release (MUST)

The step most likely to hang is the one being tested, and putting it between the
spawn and the release with no bound makes the most probable failure the one that
skips cleanup.

```bash
# DO — pure shell, no external dependency, works on a stock host
( cmd & p=$!; ( sleep 120; kill "$p" 2>/dev/null ) & w=$!; wait "$p"; kill "$w" 2>/dev/null )
# DO NOT — assume `timeout` exists
timeout 120 sh -c '...'
```

**Why:** `timeout` is **GNU coreutils, NOT in the macOS base system**. Measured on the
incident host it resolved to `/opt/homebrew/bin/timeout` — present only because
coreutils was installed. A contract prescribing it would silently not exist on a stock
host, and "the check ran" and "the binary was missing" are indistinguishable in a
transcript. If you do use it, test for it first (`command -v timeout`).

### 4. Process groups — and the correction that matters most here

**`set -m` DOES NOT WORK IN zsh, which is the harness's shell.** This corrects the
post-mortem's original recommendation. Measured at four poles on the incident host:

| pole | result |
| --- | --- |
| inline in the harness shell | `(eval):set:1: can't change option: -m` |
| `zsh -c 'set -m'` | `zsh:set:1: can't change option: -m` |
| `zsh -c 'set -o monitor'` / `setopt monitor` | `can't change option: monitor` |
| `bash -c 'set -m'` | **OK** |

A non-interactive zsh cannot enable monitor mode at all, so each backgrounded job
stays in the PARENT's process group (measured: parent pgid == child pgid) and there is
no per-job group to kill. macOS also ships **no `setsid`**, so the Linux idiom is
unavailable too.

**Consequence: do not reach for process groups on this platform. Use `pkill -P $$`,
which needs neither.** `set -m` + `kill -- -$pgid` is correct only under bash, and
prescribing it unconditionally would emit an error into a script whose stderr is
usually discarded — a silent no-op in the exact place a silent no-op already cost 22
hours.

### 5. Avoid `&` inside a harness background command (SHOULD)

Make the backgrounded harness command itself the long-running thing, rather than
backgrounding again inside it.

**Why:** the harness manages the shell it launched; anything backgrounded *inside*
that shell escapes its management completely. Killing a shell does not signal its
descendants, and POSIX reparents the survivors to launchd. Nothing in the OS links
them afterwards — which is why these 96 had no association with anything by the time
they were found.

## Verify cleanup with an instrument that can print FAILURE

```bash
# DO — a line that can report the bad outcome
command pkill -P $$ 2>/dev/null
alive=$(pgrep -P $$ | wc -l | tr -d ' ')
[ "$alive" -eq 0 ] || { echo "CLEANUP FAILED: $alive survived"; exit 1; }
# DO NOT — an unconditional claim
kill $BURNERS 2>/dev/null; echo "burners killed"
```

**Why:** `echo "burners killed"` prints whether or not anything died. No output it
could produce would indicate failure, so it is a non-discriminating instrument
(`instrument-discipline.md` MUST-1) sitting at the end of a cleanup path — and a
session reading that transcript concludes cleanup succeeded. Discarding the kill's
stderr (`2>/dev/null` on the kill itself) throws away the one error that mattered.

## What the reaper does, so you know what you are relying on

`.claude/hooks/orphan-forest-guard.js` REPORTS at SessionStart (plus a host-load line,
because a boundary reaper structurally cannot see a leak that is live NOW) and REAPS
at SessionEnd via `.claude/bin/orphan-reap.mjs --apply`.

It reaps **only the provably-inert**. A ZERO-LOSS verdict requires ALL of: past the
idle floor (default 2h), no child processes, an active CPU burn (default ≥5%), and no
held file/socket descriptors. A deliberately-detached dev server is PPID 1 too, and is
held out by at least one of those — usually all four. Everything else is a named KEEP
carrying its reasons. Kill switch: `COC_ORPHAN_AUTOREAP=0`, default ON.

**A `PreToolUse(Bash)` regex on `&`-without-`trap` is deliberately NOT the fence.**
`&` is ubiquitous so the false-positive surface is large, a noisy advisory gets
ignored, and per `hook-output-discipline.md` MUST-2 a lexical signal MUST NOT carry
`block` — so it could not stop anything even when correct. It would be a control
ADJACENT to the one needed.

## Related

- `.claude/hooks/lib/orphan-forest.js` — the classifier and its verdict gates
- `rules/instrument-discipline.md` MUST-1 — the non-discriminating-instrument test
- `skills/30-claude-code-patterns/worktree-orchestration.md` — the sibling leak class
- (loom-internal reference)

Origin: 2026-08-14, E10. The five layers are the post-mortem's, reordered by the
engineer who diagnosed the incident to put self-termination first. Layers 3 and 4
carry CORRECTIONS measured in the implementing session rather than inherited: `timeout`
is absent from a stock macOS, and `set -m` fails in zsh at every pole tested (bash was
the positive control that proves the test itself works).
