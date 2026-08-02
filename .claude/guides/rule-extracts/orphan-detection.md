# Orphan Detection — Extended Evidence and Examples

Companion reference for `.claude/rules/orphan-detection.md`. The rule body holds the load-bearing MUST clauses, their `**Why:**` lines, their BLOCKED-rationalization corpora, and the Rule-4c Trust Posture Wiring. This file holds the FULL worked DO/DO-NOT code for each clause, the evidence chains, and the per-rule origin narratives.

For the audit playbook and the historical Phase 5.11 post-mortem, see `skills/16-validation-patterns/orphan-audit-playbook.md`.

## Rule 1 — Facade Production Call Site: Full Code

```python
# DO — facade + production call site land in the same PR
class DataFlow:
    @property
    def trust_executor(self) -> TrustAwareQueryExecutor:
        return self._trust_executor

# In the framework's hot path:
class DataFlowExpress:
    async def list(self, model, ...):
        plan = await self._db.trust_executor.check_read_access(...)  # ← real call site

# DO NOT — facade ships, no call site, downstream consumers import the orphan
class DataFlow:
    @property
    def trust_executor(self) -> TrustAwareQueryExecutor:
        return self._trust_executor
# (no call site exists in any framework hot path; trust executor is dead code)
```

### Phase 5.11 Trust Executor Post-Mortem

The 2,407 LOC trust integration code with zero production call sites is the canonical orphan post-mortem. The model + facade + accessor + downstream consumers all shipped; the framework's hot path never invoked the executor; every documented security promise about the trust plane was untrue at runtime. Downstream consumers saw the public attribute, built their security model around the documented behavior, and shipped features that silently bypassed the protection because the framework never invoked the class on the actual data path.

This is the failure mode cited by `rules/autonomous-execution.md` § Origin (capacity bands) and by `rules/agents.md` § "Reviewer Prompts Include Mechanical AST/Grep Sweep" — it is invisible at diff level, which is why the mechanical sweep exists.

For the full narrative, see `skills/16-validation-patterns/orphan-audit-playbook.md` § "Phase 5.11 Post-Mortem".

## Rule 2 — Wired Manager Tier 2 Integration Test: Full Code

```python
# DO — Tier 2 test exercises the wired path against real infrastructure
@pytest.mark.integration
async def test_trust_executor_redacts_in_express_read(test_suite):
    db = DataFlow(test_suite.config.url)
    rows = await db.express.list("Document")
    assert all(row["body"] == "[REDACTED]" for row in rows)

# DO NOT — Tier 1 test against the class in isolation
def test_trust_executor_returns_redacted_plan():
    executor = TrustAwareQueryExecutor(...)
    plan = executor.check_read_access(...)
# ↑ proves the executor can redact, NOT that the framework calls it
```

Unit tests prove the orphan implements its API. Integration tests prove the framework actually calls the orphan. See `rules/testing.md` § Tier 2 for the real-database / real-adapter requirement.

## Rule 4 — API Removal Test Sweep: Full Example

```python
# DO — remove the API and its tests in one commit
# D  src/pkg/legacy_module.py
# D  tests/integration/test_legacy_module.py

# DO NOT — remove the API, leave the tests
# D  src/pkg/legacy_module.py
# (test files still import pkg.legacy_module, collection fails on next run)
```

### Why — Extended

Test files that fail at collection block the ENTIRE suite, not just themselves. One orphan import takes down the 100 tests collected after it — `pytest --collect-only` aborts at the first `ModuleNotFoundError`, so the blast radius is every test file ordered after the orphan.

Origin: 2026-04 — 9 orphan test files left by a DataFlow refactor silently broke integration collection.

## Rule 4a — Stub Implementation Sweep: Full Example

```python
# DO — implementation + deferral-test sweep in one commit
# M  src/pkg/tracking.py  (replaces NotImplementedError with real impl)
# D  tests/unit/test_pkg_deferred_bodies.py::test_track_deferral_names_phase
# A  tests/integration/test_pkg_tracking.py  (real coverage)

# DO NOT — implement the symbol, leave the deferral test
# M  src/pkg/tracking.py
# (tests/unit/test_pkg_deferred_bodies.py still calls track() inside
#  pytest.raises(NotImplementedError); CI fails "DID NOT RAISE" on every matrix job)
```

