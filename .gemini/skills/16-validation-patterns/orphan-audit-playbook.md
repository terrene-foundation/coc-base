# Orphan Audit Playbook

Extended evidence, detection protocol, and historical post-mortems for `rules/orphan-detection.md`. The rule file holds the load-bearing MUST clauses; this playbook holds the narrative evidence, the full detection protocol, and per-rule origin histories that would otherwise bloat the rule past its 200-line cap.

## Phase 5.11 Post-Mortem — TrustAwareQueryExecutor

A class that no production code calls is a lie. Beautifully implemented orphans accumulate when a feature is built top-down — model + facade + accessor get checked in, the public API documents them, downstream consumers import them — but the wiring from the product's hot path to the new class never lands. The orphan keeps passing unit tests against itself, the product keeps shipping, and the security/audit/governance promise the orphan was supposed to deliver never executes once.

This is the failure mode the Phase 5.11 audit surfaced: 2,407 LOC of trust integration code (`TrustAwareQueryExecutor`, `DataFlowAuditStore`, `TenantTrustManager`) was instantiated and exposed as `db.trust_executor` / `db.audit_store` / `db.trust_manager`, downstream consumers imported the classes, and zero production code paths invoked any method on them. Operators believed the trust plane was running for an unknown period; it was not.

The rule file prevents this by requiring every facade-shaped class on a public API to have a verifiable consumer in the production hot path within a bounded number of commits.

## Detection Protocol

When auditing for orphans, run this protocol against every class exposed on the public surface. This protocol runs as part of `/redteam` and `/codify`.

1. **Surface scan** — list every property, method, and attribute on the framework's top-level class that returns a `*Manager` / `*Executor` / `*Store` / `*Registry` / `*Engine` / `*Service`.
2. **Hot-path grep** — for each candidate, grep the framework's source (NOT tests, NOT downstream consumers) for calls into the class's methods. Zero matches in the hot path = orphan.
3. **Bridge-shim verification** — for every match from step 2, verify the call site is NOT an isolating shim (`LegacyHandlerAdapter`, `CompatBridge`, `FacadeAdapter`). If every hot-path call site routes through a shim whose job is to translate back to the OLD pre-refactor surface, the new surface is still an orphan — it has zero un-bridged consumers. Shims are the most common way an orphan "looks wired" but isn't. A new trait can have dozens of Tier 1 test matches and a production call site whose only job is to translate inputs back to the old API; until the shim is removed, the new surface is never actually used. Evidence: a 2026-04 extractor refactor — hot-path grep alone found 6 call sites; bridge-shim verification reduced that to zero non-shim call sites, surfacing the orphan.
4. **Tier 2 grep** — for each non-orphan, grep `tests/integration/` and `tests/e2e/` for the class name. Zero matches = unverified wiring.
5. **Collect-only sweep** — run `.venv/bin/python -m pytest --collect-only tests/ packages/*/tests/`. Every `ERROR <path>` / `ModuleNotFoundError` / `ImportError` at collection is a test-orphan. Disposition: delete the orphan test file (if the API is gone) or port its imports (if the API moved).
6. **Disposition** — every orphan and every unverified wiring MUST be either fixed (wire + test) or deleted (remove from public surface).

## Evidence By Rule

### §1 — Every `db.*` / `app.*` Facade Has a Production Call Site

Phase 5.11 exemplar: `db.trust_executor`, `db.audit_store`, `db.trust_manager` shipped with property accessors and documentation but with zero call sites inside DataFlow's hot-path (`express.py`, `engine.py`). Four downstream workspaces imported the classes believing the trust plane was running. It was not. Fix shape: facade property + at least one `await self._db.trust_executor.check_read_access(...)` call in the hot path, landed in the same PR.

### §2 — Every Wired Manager Has a Tier 2 Integration Test

Unit tests prove the orphan implements its API (mock framework calls into the manager). Tier 2 tests prove the framework actually calls the manager against real infrastructure. The exact failure mode §1 prevents — "the framework never calls the manager in production" — is invisible to Tier 1 by construction.

### §2a — Crypto-Pair Round-Trip Through The Facade

Crypto pairs (`encrypt` / `decrypt`, `sign` / `verify`, `seal` / `unseal`, `wrap_key` / `unwrap_key`) are the manager-pattern at a smaller scale. If `encrypt()` is tested with `algo="AES-256-GCM"` in isolation and `decrypt()` is tested with `algo="AES-256-CBC"` in isolation, the pair drifts and both unit tests still pass because each test mocks the other half. The failure modes are identical to the Phase 5.11 orphan: each side works in isolation, the pair never round-trips in production, the security contract is silently broken. Tier 2 round-trip tests through the facade (`db.crypto.encrypt(x) → db.crypto.decrypt(...) == x`) are the only structural defense; no amount of Tier 1 coverage catches "encrypt uses GCM, decrypt uses CBC."

### §3 — Removed = Deleted, Not Deprecated

Deprecation banners are easy to miss. Consumers continue importing the symbol and silently shipping insecure code across a `pip install kailash --upgrade`. Deletion is the only signal that survives the upgrade.

