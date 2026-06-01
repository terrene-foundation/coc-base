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

Origin: Session 2026-04-20 (issue #567 PR#5, PR#580). `DeterministicJudge` in `packages/kailash-kaizen/tests/integration/judges/test_judges_wiring.py` exercises 7 Tier 2 tests through the `kaizen.judges` facade without API keys; satisfies `kailash.diagnostics.protocols.JudgeCallable` at runtime.

## PR #466 — 63-Warning Sweep (2026-04-14)

PR #466 eliminated 63 unit test warnings across 10 categories. Each category recurred across multiple sessions until a dedicated MUST rule was added.

Specific fixes:

- **Resource cleanup** — `test_cli_channel_comprehensive.py` had 36 unclosed channels emitting `ResourceWarning` from `CLIChannel.__del__`. Fixture used `return` instead of `yield + close`.
- **AsyncMock double-wrap** — `tests/unit/mcp_server/test_discovery.py` patched `asyncio.open_connection` with default `AsyncMock` while providing `async def` side_effect. `AsyncMock._execute_mock_call` wrapped the coroutine again; inner wrapper never awaited; `RuntimeWarning` at GC.
- **Stub naming** — `tests/unit/runtime/mixins/test_conditional_execution_mixin.py` had `TestConditionalRuntime(BaseRuntime, ...)` with `__init__`; pytest's `python_classes = Test*` triggered `PytestCollectionWarning`.
- **JWT test secrets** — `tests/unit/mcp_server/test_auth.py` used `"secret_key"` (10 bytes) triggering `InsecureKeyLengthWarning` from PyJWT.

## Pytest Plugin + Marker Declaration — 11,917-Test Block (2026-04-20)

Session 2026-04-20 /redteam collection-gate sweep: `packages/kailash-kaizen/tests/e2e/memory/test_persistent_buffer_e2e.py` used `@pytest.mark.benchmark` + `benchmark` fixture without declaring `pytest-benchmark` in the sub-package's `[dev]` extras. Collection failed with:

```
'benchmark' not found in `markers` configuration option
```

ALL 11,917 kaizen tests blocked from collection until fixed. Fixed commit `1313ae56` by:

1. Adding `pytest-benchmark>=4.0.0` to `packages/kailash-kaizen/pyproject.toml::[project.optional-dependencies].dev`
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
3. Landed `packages/kailash-ml/tests/regression/test_readme_quickstart_executes.py::test_readme_quickstart_executes_end_to_end` as Tier-2 E2E regression

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
