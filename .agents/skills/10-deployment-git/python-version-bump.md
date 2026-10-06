# Python Version Bump Playbook

When CPython ships a new stable release (~yearly, October), declare support across the SDK in three steps. Verified end-to-end on the 3.13 → 3.14 bump (PR #474, 2026-04-15).

## Trigger

A new CPython minor version has been stable on python.org for at least one release patch (3.X.0 → 3.X.1). Earlier than that, ML stack wheels (torch, transformers) typically aren't published yet.

## The 3-Step Recipe

### 1. Add the classifier to every `pyproject.toml`

Edit the trove classifier list in **all 10** package manifests (root + 9 sub-packages). Append `Python :: 3.X` after the highest existing version.

```toml
classifiers = [
    "Programming Language :: Python :: 3.13",
    "Programming Language :: Python :: 3.14",   # <-- add this
]
```

Files (current as of 2026-04-15):

```
pyproject.toml
the dataflow package directory pyproject.toml
the nexus package directory pyproject.toml
the kaizen package directory pyproject.toml
the mcp package directory pyproject.toml
the pact package directory pyproject.toml
the trust package directory pyproject.toml
the kaizen-agents package directory pyproject.toml
the ml package directory pyproject.toml
the align package directory pyproject.toml
```

`requires-python = ">=3.11"` floor stays unchanged — we are widening declared support, not narrowing the minimum.

### 2. Add `"3.X"` to every per-version CI matrix

Four workflow files have `python-version` matrices that test multiple versions:

```
.github/workflows/unified-ci.yml          # core kailash matrix
.github/workflows/test-kailash-ml.yml     # ML stack matrix
.github/workflows/test-kailash-align.yml  # Align stack matrix
.github/workflows/trust-plane.yml         # trust plane × ubuntu/windows
```

Append `"3.X"` to each matrix array. **Do not** change single-version utility jobs (`publish-pypi.yml` builds wheels on 3.12 and that is correct — pure-Python wheels are forward-compatible).

### 3. Verify locally with `uv` BEFORE pushing

This catches missing wheels (especially in the ML stack) before CI burns time on it.

```bash
# Create a throwaway 3.X venv (uv auto-downloads the interpreter if needed)
uv venv --python 3.X /tmp/py3X-resolve

# Dry-run resolution per package — fails loudly if any wheel is missing for cp3X
for pkg in . packages/*/; do
  echo "=== $pkg ==="
  uv pip install --dry-run --python /tmp/py3X-resolve/bin/python "$pkg" 2>&1 | tail -3
done

# Confirm ML chain explicitly (highest-risk deps)
uv pip install --dry-run --python /tmp/py3X-resolve/bin/python packages/kailash-align \
  | grep -iE "^\s*\+ (torch|transformers|trl|accelerate|peft|datasets|polars|numpy|scikit-learn)"

# Optional: real install + smoke test of root kailash
uv pip install --python /tmp/py3X-resolve/bin/python .
/tmp/py3X-resolve/bin/python -c "import kailash; print(kailash.__version__)"

# Cleanup
rm -rf /tmp/py3X-resolve
```

If every package returns dependency lines (no `error:` or `No matching distribution`), 3.X is safe to declare.

## Common Gotchas

### Stale literal version assertions in test fixtures

Per-package version tests that hardcode the version string (e.g. `assert __version__ == "0.2.1"`) silently rot on every release bump and only surface when the matrix runs them. The 3.14 PR surfaced exactly this in the align package (`tests/test_package.py`) — the fixture had been red on `main` for two release bumps.

**Durable pattern** (no literal coupling to a specific version):

```python
import re

class TestVersion:
    _SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+")

    def test_version_accessible(self):
        from mypkg._version import __version__
        assert self._SEMVER_RE.match(__version__), __version__

    def test_version_from_package(self):
        import mypkg
        from mypkg._version import __version__ as canonical
        assert mypkg.__version__ == canonical  # cross-surface contract
```

**Why:** Asserting a literal couples the test to a moving target. Asserting the contract (PEP 440 format AND `mypkg.__version__ == _version.__version__`) survives every release bump and would have caught the original drift that caused the staleness.

### Wheel build version

`publish-pypi.yml` hard-codes `python-version: "3.12"` for the wheel build job. Leave it alone unless the build itself needs newer syntax — pure-Python wheels (`Requires-Python: >=3.11`) install cleanly on 3.13 and 3.14 regardless of the build interpreter.

### ML stack wheel lag

`torch`, `transformers`, `accelerate` typically publish cp3X wheels 3-6 months after CPython 3.X.0 stable. If Step 3 shows missing wheels for any of those, do not add 3.X to the `kailash-ml` / `kailash-align` matrices — wait for upstream. The other 8 packages can still ship 3.X support.

## Reference

PR #474 (2026-04-15) — first end-to-end execution of this recipe. Two commits:

- `44c00dc7` — classifier + matrix changes (15 files, +24 / -6)
- `bad6f505` — collateral fix for stale align version-test literal
