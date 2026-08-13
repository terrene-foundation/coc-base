---
id: "ORPHAN-DETECTION"
paths: ["packages/**", "src/**", "**/tests/**"]
---

# Orphan Detection Rules

A class that no production code calls is a lie. Beautifully implemented orphans accumulate when a feature is built top-down — model + facade + accessor ship, downstream consumers import them — but the framework's hot path never invokes them. Unit tests pass against the orphan in isolation; the security/audit/governance promise the orphan was supposed to deliver never executes once.

Detection playbooks and historical post-mortems live in `skills/16-validation-patterns/orphan-audit-playbook.md`; the FULL worked DO/DO-NOT code per clause, the evidence chains, and the per-rule origin narratives live in `guides/rule-extracts/orphan-detection.md`. This file holds the load-bearing MUST clauses, their `**Why:**` lines, and their BLOCKED corpora.

## MUST Rules

### 1. Every `db.*` / `app.*` Facade Has a Production Call Site

Any attribute exposed on a public surface that returns a `*Manager`, `*Executor`, `*Store`, `*Registry`, `*Engine`, or `*Service` MUST have at least one call site inside the framework's production hot path within 5 commits of the facade landing. The call site MUST live in the same package as the framework, not just in tests or downstream consumers.

```text
# DO — `db.trust_executor` facade + a real `check_read_access(...)` call site in the framework's hot path (DataFlowExpress.list), same PR
# DO NOT — facade property ships alone; no hot-path call site exists, so the trust executor is dead code downstream consumers still import
```

**Why:** Downstream consumers see the public attribute, build their security model around the documented behavior, and ship features that silently bypass the protection because the framework never invokes the class on the actual data path. Full code + the Phase 5.11 post-mortem (2,407 LOC of trust integration never executed once): `guides/rule-extracts/orphan-detection.md` § "Rule 1".

#### 1a. Library-Class Artifacts — The Public Export Surface IS The Hot Path

Rule 1 assumes an APPLICATION-FRAMEWORK shape, where the hot path is INTERNAL and a facade with no in-framework call site is dead. For a LIBRARY-class artifact — a component library, parser, or utility package consumed BY PACKAGE NAME from outside its own tree — there is no internal call site to find, because the consumer IS the call site. Running the Rule-1 audit unmodified there does not find orphans; it manufactures false positives against the wrong surface. Before auditing, CLASSIFY the artifact, then audit the surface that class actually has:

- **Application framework** — orphan = no internal call site in the framework's hot path within 5 commits (Rule 1 as written).
- **Library** — orphan = the symbol is absent from the public entry point (`src/index.ts`, `lib.rs` `pub use`, `__init__.py` `__all__`) OR no Tier 2 / wiring test imports it THROUGH the public package name within 5 commits.

Exported but never imported through the package name is a **HIGH** finding — reachable, unverified. Imported by tests but absent from the public entry is a **MED** finding — verified, unreachable to consumers.

```text
# DO — classify first: public entry exists + package consumed by name → library; audit the export surface
# DO NOT — report a library's exported symbol as an orphan because no internal caller exists (by design, there is none)
```

**BLOCKED rationalizations:** "the rule is the rule, no carve-outs" / "library context is just a special case of the application framework" / "the agent can infer the class from the repo type" / "downstream consumers are out-of-repo, so they cannot be audited anyway" (the audit is of the ENTRY POINT and the wiring tests, both in-repo).

**Why:** A rule applied to the surface it was not written for returns confident false positives, and the cost is not merely noise — an audit that reliably cries wolf on a whole artifact class gets disabled for that class, taking the real orphan check with it. Classifying first is what gives BOTH classes a check that can actually fail.

### 2. Every Wired Manager Has a Tier 2 Integration Test

Once a manager is wired into the production hot path, its end-to-end behavior MUST be exercised by at least one Tier 2 integration test (real database, real adapter — `rules/testing.md` § Tier 2). Unit tests against the manager class in isolation are NOT sufficient.

```text
# DO — `@pytest.mark.integration` test drives the REAL facade (`db.express.list("Document")`) against a real DB and asserts the redaction is observable
# DO NOT — Tier 1 test constructing `TrustAwareQueryExecutor(...)` directly; proves the executor CAN redact, not that the framework CALLS it
```

**Why:** Unit tests prove the orphan implements its API. Integration tests prove the framework actually calls the orphan. Full code: `guides/rule-extracts/orphan-detection.md` § "Rule 2".

#### 2a. Crypto-Pair Round-Trip Through Facade

Paired crypto operations (`encrypt`/`decrypt`, `sign`/`verify`, `seal`/`unseal`) MUST have a Tier 2 test that round-trips through the facade: call one half, feed its output to the other, assert equality. Isolated unit tests per half can drift silently (e.g. encrypt uses GCM while decrypt uses CBC) with both passing. See `skills/16-validation-patterns/orphan-audit-playbook.md` § 2a for the full failure pattern.

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

