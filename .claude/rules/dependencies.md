---
priority: 10
scope: path-scoped
paths:
  - "pyproject.toml"
  - "Cargo.toml"
  - "package.json"
  - "**/*.py"
  - "**/*.rs"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# Dependency Rules

See `.claude/guides/rule-extracts/dependencies.md` for full-API replacement protocol, extended BLOCKED patterns, and phantom-transitive resolution protocol.

## Latest Versions Always

All dependencies MUST use the latest stable version. Do not pin to old versions out of caution.

**Why:** Defensive pinning creates a maintenance treadmill where every update requires manual cap-bumping, and the project silently falls behind on security patches, performance improvements, and API fixes.

```toml
# ✅ Uncapped or wide range
pydantic = ">=2.0"
polars = ">=1.0"

# ❌ Defensive caps
pydantic = ">=2.0,<3.0"
polars = ">=1.0,<1.5"
```

## No Caps on Transitive Dependencies

Do NOT add version constraints for packages your code does not directly import. If a package is only a transitive dependency (required by one of your direct dependencies), let the upstream package manage compatibility.

**Why:** Capping a transitive dependency you don't import is purely speculative — you have no code that could break. The upstream package already declares its own compatibility range. Your cap just blocks users from getting updates and creates resolution conflicts.

```toml
# ❌ datasets is used by trl and transformers, not by us
dependencies = ["trl>=0.12", "datasets>=3.0,<4.0"]

# ✅ Only constrain what you import
dependencies = ["trl>=0.12"]
```

**Test:** `grep -r "import datasets" src/` returns zero? Then `datasets` is not your dependency — remove it from `pyproject.toml`.

## Own the Stack — Replace or Re-Implement

If a dependency is unmaintained (no release in 12+ months, unresolved critical issues, archived repo) or constrains your architecture, re-implement it with full API parity. Do not work around a broken or stale package — own the code.

**Why:** Unmaintained packages accumulate CVEs, break with new Python/Rust versions, and force the entire ecosystem to work around their bugs. Owning the implementation eliminates the external risk. See guide for the 5-step full-replacement protocol.

## Minimum Version Floors Are Fine

Lower bounds (`>=X.Y`) are appropriate when your code uses features introduced in that version.

**Why:** A floor prevents users from hitting cryptic errors when they install an old version missing the API you call.

```toml
# ✅ We use pydantic v2 model_validator
pydantic = ">=2.0"

# ✅ We use polars LazyFrame.collect_async (added in 0.20)
polars = ">=0.20"
```

## MUST NOT

- Cap a dependency you do not directly import

**Why:** You cannot know when a transitive dependency will break your code because you have no code that uses it. The cap just blocks upgrades.

- Pin exact versions in library pyproject.toml (`==X.Y.Z`)

**Why:** Exact pins in libraries create resolution conflicts for every downstream user who has a different pin.

- Keep unmaintained dependencies — re-implement instead

**Why:** Every unmaintained dependency is a ticking time bomb that will eventually block a Python/Rust version upgrade or introduce a security vulnerability. If you can build it, own it.

- Work around a broken dependency instead of replacing it

**Why:** Workarounds create parallel implementations that diverge from the reference API, doubling maintenance cost and surprising users with behavior differences.

## Declared = Imported — No Silent Missing Dependencies

Every `import X` / `from X import Y` / `use X` / `require('X')` in production code MUST resolve to a package explicitly listed in the project's dependency manifest (`pyproject.toml`, `Cargo.toml`, `package.json`). Transitive resolution through another package is NOT a declaration.

### MUST: Add manifest entry in the same commit as the import

```python
# DO — import + manifest entry in the same commit
# pyproject.toml: dependencies = [..., "redis>=5.0"]
import redis

# DO NOT — import exists, manifest entry does not
import redis  # works locally; breaks in fresh venv
```

**Why:** Missing manifest entries are invisible on the developer's machine (transitive / manual install) and only fail on fresh installs, CI, or production deploy. Every "works locally, breaks in CI" incident traces back to this.

### MUST: Treat dependency resolution errors as blocking failures

`ModuleNotFoundError` / `ImportError` (Python), `cannot find crate` / `unresolved import` (Rust), `Cannot find module` (JS/TS), peer dependency warnings, `pip check` failures — ALL are the SAME class as pre-existing failures in `zero-tolerance.md` Rule 1 and MUST be fixed immediately, not suppressed.

### MUST: `__init__.py` Module-Scope Imports Honor The Manifest

