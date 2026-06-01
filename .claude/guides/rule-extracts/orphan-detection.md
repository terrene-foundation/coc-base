# Orphan Detection — Extended Evidence and Examples

Companion reference for `.claude/rules/orphan-detection.md`. Holds extended `__all__` reconciliation evidence, full code examples, and merge-time post-mortems.

For the comprehensive 5-step audit playbook and historical Phase 5.11 post-mortem, see `skills/16-validation-patterns/orphan-audit-playbook.md`.

## Rule 6a — Full Merge-Time `__all__` Reconciliation Example

When two or more parallel-worktree shards each edit the same package's `__init__.py::__all__` AND the shards were branched from DIFFERENT base SHAs, the orchestrator MUST reconcile `__all__` at merge time using this protocol:

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

### Why — Extended

`__all__` is the public-API contract; parallel shards from different base SHAs each advance that contract independently, and git's 3-way merge picks one side arbitrarily when both modified the same list. Without explicit reconciliation, the newer shard's canonical structure wipes the older shard's added exports, silently orphaning production symbols that downstream consumers depend on. The count-dependent tests are the structural defense — they fail loudly when `len(__all__)` changes unexpectedly, forcing the orchestrator to examine every reconciliation.

Evidence: kailash-ml-audit 2026-04-23 merge — W33 (base `41a217dc`) landed a 6-group canonical `__all__`; W31 (base `899ce3e5`) had separately added 7 Trainable adapters. Merge picked HEAD; fix commit `fa300831` merged the 6-group canonical structure with the 7 Phase-1 Trainable adapters and reconciled `test_km_all_ordering.py` count expectation.

Origin: kailash-ml-audit session 2026-04-23 — W31/W33 parallel-shard `__all__` reconciliation at merge (commit `fa300831`).

## Rule 4a — Stub Implementation Sweep Full Example

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

## Rule 1 — Phase 5.11 Trust Executor Post-Mortem

The 2,407 LOC trust integration code with zero production call sites is the canonical orphan post-mortem. The model + facade + accessor + downstream consumers all shipped; the framework's hot path never invoked the executor; every documented security promise about the trust plane was untrue at runtime.

For the full narrative, see `skills/16-validation-patterns/orphan-audit-playbook.md` § "Phase 5.11 Post-Mortem".

## Rule 6 — Module-Scope `__all__` Full Code

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

Origin: PR #523 / PR #529 (2026-04-19) — kailash-ml 0.11.0 eagerly imported 4 DeviceReport symbols but omitted all from `__all__`; patched in 0.11.1.
