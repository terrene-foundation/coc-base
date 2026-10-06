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

## Rule 3 — Removed = Deleted, Not Deprecated

**This clause carries NO extracted depth, and that is the finding rather than an omission.** Its obligation, its `**Why:**` and its failure mode are wholly stated in the rule body: deprecation banners are easy to miss, consumers keep importing the symbol, and deletion is the only signal that survives a `pip install <pkg> --upgrade`. Nothing was held back from it, so there is nothing here to resolve to — the heading exists so that grepping the clause number lands somewhere, which is what the rule's preamble convention promises. Added 2026-09-15: the preamble asserted one heading per clause while Rules 3 and 5 had none, so the convention was FALSE for exactly the two self-contained clauses.

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

## Rule 5 — Collect-Only Is A Merge Gate

**This clause carries NO extracted depth** — same disposition as § "Rule 3 — Removed = Deleted, Not Deprecated" above, and added in the same 2026-09-15 pass for the same reason. The gate command, its DO/DO-NOT fence and its `**Why:**` (collection failures are invisible in unit-only CI yet merge-blocking the moment someone runs the full suite locally) are wholly in the rule body. What DID have depth is its sub-clause **5a**, which has its own two headings immediately below — do not read 5a's depth as Rule 5's.

## Rule 5a — Sub-Package Collection Gate

`python-environment.md` Rule 4 blocks sub-package test deps from root `[dev]` because plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity — which is why Rule 5 MUST NOT be read as mandating a single combined root-venv invocation. The gate passes per-package after installing each sub-package's `[dev]` extras.

See `skills/16-validation-patterns/orphan-audit-playbook.md` § "§5a — Collect-Only Gate Passes Per-Package, Not Combined Root Invocation" for the full iteration script.

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

---

The sections below were extracted from the rule body on 2026-08-19 (structural-cleanup extraction — see § "Extraction Record — 2026-08-19"). Every one is EVIDENCE, RUNNABLE DETAIL, WORKED EXAMPLE, MEASURED NARRATIVE or PER-INSTANCE PROVENANCE. No MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block or `**Why:**` line was moved.

## The Orphan Failure Shape — How Orphans Accumulate

Beautifully implemented orphans accumulate when a feature is built top-down — model + facade + accessor ship, downstream consumers import them — but the framework's hot path never invokes them. Unit tests pass against the orphan in isolation; the security/audit/governance promise the orphan was supposed to deliver never executes once.

This is the shape every clause of `rules/orphan-detection.md` guards a different emergence path of. The canonical instance is the Phase 5.11 trust executor (§ "Phase 5.11 Trust Executor Post-Mortem" above): 2,407 LOC of trust integration code with zero production call sites.

## Rule 1a — Why The Artifact Class Must Be Classified Before The Audit

Rule 1 assumes an APPLICATION-FRAMEWORK shape, where the hot path is INTERNAL and a facade with no in-framework call site is dead. For a LIBRARY-class artifact — a component library, parser, or utility package consumed BY PACKAGE NAME from outside its own tree — there is no internal call site to find, because the consumer IS the call site. Running the Rule-1 audit unmodified there does not find orphans; it manufactures false positives against the wrong surface.

The two per-class orphan definitions and the HIGH/MED finding grades stay in the rule body — this section holds only the reason the classification step precedes the audit.

## Rule 2a — The Isolated-Crypto-Test Drift Pattern

Isolated unit tests per half can drift silently (e.g. encrypt uses GCM while decrypt uses CBC) with both passing. Neither test observes the other half, so each is green against a contract the pair no longer shares; only a round-trip through the facade — call one half, feed its output to the other, assert equality — can observe the divergence.

Full failure pattern: `skills/16-validation-patterns/orphan-audit-playbook.md` § 2a.

## Rule 4a — The Scaffold-Test Flip

Scaffold-era tests like `test_foo_deferral_names_phase` that `pytest.raises(NotImplementedError)` on the now-implemented symbol flip from pass to fail and block release CI. The flip is invisible at implementation time because the implementation diff never touches the test file; it surfaces on the next matrix run.

