# Testing Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/testing.md`. Holds post-mortems, extended examples, session evidence, and protocol blocks that would exceed the 200-line rule budget.

## Protocol-Satisfying Deterministic Adapters (Tier 2 Exception)

A class satisfying a `typing.Protocol` at runtime (`isinstance(x, TheProtocol) is True`) and producing deterministic output from its inputs is NOT a mock — it is a real Protocol implementation whose output happens to be deterministic. Tier 2 integration tests MAY use such adapters for Protocol-typed dependencies where real production implementations require API keys, network, or GPU that CI cannot provide.

```python
# DO — real Protocol implementation, isinstance holds, deterministic output
class DeterministicJudge:
    """Real JudgeCallable implementation for Tier 2 tests."""
    judge_model: str = "deterministic-test-judge"

    def __init__(self) -> None:
        self.calls: list[JudgeInput] = []

    async def __call__(self, judge_input: JudgeInput) -> JudgeResult:
        self.calls.append(judge_input)
        raw = min(len(judge_input.candidate_a) / 200.0, 1.0)
        return JudgeResult(
            score=raw, winner=None,
            reasoning=f"Deterministic score={raw:.2f}",
            judge_model=self.judge_model,
            cost_microdollars=150,
            prompt_tokens=10, completion_tokens=15,
        )

@pytest.mark.integration
def test_facade_satisfies_protocol() -> None:
    judge = DeterministicJudge()
    assert isinstance(judge, JudgeCallable)  # Protocol check holds at runtime

# DO NOT — MagicMock with spec=JudgeCallable
judge = MagicMock(spec=JudgeCallable)  # methods auto-generated stubs, still mock-based
```

**BLOCKED rationalizations:**

- "MagicMock with `spec=` passes isinstance — same thing"
- "It's the same as a mock if the output is scripted"
- "`side_effect` on an AsyncMock is functionally equivalent"
- "Protocol adapter is over-engineering; just use `patch`"

**Why:** The Protocol contract is the scripting surface, not a mock framework's `side_effect` or `return_value`. A real class declaring Protocol-required methods with correct signatures + returning real values of the Protocol-required types is a valid Tier 2 test double even when output is deterministic. A real PostgreSQL + `DeterministicJudge` are both Tier 2-legal; a mocked PostgreSQL + real OpenAI call is Tier 2 illegal.

