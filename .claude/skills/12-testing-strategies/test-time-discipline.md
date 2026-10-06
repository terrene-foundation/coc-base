# Test-Time Discipline — Do Not Assert On Real Elapsed Time

A test that asserts something about real elapsed time turns red when the host is busy while the code
under test is behaving correctly. A red that carries no information is worse than no test: it costs
a diagnosis every time and trains everyone to re-run rather than read it, which is how a genuine
regression gets waved through.

Governing clause: `rules/testing.md` § "MUST: Never Assert An UPPER Bound On Real Elapsed Time".
This file is that clause's runbook.

## The rule

**Do not assert an UPPER bound on real elapsed time.** An upper bound is a claim about how fast the
host is. Reach for, in order:

| Shape of the thing under test                                        | Instrument                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Timer-driven async (a sleep, a deadline, a graceful-shutdown budget) | The runtime's **paused / virtual clock** test mode                         |
| A throttle / window / TTL whose interval you control                 | Configure the window so the premise cannot be raced, or **inject a clock** |
| "An event eventually happens"                                        | **POLL to a ceiling** — never sleep a fixed budget and then assert         |
| Worker occupancy / scheduler starvation                              | Real time is unavoidable; see § When the property really is real-time      |

### Direction is what decides fragility

A **lower** bound on elapsed time (`elapsed >= X`) is load-ROBUST: host load can only make it more
true. Only upper bounds are the defect class.

But **read the whole test before calling it load-robust.** A test can carry one conspicuous
lower-bound assertion and two unremarked upper bounds elsewhere — a fixed per-attempt connect
budget, a join/`timeout` ceiling — and go red under load anyway. One load-robust assertion does not
make a test load-robust. Enumerate EVERY time-dependent bound in the test, not the one you were
looking at.

**A generous margin is NOT a defence.** A measured instance gave a ~5000× margin against an
effectively-instant shutdown and still went red; a memory probe asserting usage below 99% on a
machine reading 55.56% also went red. A margin makes the false red rarer, and therefore harder to
attribute — it does not make the test sound.

## Technique 1 — the paused / virtual clock (timer-driven async)

Most async runtimes expose a test mode where the clock advances only when every task is parked on a
timer, and then by exactly the amount slept. That turns "did the waits run in parallel?" into an
exact question about how many times the clock advanced, instead of a wall-clock race against a
threshold.

```text
# DO — virtual clock; the bound can be TIGHT because only a real timer moves it
test(paused_clock) shutdown_is_prompt:
    start = <runtime>.now()            # the RUNTIME's clock type
    run_shutdown()
    assert start.elapsed() < 1s

# DO NOT — wall clock; the threshold is a claim about the host
test shutdown_is_prompt:
    start = <system>.now()
    run_shutdown()
    assert start.elapsed() < 5s
```

**Measure with the RUNTIME's clock type, never the system clock** — the system clock ignores the
pause and silently re-inherits the defect.

**Keep the pause facility in DEV/TEST dependencies only.** A frozen clock constructible in a release
binary is an attack surface, not a convenience (`rules/security.md` § Secure-Default For A New
Security Feature).

### A paused clock does NOT replace a real-clock bound — it only replaces the TIMER half

The virtual clock sees timers. It is structurally blind to a SYNCHRONOUS stall: a blocking sleep,
blocking IO, a blocking DNS or filesystem call, a blocking-context escape hatch. Those advance real
time and not virtual time, so converting a wall-clock assertion to a purely virtual one **silently
deletes that detection**.

This was measured, not theorised. One conversion replaced a system-clock `< 5s` bound with a
runtime-clock `< 1s` bound and nothing else. An 8s blocking sleep injected into the graceful-shutdown
path then passed **30/30**, where the pre-conversion form would have caught it — a concrete
original-red / new-green regression, shipped in a PR whose body claimed no assertion had been
weakened.

Keep both bounds, and label each with the defect it catches:

```text
# VIRTUAL — a TIMER on the path. Tight, deterministic, load-immune.
assert virtual_elapsed < 1s     # "... a TIMER on the stop path ..."
# REAL — a SYNCHRONOUS stall the virtual clock cannot see. Deliberately wide,
# sized FROM MEASUREMENT (observed max 4.07ms at load ~400 → 2s is ~490×).
assert wall_elapsed < 2s        # "... a SYNCHRONOUS stall ... ~490× margin ..."
```

**Ask, for every conversion: what could break this property WITHOUT touching a timer?** If the
answer is not "nothing", the virtual bound alone is a downgrade.

### The paused clock is not free with real IO

The virtual clock auto-advances when the runtime has no work. If the only pending timer is a
client's request timeout and the runtime is parked on a socket, a paused clock can jump to that
deadline and abort a real request. Verify empirically — run the converted test 5+ times and check
the elapsed reading — before trusting it in a test that does real network IO.

## Technique 2 — an injected clock (throttles, windows, TTLs)

The pattern is a `Clock` interface, a system-backed implementation as the production default, and a
fixed/controllable implementation for tests.