Worked commit shape: § "Rule 4a — Stub Implementation Sweep: Full Example" above. The 5-matrix-job CI failure: `skills/16-validation-patterns/orphan-audit-playbook.md` § 4a.

## Rule 4c — CI-Green Is Not Full-Suite-Green

CI matrices routinely EXCLUDE example tests, optional-dependency-gated tests, and ambient-`.env`-dependent tests, so a default change can be FULLY CI-green while N full-suite tests still assert the OLD value. That is the load-bearing insight Rule 4c carries beyond Rule 4a's same-commit-sweep discipline: the sweep's denominator is the ENTIRE test corpus, not the CI-selected subset.

Measured instance (kailash-py PR #1847, 2026-07-20): CI was fully green and **18** out-of-CI-matrix test files still asserted the old model defaults. Had the sweep-denominator claim been false — i.e. had CI selected the full corpus — those 18 files would have RED-ed #1847's own CI run and never reached release prep. They reached release prep (PR #1850), which is the falsifying context that makes the 18 readable.

## Rule 4c — Trust-Posture Wiring Depth

### The Phase-1 detection command

The Phase-1 gate-review sweep is a full-corpus grep for the old value, run by reviewer at `/implement` and release-specialist at `/release`:

```bash
grep -rln '<old-value>' tests/ examples/ packages/*/tests/
```

The path set is deliberately WIDER than the CI-selected subset (`tests/` alone on most matrices) — `examples/` and `packages/*/tests/` are exactly the trees the matrix excludes. Zero stale old-value assertions across that set is the pass condition; any hit is a finding.

### Regression-within-grace — the named deviation, in full

Rule 4c routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) with NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded per `trust-posture.md` Rule 8, for two reasons: a test-sweep completeness property is review-layer-only (there is no structural tool-call-time signal for "the sweep covered the excluded trees"), and minting a key would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit.

Sibling precedents taking the same no-dedicated-key disposition: `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge.

### Rule 4c → Origin (measured)

kailash-py PR #1847 (#1844/#1845 cost fix, 2026-07-20) — a model-default change was fully CI-green while **18** out-of-CI-matrix test files still asserted the old defaults, caught only at release prep (PR #1850). Landed at loom via `/sync-from-build` Gate-1 classification. Full narrative: § "Rule 4c — Default/Behavior-Change Sweep: Full Example" → "Origin — Full Narrative" above.

## Rule 5a — Why A Combined Root-Venv Invocation Cannot Pass

Monorepos with sub-package test-only deps (e.g. `hypothesis` in pact, `respx` in kaizen) CANNOT pass a combined root-venv `--collect-only` invocation, because `python-environment.md` Rule 4 blocks duplicating sub-package test deps in root `[dev]` — plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity, which is why Rule 5's merge gate passes per-package after installing each sub-package's `[dev]` extras rather than as one combined run.

Full iteration script: `skills/16-validation-patterns/orphan-audit-playbook.md` § "§5a — Collect-Only Gate Passes Per-Package, Not Combined Root Invocation". See also § "Rule 5a — Sub-Package Collection Gate" above.

## Rule 6a — Reconciliation Step 2: The Invariant Enumeration

Step 2 of the merge-time protocol ("Preserve invariants from the older base") enumerates symbols / counts / semantic groups the older-base shard depended on. The canonical worked instance is the W31 invariant "7 Phase-1 Trainable adapters MUST be exported" — a count-plus-membership invariant that a 3-way merge picking HEAD wholesale silently drops. Full reconciliation example: § "Rule 6a — Full Merge-Time `__all__` Reconciliation Example" above.

## Rule 6b — Why Neither Eager-Import Nor `__all__`-Removal Works

Eager-importing the heavy deps defeats the lazy design (torch/vllm/catboost land in the hot import path, which is the cost the `__getattr__` indirection exists to avoid); removing them from `__all__` breaks `from pkg import *` and drops the symbols from Sphinx autodoc. The `TYPE_CHECKING` pattern is the single reconciliation that satisfies both contracts. Full code: § "Rule 6b — TYPE_CHECKING Block For Lazy `__getattr__` Exports: Full Code" above.

## Rule-Body Length Rationale — Full Clause Enumeration

The rule body's named rationale is **orphan-surface scope**. The numbered clauses, RE-DERIVED from the rule body's `###`/`####` headings on 2026-09-15, are **thirteen**: 1/1a, 2/2a, 3, 4/4a/4c, 5/5a, 6/6a/6b. An earlier revision of this line — and the matching "twelve" in the rule body's own length rationale — said TWELVE and omitted **1a** (Library-Class Artifacts), a clause the body has carried since it landed; both were stale and are corrected here, the body's by DELETING the figure in favour of a count-the-headings instruction rather than replacing one remembered total with another. The 4b slot holds the extracted Error-Contract Refactor clause, which lives at `skills/16-validation-patterns/orphan-audit-playbook.md` § 4b rather than in the rule body. Each clause guards a DISTINCT orphan-emergence path that a `/redteam` orphan audit MUST hold simultaneously; splitting them across sibling rules would force a cross-rule lookup at every audit step. The body additionally carries the post-cutoff clause-scoped Trust-Posture Wiring (Rule 4c) that `trust-posture.md` MUST-8 requires to live in the rule body itself.

The rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and `rule-authoring.md` Rule 10's proximity-band gate does NOT fire on it. Sibling precedent for a named length rationale: `tenant-isolation.md` + `cross-sdk-inspection.md`.

## Extraction Record — 2026-08-19

Structural-cleanup extraction from `.claude/rules/orphan-detection.md` to bring loom's rule-injection budget under its per-profile ceilings (the rule fires in the `consumer-sdk-src` and `consumer-test` profiles, both over budget). **ZERO de-scoping**: every MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and `**Why:**` line stayed in the rule body verbatim; only evidence, runnable detail, worked examples, measured narratives and per-instance provenance moved here, each leaving a resolving pointer.

Topics moved: the orphan failure shape (rule-body opening exposition) · Rule 1a's classify-before-audit reasoning · Rule 2a's isolated-crypto-test drift pattern · Rule 4a's scaffold-test flip · Rule 4c's CI-green-is-not-full-suite-green evidence · Rule 4c's Trust-Posture Wiring depth (the Phase-1 grep command, the Rule-8 named-deviation reasoning and its sibling precedents, the measured Origin narrative) · Rule 5a's combined-invocation impossibility · Rule 6a's step-2 invariant enumeration · Rule 6b's why-neither-alternative-works · the length rationale's full clause enumeration.

**`rule-authoring.md` Rule 10 and Rule 11 do NOT fire here.** Rule 10 § "Trigger scope" limits the proximity-band admission gate to `priority: 0` + `scope: baseline` rules; `orphan-detection.md` is `priority: 10` + `scope: path-scoped`, so it contributes nothing to baseline emission and Rule 10 is not engaged. Rule 11 counts only Rule-10-MANDATED invocations, so a structural-cleanup extraction on a path-scoped rule is not Rule-11 input either. Same disposition `journal/0148` recorded for the `rule-authoring.md` self-extraction.

The Phase 5.11 orphan evidence (2,407 LOC of trust integration with zero production call sites), cited by `rules/autonomous-execution.md` § Origin and `rules/agents.md` § "Reviewer Prompts Include Mechanical AST/Grep Sweep", is unchanged and still resolves at § "Phase 5.11 Trust Executor Post-Mortem" above.

## Extraction Record — 2026-09-13

A second structural-cleanup pass moved the remaining per-field Wiring narrative,
the probe-registration boilerplate and five rationale/cost tails out of
`.claude/rules/orphan-detection.md`, to hold that path-scoped rule under the
over-budget `consumer-sdk-src` / `consumer-test` rule-injection profiles.