Origin: Session 2026-04-20 (issue #567 PR#5, PR#580). `DeterministicJudge` in the kaizen package (`tests/integration/judges/test_judges_wiring.py`) exercises 7 Tier 2 tests through the `kaizen.judges` facade without API keys; satisfies `kailash.diagnostics.protocols.JudgeCallable` at runtime.

## PR #466 — 63-Warning Sweep (2026-04-14)

PR #466 eliminated 63 unit test warnings across 10 categories. Each category recurred across multiple sessions until a dedicated MUST rule was added.

Specific fixes:

- **Resource cleanup** — `test_cli_channel_comprehensive.py` had 36 unclosed channels emitting `ResourceWarning` from `CLIChannel.__del__`. Fixture used `return` instead of `yield + close`.
- **AsyncMock double-wrap** — `tests/unit/mcp_server/test_discovery.py` patched `asyncio.open_connection` with default `AsyncMock` while providing `async def` side_effect. `AsyncMock._execute_mock_call` wrapped the coroutine again; inner wrapper never awaited; `RuntimeWarning` at GC.
- **Stub naming** — `tests/unit/runtime/mixins/test_conditional_execution_mixin.py` had `TestConditionalRuntime(BaseRuntime, ...)` with `__init__`; pytest's `python_classes = Test*` triggered `PytestCollectionWarning`.
- **JWT test secrets** — `tests/unit/mcp_server/test_auth.py` used `"secret_key"` (10 bytes) triggering `InsecureKeyLengthWarning` from PyJWT.

## Pytest Plugin + Marker Declaration — 11,917-Test Block (2026-04-20)

Session 2026-04-20 /redteam collection-gate sweep: the kaizen package (`tests/e2e/memory/test_persistent_buffer_e2e.py`) used `@pytest.mark.benchmark` + `benchmark` fixture without declaring `pytest-benchmark` in the sub-package's `[dev]` extras. Collection failed with:

```
'benchmark' not found in `markers` configuration option
```

ALL 11,917 kaizen tests blocked from collection until fixed. Fixed commit `1313ae56` by:

1. Adding `pytest-benchmark>=4.0.0` to the kaizen package (`pyproject.toml::[project.optional-dependencies].dev`)
2. Registering `benchmark: Performance benchmark tests (pytest-benchmark)` in `markers` config

See `workspaces/kailash-ml-gpu-stack/journal/0008-GAP-full-specs-redteam-2026-04-20-findings.md`.

## Env-Var Race (2026-04-20)

Origin of the env-var isolation rule. `DATAFLOW_MAX_CONNECTIONS` env-var race between `test_reads_max_connections_from_env` and `test_defaults_to_99_when_env_unset` produced a flaky CI failure (expected=7, actual=99). Root cause: both tests mutated the env var without a serialization lock; xdist worker re-ordered the mutations; sibling test observed the wrong value.

Codified 2026-04-20:

- Python: `monkeypatch` + `threading.Lock()`
- Compiled-language equivalent: an async-guard-aware mutex (see the language variant for `.await`-safe semantics)

## End-to-End Pipeline Regression — kailash-ml W33b (2026-04-23)

`TrainingResult(frozen=True)` without `trainable` field shipped to main in W31 + W33 despite passing every unit test. Every primitive's own unit tests constructed a `TrainingResult` with exactly the fields IT needed:

- `Trainable.fit()` unit tests: constructed `TrainingResult(run_id=..., metrics=..., duration_s=...)` — no `trainable` needed because fit is the producer.
- `MLEngine.register()` unit tests: constructed `TrainingResult(trainable=MagicMock(...))` — mocked `.trainable` because test wasn't exercising the handoff.

The canonical 3-line README Quick Start (`result = km.train(df, target=...); registered = km.register(result, ...)`) raised `ValueError` on every fresh install because `km.register` couldn't resolve `.model` for ONNX export (missing `trainable` attribute).

W33b fix:

1. Added `trainable: Trainable | None = None` field to `TrainingResult` dataclass
2. Every `Trainable.fit()` return site populated with `trainable=self`
3. Landed the ml package (`tests/regression/test_readme_quickstart_executes.py::test_readme_quickstart_executes_end_to_end`) as Tier-2 E2E regression

See `rules/zero-tolerance.md` §2 "Fake integration via missing handoff field" for the stub-pattern framing.

## Delegating Primitives (2026-04-14)

`ServiceClient` module exposed paired typed/raw variants (`get`/`get_raw`, `post`/`post_raw`, etc.) delegating to a shared `execute()` core. Tests only exercised the typed variants; `put_raw` and `delete_raw` had zero direct call sites in the test suite — they were reached transitively through delegation. A refactor that touched `put_raw`'s error mapping would have shipped a silent regression.

Fix (commit `d3a14a73`): added four direct wiremock tests, one per raw variant. Pattern generalises to any module with paired typed/raw, single/batch, or sync/async variants that delegate to a shared core.

Mechanical `/redteam` grep:

```bash
for variant in get_raw post_raw put_raw delete_raw; do
  count=$(grep -rln "client.$variant\(" tests/ | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "MISSING: no test calls client.$variant() directly"
  fi
done
```

## Test-Skip Triage Decision Tree (gh #512 / PR #518, 2026-04-19)

Every test that is skipped, xfailed, or deleted MUST be classified into exactly one of three tiers:

| Tier           | When                                                          | Action                                                                                                             |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **ACCEPTABLE** | Missing dep / infra unavailable / platform constraint         | Keep skip; reason MUST name the constraint (`@pytest.mark.skipif(not REDIS_AVAILABLE, reason="redis required")`)   |
| **BORDERLINE** | Real library limitation; documenting known-failing edge case  | Convert to `@pytest.mark.xfail(strict=False, reason="...")` — preserves test body, flips green when fixed upstream |
| **BLOCKED**    | "TODO", "needs refactoring", "flaky", "times out", empty body | DELETE the test (and any abandoned fixtures it owned); if underlying bug matters, file issue                       |

Applied in gh #512 / PR #518 to convert 1 test to xfail (real PG ON CONFLICT limitation), delete 2 TODO-style tests, and delete 6 abandoned test files (`test_migration_path_tester`, `test_model_registry`, `test_edge_dataflow_unit`, `test_dataflow_bug_011_012_unit`, `test_migration_trigger_system`, `test_dataflow_postgresql_parameter_conversion`).

See `skills/test-skip-discipline/SKILL.md` for full triage protocol.

## Full Origin Line

Origin: 2026-04-14 warnings sweep + 2026-04-19 test-skip triage + 2026-04-14 paired-variant coverage + 2026-04-20 env-var race + 2026-04-20 Protocol adapter exception + 2026-04-23 E2E pipeline regression.

## xfail-Strict For Deferred-Implementation Conformance Vectors — Evidence

When a conformance vector pins a contract the implementation does NOT yet enforce, the test MUST carry `@pytest.mark.xfail(strict=True, reason="...")` — NOT skip, NOT delete, NOT comment-out. Strict-xfail surfaces XPASS on closure: the moment the implementation catches up, the test transitions from xfail to passing AND pytest reports it as a "strict xpass failure", forcing the author to remove the marker. Skip silently stays skipped after closure; deletion loses the contract pin entirely.

Generalisation: the pattern for any "spec ahead of impl" deferral where the test SHOULD fail today but MUST be the first thing that surfaces when impl catches up. Compiled-language analogues: Rust `#[ignore = "..."]` + `cargo test -- --ignored` with a CI job asserting ignored tests STILL fail; Go `t.Skip` + an explicit "want fail, got pass" marker.

**BLOCKED rationalizations:** "Skip is cleaner than xfail" / "We'll un-skip when the impl lands" / "Delete it and re-add later" / "xfail-strict is pytest ceremony" / "The contract is documented in the spec, the test pin is redundant".

Evidence: kailash-py PR #1142 + #1144 — S7 conformance vectors at `tests/fixtures/delegate-conformance/canonical.json`. One vector (single-shot phase monotonicity) initially xfailed-strict because the runtime did not enforce single-shot consumption; the marker reverted to passing automatically when a `self._consumed` guard + try/finally landed — the XPASS forced the author to remove the marker the same shard. Skip would have left the vector silently skipped after the fix.

Relationship: pairs with `skills/test-skip-discipline/SKILL.md` (acceptable skip vs masked failure) — that governs WHEN tests skip; this governs the structural defense for the subclass of "skip" that is actually "xfail-strict deferral". Extends `probe-driven-verification.md` MUST-3 § skip-vs-lexical-fallback.

Trust Posture Wiring: Severity `advisory` at gate-review (reviewer mechanical sweep on conformance-vector test files) / `halt-and-report` at `/codify` when a vector is added with `@pytest.mark.skip` instead of xfail-strict for a deferred-impl claim. Grace 7 days. Detection: `grep -rn '@pytest.mark.skip' tests/**/conformance/` MUST return zero hits where the skip reason cites a deferred implementation; AST walk asserts conformance-vector xfail markers are `strict=True`. Origin: PRs #1142/#1144 (2026-05-22).

## `__all__` Structural-Enumeration

Depth companion for `.claude/rules/testing.md` § "MUST: `__all__` / Re-export Symbol Counts Use Structural Enumeration, Not Grep".

**BLOCKED rationalizations:** "Grep is faster" / "I'll subtract the comment lines manually" / "The count is approximate anyway" / "AST is overkill for a docstring number".

**Wave 6 evidence.** A single `__all__` block was counted three incompatible ways in the same review: the docstring claimed 41, `grep -c` reported 48, and an `ast.parse()` walk reported 49. Grep cannot distinguish `# Group N — comment` from `"Group_N",` when both contain quotes; it cannot follow line continuations across an `__all__ = [...]` block. Structural parsing is canonical because it parses the language, not text.

Canonical enumeration:

- **Python:** `import ast`, walk `ast.Assign` targets for `__all__`, `len(node.value.elts)` on the assigned `ast.List` / `ast.Tuple`.
- **Rust:** `syn::parse_file` and count `pub use` re-exports, OR `cargo doc --document-private-items` and count the emitted symbols.

## Test Resource Cleanup — BLOCKED Corpora

Depth companion for `.claude/rules/testing.md` § "Test Resource Cleanup" — the BLOCKED-rationalization corpora for the fixture-cleanup and plugin/marker clauses.

**Fixtures Yield + Cleanup, Never Return — BLOCKED rationalizations:** "class has `__del__`" / "unit test, process exits anyway" / "mock makes it fake".

**Pytest Plugin + Marker Declaration Pair — BLOCKED rationalizations:** "plugin is in CI so local works" / "pytest accepts unknown markers" / "we'll register in follow-up" / "fixture imported lazily" / "sub-package venv is separate".

## Env-Var Lock Discipline

Depth companion for `.claude/rules/testing.md` § "MUST: Serialize Env-Var-Mutating Tests Via Module Lock" + § "MUST: One Lock Domain Per Env Surface Per Test Binary".

**Serialize Env-Var-Mutating Tests — BLOCKED rationalizations:** "passes locally, CI scheduling is the bug" / "lock is overkill" / "pytest one-per-worker default" / "`@pytest.mark.serial`" (only with `--dist=loadgroup`) / "monkeypatch auto-restores".

**One Lock Domain Per Env Surface — BLOCKED rationalizations:** "each module serializes its own tests, that's enough" / "the lock has worked for months" (intermittent — fails only when the scheduler interleaves across modules) / "the group lock is for cross-worker, the in-process lock covers the rest" (one surface needs ONE domain, whichever primitive it is).

**Full DO / DO-NOT variant (one lock domain):**

```python
# DO — every env-mutating test on this surface joins ONE module-scope lock
_LLM_ENV_LOCK = threading.Lock()
def test_reads_openai_key(monkeypatch):
    with _LLM_ENV_LOCK:
        monkeypatch.setenv("OPENAI_API_KEY", "k"); assert client().key == "k"

# DO NOT — a second, non-interlocking mechanism in a sibling module
@pytest.mark.xdist_group("llm_env")   # group lock — does NOT exclude _LLM_ENV_LOCK holders
def test_reads_bedrock_token(monkeypatch):
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "t")  # races the _LLM_ENV_LOCK tests
```

**Post-mortem — Rust SDK PR #1283 (2026-06-11).** A `file_serial(llm_env)` test failed 2 of 3 main runs because sibling tests guarded the same `AWS_BEARER_TOKEN_BEDROCK` / `OPENAI_API_KEY` surface with a module-local mutex — two non-interlocking lock domains over one env surface. Lock domains don't compose: mutual exclusion holds only among holders of the SAME lock, so a test holding the `file_serial` group lock interleaved with a test holding only the module-local mutex, racing on the shared vars. The failure is probabilistic and module-boundary-shaped, so it presented as a flaky single test rather than a structural race. Unifying all 22 sites onto one domain closed it.

## Complexity-Bound Ratios

Depth companion for `.claude/rules/testing.md` § "MUST: Complexity Bounds Use Self-Normalizing Ratios, Not Absolute Wall-Clock Thresholds".

**BLOCKED rationalizations:** "the runner was loaded, bump the bound" / "60s is generous, real users never hit 10K nodes" / "the test is flaky, widen it" / "we'll profile it later if someone complains".

**Full DO / DO-NOT variant:**

```python
# DO — self-normalizing ratio: machine- and load-independent
base = timeit(lambda: validate(graph(1_000)))    # in-process baseline, same run
big  = timeit(lambda: validate(graph(10_000)))    # 10x the nodes
ratio = big / base
assert ratio < 40, f"validation scaled {ratio:.0f}x for 10x nodes (linear ~10x, quadratic ~100x)"

# DO NOT — absolute bound; ratchets upward under load until it masks O(n^2)
assert big < 60.0    # was 30s, bumped once already
```

**Post-mortem — Rust SDK journal 0177 (2026-06-10).** A 10K-node validation stress bound had been bumped 30s→60s as a "flake". The replacement ratio test failed deterministically 3/3 (10× nodes costing ~99× time) and surfaced a real O(n²) loop, fixed to O(n+e) in the same shard. Absolute bounds ratchet — each load-driven bump widens the window an algorithmic regression hides in, and the bump itself is the institutional tell; the ratio assert is a pure function of the algorithm, not the machine.

## E2E Pipeline Regression — BLOCKED Corpus

Depth companion for `.claude/rules/testing.md` § "MUST: End-to-End Pipeline Regression Above Unit + Integration". See also § "End-to-End Pipeline Regression — kailash-ml W33b (2026-04-23)" above for the full W33b evidence chain.

**BLOCKED rationalizations:** "primitives have unit+integration, pipeline is composition" / "README is illustrative" / "Tier 2 per primitive proves interfaces" / "user will file issue" / "E2E is slow and flaky" / "pipeline is demo's concern, not SDK".

## FFI Handle Concurrent-Close

Depth companion for `.claude/rules/testing.md` § "MUST: FFI Handle Wrappers Ship A Concurrent-Close Stress Test".

**Full DO / DO-NOT variant:**

```text
# DO — stress test races method calls vs Close (+ force GC for the finalizer racer)
spawn N concurrent method-call goroutines/threads; concurrently call Close(); force GC
# DO NOT — flag-gated close validated only by sequential unit tests
if closed: return ErrClosed   # check
native_call(ptr)              # Close can free into this window → UAF
```

**Post-mortem — Rust SDK journals 0174 + 0178.** The check-then-use UAF only crashes under a concurrent closer (often the GC finalizer), so unit tests pass forever while production segfaults under GC pressure. A Go `Subscription` UAF crashed 8/8 under stress (SIGSEGV in `runFinalizers → cgocall`); the identical class recurred on a Go `AlignEngine` one wave later and was caught only because the concurrent-stress-test lens existed. A flag-gated close is NOT deref-safe — the pointer read and the native call are separated by a window `Close` can free into; only a per-handle mutex serializing the entire read-pointer → native-call → free window closes it, and only the concurrent stress test makes the use-after-free non-silent. Cross-binding depth + per-runtime fix shapes (Go/Java/.NET/Ruby/Python/Node) live in the FFI-handle-lifecycle project skill shipped with the rs all-bindings template.
