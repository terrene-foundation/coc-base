# Dependency Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/dependencies.md`. Holds extended
examples, full rationale paragraphs, and the phantom-transitive
resolution protocol that would exceed the 200-line rule budget.

## Own the Stack — Full Replacement Protocol

When a dependency is unmaintained (no release in 12+ months, unresolved critical issues, archived repo) or constrains your architecture, re-implement it with full API parity. Do not work around a broken or stale package — own the code.

This applies equally to small utilities and large frameworks. If the reference package does X, your replacement MUST do X with identical behavior at the API surface.

**Why:** Unmaintained packages accumulate CVEs, break with new Python/Rust versions, and force the entire ecosystem to work around their bugs. Owning the implementation eliminates the external risk and gives you full control over the API surface, performance, and release cadence.

Process:

1. Identify the full API surface of the reference package that you (or your users) depend on
2. Re-implement with full parity — every public function, class, and behavior
3. Test against the reference package's own test suite where available
4. Provide a drop-in migration path (same import names or thin adapter)
5. Remove the old dependency

## Declared = Imported — Extended BLOCKED Patterns

Every `import X` / `from X import Y` / `use X` / `require('X')` in production code MUST resolve to a package explicitly listed in the project's dependency manifest. Transitive resolution through another package is NOT a declaration.

### Manifest entry + import in same commit

```python
# DO — import + manifest entry in the same commit
# pyproject.toml: dependencies = [..., "redis>=5.0"]
import redis

# DO NOT — import exists, manifest entry does not
import redis  # works locally because something else installed it; breaks in fresh venv
```

**Why:** Missing manifest entries are invisible on the developer's machine (where the package was installed transitively or manually) and only fail on fresh installs, CI, or production deploy. Every "works locally, breaks in CI" incident traces back to this.

### Dependency resolution errors are blocking

The following errors are the SAME class as pre-existing failures in `zero-tolerance.md` Rule 1 — they MUST be fixed immediately, not suppressed:

- `ModuleNotFoundError` / `ImportError` (Python)
- `cannot find crate` / `unresolved import` (Rust)
- `Cannot find module` / `Module not found` (JS/TS)
- Peer dependency warnings during `npm install` / `yarn install`
- `pip check` failures reporting unmet or conflicting requirements

### BLOCKED anti-patterns for hiding missing deps

```python
# Python — BLOCKED: dodging declaration with a silent fallback
try:
    import redis
except ImportError:
    redis = None  # silently degrades; production path never works

# Python — BLOCKED: hiding a missing module from the type checker
import redis  # type: ignore[import]
```

```typescript
// TypeScript — BLOCKED: suppressing module resolution
// @ts-ignore
import { something } from "missing-package";
```

**Why:** Each of these patterns converts a loud, fixable failure ("package not declared") into a silent, cascading one ("feature doesn't work and nobody knows why"). The `try/except ImportError` pattern is particularly dangerous because it makes the import "succeed" with `None`, pushing the failure to a runtime `AttributeError` deep in a code path that only runs in production.

### Exception: Optional Extras With Loud Failure

`try/except ImportError` IS allowed for packages declared as optional extras (`[project.optional-dependencies]`) IF the fallback raises a descriptive error at the call site naming the missing extra. Silent degradation to `None` is still BLOCKED.

```python
# DO — optional extra with loud, actionable failure
try:
    import redis
except ImportError:
    redis = None

def get_cache_client():
    if redis is None:
        raise ImportError("redis backend requires the [redis] extra: pip install kailash[redis]")
    return redis.Redis(...)

# DO NOT — silent None propagation
try:
    import redis
except ImportError:
    redis = None

def get_cache_client():
    return redis.Redis(...) if redis else None  # downstream gets None, fails with AttributeError
```

This exception aligns with `infrastructure-sql.md` Rule 8 (lazy driver imports). The principle: optional dependencies are fine; silent degradation is not.

### Verification step

Before `/redteam` and `/deploy`, run the project's dependency resolver as a verification step:

```bash
# Python — pip check catches unmet/conflicting requirements
pip check

# Node
npm ls --all 2>&1 | grep -iE "missing|warn|err"

# Rust
cargo check --quiet
```

Any unmet, missing, or conflicting dependency BLOCKS the gate.

## Phantom Transitive Deps — Full Resolution Protocol

When `pip check` reports a conflict whose root cause is a transitive package that no source file actually imports, the fix MUST be `uv lock --upgrade-package <phantom> <constrained_siblings>` followed by `uv sync` — which drops the unused dep and re-solves. Adding a local `<N` cap on a package this project does not directly import is BLOCKED (see § "No Caps on Transitive Dependencies" in the rule).

```bash
# DO — diagnose the phantom, upgrade, drop
$ uv pip check
The package `grpcio-status` requires protobuf<6.0.dev0, but 6.33.6 is installed
The package `google-ai-generativelanguage` requires protobuf<6.0.0.dev0, but 6.33.6 is installed

# Trace the source (no src/ imports google.generativeai → phantom):
$ grep -rln 'import google\.generativeai\|from google\.generativeai' src/ packages/ | head
# (empty)

$ uv lock --upgrade-package grpcio-status --upgrade-package google-ai-generativelanguage \
          --upgrade-package google-generativeai --upgrade-package protobuf
$ uv sync --extra dev  # or whichever extras you use
$ uv pip check
Checked 224 packages in 2ms. All installed packages are compatible

# DO NOT — pin the transitive locally
# pyproject.toml
dependencies = [
    ...,
    "protobuf>=5.26,<6.0",   # capping a package we don't import
]
```

**BLOCKED rationalizations:**

- "A local cap is faster than chasing the transitive tree"
- "Pinning protobuf keeps the tree stable"
- "We'll drop the cap once upstream catches up"
- "`uv lock --upgrade` is risky, could break other deps"

**Why:** A local cap on a package this project does not directly import is purely speculative — no code could break if it upgrades, and the cap just blocks every downstream user from getting patches. Phantom-transitive conflicts almost always resolve by dropping the phantom (`uv lock --upgrade` lets the solver drop installs with zero consumers). When upstream actually holds the constraint legitimately, the solver will report that — which is the signal to upgrade THAT package, not to local-cap the transitive. Evidence: PR #530 (2026-04-19) — `google-generativeai 0.8.6` installed but zero imports; `uv lock --upgrade-package` dropped it + two transitive orphans (`google-ai-generativelanguage`, `grpcio-status 1.71.2`); `pip check` became clean without a local cap.

Origin: PR #530 (2026-04-19) — phantom `google-generativeai` held protobuf solver at an old cap.