**Why:** Test files that fail at collection block the ENTIRE suite, not just themselves. One orphan import takes down the 100 tests collected after it. Origin + full example: `guides/rule-extracts/orphan-detection.md` § "Rule 4".

### 4a. Stub Implementation MUST Sweep Deferral Tests In Same Commit

Mirror of Rule 4. Any PR that _implements_ a previously-deferred stub — replacing `NotImplementedError` / `raise NotImplementedError("Phase N — will implement")` with a real implementation — MUST delete or rewrite every test that asserts the deferred behavior in the same commit. Scaffold-era tests like `test_foo_deferral_names_phase` that `pytest.raises(NotImplementedError)` on the now-implemented symbol flip from pass to fail and block release CI.

```text
# DO — one commit lands the real impl AND deletes/rewrites the `pytest.raises(NotImplementedError)` deferral test, adding real coverage
# DO NOT — land the impl only; the deferral test still asserts the raise and CI fails "DID NOT RAISE" on every matrix job
```

**BLOCKED rationalizations:**

- "The deferral test was a scaffold; CI will surface it and we'll fix it then"
- "I'll clean up the scaffold tests in a follow-up"
- "The Phase N naming means the test self-documents as obsolete"

**Why:** CI-late discovery blocks the release PR's matrix run at the worst possible moment. A `grep -rln 'NotImplementedError.*<symbol>' tests/` at implementation time catches it in O(seconds); a CI re-run costs O(minutes) plus an extra reviewer cycle. Full example + Origin: `guides/rule-extracts/orphan-detection.md` § "Rule 4a"; the 5-matrix-job CI failure: `skills/16-validation-patterns/orphan-audit-playbook.md` § 4a.

### 4c. Default/Behavior Change MUST Sweep Stale-Assertion Tests In Same PR — Including Out-Of-CI-Matrix Tests

Sibling of Rule 4a, generalizing "sweep the paired tests in the same commit" from stub-implementation (4a) to ANY default or behavior change (a model default, a config default, a threshold, a resolved value), PLUS the load-bearing "CI-green is NOT full-suite-green" insight: CI matrices routinely EXCLUDE example tests, optional-dependency-gated tests, and ambient-`.env`-dependent tests, so a default change can be FULLY CI-green while N full-suite tests still assert the OLD value. Any PR that changes a default/behavior MUST grep the ENTIRE test corpus (not just the CI-selected subset) for assertions pinning the old value and update them in the SAME PR.

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

**Why:** A default/behavior change silently invalidates every test that pinned the old value, and the CI matrix's exclusions (examples, optional-dep-gated, ambient-`.env`) mean "CI green" is NOT "full-suite green" — so the stragglers surface at release prep, a separate PR and a separate cycle. The full-corpus grep at change time is O(seconds); the deferred discovery is O(minutes) plus a reviewer cycle. Full example + evidence: `guides/rule-extracts/orphan-detection.md` § "Rule 4c".

