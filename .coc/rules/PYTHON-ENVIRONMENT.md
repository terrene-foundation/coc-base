---
id: "PYTHON-ENVIRONMENT"
paths: ["**/*.py", "pyproject.toml", "conftest.py", "tests/**"]
---

# Python Environment Rules

See `.claude/guides/rule-extracts/python-environment.md` for extended command examples, BLOCKED rationalization lists, and full post-mortem rationale.

Every Python project MUST use `.venv` at the project root, managed by `uv`. Global Python is BLOCKED.

**Why:** Global Python causes dependency conflicts between projects and makes builds non-reproducible across machines.

## Setup

```bash
uv venv          # Create .venv
uv sync          # Install from pyproject.toml + uv.lock
```

## Running

```bash
# Preferred — uv run
uv run pytest tests/ -x

# Or activate
source .venv/bin/activate
pytest tests/ -x
```

## Verification

```bash
which python   # MUST show .venv/bin/python, NOT /usr/bin/python
which pytest   # MUST show .venv/bin/pytest
```

## MUST Rules

### 1. MUST Address the Venv Interpreter Explicitly

Every invocation MUST resolve through `.venv/bin/python` (explicit), `uv run` (resolves via `pyproject.toml`), or an activated shell. Bare `python` / `python3` / `python3.13` / `pytest` is BLOCKED — pyenv, asdf, and Homebrew all install shims that can resolve to a different interpreter than the project `.venv`.

```bash
# DO
.venv/bin/python -m pytest tests/
uv run pytest tests/
source .venv/bin/activate && pytest tests/

# DO NOT
python -m pytest tests/           # which python? unknown
python3 -m pytest tests/          # pyenv shim — may not be .venv
pytest tests/                     # same — whose pytest?
```

**BLOCKED rationalizations:** "It's fine, `which python` showed the venv earlier" / "The shim points at the right version most of the time" / "CI uses `python3`, so the test command should match".

**Why:** The pyenv/asdf shim is the #1 cause of "I edited the file but tests don't see the change" debugging sessions. An installed package that conflicts with your source resolves silently against the wrong code and tests "pass" without exercising the edit. Explicit `.venv/bin/python` turns silent correctness bugs into loud `No such file or directory` errors.

### 2. Monorepo Sub-Packages MUST Be Installed Editable

When a repo contains `packages/*/pyproject.toml`, every sub-package MUST be installed editable into the root `.venv` at setup time. A `PYTHONPATH=packages/foo/src:packages/bar/src ...` prefix as a workaround is BLOCKED.

```bash
# DO — one-time setup
uv pip install \
  -e packages/kailash-dataflow \
  -e packages/kailash-nexus \
  -e packages/kailash-kaizen

# DO NOT — PYTHONPATH prefix workaround
PYTHONPATH=the dataflow package directory src:the nexus package directory src \
  .venv/bin/python -m pytest tests/
```

**BLOCKED rationalizations:** "PYTHONPATH works for this one command" / "I'll add the editable install later" / "The sub-package has its own pytest config anyway".

**Why:** Editable installs make the sub-package `src/` the canonical import path, so editors, type checkers, test runners, and scripts all agree on which code runs. A `PYTHONPATH` prefix is invisible to every tool except the single command that sets it.

### 3. Monorepo `[tool.uv.sources]` Over PyPI Version Pin

Root `pyproject.toml` constraints on monorepo sub-packages MUST be expressed as a `[tool.uv.sources]` editable path entry, NOT as a PyPI version pin. Version pins on sub-packages that are also installed editable are BLOCKED.

```toml
# DO — editable path entry in root pyproject.toml
[tool.uv.sources]
kailash-dataflow = { path = "packages/kailash-dataflow", editable = true }

# DO NOT — PyPI version pin on a sub-package you're editing locally
[project]
dependencies = [
    "kailash-dataflow>=2.0.3",   # uv sync downloads stale PyPI tarball
]
```

**BLOCKED rationalizations:** "The PyPI pin ensures minimum version compatibility" / "Editable installs are only for dev, CI uses the pin" / "The version pin and local source happen to match".

**Why:** A PyPI version pin on a sub-package the developer is editing forces `uv sync` to download a stale tarball, masking the editable changes. Recurring monorepo bootstrap pain.