**MUST preserve: the fixed clock is compile-time or feature-gated out of production builds** — a
time seam that ships is an attack surface. Anything generalizing this pattern inherits that
requirement.

### Prefer removing the race to adding a seam

Before adding a production time seam, ask whether the test's PREMISE can simply be made unraceable.
One case asserted "12 tokens presented inside a 200ms throttle window ⇒ at most one refresh" and
then raced 12 real HTTP round-trips against those 200ms. Configuring the window to ten minutes makes
"the burst is inside one window" a fact of the test's own timeline, needs no production change, and
adds no seam to a security-critical path.

```text
# DO — widen the WINDOW so the premise holds; the assertion is untouched
throttle = 600s
assert refreshes <= 1

# DO NOT — widen the ASSERTION; this silently reduces what the test pins
throttle = 200ms
assert refreshes <= 4        # tolerance bump
```

**Widening a window restores a premise. Widening a threshold destroys a property.** They look
similar in a diff and are opposites.

## Technique 3 — poll to a ceiling (never sleep-then-assert)

```text
# DO — load makes this WAIT longer instead of failing at a fixed budget
loop:
    if reaped(): return started.elapsed()
    assert started.elapsed() < CEILING,
        "... This is a PROBE-RESOLUTION failure, not a <X> finding"
    sleep(POLL_INTERVAL)

# DO NOT — asserts the event beat a wall-clock deadline
sleep(600ms)
assert reaped(), "should have been reaped"
```

Polling is also FASTER on a quiet machine, since it returns the moment the event fires.

**The ceiling is still a real-clock upper bound — do not over-claim.** "Load can no longer make this
fail" is false; it can only make it much less likely. A 30s ceiling guarding a ~100ms event was
observed firing on a CLEAN tree at host load ~350–440, which is why those probes were widened to
120s. Size a ceiling FROM a measurement, state the margin next to it, and treat a ceiling that has
ever fired on a clean tree as evidence it is too tight.

A **ceiling used purely as a hang guard** is legitimate even though it is nominally an upper bound,
provided it is (a) orders of magnitude above the expected value and (b) worded so it is unmistakable
for the finding the test exists to make — the `PROBE-RESOLUTION` wording above is the house style.
Verify the guard actually fires: make the event impossible and check the message.

## When the property really is real-time

Some properties cannot be moved off the wall clock, and pretending otherwise trades a flaky signal
for NO signal — which is strictly worse.

**Worker occupancy is the worked example.** "This call must not occupy the runtime worker
synchronously" is a claim about REAL time: a blocking sleep on that path advances real time and not
virtual time, so under a paused clock the injected regression is INVISIBLE and the test passes while
pinning nothing.

A differential (measure vs control window) is the standard remedy — but verify it end-to-end before
believing it. Measured at host load ~390, 30 interleaved runs per arm, with NO regression present:

| control-window arrangement                          | false-failure rate |
| --------------------------------------------------- | ------------------ |
| sequential (control runs after the measured window) | 23%                |
| simultaneous (control on a sibling single-worker)   | **47%**            |

Making the windows simultaneous — which removes the stated "both windows saw the same host load"
assumption — made it WORSE, because on a single worker the measured work's legitimate CPU
consumption starves a co-scheduled probe regardless of whether it ever blocks. A
max-contiguous-gap arm was also measured and rejected: healthy gaps reached 182ms at that load,
indistinguishable from a 150ms injected block.

**The lesson is the process, not the numbers: A/B the old and new instruments INTERLEAVED under the
same load, and count failures.** A redesign that "obviously" removes a confound can double the
failure rate.

## Verifying a converted test — MANDATORY

A test that passes under a paused clock **because it now asserts nothing** is a regression dressed
as a fix, and it is the most likely way to get this wrong (`instrument-discipline.md` MUST-2).

1. Mutate the code under test so the property genuinely breaks. Assert the test goes **RED**.
2. Revert. Assert it goes **GREEN**.
3. State per test what it pinned BEFORE and what it pins AFTER. If the conversion weakens the
   assertion, say so.
4. Check the mutation **arity** — a patch that matches nothing reads exactly like a survivor. Count
   the emit/call sites and confirm the mutation reached all of them. One near-miss: a test survived
   a mutation pass only because the event had TWO emit sites and one was mutated.
5. To claim a flake is retired, **reproduce it first** (run under CPU oversubscription). A fix
   justified by reasoning alone MUST be labelled as such.

## Finding the rest of the class

**No regex finds this class reliably. Validate any sweep command against a KNOWN member before
trusting its output** — an empty result from a blind pattern is indistinguishable from a clean repo
(`instrument-discipline.md` MUST-3).

Build a calibration corpus of known members first, and **take their PRE-conversion text from git**
(`git show <base>:<path>`) — measuring a pattern against the already-fixed file is a self-derived
oracle (`evidence-first-claims.md` MUST-5) and will tell you a blind pattern works.

The measured lesson from one such calibration, against four known members:

