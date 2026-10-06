---
priority: 10
scope: path-scoped
paths:
  - "tests/**"
  - "**/*test*"
  - "**/*spec*"
  - "conftest.py"
  - "**/.spec-coverage*"
  - "**/.test-results*"
  - "**/02-plans/**"
  - "**/04-validate/**"
  - "crates/**"
---

# Testing Rules

See `.claude/guides/rule-extracts/testing.md` for full evidence, the kailash-ml W33b post-mortem, the test-skip triage decision tree, the test-resource-cleanup post-mortems (PR #466 63-warning sweep, 11,917-test block, env-var race), and protocol blocks.

<!-- slot:neutral-body -->

## Test-Once Protocol (Implementation Mode)

During `/implement`, tests run ONCE per code change, not once per phase — and the run is **SCOPED TO THE DIFF by default**, the selection DERIVED from `git diff --name-only`, never picked by judgment about which tests look relevant. Pre-commit Tier 1 is the safety net; CI's full matrix is the final gate. The unscoped full suite is an EARNED exception, taken only at the five junctures `git.md` § "Pre-FIRST-Push CI Parity Discipline — SCOPED By Default" enumerates. Re-run only on commit-hash mismatch, infra change, or a specific test suspected wrong.

**Why:** Re-running the FULL suite every phase spends [UNMEASURED — see `guides/rule-extracts/git.md` § "The local pre-flight cost figure is UNMEASURED"] per cycle re-answering questions the diff never raised. **Scoping the gate is EXPECTED — it narrows the gate's INPUT; skipping it removes the OUTPUT and stays BLOCKED.** This rule is path-scoped to test-shaped globs, so a source-only edit never loads it: the always-on home of the mandate is `git.md`'s baseline clause.

### MUST: Parallelize FIRST, Scope SECOND — The Multiplier Is Free

The gate has two cost levers and they are NOT equal. **Parallelism is a mechanical ~5x that costs one flag; diff-scoping is second-order and costs correctness reasoning about what the diff touches.** Every pytest gate invocation — scoped or full — MUST carry a PINNED worker count (`--dist loadfile -n 8`, the measured optimum on a 16-CPU host); running a gate serially and then reaching for scoping to recover the time is BLOCKED. Measured on one repo's real gate: `tests/unit` 324.10s serial -> 65.23s at `-n 8` = **4.97x**, with collection clean at both (41,763 enumerated, exit 0). `pytest-xdist` was already installed and CI was already using the parallel shape.

```bash
# DO — take the free multiplier, THEN narrow the input
pytest $(<dirs derived from git diff --name-only>) --dist loadfile -n 8
# DO NOT — `-n auto` measured SLOWER (39/45s vs 33/40s at `-n 8`); do NOT scope a still-serial gate
pytest tests/ -n auto
```

**`-n 8` and the durations are NOT laws** — they are one 16-CPU host's measurement. The transferable practice is _pin a worker count and measure it_; quoting another repo's seconds is `instrument-discipline.md` MUST-4. **Coverage is not the dominant term:** under `-n 8`, `--cov` measured **1.48x — 31s of a 96s run**, so dropping it buys ~half a minute, not half the gate. Rust differs and is a genuine trade, NOT a mandate — `cargo nextest` process-isolates and is therefore structurally BLIND to the cross-test interaction class shared-process `cargo test` exposes, and it never runs doctests; see the runbook. Depth, both Rust measurements, and the UNMEASURED boundary: `skills/12-testing-strategies/gate-runner-economics.md`.

**Why:** An agent that scopes a serial gate has spent the expensive lever to buy back what the cheap one gives away free, and has narrowed the gate's INPUT to avoid a cost a flag would have removed outright.

## Probe-Driven Verification (MUST)

Semantic verification of assistant output (recommendations, refusals, compliance, response quality) MUST be probe-driven per `rules/probe-driven-verification.md`. Regex/keyword/substring matching against semantic claims is BLOCKED. Structural assertions (file existence, exit code, fixture-marker presence) keep regex per `probe-driven-verification.md` Rule 3.

See `skills/12-testing-strategies/probe-driven-verification.md` for the operational runbook.

## Audit Mode (/redteam)

In audit mode, MUST (1) re-derive coverage from scratch via `pytest --collect-only -q tests/` (NOT `cat .test-results` — BLOCKED); (2) for every NEW module, grep test directory for import — empty = HIGH; (3) for every spec § Security Threats subsection, grep `test_<threat>` — missing = HIGH.

**Why:** Prior `.test-results` may claim "5950 tests pass" true for OLD code while new modules ship with zero coverage. Documented threats without tests are unmitigated claims. See `skills/spec-compliance/SKILL.md` for full protocol.

## Regression Testing

Every bug fix MUST include a regression test BEFORE merge. Place in `tests/regression/test_issue_*.py` with `@pytest.mark.regression`. NEVER deleted.

**Why:** Without it, same bug re-appears in future refactor, undetected until a user reports.

### MUST: Behavioral Regression Tests Over Source-Grep

Call the function; assert raise/return. Grepping source for literal substrings is BLOCKED as sole assertion.

```python
# DO — behavioral
@pytest.mark.regression
def test_null_byte_rejected():
    with pytest.raises(ValueError, match="null byte"):
        decode_userinfo_or_raise(urlparse("mysql://u:%00x@h/d"))

# DO NOT — source-grep pins implementation
assert "\\x00" in open("src/…/connection.py").read()  # breaks on refactor
```

**Why:** Source-grep breaks when logic moves to a shared helper (the right refactor). Behavioral tests survive refactors and module moves.

### MUST: Verified Numerical Claims In Session Notes

Numerical claims (test counts, file counts, coverage) in session notes MUST be produced by a verifying command at the moment of writing. Hand-typed is BLOCKED.

```bash
# DO     pytest tests/regression/ --collect-only -q 2>&1 | grep -c '::'
# DO NOT hand-recalled round numbers
```

**Why:** "Claim a number, never verify" produces multi-test discrepancies; 2-second command converts memory bug into script.

### MUST: Deferred-Implementation Conformance Vectors Use xfail-Strict, Not Skip

When a conformance vector (canonical fixture, cross-impl spec test, integration receipt) pins a contract the implementation does NOT yet enforce, the test MUST carry a STRICT-xfail marker (`@pytest.mark.xfail(strict=True, reason=...)`) — NOT skip, NOT delete, NOT comment-out. Strict-xfail surfaces an XPASS failure the moment the implementation catches up, forcing the author to remove the marker same-shard.

```python
# DO — strict-xfail; auto-fails (XPASS) when the impl catches up
@pytest.mark.xfail(strict=True, reason="single-shot consumption not yet enforced")
def test_phase_monotonicity(): ...
# DO NOT — skip silently stays skipped after closure; deletion loses the contract pin
@pytest.mark.skip(reason="impl not ready")
```

**Why:** Skip stays green-and-silent after the impl lands, so the deferred contract is never re-verified; deletion loses the pin entirely. Strict-xfail converts honest deferral from a silent ratchet into a self-clearing tripwire. The cross-runtime mapping (Rust `#[ignore]` + a CI job asserting ignored tests STILL fail) is in the companion § xfail-strict.

### MUST: `__all__` / Re-export Symbol Counts Use Structural Enumeration, Not Grep

Counts of `__all__` entries (Python) or re-exports (Rust `pub use ...`) used in spec authority, docstrings, audit findings, or CHANGELOG claims MUST be produced by structural enumeration of the language's parser AST — NOT `grep -c` / `wc -l`. Canonical Python + Rust enumeration snippets: companion § `__all__` Structural-Enumeration.

```python
# DO — Python: walk ast.Assign for __all__, len(value.elts)
# DO NOT — grep '^\s*"' (counts comments + blank lines + line continuations as entries)
```

**BLOCKED:** see companion § `__all__` Structural-Enumeration.

**Why:** Grep cannot distinguish `# Group N — comment` from `"Group_N",` when both contain quotes; structural parsing parses the language, not text. See companion § `__all__` Structural-Enumeration for Wave 6 evidence (three incompatible counts: docstring 41, grep 48, AST 49).

## Test Resource Cleanup

Warnings during `pytest` are real bugs that will surface as production incidents. See guide § "PR #466 — 63-Warning Sweep" for full evidence per category below.

### MUST: Fixtures Yield + Cleanup, Never Return

```python
# DO    yield channel; channel.close()
# DO NOT return without cleanup → resource leaks until GC
```

**BLOCKED:** see companion § Test Resource Cleanup — BLOCKED Corpora.

**Why:** Resource classes emitting `ResourceWarning` from `__del__` flood the runner hiding real signals. See guide for PR #466 (36 unclosed channels).

### MUST: AsyncMock Replaced By Mock When `side_effect` Is `async def`

```python
# DO    patch(..., new_callable=Mock); m.side_effect = fake_open  # async def
# DO NOT default AsyncMock double-wraps the coroutine; never awaited; RuntimeWarning at GC
```

**Why:** Default `AsyncMock` wraps the side_effect coroutine again; the wrapper is never awaited; `RuntimeWarning` surfaces at GC, hours later.

### MUST: Helper Classes Use Stub/Helper/Fake Suffix; JWT Test Secrets ≥ 32 Bytes

`class NameStub:` (NOT `class TestName:` with `__init__` — pytest collects `Test*`, triggers `PytestCollectionWarning`, class silently dropped). `JWT_TEST_SECRET = "test-secret-key-minimum-32-bytes!"` (NOT short — `InsecureKeyLengthWarning` per RFC 7518 §3.2).

**Why:** Pytest's `Test*` collection silently drops `__init__`-bearing helper classes, hiding real test logic. Short HMAC keys teach contributors that 10 bytes is acceptable when 32 is the floor.

### MUST: Pytest Plugin + Marker Declaration Pair

Any test using `@pytest.mark.<X>` or `<X>` fixture from a plugin MUST declare the plugin in the owning sub-package's `[dev]` extras AND register the marker in pytest config SAME commit.

```toml
# DO    dev = ["pytest-benchmark>=4.0.0"]
#       [tool.pytest.ini_options]
#       markers = ["benchmark: Performance tests"]
# DO NOT either layer missing → collection fails, whole sub-package blocked
```

**BLOCKED:** see companion § Test Resource Cleanup — BLOCKED Corpora.

**Why:** Missing any layer breaks collection with an unhelpful error. See guide for 2026-04-20 11,917-test block.

## MUST: Serialize Env-Var-Mutating Tests Via Module Lock

Any two tests mutating SAME env var MUST serialize through a module-scope `threading.Lock` held across read-then-mutate; tests take `(monkeypatch, _env_serialized)`. See guide for full fixture pattern.

**BLOCKED:** see companion § Env-Var Lock Discipline.

**Why:** `monkeypatch.setenv` restores at fixture teardown — AFTER the test body — so sibling tests observe either value depending on xdist scheduling. Classic "passes locally, fails CI".

### MUST: One Lock Domain Per Env Surface Per Test Binary

Serialization only works when every env-mutating test sharing one env surface holds the SAME lock. When a suite adopts one lock domain for an env surface, EVERY env-mutating test touching that surface MUST join that SAME domain; introducing a second mechanism is BLOCKED. Non-interlocking-mechanism mechanics + the Rust cross-runtime sibling: companion § "One Lock Domain — Non-Interlocking Mechanics".

```python
# DO — every env-mutating test on this surface joins ONE module-scope lock
with _LLM_ENV_LOCK: monkeypatch.setenv("OPENAI_API_KEY", "k")
# DO NOT — a second, non-interlocking mechanism (@pytest.mark.xdist_group) in a sibling module races it
```

**BLOCKED:** see companion § Env-Var Lock Discipline.

**Why:** Lock domains don't compose — mutual exclusion holds only among holders of the SAME lock. The failure is probabilistic and module-boundary-shaped, so it looks like a flaky single test rather than a structural race. Evidence: Rust SDK PR #1283 (a `file_serial` test racing a module-local mutex on the same env surface); full post-mortem in companion § Env-Var Lock Discipline.

### MUST: Complexity Bounds Use Self-Normalizing Ratios, Not Absolute Wall-Clock Thresholds

A stress test asserting algorithmic behavior MUST measure an in-process baseline at 1/N scale in the same run and assert the N-scale cost as a RATIO of that baseline (linear ≈ N×, quadratic ≈ N²× — pick the bound between them) — NOT an absolute wall-clock threshold. Bumping an absolute threshold in response to a stress-test "flake" is BLOCKED until the ratio has been checked: a threshold bump on a super-linear ratio is burying a complexity-class regression, not fixing a flake.

```python
# DO — self-normalizing ratio (machine- and load-independent), same run
ratio = timeit(lambda: validate(graph(10_000))) / timeit(lambda: validate(graph(1_000)))
assert ratio < 40, f"scaled {ratio:.0f}x for 10x nodes (linear ~10x, quadratic ~100x)"
# DO NOT — absolute bound; ratchets upward under load until it masks O(n^2)
assert big < 60.0    # was 30s, bumped once already
```

**BLOCKED:** see companion § Complexity-Bound Ratios.

**Why:** Absolute bounds ratchet — each load-driven bump widens the window an algorithmic regression hides in, and the bump itself is the institutional tell. The ratio assert is a pure function of the algorithm, not the machine. Evidence: Rust SDK journal 0177 (an O(n²) loop surfaced after a 30s→60s "flake" bump); full post-mortem in companion § Complexity-Bound Ratios.

### MUST: Never Assert An UPPER Bound On Real Elapsed Time

A test MUST NOT assert that real elapsed time stayed BELOW a threshold — that is a claim about how fast the HOST is, so a busy runner reddens it while the code is correct. Use the runtime's **paused/virtual clock** for timer-driven async, an **injected clock** (production-gated) for throttles and windows, and **POLL-to-a-ceiling** for "an event eventually happens" — never sleep a fixed budget and then assert the event already occurred. A **lower** bound (`elapsed >= X`) is load-robust and fine. Widening a test's WINDOW to restore a premise is sound; **widening the ASSERTION is a tolerance bump and BLOCKED.**

```text
# DO — virtual clock (only an awaited timer advances it), or poll to a ceiling
#      assert elapsed_on_virtual_clock < ONE_SEC
#      poll_until(cond, ceiling=30s)            # asserts "eventually", not "within"
# DO NOT — wall clock upper bound; the threshold measures the runner, not the code
#      assert wall_clock_elapsed < FIVE_SEC
```

**BLOCKED rationalizations:** "the margin is generous" (a 5000× margin still went red) / "that one's flaky, re-run it" / "just bump the threshold" / "widening the assert is the same as widening the window".

**Why:** A red that carries no information costs a diagnosis every time and trains readers to dismiss the test, which is how a genuine regression gets waved through. **A paused clock is NOT a universal fix**: it cannot see a SYNCHRONOUS stall (a blocking sleep, blocking IO, a blocking-context escape hatch) or any real-time property such as worker occupancy, so converting one of those trades a flaky signal for NO signal — pair the virtual bound with a wide real-clock hang-stop, or keep real time and make the measurement DIFFERENTIAL. Every converted test MUST be demonstrated able to FAIL (`instrument-discipline.md` MUST-2). Per-runtime primitives, the calibrated sweep commands, and the measured negative results: `.claude/skills/12-testing-strategies/test-time-discipline.md`.

## 3-Tier Testing

- **Tier 1 (Unit)**: Mocking allowed, <1s per test
- **Tier 2 (Integration)**: Real infrastructure recommended (mocking discouraged — prefer real services where practical)
- **Tier 3 (E2E)**: Real everything recommended (real services preferred); every write verified with read-back where practical

**Why:** Mocks in Tier 2/3 hide real failures (connection handling, schema mismatches, transactions) that only surface against real infra. Exception — Protocol-Satisfying Deterministic Adapters: a class satisfying a `typing.Protocol` at runtime with deterministic output is NOT a mock. See guide § "Protocol Adapters" for full example.

## Tier-1 Conftest Stub for Newly-Side-Effecting Internal Methods (Advisory)

When an internal method that was previously deterministic becomes side-effecting (e.g., an LLM call, a DB lookup, a network fetch) WITHOUT changing its return-shape contract, the canonical Tier-1 sweep is one autouse fixture in the _deepest applicable_ conftest. Fixture template, the conftest-scope non-leak guarantee, and the when-to-use / when-NOT-to-use criteria: companion § "Tier-1 Conftest Stub — Fixture Template And Applicability Criteria".

**Why:** A monkey-patch fixture keeps Tier-1 deterministic and offline without touching N test files. Future test additions pick up the stub automatically. The pattern collapsed a 36-call-site sweep to 1 file in the kailash-kaizen 2.20.0 release cycle (2026-05-06, issue #829).

## Coverage Requirements

| Code Type                            | Minimum |
| ------------------------------------ | ------- |
| General                              | 80%     |
| Financial / Auth / Security-critical | 100%    |

## MUST: End-to-End Pipeline Regression Above Unit + Integration

Every canonical pipeline the docs teach (README Quick Start, tutorial, 3-line example) MUST have a Tier-2+ regression test executing DOCS-EXACT code against real infra, asserting the final user-visible outcome. Lives in `tests/regression/` with `@pytest.mark.regression`; name includes "quickstart"/"readme"/tutorial-name (grep-able). Worked docs-exact example: companion § "E2E Pipeline Regression — Docs-Exact Worked Example".

**BLOCKED:** see companion § E2E Pipeline Regression — BLOCKED Corpus.

**Why:** Unit tests per primitive construct fixtures with exactly the fields THAT primitive needs — they cannot observe a field MISSING from the A→B handoff. Only DOCS-EXACT chain exercises the handoff contract. See guide for kailash-ml W33b evidence + `zero-tolerance.md` §2 "Fake integration via missing field".

## State Persistence Verification (Tiers 2-3)

Every write MUST be verified with a read-back: call create/update, then call get/list, assert the value.

```python
# DO    result = api.create_company(name="Acme"); assert api.get_company(result.id).name == "Acme"
# DO NOT assert result.status == 200  # DataFlow may silently ignore params
```

**Why:** DataFlow `UpdateNode` silently ignores unknown parameter names — API returns success but zero bytes written.

## MUST: One Direct Test Per Variant In Every Delegating Pair

When a module exposes paired variants delegating to a shared core (`get`/`get_raw`, `post`/`post_raw`, `insert`/`insert_batch`, `read`/`read_typed`), each variant MUST have a direct-call test — not reaching the other by delegation.

```python
# DO — direct per-variant tests
def test_get_typed_success(client): user = client.get("/u/42"); assert user["name"] == "Alice"
def test_get_raw_success(client):   resp = client.get_raw("/u/42"); assert resp["status"] == 200
# DO NOT — only typed variant; refactor of get_raw error-mapping ships silent regression
```

**BLOCKED rationalizations:** "typed calls raw internally, one test covers both" / "shared core" / "integration catches this" / "raw is just less-useful typed".

**Why:** Convergent delegation paths look like one path until they diverge under refactor pressure. `/redteam` MUST mechanically grep each variant pair; any pair with zero direct call site is a finding.

## MUST: FFI Handle Wrappers Ship A Concurrent-Close Stress Test

Every FFI handle wrapper that exposes `Close`/`free` (or a GC finalizer/Cleaner backstop) ALONGSIDE methods that pass the raw handle into native code MUST ship a stress test that races method calls against `Close()` under concurrency (including the finalizer path where the runtime has one). Deref-safety mechanics (why a flag-gated close is not enough): companion § "FFI Handle Concurrent-Close". Cross-binding depth + per-runtime fix shapes (Go/Java/.NET/Ruby/Python/Node) live in the FFI-handle-lifecycle project skill shipped with the rs all-bindings template.

```text
# DO — stress test races method calls vs Close (+ force GC for the finalizer racer)
spawn N concurrent method-call goroutines/threads; concurrently call Close(); force GC
# DO NOT — flag-gated close validated only by sequential unit tests
if closed: return ErrClosed   # check
native_call(ptr)              # Close can free into this window → UAF
```

**Why:** The check-then-use UAF only crashes under a concurrent closer (often the GC finalizer), so unit tests pass forever while production segfaults under GC pressure. Evidence: Rust SDK journals 0174 + 0178 (a Go `Subscription` UAF crashing 8/8 under stress, recurring on `AlignEngine` one wave later); full post-mortem in companion § FFI Handle Concurrent-Close.

## Rules

- Test-first development for new features
- Deterministic: no random data without seeds, no time-dependent assertions
- Isolated: clean setup/teardown, isolated DBs, tests MUST NOT affect each other
- Naming: `test_[feature]_[scenario]_[expected_result].py`

**Why:** Intermittent failures erode trust; shared state → order-dependent results that pass individually but fail in CI where order differs.

Origin: warnings sweep + test-skip triage + paired-variant coverage + env-var race + E2E regression + 2026-04-27 AST-counts review; **§ Never Assert An UPPER Bound On Real Elapsed Time** — BUILD stream, landed at loom via Gate-1 ingest 2026-08-19, classified GLOBAL.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **test-surface scope** — twelve independent always-on testing surfaces, each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates. `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and Rule 10's proximity-band gate does not fire; depth: `.claude/skills/12-testing-strategies/`.

Depth — the full session evidence, the per-instance elapsed-time evidence + GLOBAL-classification reasoning, the 2026-08-19 extraction record with its Rule-10/Rule-11 non-firing disposition, and the full twelve-surface enumeration — lives in `.claude/guides/rule-extracts/testing.md` § "Never Assert An UPPER Bound On Real Elapsed Time — Origin And Per-Instance Evidence", § "Extraction record — 2026-08-19" and § "Length Rationale — Full Surface Enumeration".

<!-- /slot:neutral-body -->

<!-- slot:lang-testing-extensions -->
<!-- /slot:lang-testing-extensions -->
