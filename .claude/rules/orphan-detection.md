---
priority: 10
scope: path-scoped
paths:
  - "packages/**"
  - "src/**"
  - "**/tests/**"
---

# Orphan Detection Rules

A class that no production code calls is a lie. Beautifully implemented orphans accumulate when a feature is built top-down — model + facade + accessor ship, downstream consumers import them — but the framework's hot path never invokes them. Unit tests pass against the orphan in isolation; the security/audit/governance promise the orphan was supposed to deliver never executes once.

Extended evidence, detection playbooks, and historical post-mortems live in `skills/16-validation-patterns/orphan-audit-playbook.md`. This file holds the load-bearing MUST clauses.

## MUST Rules

### 1. Every `db.*` / `app.*` Facade Has a Production Call Site

Any attribute exposed on a public surface that returns a `*Manager`, `*Executor`, `*Store`, `*Registry`, `*Engine`, or `*Service` MUST have at least one call site inside the framework's production hot path within 5 commits of the facade landing. The call site MUST live in the same package as the framework, not just in tests or downstream consumers.

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

**Why:** Downstream consumers see the public attribute, build their security model around the documented behavior, and ship features that silently bypass the protection because the framework never invokes the class on the actual data path. See Phase 5.11 post-mortem in the playbook skill (2,407 LOC of trust integration never executed once).

### 2. Every Wired Manager Has a Tier 2 Integration Test

Once a manager is wired into the production hot path, its end-to-end behavior MUST be exercised by at least one Tier 2 integration test (real database, real adapter — `rules/testing.md` § Tier 2). Unit tests against the manager class in isolation are NOT sufficient.

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

**Why:** Unit tests prove the orphan implements its API. Integration tests prove the framework actually calls the orphan.

#### 2a. Crypto-Pair Round-Trip Through Facade

Paired crypto operations (`encrypt`/`decrypt`, `sign`/`verify`, `seal`/`unseal`) MUST have a Tier 2 test that round-trips through the facade: call one half, feed its output to the other, assert equality. Isolated unit tests per half can drift silently (e.g. encrypt uses GCM while decrypt uses CBC) with both passing. See `skills/16-validation-patterns/orphan-audit-playbook.md` § 2a for the full failure pattern.

**Why:** Crypto pairs are the manager-pattern at a smaller scale — each half is a dependency of the other, invisible to isolated tests.

### 3. Removed = Deleted, Not Deprecated

If a manager is found to be an orphan and the team decides not to wire it, it MUST be deleted from the public surface in the same PR — not marked deprecated, not left behind a feature flag, not commented out.

**Why:** Deprecation banners are easy to miss; consumers continue importing the symbol and silently shipping insecure code. Deletion is the only signal that survives a `pip install kailash --upgrade`.

### 4. API Removal MUST Sweep Tests In The Same PR

Any PR that removes a public symbol MUST delete or port the tests that import it, in the same commit. Test files that reference the removed symbol fail at `pytest --collect-only` with `ModuleNotFoundError`, blocking every subsequent test run.

```python
# DO — remove the API and its tests in one commit
# D  src/pkg/legacy_module.py
# D  tests/integration/test_legacy_module.py

# DO NOT — remove the API, leave the tests
# D  src/pkg/legacy_module.py
# (test files still import pkg.legacy_module, collection fails on next run)
```

**BLOCKED rationalizations:**

- "The tests will be cleaned up in a follow-up PR"
- "CI doesn't run those tests anyway"
- "The tests are obsolete; they don't need to move"
- "`pytest --collect-only` isn't part of CI"

**Why:** Test files that fail at collection block the ENTIRE suite, not just themselves. One orphan import takes down the 100 tests collected after it.

Origin: 2026-04 — 9 orphan test files left by a DataFlow refactor silently broke integration collection.

### 4a. Stub Implementation MUST Sweep Deferral Tests In Same Commit

Mirror of Rule 4. Any PR that _implements_ a previously-deferred stub — replacing `NotImplementedError` / `raise NotImplementedError("Phase N — will implement")` with a real implementation — MUST delete or rewrite every test that asserts the deferred behavior in the same commit. Scaffold-era tests like `test_foo_deferral_names_phase` that `pytest.raises(NotImplementedError)` on the now-implemented symbol flip from pass to fail and block release CI.

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