**ZERO de-scoping, measured.** The enforcement-token census of the rule body is
IDENTICAL before and after: `must_clause` 5, `must_token` 41, `must_not_token` 5,
`blocked_token` 11, `why_line` 16, and each of the eight canonical
`wiring:<Field>` bullet counts 1. Every `MUST`, `MUST NOT`, BLOCKED entry,
DO/DO-NOT fenced block and `**Why:**` failure-mode statement stayed in the rule
body; the Rule-4c Wiring block keeps all 8 canonical field labels with their
normative statements. STRUCTURAL CLEANUP, not a Rule-10 paired extraction —
Rule 10 § "Trigger scope" limits the proximity-band gate to `priority: 0` +
`scope: baseline` rules and this rule is `scope: path-scoped`, so neither Rule 10
nor Rule 11 fires (same disposition `journal/0148` recorded).

### Rule 4c — probe-registration narrative (moved 2026-09-13)

Moved verbatim from the rule body's `**Detection mechanism:**` bullet. The bullet
retains the registered probe path, the row/pair counts, the per-clause firing-pair
enumeration, the fixtures directory, the load-bearing-pair identification and the
Phase-2 deferral:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses. An earlier revision of this row said the suite was NOT YET AUTHORED and pointed at the dated `phase2-deferrals.json::probe_authorship_deferrals` entry; that was true when written and is now FALSE, corrected here rather than left standing, and the dated row is DELETED in the same change rather than renewed. The MUST-4c pair is the one that row called infeasible: BOTH poles sweep, and they separate only on whether the grep's input set was the CI selection or the whole corpus — visible in the invocation's own scope flags, which is why the clause is probeable at all. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.

### Rule 1a — the classify-first conclusion (moved 2026-09-13)

Moved verbatim from the Rule 1a `**Why:**` line. Its failure-mode statement (a
rule applied to the wrong surface returns confident false positives, and an audit
that cries wolf on a whole artifact class gets disabled for that class) stayed in
the rule:

> Classifying first is what gives BOTH classes a check that can actually fail.

### Rule 4a — the deferral-test grep command (moved 2026-09-13)

Moved verbatim from the Rule 4a `**Why:**` line. The cost comparison stayed in the
rule in compressed form; the runnable command moved here:

> A `grep -rln 'NotImplementedError.*<symbol>' tests/` at implementation time catches it in O(seconds); a CI re-run costs O(minutes) plus an extra reviewer cycle.

### Rule 4c — the change classes and the cost arithmetic (moved 2026-09-13)

Moved verbatim from the Rule 4c clause body and its `**Why:**` line. The
obligation (grep the ENTIRE test corpus, not the CI-selected subset, and update
every stale assertion in the SAME PR) and the CI-green-is-not-full-suite-green
failure-mode statement both stayed in the rule:

> (a model default, a config default, a threshold, a resolved value)

> The full-corpus grep at change time is O(seconds); the deferred discovery is O(minutes) plus a reviewer cycle.

## Extraction Record — 2026-09-15

A third structural-cleanup pass, taken to relieve the two remaining tight
rule-injection profiles (`consumer-test`, `consumer-sdk-src`) that
`.claude/rules/orphan-detection.md` fires in. It moved NO obligation. What it
removed was **navigation scaffolding**: nineteen per-clause `extract § "…"`
pointer tails, each naming the extract heading that serves its clause.

**Those pointers are not gone — they were CONSOLIDATED into the rule's preamble**,
which now states the resolution convention once: the extract is organised with one
heading per clause, so `§ "Rule 4c — …"` / `§ "Rule 6b — …"` resolve by grepping
the clause number here. The mapping the tails used to carry, recorded once so it is
not reconstructed from memory:

| clause  | extract heading                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| opening | § "The Orphan Failure Shape — How Orphans Accumulate"                                                                                                 |
| Rule 1  | § "Rule 1 — Facade Production Call Site: Full Code" (+ § "Phase 5.11 Trust Executor Post-Mortem")                                                     |
| Rule 1a | § "Rule 1a — Why The Artifact Class Must Be Classified Before The Audit"                                                                              |
| Rule 2  | § "Rule 2 — Wired Manager Tier 2 Integration Test: Full Code"                                                                                         |
| Rule 2a | § "Rule 2a — The Isolated-Crypto-Test Drift Pattern"                                                                                                  |
| Rule 3  | § "Rule 3 — Removed = Deleted, Not Deprecated" (no extracted depth; heading added 2026-09-15)                                                         |
| Rule 4  | § "Rule 4 — API Removal Test Sweep: Full Example"                                                                                                     |
| Rule 4a | § "Rule 4a — The Scaffold-Test Flip" · § "Rule 4a — Stub Implementation Sweep: Full Example"                                                          |
| Rule 4c | § "Rule 4c — CI-Green Is Not Full-Suite-Green" · § "Rule 4c — Default/Behavior-Change Sweep: Full Example" · § "Rule 4c — Trust-Posture Wiring Depth" |
| Rule 5  | § "Rule 5 — Collect-Only Is A Merge Gate" (no extracted depth; heading added 2026-09-15)                                                              |
| Rule 5a | § "Rule 5a — Sub-Package Collection Gate" · § "Rule 5a — Why A Combined Root-Venv Invocation Cannot Pass"                                             |
| Rule 6  | § "Rule 6 — Module-Scope `__all__`: Full Code"                                                                                                        |
| Rule 6a | § "Rule 6a — Full Merge-Time `__all__` Reconciliation Example" · § "Rule 6a — Reconciliation Step 2: The Invariant Enumeration"                       |
| Rule 6b | § "Rule 6b — TYPE_CHECKING Block For Lazy `__getattr__` Exports: Full Code" · § "Rule 6b — Why Neither Eager-Import Nor `__all__`-Removal Works"      |

Also compressed, with every normative token held in place: the Rule-4c Wiring
`**Severity:**` and `**Detection mechanism:**` field bodies, the length rationale,
and the extraction-record line.

**ZERO de-scoping, MEASURED on this tree rather than asserted.** `check-descoping.mjs`
resolves both sides with `git show` and has no working-tree mode, so on an
uncommitted lane it returns CLEAN whether or not a clause was dropped — its verdict
is NOT evidence about this diff. The census below was taken instead by a harness
importing `extractInventory` and `CITATION_CLASSES` from that same file and diffing
the merge-base blob against the working tree, applying the identical decision
procedure (normative classes fail on a FALLEN count; citation classes fail on a
member that LEFT the set). The harness was fired at a known-answer mutation first —
deleting one `**Why:**` line and one code-span path from a scratch copy — and it
reported `why_line` 16 → 15 and `citation_path` 10 → 9, so it is shown to fire HERE;
the falsifying result was available and did not occur.

Result, base `c0d98bb9` → working tree: `must_clause` 5→5, `must_token` 41→41,
`must_not_token` 5→5, `blocked_token` 11→11, `why_line` 16→16, each of the eight
`wiring:<Field>` labels 1→1, and all 18 citation members (10 `citation_path`,
4 `citation_anchor`, 4 `citation_file`) still present. Rule body 19,766 B → 17,919 B,
a 1,847 B reduction.

The destination matters and is stated rather than assumed: `guides/rule-extracts/**`
is NOT an injected move destination under
`check-descoping.mjs::isInjectedMoveDestination`, which credits a relocation only
into `.claude/rules/**` or `.claude/skills/**`. A tripwire moved rule → guide would
therefore be a REMOVAL with a forwarding address, not an extraction. That is why
this pass moved NO normative token at all and confined itself to prose carrying
none — the census above is what makes the claim checkable.

**Stale figure corrected, not carried.** The rule body's length rationale and this
file's § "Rule-Body Length Rationale" both said the body holds TWELVE numbered
clauses. Re-derived from the body's own `###`/`####` headings on 2026-09-15 it holds
THIRTEEN — the enumeration omitted **1a** (Library-Class Artifacts). The extract's
enumeration is corrected in place; the RULE's figure was DELETED rather than
re-stated, replaced by an instruction to count the headings, because a remembered
total is what went stale in the first place.

`rule-authoring.md` Rule 10 and Rule 11 do NOT fire, on the disposition both prior
records state: Rule 10 § "Trigger scope" limits the proximity-band gate to
`priority: 0` + `scope: baseline` rules, and this rule is `priority: 10` +
`scope: path-scoped`.