- The OBVIOUS pattern — an `assert … elapsed() … <` shape — found **none** of the four. It missed
  the first because the assertion was on a VARIABLE (`elapsed`), not a call; and the rest because a
  sleep-then-assert contains no `elapsed` token at all.
- It was not caught sooner because it had been validated against the CONVERTED file, which by then
  contained a freshly-added elapsed-assert.
- **The window is the whole game, and every fixed window can be beaten.** The widest-net pattern —
  a sleep followed by an assert within N characters — caught 1 of 4 at N=200, 3 of 4 at N=400 and
  4 of 4 at N=800, because one member's assertion sat 715 characters after its sleep with a shutdown
  block and a counting loop in between. Treat the calibrated N as CURRENT calibration, not a law:
  when the next member is found, re-measure rather than assuming the sweep still covers the class.
- Every pattern MUST be run in MULTILINE mode, because formatters wrap `assert(` onto its own line —
  a line-based `assert.*elapsed` returns nothing on any member, which is how one instance survived
  an earlier sweep.

**Triage rule for the wide net** (most of its hits are fine): a sleep-then-assert is only a defect
when the assertion claims the event has ALREADY happened by the deadline. If the sleep merely lets a
value settle and the assert then checks that value, it is not this class.

**Before deleting a sleep, check whether it is load-bearing.** In one member, the awaits below the
sleep looked like they already blocked on completion; they did not — they blocked on worker EXIT,
which only happens after a shutdown signal. Setting the sleep to zero dropped the completion count
from 5 to 0. The fix is to poll the real progress signal, not to remove the wait.

Classify every hit as **upper bound** (fix), **lower bound** (fine), or **hang-guard ceiling** (fine
if wide and worded distinguishably).

**The narrow net cannot tell a virtual-clock bound from a wall-clock one.** When triaging, check
first for the paused-clock test attribute and the runtime clock type — those are CONVERTED tests,
not members.

**Because the sweep is this weak, the convention matters more than the sweep.** That is why the
clause also lives in `rules/testing.md`, which is path-scoped to `tests/**` and `**/*test*` so it
loads while a test is being WRITTEN rather than only when someone goes looking for it.

## A fourth shape: a TIMEOUT that satisfies the assertion

Tests that spawn a real interpreter, container, or subprocess inherit the PRODUCTION default timeout
as a HIDDEN upper bound. Several such tests asserted only `result.is_error()` — and a timeout is
also an error, so under load they PASSED while exercising nothing. Measured with the budget forced
to expire, two import-SANDBOX tests passed without the sandbox ever running.

This is worse than the flaky red this page is about, because it is silent. When a test's "failure"
assertion is satisfiable by the probe failing to RESOLVE, assert the SHAPE of the failure, not
merely its presence:

```text
# DO — a timeout is a PROBE-RESOLUTION failure, not evidence the import was blocked
err = assert_refused(result, "importing os")   # rejects a Timeout error kind
# DO NOT — satisfied by any error at all, including one that never ran the sandbox
assert result.is_error(), "importing os should fail"
```

Also note the COMPILATION / COLLECTION SCOPE: tests behind an optional feature, marker, or extra are
not compiled or collected by a default test invocation, so a green from that invocation says nothing
about them (`rules/evidence-first-claims.md` MUST-6).

## The sibling class: a FIXED shared path is the same defect without a clock

The same flake class appears with resource contention rather than time. One test wrote to a FIXED,
machine-global temp path — created the directory, wrote a fixture, then removed it. Two concurrent
runs of that binary (two worktrees, or a workspace run overlapping another) collide, and one deletes
the other's fixture mid-test. Measured, 40 concurrent pairs per arm, interleaved: **6/40 RED before,
0/40 after.**

A sweep for shared temp paths found most sites already uniquified by pid or uuid, and **seven** that
were not. All seven now carry a per-process suffix.

```text
# DO — the shared resource is removed, not merely guarded
dir = temp_dir() / f"my-test-{process_id()}"
# DO NOT — a fixed literal is shared with every other process on the machine
dir = temp_dir() / "my-test"
```

**Note what this costs to find.** A single suite run is green. It took repeated shared-process runs,
and the failure appeared in a DIFFERENT test on each run.

## Beware contaminating your own instrument

In the same sweep, one suite went red that was NOT a repo defect: it spawns a NESTED build, and a
second build running concurrently (the sweep's own) contended on the build lock. In isolation it
passed. Two reds in one sweep, one real and one self-inflicted: **diagnose each in a clear field
before reporting either.** Kill every other build process first, then re-run the failing target
alone.

## Reporting rather than converting

Two dispositions are legitimate and MUST be recorded rather than silently skipped:

- A second copy of a known race in a crate whose remedy needs a PRODUCTION API addition in a
  different module — that is its own shard, not a rider.
- A Tier-2 test needing live infrastructure you cannot run: converting it without being able to run
  it would be a change justified by reasoning alone, which § "Verifying a converted test" forbids.

Both are `rules/product-completion-first.md` findings that need a category and a disposition, not an
omission.
