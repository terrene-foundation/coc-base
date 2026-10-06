---
id: "ORPHAN-DETECTION"
paths: ["packages/**", "src/**", "**/tests/**", "crates/**", "**/src/**"]
---

# Orphan Detection Rules

A class that no production code calls is a lie. This file holds the load-bearing MUST clauses, their `**Why:**` lines and their BLOCKED corpora.

Depth — worked code, evidence, measured narratives, per-clause Origin, and how orphans accumulate while isolated unit tests stay green over them — lives in `guides/rule-extracts/orphan-detection.md` (the **extract**), under one heading per clause: grep the clause number (`§ "Rule 4c — …"`, `§ "Rule 6b — …"`). No clause carries its own tail (consolidated here 2026-09-15). Playbooks + post-mortems: `skills/16-validation-patterns/orphan-audit-playbook.md`.

## MUST Rules

### 1. Every `db.*` / `app.*` Facade Has a Production Call Site

Any attribute exposed on a public surface that returns a `*Manager`, `*Executor`, `*Store`, `*Registry`, `*Engine`, or `*Service` MUST have at least one call site inside the framework's production hot path within 5 commits of the facade landing. The call site MUST live in the same package as the framework, not just in tests or downstream consumers.

```text
# DO — `db.trust_executor` facade + a real `check_read_access(...)` call site in the framework's hot path (DataFlowExpress.list), same PR
# DO NOT — facade property ships alone; no hot-path call site exists, so the trust executor is dead code downstream consumers still import
```

**Why:** Downstream consumers see the public attribute, build their security model around the documented behavior, and ship features that silently bypass the protection because the framework never invokes the class on the actual data path.

#### 1a. Library-Class Artifacts — The Public Export Surface IS The Hot Path

Before auditing, CLASSIFY the artifact, then audit the surface that class actually has:

- **Application framework** — orphan = no internal call site in the framework's hot path within 5 commits (Rule 1 as written).
- **Library** — orphan = the symbol is absent from the public entry point (`src/index.ts`, `lib.rs` `pub use`, `__init__.py` `__all__`) OR no Tier 2 / wiring test imports it THROUGH the public package name within 5 commits.

Exported but never imported through the package name is a **HIGH** finding — reachable, unverified. Imported by tests but absent from the public entry is a **MED** finding — verified, unreachable to consumers.

```text
# DO — classify first: public entry exists + package consumed by name → library; audit the export surface
# DO NOT — report a library's exported symbol as an orphan because no internal caller exists (by design, there is none)
```

**BLOCKED rationalizations:** "the rule is the rule, no carve-outs" / "library context is just a special case of the application framework" / "the agent can infer the class from the repo type" / "downstream consumers are out-of-repo, so they cannot be audited anyway" (the audit is of the ENTRY POINT and the wiring tests, both in-repo).

**Why:** A rule applied to the surface it was not written for returns confident false positives, and the cost is not merely noise — an audit that reliably cries wolf on a whole artifact class gets disabled for that class, taking the real orphan check with it.

### 2. Every Wired Manager Has a Tier 2 Integration Test

Once a manager is wired into the production hot path, its end-to-end behavior MUST be exercised by at least one Tier 2 integration test (real database, real adapter — `rules/testing.md` § Tier 2). Unit tests against the manager class in isolation are NOT sufficient.

```text
# DO — `@pytest.mark.integration` test drives the REAL facade (`db.express.list("Document")`) against a real DB and asserts the redaction is observable
# DO NOT — Tier 1 test constructing `TrustAwareQueryExecutor(...)` directly; proves the executor CAN redact, not that the framework CALLS it
```

**Why:** Unit tests prove the orphan implements its API. Integration tests prove the framework actually calls the orphan.

#### 2a. Crypto-Pair Round-Trip Through Facade

Paired crypto operations (`encrypt`/`decrypt`, `sign`/`verify`, `seal`/`unseal`) MUST have a Tier 2 test that round-trips through the facade: call one half, feed its output to the other, assert equality.