### §4 — API Removal MUST Sweep Tests In The Same PR

Test files that fail at collection block the ENTIRE suite from running, not just themselves. One orphan test import takes down the 100 tests collected after it. Evidence: a 2026-04 cleanup deleted 9 orphan test files left behind by an earlier DataFlow refactor — integration collection had been failing since that refactor landed, but nobody noticed because the collection error was buried in the middle of a log.

### §4a — Stub Implementation MUST Sweep Deferral Tests In Same Commit

Origin: 2026-04-20 — a release CI surfaced the deferral-test orphan as a 5-job CI failure across the Python matrix; fixed in a follow-up commit on the release branch that deleted the scaffold `test_<symbol>_deferral_names_phase` test. The implementation-author is uniquely positioned to spot the paired deferral test — they know exactly which symbol they un-deferred. A simple `grep -rln 'NotImplementedError.*<symbol>\|<symbol>.*deferral' tests/` at implementation time catches it in O(seconds); a CI re-run costs O(minutes) plus an extra reviewer cycle. Compiled-language equivalent: scaffold-era tests that `#[should_panic]` on `todo!()` / `unimplemented!()` flip identically when the real implementation lands.

### §4b — Error-Contract Refactor MUST Sweep Paired Tests In Same Commit

Origin: 2026-04-20 dialect-safety sweep — a security-driven error-type refactor (`ValueError("Invalid table name")` → typed `IdentifierError`) shipped without sweeping the paired `pytest.raises` assertion; CI went red across the OS × Python-version matrix before the paired test was updated in a follow-up commit on the same PR. Error-contract refactors on non-stub APIs fail identically to Rule 4a's stub-un-deferral pattern — scaffold-era assertions matching the OLD type + message flip from green to red the moment the fix lands and block release CI across every matrix job. Compiled-language equivalent: `Result<_, OldError>` → `Result<_, NewError>` refactors break every `.unwrap_err()` / `assert_matches!(err, OldError::...)` site identically — `rg "OldError::"` is the structural companion to `pytest.raises(OldType`. This is the error-contract form of `rules/security.md` § "Multi-Site Kwarg Plumbing": grep every caller, patch every hit, same PR.

### §5 — Collect-Only Is A Merge Gate

Collection failures are invisible in "unit-only CI" setups yet become merge-blocking the moment someone runs the full suite locally. The only way to keep the full suite runnable is to gate every PR on collect-only-green.

### §5a — Collect-Only Gate Passes Per-Package, Not Combined Root Invocation

Origin: Session 2026-04-20 /redteam collection-gate work — combined `pytest --collect-only tests/ packages/*/tests/` from root venv failed with 3 distinct root causes; per-package iteration after installing `packages/<pkg>[dev]` succeeded for all 9 sub-packages. `python-environment.md` Rule 4 blocks sub-package test deps (specifically plugins like `hypothesis` that register globally) from root `[dev]` because they trigger `MemoryError` during AST rewrite on large monorepo suites. Per-package collection granularity matches dep-graph granularity: each sub-package's test contract is validated against its own `[dev]` extras, and the root venv carries only what root tests need. Combined invocation is an optimization, not a requirement; when it collides with Rule 4, per-package is the correct shape. Rust equivalent: workspace-level `cargo test -p <crate>` per-crate matches each crate's dev-dependencies rather than forcing every dev-dep into the workspace root.

### §6 — Module-Scope Public Imports Appear In `__all__`

Origin: 2026-04-19 — a release eagerly imported four new symbols but omitted all four from `__all__`; caught by post-release reviewer; patched in a follow-up. `__all__` is the package's public-API contract: documentation generators (Sphinx autodoc), linters, typing tools (`mypy --strict`), and `from pkg import *` consumers all read it as the canonical export list. A symbol that is "eagerly imported" but never listed is both advertised (via the import) AND hidden (via `__all__`) — that inconsistency is the exact failure shape the orphan pattern produces on the consumer side. The fix is a one-line addition in the same PR; deferring it means the advertised feature ships broken for every tool that respects `__all__`.

### §7 — Public-API Removal MUST Sweep Binding / Downstream Consumers

Consumer trees typically share the same lockfile (`Cargo.lock`, `uv.lock`, `package-lock.json`) and are always-built in matrix CI. A single unresolved import in one consumer blocks release of every sibling consumer. The grep is O(1) — seconds per tree — while a broken `main` costs hours of runner time per re-run cycle.

### §8 — Delete-or-Migrate Grep Is A Merge Gate

Origin: 2026-04-19 — a removal of `kailash-nexus::auth` re-exports passed `cargo check -p kailash-nexus` clean but had no cross-binding grep; Ruby + Python + Node CI all red on first run; 7-file follow-up commit required. Symmetric generalization of Rule 4 (test sweep) extended to every sibling consumer tree, not just `tests/`. A grep in the PR body is a commit-time claim that sweeping is complete. Without it, the reviewer has no shortcut to verify the sweep — every consumer tree must be hand-inspected, which routinely gets skipped on large PRs. The grep converts "I think I got them all" into a verifiable claim that survives review.