Origin: a BUILD-repo upstream-fixes session (2026-04-12).

### 4. MUST NOT Duplicate Sub-Package Test Deps In Root Dev Deps

A dev dependency declared by a sub-package (`packages/*/pyproject.toml`) MUST NOT also be declared in the root `pyproject.toml [dev]` section. Re-declaring at the root is BLOCKED — it installs the package into the root test venv where pytest's plugin auto-discovery loads it for every test run, including runs that don't need it.

```toml
# DO — sub-packages own their test deps
# the pact package directory pyproject.toml:
[project.optional-dependencies]
test = ["hypothesis>=6.98"]
# root pyproject.toml [dev]: (no hypothesis entry)

# DO NOT — duplicate at root
[project.optional-dependencies]
dev = ["hypothesis>=6.0.0"]  # already in kailash-pact + kailash-ml
```

**BLOCKED rationalizations:** "The version is different, it's not a duplicate" / "hypothesis is small, it won't hurt to install at root" / "Our test command might need it someday" / "The sub-package pin is for test-time only, this one is for dev-time".

**Why:** `hypothesis` registers as a pytest plugin; pytest's assertion rewriter AST-rewrites `hypothesis.internal.conjecture.shrinking.collection` and exhausts memory on GitHub runners, producing `MemoryError` during collection with no root-cause signal. Root venvs MUST NOT install what only sub-package test venvs need.

Origin: PR #430 CI failure (2026-04-12), commit a9fd4e56. See guide for the full post-mortem.

### 5. Python 3.11+ Lock Factory Gotcha (MUST)

`threading.Lock` and `threading.RLock` are factory functions — NOT classes — in Python 3.11+. Using them as `isinstance` predicates raises `TypeError: isinstance() arg 2 must be a type, a tuple of types, or a union` at runtime. Code that passed 3.10 silently blocks every call on 3.11+.

To runtime-check lock types, capture the actual type by calling the factory once at module scope and use that constant:

```python
# DO — module-scope type constants via one factory call each
import threading
_LOCK_TYPES = (type(threading.Lock()), type(threading.RLock()))

def is_lock(obj: object) -> bool:
    return isinstance(obj, _LOCK_TYPES)

# DO NOT — isinstance against the factory itself (Py3.11+ TypeError)
if isinstance(lock, threading.Lock):  # TypeError at runtime
    ...
```

**BLOCKED rationalizations:** "`isinstance(x, threading.Lock)` worked on 3.10" / "we'll pin to 3.10 for now" / "the CI matrix will catch it" / "the factory is close enough to a type, Python will DWIM".

**Why:** Python 3.11 converted `Lock`/`RLock` to factory functions for CPython internal reasons; the names are callable but not types. `isinstance()` arg 2 MUST be a type — the factory fails the check. Pinning to 3.10 is a rotting workaround (3.10 reaches EOL October 2026); the factory form will stay on 3.11+. The one-line module-scope constant is the structural fix.

Origin: kailash-pact 0.10.0 release cycle (2026-04-23) — `pact/ml/__init__.py:412` used `isinstance(lock, threading.Lock)` which blocked all 5 PACT ML bridge integration tests on Python 3.11+. Fixed at commit `5655dd59`.

## Rules

- `.venv/` MUST be in `.gitignore` — **Why:** Committed `.venv/` bloats the repo with platform-specific binaries.
- `uv.lock` MUST be committed for applications — **Why:** Without a lockfile, different machines resolve different versions.
- One project, one `.venv` (no `.env`, `venv`, `.virtualenv` alternatives) — **Why:** Non-standard names are invisible to IDEs / CI / `uv run`.
- No `pip install` in project context — use `uv sync` or `uv pip install` — **Why:** `pip install` bypasses `uv.lock`, creating invisible drift.
- No global/system/Homebrew/pyenv-global Python — **Why:** System packages leak into project imports, masking missing deps.
- No bare `python` / `python3` / `pytest` — always `.venv/bin/python` or `uv run` — **Why:** See MUST Rule 1.

Origin: a BUILD-repo upstream-fixes session § "Traps / gotchas" (2026-04-11). See guide for extended rationale.