**Why:** Crypto pairs are the manager-pattern at a smaller scale — each half is a dependency of the other, invisible to isolated tests.

### 3. Removed = Deleted, Not Deprecated

If a manager is found to be an orphan and the team decides not to wire it, it MUST be deleted from the public surface in the same PR — not marked deprecated, not left behind a feature flag, not commented out.

**Why:** Deprecation banners are easy to miss; consumers continue importing the symbol and silently shipping insecure code. Deletion is the only signal that survives a `pip install kailash --upgrade`.

### 4. API Removal MUST Sweep Tests In The Same PR

Any PR that removes a public symbol MUST delete or port the tests that import it, in the same commit. Test files that reference the removed symbol fail at `pytest --collect-only` with `ModuleNotFoundError`, blocking every subsequent test run.

```text
# DO — one commit deletes BOTH `src/pkg/legacy_module.py` AND `tests/integration/test_legacy_module.py`
# DO NOT — delete only the module; the test still imports `pkg.legacy_module` and collection fails on the next run
```

**BLOCKED rationalizations:**

- "The tests will be cleaned up in a follow-up PR"
- "CI doesn't run those tests anyway"
- "The tests are obsolete; they don't need to move"
- "`pytest --collect-only` isn't part of CI"

**Why:** Test files that fail at collection block the ENTIRE suite, not just themselves. One orphan import takes down every test collected after it.

### 4a. Stub Implementation MUST Sweep Deferral Tests In Same Commit

Mirror of Rule 4. Any PR that _implements_ a previously-deferred stub — replacing a `raise NotImplementedError(...)` with a real implementation — MUST delete or rewrite every test that asserts the deferred behavior in the same commit.

```text
# DO — one commit lands the real impl AND deletes/rewrites the `pytest.raises(NotImplementedError)` deferral test, adding real coverage
# DO NOT — land the impl only; the deferral test still asserts the raise and CI fails "DID NOT RAISE" on every matrix job
```

**BLOCKED rationalizations:**

- "The deferral test was a scaffold; CI will surface it and we'll fix it then"
- "I'll clean up the scaffold tests in a follow-up"
- "The Phase N naming means the test self-documents as obsolete"

**Why:** CI-late discovery blocks the release PR's matrix run at the worst possible moment; a `grep -rln 'NotImplementedError.*<symbol>' tests/` at implementation time catches it in O(seconds) against a CI re-run's O(minutes) plus a reviewer cycle.

### 4c. Default/Behavior Change MUST Sweep Stale-Assertion Tests In Same PR — Including Out-Of-CI-Matrix Tests

Sibling of Rule 4a, generalizing sweep-in-the-same-commit to ANY default or behavior change, PLUS the load-bearing "CI-green is NOT full-suite-green" insight. Any PR that changes a default/behavior MUST grep the ENTIRE test corpus (not just the CI-selected subset) for assertions pinning the old value and update them in the SAME PR.