**BLOCKED rationalizations:**

- "The deferral test was a scaffold; CI will surface it and we'll fix it then"
- "I'll clean up the scaffold tests in a follow-up"
- "The Phase N naming means the test self-documents as obsolete"

**Why:** CI-late discovery blocks the release PR's matrix run at the worst possible moment. A `grep -rln 'NotImplementedError.*<symbol>' tests/` at implementation time catches it in O(seconds); a CI re-run costs O(minutes) plus an extra reviewer cycle.

Origin: Session 2026-04-20 kailash-ml 0.13.0 release (PR #552). See `skills/16-validation-patterns/orphan-audit-playbook.md` § 4a for the full 5-matrix-job CI failure.

### 5. Collect-Only Is A Merge Gate

`pytest --collect-only` across every test directory MUST return exit 0 before any PR merges. A collection error is a blocker in the same class as a test failure.

```bash
# DO — gate in CI, pre-commit, or /redteam
.venv/bin/python -m pytest --collect-only tests/ packages/*/tests/
# exit 0 required

# DO NOT — "we only run unit tests in CI, integration is manual"
```

**Why:** Collection failures are invisible in "unit-only CI" setups yet become merge-blocking the moment someone runs the full suite locally.

#### 5a. Per-Package Collection In Monorepos With Sub-Package Test Deps

Rule 5 MUST NOT be interpreted as mandating a single combined root-venv invocation. Monorepos with sub-package test-only deps (e.g. `hypothesis` in pact, `respx` in kaizen) CANNOT pass a combined invocation because `python-environment.md` Rule 4 blocks duplicating sub-package test deps in root `[dev]`. The gate passes per-package after installing each sub-package's `[dev]` extras. See `skills/16-validation-patterns/orphan-audit-playbook.md` § "Sub-Package Collection-Gate Patterns" for the full iteration script.

**BLOCKED rationalizations:**

- "A single invocation is faster for CI"
- "We'll duplicate the test deps in root [dev] just for collection"
- "Per-package collection is belt-and-suspenders"

**Why:** `python-environment.md` Rule 4 blocks sub-package test deps from root `[dev]` because plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity.

Origin: Session 2026-04-20 /redteam collection-gate work.

### 6. Module-Scope Public Imports Appear In `__all__`

When a symbol is imported at module-scope into a package's `__init__.py` (not behind `_` / not lazy via `__getattr__`), it MUST appear in that module's `__all__` list unless the symbol is private. New `__all__` entries MUST land in the same PR as the import. Eagerly-imported-but-absent-from-`__all__` is BLOCKED.

```python
# DO — every public module-scope import appears in __all__
from kailash_ml._device_report import DeviceReport, device_report_from_backend_info

__all__ = ["__version__", "DeviceReport", "device_report_from_backend_info", ...]

# DO NOT — public symbol imported but missing from __all__
from kailash_ml._device_report import DeviceReport, device_report_from_backend_info

__all__ = ["__version__", ...]  # DeviceReport absent
# Result: `from kailash_ml import *` drops the advertised public API
```

**BLOCKED rationalizations:**

- "The symbol is reachable via `pkg.X`, that's enough"
- "Nobody uses `from pkg import *`"
- "`__all__` is a convention, not a contract"

**Why:** `__all__` is the package's public-API contract: Sphinx autodoc, linters, `mypy --strict`, and `from pkg import *` all read it as the canonical export list. A symbol that's eagerly imported but absent is both advertised (via import) AND hidden (via `__all__`) — the exact inconsistency the orphan pattern produces.

Origin: PR #523 / PR #529 (2026-04-19) — kailash-ml 0.11.0 eagerly imported 4 DeviceReport symbols but omitted all from `__all__`; patched in 0.11.1.

#### 6b. TYPE_CHECKING Block For Lazy `__getattr__` Exports

Packages that lazy-load heavy optional deps (torch, vllm, catboost) via `__getattr__` MUST still expose those symbols to static analysis (CodeQL `py/undefined-export`, pyright, mypy `--strict`, Sphinx autodoc) via a `TYPE_CHECKING` block. Eager-importing the heavy deps defeats the lazy design; removing them from `__all__` breaks `from pkg import *`. The `TYPE_CHECKING` pattern is the single reconciliation.

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

**BLOCKED rationalizations:** "CodeQL is noisy, suppress the finding" / "static analyzers will catch up eventually" / "eager-importing is fine, users have torch installed anyway" / "we can drop the lazy path".

**Why:** A `__getattr__`-resolved entry in `__all__` is both advertised (Sphinx autodoc reads `__all__`) AND unverifiable (the symbol has no module-scope binding). Static analyzers flag it as undefined; users who `from pkg import *` get `ImportError` at runtime when the heavy dep is missing. The `TYPE_CHECKING` block resolves the static-analysis half without dragging the heavy dep into the hot import path — both contracts satisfied.

Origin: commit `7943b3a1` (2026-04-23) — closed 17 `py/undefined-export` CodeQL findings in `kailash_align/__init__.py` without forcing torch into the eager import path.

### 6a. Merge-Time `__all__` Reconciliation Across Shard Base-SHAs

When two or more parallel-worktree shards each edit the same package's `__init__.py::__all__` AND the shards were branched from DIFFERENT base SHAs (see `rules/worktree-isolation.md` §5), the orchestrator MUST reconcile `__all__` at merge time using this protocol:

1. **Prefer HEAD (newest canonical structure).** The later-merged shard's `__all__` ordering + group-comment layout is canonical.
2. **Preserve invariants from the older base.** Enumerate any symbols / counts / semantic groups the older-base shard depended on (e.g. "7 Phase-1 Trainable adapters MUST be exported") and verify they survive the reconciliation.
3. **Update count-dependent tests.** Tests that assert `len(__all__) == N` MUST be patched to reflect the reconciled count in the SAME commit as the reconciliation.
4. **Run the module-scope import check from §6.** Every newly-added entry MUST still have a matching eager import.

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

**BLOCKED rationalizations:**

- "The merge conflict resolution picked one side; git knows best"
- "The missing adapters will surface in CI; we'll fix then"
- "Count-dependent tests are brittle; we should delete them"
- "HEAD always wins, older shard's invariants don't matter"
- "The reconciliation can happen in a follow-up PR"

**Why:** `__all__` is the public-API contract (§6 above); parallel shards from different base SHAs each advance that contract independently, and git's 3-way merge picks one side arbitrarily when both modified the same list. Without explicit reconciliation, the newer shard's canonical structure wipes the older shard's added exports, silently orphaning production symbols that downstream consumers depend on. The count-dependent tests are the structural defense — they fail loudly when `len(__all__)` changes unexpectedly, forcing the orchestrator to examine every reconciliation. Evidence: kailash-ml-audit 2026-04-23 merge — W33 (base `41a217dc`) landed a 6-group canonical `__all__`; W31 (base `899ce3e5`) had separately added 7 Trainable adapters. Merge picked HEAD; fix commit `fa300831` merged the 6-group canonical structure with the 7 Phase-1 Trainable adapters and reconciled `test_km_all_ordering.py` count expectation.

Origin: kailash-ml-audit session 2026-04-23 — W31/W33 parallel-shard `__all__` reconciliation at merge (commit `fa300831`).

## MUST NOT

- Land a `db.X` / `app.X` facade without the production call site in the same PR

**Why:** The PR review is the only structural gate that catches orphans before they ship.

- Skip the consumer check on grounds that "downstream consumers will use it"

**Why:** Downstream consumers using a class is NOT the same as the framework using it. The framework's hot path is the security boundary.

- Mark a wired manager as "fully tested" based on Tier 1 unit tests alone

**Why:** Tier 1 mocks the framework's call into the manager. The orphan failure mode is precisely "the framework never calls the manager in production" — Tier 1 cannot detect that.

## Detection Protocol

The 5-step `/redteam` audit procedure lives in `skills/16-validation-patterns/orphan-audit-playbook.md` § "Detection Protocol". Runs as part of `/redteam` and `/codify`.