**Trust Posture Wiring (Rule 4c):**

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + release-specialist at `/release` confirm the ENTIRE test corpus — including CI-excluded example / optional-dep-gated / ambient-`.env` tests — was swept for stale old-value assertions in the same PR); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (a full-corpus-sweep property is judgment-bearing over cross-file state, not a structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-20 → 2026-07-27).
- **Cumulative posture impact:** same-class violations (a default/behavior change that left stale old-value assertions in out-of-CI-matrix tests) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key (a test-sweep completeness property is review-layer-only, and minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — same disposition as `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge.
- **Receipt requirement:** SessionStart soft-gate `[ack: orphan-detection]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any diff changing a default/behavior, reviewer at `/implement` + release-specialist at `/release` run `grep -rln '<old-value>' tests/ examples/ packages/*/tests/` across the FULL corpus (not the CI-selected subset) and confirm zero stale old-value assertions remain. Probes `.claude/test-harness/probes/orphan-detection.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/orphan-default-change-sweep/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 4c (default/behavior-change stale-assertion sweep, including out-of-CI-matrix tests) ONLY; Rules 1–4a / 5–6b stay grandfathered until each is itself `/codify`-touched.
- **Origin:** kailash-py PR #1847 (#1844/#1845 cost fix, 2026-07-20) — model-default change was fully CI-green while 18 out-of-CI-matrix test files still asserted the old defaults, caught only at release prep (PR #1850). Landed at loom via `/sync-from-build` Gate-1 classification. Full narrative: `guides/rule-extracts/orphan-detection.md` § "Rule 4c → Origin".

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

**Why:** `python-environment.md` Rule 4 blocks sub-package test deps from root `[dev]` because plugins like `hypothesis` register as pytest plugins and trigger `MemoryError` during AST rewrite. Per-package collection granularity matches dep-graph granularity. Origin + detail: `guides/rule-extracts/orphan-detection.md` § "Rule 5a".

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

**Why:** `__all__` is the package's public-API contract: Sphinx autodoc, linters, `mypy --strict`, and `from pkg import *` all read it as the canonical export list. A symbol that's eagerly imported but absent is both advertised (via import) AND hidden (via `__all__`) — the exact inconsistency the orphan pattern produces. Full code + Origin (PR #523 / #529, 2026-04-19): `guides/rule-extracts/orphan-detection.md` § "Rule 6".

#### 6b. TYPE_CHECKING Block For Lazy `__getattr__` Exports

Packages that lazy-load heavy optional deps (torch, vllm, catboost) via `__getattr__` MUST still expose those symbols to static analysis (CodeQL `py/undefined-export`, pyright, mypy `--strict`, Sphinx autodoc) via a `TYPE_CHECKING` block. Eager-importing the heavy deps defeats the lazy design; removing them from `__all__` breaks `from pkg import *`. The `TYPE_CHECKING` pattern is the single reconciliation.

```text
# DO — `if TYPE_CHECKING: from pkg.torch_utils import TorchTrainer` (analyzer-only) alongside the lazy `__getattr__` runtime import; `__all__` entry then resolves for CodeQL/pyright/Sphinx
# DO NOT — list the symbol in `__all__` with only a `__getattr__` resolution; CodeQL `py/undefined-export` flags it as undefined at module scope
```

**BLOCKED rationalizations:** "CodeQL is noisy, suppress the finding" / "static analyzers will catch up eventually" / "eager-importing is fine, users have torch installed anyway" / "we can drop the lazy path".

**Why:** A `__getattr__`-resolved entry in `__all__` is both advertised (Sphinx autodoc reads `__all__`) AND unverifiable (no module-scope binding), so static analyzers flag it undefined and `from pkg import *` raises `ImportError` when the heavy dep is absent. The `TYPE_CHECKING` block satisfies both contracts without dragging the dep into the hot import path. Full code + Origin (commit `7943b3a1`, 17 `py/undefined-export` findings closed): `guides/rule-extracts/orphan-detection.md` § "Rule 6b".

### 6a. Merge-Time `__all__` Reconciliation Across Shard Base-SHAs

When two or more parallel-worktree shards each edit the same package's `__init__.py::__all__` AND the shards were branched from DIFFERENT base SHAs (see `rules/worktree-isolation.md` §5), the orchestrator MUST reconcile `__all__` at merge time using this protocol:

1. **Prefer HEAD (newest canonical structure).** The later-merged shard's `__all__` ordering + group-comment layout is canonical.
2. **Preserve invariants from the older base.** Enumerate any symbols / counts / semantic groups the older-base shard depended on (e.g. "7 Phase-1 Trainable adapters MUST be exported") and verify they survive the reconciliation.
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

**Why:** Parallel shards from different base SHAs each advance the `__all__` public-API contract independently, and git's 3-way merge picks one side arbitrarily — so the newer shard's canonical structure silently wipes the older shard's added exports, orphaning production symbols downstream consumers import. The count-dependent tests are the structural defense: they fail loudly when `len(__all__)` shifts unexpectedly. Full example + evidence chain + Origin (kailash-ml-audit 2026-04-23 W31/W33 merge, fix commit `fa300831`): `guides/rule-extracts/orphan-detection.md` § "Rule 6a".

## MUST NOT

- Land a `db.X` / `app.X` facade without the production call site in the same PR

**Why:** The PR review is the only structural gate that catches orphans before they ship.

- Skip the consumer check on grounds that "downstream consumers will use it"

**Why:** Downstream consumers using a class is NOT the same as the framework using it. The framework's hot path is the security boundary.

- Mark a wired manager as "fully tested" based on Tier 1 unit tests alone

**Why:** Tier 1 mocks the framework's call into the manager. The orphan failure mode is precisely "the framework never calls the manager in production" — Tier 1 cannot detect that.

## Detection Protocol

The 6-step `/redteam` audit procedure (six detection steps + disposition) lives in `skills/16-validation-patterns/orphan-audit-playbook.md` § "Detection Protocol". Runs as part of `/redteam` and `/codify`.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is 215 lines, exceeding the 200-line guidance by 15 (down from 312 at the #1392 trim). Named rationale: **orphan-surface scope** — twelve numbered clauses (1, 2/2a, 3, 4/4a/4c, 5/5a, 6/6a/6b; the 4b slot holds the extracted Error-Contract Refactor clause, `orphan-audit-playbook.md` §4b), each guarding a DISTINCT orphan-emergence path a `/redteam` orphan audit MUST hold simultaneously, plus the post-cutoff clause-scoped Trust-Posture Wiring (Rule 4c) that `trust-posture.md` MUST-8 requires in the rule body. All worked code, evidence chains, and origin narratives are EXTRACTED to `guides/rule-extracts/orphan-detection.md` + `skills/16-validation-patterns/orphan-audit-playbook.md`. `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and `rule-authoring.md` Rule 10's proximity-band gate does NOT fire. Sibling precedent: `tenant-isolation.md` + `cross-sdk-inspection.md`.