### Why — Extended

CI-late discovery blocks the release PR's matrix run at the worst possible moment. A `grep -rln 'NotImplementedError.*<symbol>' tests/` at implementation time catches it in O(seconds); a CI re-run costs O(minutes) plus an extra reviewer cycle.

Origin: Session 2026-04-20 kailash-ml 0.13.0 release (PR #552). See `skills/16-validation-patterns/orphan-audit-playbook.md` § 4a for the full 5-matrix-job CI failure.

## Rule 4c — Default/Behavior-Change Sweep: Full Example

```python
# DO — change the default AND sweep every stale assertion in the same PR
# M  src/pkg/agents.py            (default gpt-3.5-turbo → gpt-4o-mini)
# $ grep -rln 'gpt-3.5-turbo' tests/ examples/ packages/*/tests/   # ENTIRE corpus, not CI subset
# M  tests/... examples/... (18 files asserting the old default) — all in THIS PR

# DO NOT — change the default, sweep only the CI-selected tests
# M  src/pkg/agents.py
# (CI is fully green; 18 example / sentence-transformers-gated / ambient-.env tests still assert
#  gpt-3.5-turbo, caught only at release prep — a separate PR, a separate cycle)
```

### Why — Extended

A default/behavior change silently invalidates every test that pinned the old value; the CI matrix's exclusions (examples, optional-dep-gated, ambient-`.env`) mean "CI green" is NOT "full-suite green", so the stragglers surface at release prep — a separate PR, a separate cycle — instead of in the change's own PR. A `grep -rln '<old-value>' tests/ examples/ packages/*/tests/` across the ENTIRE corpus at change time is O(seconds); the deferred discovery is O(minutes) plus a reviewer cycle. This is Rule 4a's sweep-in-same-commit discipline generalized from stub-un-deferral to any default/behavior change.

### Origin — Full Narrative

kailash-py PR #1847 (#1844/#1845 cost fix, 2026-07-20) changed model defaults (`gpt-3.5-turbo` → `gpt-4o-mini` in examples; `gpt-4` → env-resolved in specialized agents); CI was fully green, yet 18 test files (example + sentence-transformers-gated + ambient-`.env`-dependent) still asserted the old defaults — caught only at release prep (PR #1850), never by #1847's own CI. Language-agnostic: any SDK / downstream consumer that changes a default inherits the failure mode. Landed at loom via `/sync-from-build` Gate-1 classification.

## Rule 5a — Sub-Package Collection Gate

`python-environment.md` Rule 4 blocks sub-package test deps from root `[dev]` because plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity — which is why Rule 5 MUST NOT be read as mandating a single combined root-venv invocation. The gate passes per-package after installing each sub-package's `[dev]` extras.

See `skills/16-validation-patterns/orphan-audit-playbook.md` § "Sub-Package Collection-Gate Patterns" for the full iteration script.

Origin: Session 2026-04-20 /redteam collection-gate work.

## Rule 6 — Module-Scope `__all__`: Full Code

```python
# DO — every public module-scope import appears in __all__
from kailash_ml._device_report import DeviceReport, device_report_from_backend_info

__all__ = ["__version__", "DeviceReport", "device_report_from_backend_info", ...]

# DO NOT — public symbol imported but missing from __all__
from kailash_ml._device_report import DeviceReport, device_report_from_backend_info

__all__ = ["__version__", ...]  # DeviceReport absent
# Result: `from kailash_ml import *` drops the advertised public API
# Sphinx autodoc, linters, mypy --strict all skip the symbol
```

### Why — Extended

`__all__` is the package's public-API contract: Sphinx autodoc, linters, `mypy --strict`, and `from pkg import *` all read it as the canonical export list. A symbol that's eagerly imported but absent is both advertised (via import) AND hidden (via `__all__`) — the exact inconsistency the orphan pattern produces.

Origin: PR #523 / PR #529 (2026-04-19) — kailash-ml 0.11.0 eagerly imported 4 DeviceReport symbols but omitted all from `__all__`; patched in 0.11.1.

## Rule 6b — TYPE_CHECKING Block For Lazy `__getattr__` Exports: Full Code

```python
# DO — TYPE_CHECKING block satisfies static analyzers; runtime stays lazy
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from kailash_align.torch_utils import TorchTrainer  # analyzer-only import

__all__ = ["TorchTrainer", ...]  # CodeQL py/undefined-export resolves via TYPE_CHECKING

def __getattr__(name):
    if name == "TorchTrainer":
        from kailash_align.torch_utils import TorchTrainer  # lazy runtime import
        return TorchTrainer
    raise AttributeError(name)

# DO NOT — __all__ entry with no static-analyzer resolution
__all__ = ["TorchTrainer", ...]
def __getattr__(name):
    if name == "TorchTrainer":
        from kailash_align.torch_utils import TorchTrainer
        return TorchTrainer
# ↑ CodeQL py/undefined-export flags "TorchTrainer" as undefined at module scope
```

### Why — Extended

A `__getattr__`-resolved entry in `__all__` is both advertised (Sphinx autodoc reads `__all__`) AND unverifiable (the symbol has no module-scope binding). Static analyzers flag it as undefined; users who `from pkg import *` get `ImportError` at runtime when the heavy dep is missing. The `TYPE_CHECKING` block resolves the static-analysis half without dragging the heavy dep into the hot import path — both contracts satisfied. Eager-importing the heavy deps defeats the lazy design; removing them from `__all__` breaks `from pkg import *`; the `TYPE_CHECKING` pattern is the single reconciliation.

Origin: commit `7943b3a1` (2026-04-23) — closed 17 `py/undefined-export` CodeQL findings in `kailash_align/__init__.py` without forcing torch into the eager import path.

## Rule 6a — Full Merge-Time `__all__` Reconciliation Example

The four-step reconciliation protocol itself is load-bearing and stays in the rule body. This is its worked example and evidence chain.

```python
# DO — reconcile __all__ at merge time, prefer HEAD, preserve invariants
# After merging W31 (base 899ce3e5) + W33 (base 41a217dc), both edited __all__.
# W33 introduced 6-group canonical structure; W31 added 7 Trainable adapters.
# Resolution:
__all__ = [
    # Group 1 — Core engine facade (W33's canonical structure)
    "MLEngine", "Engine",
    # Group 2 — Trainable adapters (W31 invariant: 7 Phase-1 adapters)
    "Trainable", "SklearnTrainable", "LightGBMTrainable", "XGBoostTrainable",
    "CatBoostTrainable", "TorchTrainable", "LightningTrainable",
    # ... Groups 3-6 from W33 ...
]
# Then: update test_km_all_ordering.py count expectation in the same commit.

# DO NOT — pick one shard's __all__ wholesale, lose the other's invariant
# (W33's __all__ wins → 7 Trainable adapters missing → every downstream
#  import of SklearnTrainable breaks on the next install)
```

### Why — Extended

`__all__` is the public-API contract (§6 above); parallel shards from different base SHAs each advance that contract independently, and git's 3-way merge picks one side arbitrarily when both modified the same list. Without explicit reconciliation, the newer shard's canonical structure wipes the older shard's added exports, silently orphaning production symbols that downstream consumers depend on. The count-dependent tests are the structural defense — they fail loudly when `len(__all__)` changes unexpectedly, forcing the orchestrator to examine every reconciliation.

Evidence: kailash-ml-audit 2026-04-23 merge — W33 (base `41a217dc`) landed a 6-group canonical `__all__`; W31 (base `899ce3e5`) had separately added 7 Trainable adapters. Merge picked HEAD; fix commit `fa300831` merged the 6-group canonical structure with the 7 Phase-1 Trainable adapters and reconciled `test_km_all_ordering.py` count expectation.

Origin: kailash-ml-audit session 2026-04-23 — W31/W33 parallel-shard `__all__` reconciliation at merge (commit `fa300831`).
