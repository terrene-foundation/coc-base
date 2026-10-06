# Gate Runner Economics — Take The Parallelism First

A test gate has two independent cost levers, and they are not equal. **Parallelism is a ~5× multiplier
that costs one flag. Diff-scoping is a second-order refinement that costs correctness reasoning about
what the diff touches.** An agent that reaches for scoping while still running the suite serially has
skipped the free win and paid for the expensive one.

Governing clauses: `rules/testing.md` § "Test-Once Protocol (Implementation Mode)" and
`guides/rule-extracts/git.md` § "Pre-FIRST-Push CI Parity Discipline". This file is their runbook.

## The ordering

1. **Parallelize.** Free, mechanical, ~5× on a multi-core host. No judgment required.
2. **Then scope to the diff.** Second-order. Requires deriving the selection from `git diff --name-only`
   and reasoning about the five earning junctures.
3. **Drop coverage only if you have already done 1 and 2** — under parallelism it buys far less than
   its reputation suggests (§ Coverage is not the multiplier you think).

Doing 2 before 1 is the common error. It spends the expensive lever to buy back what the cheap lever
gives away for free, and it narrows the gate's input — which is a real, if bounded, loss of signal —
to avoid a cost that a flag would have removed outright.

## The measurement (Python / pytest)

Measured at **a 16-CPU operator workstation**, on the operator's actual gate command
(`pytest tests/unit tests/regression tests/deployment tests/security`). `pytest-xdist 3.8.0` was
already installed; nothing needed to be added.

| invocation                        | wall time            | note                          |
| --------------------------------- | -------------------- | ----------------------------- |
| `-n 8 --dist loadfile --cov`      | **271.37s = 4m31s**  | 41,739 passed. CI already runs this shape. |
| serial, no coverage               | 1115.4s = 18m35s     |                               |
| serial, `--cov`                   | ~38 min              | **EXTRAPOLATED, not timed**   |

The serial-plus-coverage row is what a session running the documented serial shape actually pays,
and it is roughly **8× the shape CI was already using**.

Isolating the multiplier on one directory, so the figure is a ratio and not a repo-specific duration:

> `tests/unit` alone: **324.10s serial → 65.23s at `-n 8` = 4.97×.**

The **ratio** is the transferable claim. The absolute durations belong to a 16-CPU operator workstation and MUST
NOT be quoted as what any other repo's gate costs (`instrument-discipline.md` MUST-4 — a figure
produced for one repo's question answers no other repo's).

Collection was clean throughout: **41,763 tests enumerated, exit 0, 15.77s** — so the parallel run is
covering the same set, not silently collecting less.

### `-n auto` is SLOWER than `-n 8` — do not write `-n auto`

On the same subset and the same 16-CPU host, `-n auto` (which selects 16 workers) measured
**39s / 45s** against `-n 8`'s **33s / 40s**. More workers is not better: past a point the
per-worker collection cost, the process overhead, and the contention on shared fixtures and I/O
outweigh the added concurrency.

```bash
# DO — a pinned worker count, at roughly half the core count on this class of host
pytest tests/unit tests/regression --dist loadfile -n 8
# DO NOT — `auto` measured SLOWER here, and it silently re-tunes when the host changes
pytest tests/unit tests/regression -n auto
```

**`-n 8` is not a law either.** It is the measured optimum on a 16-CPU host. The transferable
practice is *pin a worker count and measure it*, not *copy the 8*.

### `--dist loadfile` is the mode that was measured

`loadfile` keeps every test in a file on one worker. That matters wherever module- or class-scoped
fixtures exist: the default `load` mode scatters a file's tests across workers and re-pays
module-scoped setup on each one, and it breaks any test that assumed file-local ordering. The
measurement above is `loadfile`; a different `--dist` mode is a different instrument and its timing
is not inherited from this table.

Note the interaction with `rules/testing.md` § env-var serialization: `--dist loadfile` does NOT
serialize tests across FILES, so two files mutating the same env var still race. The module-scope
lock that rule mandates is still required.

## Coverage is not the multiplier you think

`--cov` has a reputation as the expensive flag. Measured, its cost is strongly workload-dependent
and it largely **disappears under parallelism**:

- **2.2–2.8×** for CPU-bound pure-Python code.
- **1.4–1.8×** for I/O-bound code.
- **1.48× under `-n 8`** — that is **31s of a 96s run**.

So dropping coverage at a parallel gate buys back **about half a minute**, not half the gate.
Any text implying `--cov` is the dominant term is wrong once `-n 8` is in the command.

```text
# DO — the honest trade
"Dropping --cov saves ~31s of a 96s parallel run (1.48x). Take it only if you do not need the report."
# DO NOT — the folk claim
"Coverage roughly doubles the gate, so drop it for a fast local run."
```

**The real cost signature of coverage is not wall time.** Measured at csq, it was **binary size
(1.47×)** and **~75 MB of profraw I/O**. On a constrained runner or a small disk, THAT is the
constraint worth naming — not the seconds.

## Rust: `cargo nextest` is a SECOND INSTRUMENT, not a drop-in

**This is a genuine trade with measurements on both sides. Do not mandate nextest, and do not
forbid it — present the trade and let the repo choose.**

**The case against making it the gate runner** (kailash-rs, where nextest IS installed and is
DELIBERATELY not the gate runner):

> nextest **process-isolates** each test. It is therefore structurally blind to the cross-test
> interaction class that CI's shared-process `cargo test` exposes.

That is the whole argument, and it is a coverage argument, not a taste one. Shared-process
`cargo test` is the instrument that can observe a test polluting global state for its neighbour;
nextest's isolation makes that class unobservable by construction.

Scope also inflates the apparent speedup: **nextest does not run doctests** — measured **1,760
(`cargo test`) vs 1,738 (nextest)** on one crate. The conclusion drawn there is that roughly **one
third of nextest's apparent 2–3.6× win is SCOPE, not speed**: it is partly faster because it is
running less.

**The case for it** (csq, same tool): measured **up to 16.5×**, and it **removed a real flake** —
precisely because process isolation eliminated the cross-test interaction that was causing it.

Both measurements are real. They point opposite ways because the two repos want opposite things
from the same property: kailash-rs wants the interaction class VISIBLE; csq wanted it GONE.

| you want                                        | runner                                  |
| ----------------------------------------------- | --------------------------------------- |
| cross-test interaction + state pollution visible | shared-process `cargo test`             |
| speed, isolation, flake suppression, CI sharding | `cargo nextest run`                     |
| doctests                                        | `cargo test --doc` (nextest never runs them) |

**If a repo adopts nextest as its gate runner it MUST keep `cargo test --doc` wired separately**, or
it silently stops running doctests — an `orphan-detection` failure at the test-runner level, and one
that a green nextest run reports as success.

**A nextest green and a `cargo test` green are not the same evidence** (`evidence-first-claims.md`
MUST-6 — an instrument's scope is established before its green is generalized). State which runner
produced a green and what that runner's set excludes.

## What is NOT measured here

- Any per-repo gate duration other than that workstation's. **UNMEASURED** — see
  `guides/rule-extracts/git.md` § "The local pre-flight cost figure is UNMEASURED" for the settling
  instrument. Do not substitute those figures for a repo that has not been timed.
- The optimal worker count on any host other than a 16-CPU one. **UNMEASURED.**
- Whether `--dist loadgroup` or `worksteal` beats `loadfile` here. **UNMEASURED** — `loadfile` is
  what was timed.
- Node, Go, and JVM gate runners. **UNMEASURED** — the ordering claim (parallelism before scoping)
  is expected to generalize because it is an argument about which lever is cheap, but no timing was
  taken.

## Verifying the win in a repo that has not been timed

Name the falsifying result first (`instrument-discipline.md` MUST-1): a parallel run that is not
faster, or that collects fewer tests than the serial run, falsifies "parallelism is free here."

```bash
pytest <dirs> --collect-only -q | tail -1     # pin the count FIRST — both runs must match it
/usr/bin/time -p pytest <dirs>                       # serial control
/usr/bin/time -p pytest <dirs> --dist loadfile -n 8  # the candidate
```

If the counts differ, the speedup is SCOPE and not speed — the same error the nextest doctest gap
makes — and the timing comparison is void until they match.