Every unconditional `import X` / `from X import Y` at module scope in any package's `__init__.py` MUST resolve to a package declared in that package's own `pyproject.toml::dependencies`. Imports of co-installed but optional sibling packages (defensive proxy aliases, legacy `mock.patch` shims, integration surfaces that activate only when the sibling is present) MUST be wrapped in `try/except ImportError` AND any alias side-effects (`sys.modules.setdefault`, re-exports, attribute assignments) MUST live in the `else` branch.

```python
# DO — optional proxy aliases are guarded; clean install still imports
try:
    import kaizen_agents.patterns.patterns as _pp
    import kaizen_agents.patterns.patterns.blackboard as _bb
except ImportError:
    pass
else:
    sys.modules.setdefault("kaizen.orchestration.patterns", _pp)
    sys.modules.setdefault("kaizen.orchestration.patterns.blackboard", _bb)

# DO NOT — unconditional import of a non-declared sibling
import kaizen_agents.patterns.patterns as _pp  # ModuleNotFoundError on clean install
sys.modules.setdefault("kaizen.orchestration.patterns", _pp)
```

**BLOCKED rationalizations:**

- "Everyone in dev has the sibling editable-installed"
- "The proxy is defensive; a clean install will never hit it"
- "We declared kaizen-agents as an extra, that's enough"
- "The next CI run will catch it"
- "It's been in main for months without breaking"

**Why:** Editable installs in dev environments hide cross-package import dependency gaps that surface only on a clean PyPI install. An unconditional module-scope import of a NON-declared sibling raises `ModuleNotFoundError` at the FIRST `import <package>`, blocking every downstream consumer. The `try/except ImportError: pass` pattern is the OPPOSITE of the silent-fallback anti-pattern below — it has no later-use site that could break, and the `else`-branch alias-installation guarantees that when the sibling IS present, the proxy works exactly as before.

This rule is the structural defense that pairs with `build-repo-release-discipline.md` Rule 2 (clean-venv installability is the done gate). Rule 2 catches the failure; this rule prevents it.

Origin: kailash-kaizen 2.13.1 hotfix (commit `9002c002`, 2026-04-25). Four unconditional `kaizen_agents.patterns.*` imports in `kaizen/orchestration/__init__.py` (predating the structural-split refactor #75) raised `ModuleNotFoundError` on every clean `pip install kailash-kaizen` because `kaizen-agents` is not a declared dep. Caught by post-2.13.0 clean-venv check; fixed via `try/except ImportError`.

### BLOCKED Anti-Patterns

```python
# BLOCKED: silent fallback to None
try:
    import redis
except ImportError:
    redis = None  # degrades silently; production path never works

# BLOCKED: hiding a missing module
import redis  # type: ignore[import]
```

**Why:** Each pattern converts a loud, fixable failure into a silent, cascading one. The `try/except ImportError` pattern pushes failures to deep runtime `AttributeError`s that only surface in production. See guide for optional-extras exception (loud failure at call site is permitted).

### Verification step

Before `/redteam` and `/deploy`, run the project's dependency resolver:

```bash
pip check             # Python
npm ls --all 2>&1     # Node
cargo check --quiet   # Rust
```

Any unmet, missing, or conflicting dependency BLOCKS the gate.

### Phantom Transitive Deps — Resolve Via `uv lock --upgrade`, Not Local Caps

When `pip check` reports a conflict whose root cause is a transitive package that no source file actually imports, the fix MUST be `uv lock --upgrade-package <phantom> <constrained_siblings>` followed by `uv sync` — which drops the unused dep and re-solves. Adding a local `<N` cap on a package this project does not directly import is BLOCKED.

```bash
# DO — diagnose the phantom (no imports → drop it), upgrade, re-solve
$ grep -rln 'import google\.generativeai' src/ packages/  # empty
$ uv lock --upgrade-package google-generativeai --upgrade-package protobuf
$ uv sync && uv pip check  # clean

# DO NOT — pin the transitive locally in pyproject.toml
# dependencies = [..., "protobuf>=5.26,<6.0"]  # capping an un-imported package
```

**BLOCKED rationalizations:** "A local cap is faster than chasing the transitive tree" / "Pinning protobuf keeps the tree stable" / "We'll drop the cap once upstream catches up" / "`uv lock --upgrade` is risky, could break other deps".

**Why:** A local cap on an un-imported package is purely speculative — no code could break if it upgrades, and the cap just blocks every downstream user from getting patches. Phantom-transitive conflicts almost always resolve by dropping the phantom. When upstream legitimately holds the constraint, the solver will report that — the signal to upgrade THAT package, not to local-cap.

Origin: PR #530 (2026-04-19) — phantom `google-generativeai` held protobuf solver at an old cap. See guide for full evidence.