```text
# DO — change the default, then `grep -rln '<old-value>' tests/ examples/ packages/*/tests/` (ENTIRE corpus, not the CI subset) and update every stale assertion in THIS PR
# DO NOT — change the default and sweep only CI-selected tests; CI goes fully green while example / optional-dep-gated / ambient-.env tests still assert the old value
```

**BLOCKED rationalizations:**

- "CI is fully green, so the sweep is complete" (CI excludes example / optional-dep-gated / ambient-.env tests)
- "The old-value assertions are in tests CI never runs — they don't matter"
- "Release prep will catch the stragglers" (release prep is a separate PR + cycle; the sweep is O(seconds) now)
- "The default change is one line; the test sweep is scope creep"
- "The gated tests re-assert when someone installs the optional dep" (they red for whoever runs the full suite, unbounded)

**Why:** A default/behavior change silently invalidates every test that pinned the old value, and the CI matrix's exclusions (examples, optional-dep-gated, ambient-`.env`) mean "CI green" is NOT "full-suite green" — so the stragglers surface at release prep, a separate PR and a separate cycle.

**Trust Posture Wiring (Rule 4c).**

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + release-specialist at `/release` confirm the ENTIRE corpus — CI-excluded example / optional-dep-gated / ambient-`.env` tests included — was swept for stale old-value assertions in the same PR); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-07-20 → 2026-07-27).
- **Cumulative posture impact:** same-class violations (a default/behavior change leaving stale old-value assertions in out-of-CI-matrix tests) contribute per `trust-posture.md` MUST-4 (3×/5× in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: orphan-detection]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — on any default/behavior diff, reviewer at `/implement` + release-specialist at `/release` run the FULL-corpus stale-assertion grep; zero hits is the pass. **Probes: REGISTERED — `.claude/test-harness/probes/orphan-detection.probes.json`**, one bipolar `pair_id` pair per clause `check-clause-coverage.mjs::deriveClauses` returns (MUST-1, MUST-2, MUST-3, MUST-4, MUST-4a, MUST-4c, MUST-5, MUST-6, MUST-6a, MUST NOT) plus a meta pair — read the row/pair counts off the suite, never off this line; the MUST-4c pair is load-bearing. Fixtures `.claude/audit-fixtures/orphan-detection/`, registered in `eval-manifest.json`, pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; no workflow invokes `coc-probe-dispatch.mjs`, so registration buys dispatchability only. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; fixtures land with it at `.claude/audit-fixtures/orphan-default-change-sweep/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 4c (default/behavior-change stale-assertion sweep, incl. out-of-CI-matrix tests) ONLY; Rules 1–4a / 5–6b stay grandfathered until each is itself `/codify`-touched.
- **Origin:** kailash-py PR #1847 (#1844/#1845 cost fix, 2026-07-20); landed at loom via `/sync-from-build` Gate-1.

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

Rule 5 MUST NOT be interpreted as mandating a single combined root-venv invocation. The gate passes per-package after installing each sub-package's `[dev]` extras.

**BLOCKED rationalizations:**

- "A single invocation is faster for CI"
- "We'll duplicate the test deps in root [dev] just for collection"
- "Per-package collection is belt-and-suspenders"

**Why:** `python-environment.md` Rule 4 blocks sub-package test deps from root `[dev]` because plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity.

### 6. Module-Scope Public Imports Appear In `__all__`

When a symbol is imported at module-scope into a package's `__init__.py` (not behind `_` / not lazy via `__getattr__`), it MUST appear in that module's `__all__` list unless the symbol is private. New `__all__` entries MUST land in the same PR as the import. Eagerly-imported-but-absent-from-`__all__` is BLOCKED.

```text
# DO — every public module-scope import (`DeviceReport`, `device_report_from_backend_info`) also appears in that module's `__all__`
# DO NOT — eagerly import the public symbol but omit it from `__all__`; `from pkg import *` then drops the advertised public API
```

**BLOCKED rationalizations:**

- "The symbol is reachable via `pkg.X`, that's enough"
- "Nobody uses `from pkg import *`"
- "`__all__` is a convention, not a contract"

**Why:** `__all__` is the package's public-API contract: Sphinx autodoc, linters, `mypy --strict`, and `from pkg import *` all read it as the canonical export list. A symbol that's eagerly imported but absent is both advertised (via import) AND hidden (via `__all__`) — the exact inconsistency the orphan pattern produces.

#### 6b. TYPE_CHECKING Block For Lazy `__getattr__` Exports

Packages that lazy-load heavy optional deps (torch, vllm, catboost) via `__getattr__` MUST still expose those symbols to static analysis (CodeQL `py/undefined-export`, pyright, mypy `--strict`, Sphinx autodoc) via a `TYPE_CHECKING` block — the single reconciliation.

```text
# DO — `if TYPE_CHECKING: from pkg.torch_utils import TorchTrainer` (analyzer-only) alongside the lazy `__getattr__` runtime import; `__all__` entry then resolves for CodeQL/pyright/Sphinx
# DO NOT — list the symbol in `__all__` with only a `__getattr__` resolution; CodeQL `py/undefined-export` flags it as undefined at module scope
```

**BLOCKED rationalizations:** "CodeQL is noisy, suppress the finding" / "static analyzers will catch up eventually" / "eager-importing is fine, users have torch installed anyway" / "we can drop the lazy path".

**Why:** A `__getattr__`-resolved entry in `__all__` is both advertised (Sphinx autodoc reads `__all__`) AND unverifiable (no module-scope binding), so static analyzers flag it undefined and `from pkg import *` raises `ImportError` when the heavy dep is absent. The `TYPE_CHECKING` block satisfies both contracts without dragging the dep into the hot import path.

### 6a. Merge-Time `__all__` Reconciliation Across Shard Base-SHAs

When two or more parallel-worktree shards each edit the same package's `__init__.py::__all__` AND the shards were branched from DIFFERENT base SHAs (see `rules/worktree-isolation.md` §5), the orchestrator MUST reconcile `__all__` at merge time using this protocol:

1. **Prefer HEAD (newest canonical structure).** The later-merged shard's `__all__` ordering + group-comment layout is canonical.
2. **Preserve invariants from the older base.** Enumerate any symbols / counts / semantic groups the older-base shard depended on and verify they survive the reconciliation.
3. **Update count-dependent tests.** Tests that assert `len(__all__) == N` MUST be patched to reflect the reconciled count in the SAME commit as the reconciliation.
4. **Run the module-scope import check from §6.** Every newly-added entry MUST still have a matching eager import.

```text
# DO — adopt the later shard's canonical `__all__` structure AND re-add the older shard's invariant symbols, then fix the count-assertion test in the SAME commit
# DO NOT — take one shard's `__all__` wholesale; the other shard's added exports vanish and every downstream import of them breaks on the next install
```

**BLOCKED rationalizations:**

- "The merge conflict resolution picked one side; git knows best"
- "The missing adapters will surface in CI; we'll fix then"
- "Count-dependent tests are brittle; we should delete them"
- "HEAD always wins, older shard's invariants don't matter"
- "The reconciliation can happen in a follow-up PR"

**Why:** Parallel shards from different base SHAs each advance the `__all__` public-API contract independently, and git's 3-way merge picks one side arbitrarily — so the newer shard's canonical structure silently wipes the older shard's added exports, orphaning production symbols downstream consumers import. The count-dependent tests are the structural defense: they fail loudly when `len(__all__)` shifts unexpectedly.

## MUST NOT

- Land a `db.X` / `app.X` facade without the production call site in the same PR

**Why:** The PR review is the only structural gate that catches orphans before they ship.

- Skip the consumer check on grounds that "downstream consumers will use it"

**Why:** Downstream consumers using a class is NOT the same as the framework using it. The framework's hot path is the security boundary.

- Mark a wired manager as "fully tested" based on Tier 1 unit tests alone

**Why:** Tier 1 mocks the framework's call into the manager. The orphan failure mode is precisely "the framework never calls the manager in production" — Tier 1 cannot detect that.

## Detection Protocol

The 6-step audit procedure (six detection steps + disposition) lives in `orphan-audit-playbook.md` § "Detection Protocol". Runs as part of `/redteam` and `/codify`.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named: **orphan-surface scope** — every numbered clause above (count the `###`/`####` headings; do not carry a remembered total) guards a DISTINCT orphan-emergence path one audit MUST hold at once, plus the post-cutoff Rule-4c Wiring `trust-posture.md` MUST-8 requires in the body. `priority: 10` + `scope: path-scoped` ⇒ NO baseline-emission cost.

**Extraction record** — ZERO de-scoping across 2026-08-19, 2026-09-13 and 2026-09-15: every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**` line stayed here.
