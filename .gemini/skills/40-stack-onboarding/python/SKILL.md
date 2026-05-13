---
name: stack-onboarding-python
description: "Python stack onboarding — runner, package mgr, build, idioms. Use when STACK.md=python."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# Python Stack Onboarding (STARTER)

Per-stack reference for the base variant. Companion to `agents/onboarding/idiom-advisor.md` — this skill is the deeper reference; the advisor is the orienting card.

## Quick Reference

| Concern         | Recommendation                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| Test runner     | `pytest` (preferred) or `unittest` (stdlib)                                     |
| Package manager | `uv` (preferred for new) or `pip` (universal)                                   |
| Build tool      | `hatch build` (PEP 517) or `python -m build`                                    |
| Type checker    | `mypy --strict` or `pyright`                                                    |
| Linter          | `ruff check` (fast; replaces flake8 + isort + many pylint checks)               |
| Formatter       | `ruff format` (replaces black with same defaults)                               |
| Min Python      | 3.10+ for new projects (PEP 604 union syntax, `match` statement, type-hints UX) |

## Test Runner: pytest

### Invocation

```bash
pytest                                # all tests under cwd
pytest -xvs                           # stop on first fail; verbose; capture off
pytest tests/test_foo.py::TestClass   # single class
pytest -k "name_substring"            # name filter
pytest --collect-only -q              # inventory without running
pytest -n auto                        # parallel (requires pytest-xdist)
pytest --cov=src --cov-report=term    # coverage (requires pytest-cov)
```

### Fixtures + Parametrize

```python
import pytest

@pytest.fixture
def db_session():
    s = make_session()
    yield s
    s.close()

@pytest.mark.parametrize("inp,expected", [
    ("foo", 3),
    ("bar", 3),
    ("baz", 3),
])
def test_len(inp, expected):
    assert len(inp) == expected
```

### Markers + conftest

`conftest.py` is auto-discovered by pytest; put shared fixtures there. Custom markers go in `pyproject.toml::[tool.pytest.ini_options].markers`.

## Package Manager: uv (preferred) or pip

### uv (recommended for new projects)

```bash
uv venv                            # create .venv
uv pip install -e .                # editable install of current project
uv pip install pytest mypy ruff    # add deps
uv lock                            # write uv.lock
uv sync                            # install per uv.lock (reproducible)
```

### pip / pip-tools (legacy / universal)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e .
pip install pytest mypy ruff
pip freeze > requirements.txt      # NOT ideal — use pip-tools for proper locking
```

### pyproject.toml shape (PEP 621)

```toml
[project]
name = "myproject"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["httpx>=0.27", "pydantic>=2.0"]

[project.optional-dependencies]
dev = ["pytest>=8", "mypy>=1.10", "ruff>=0.5"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

## Build Tool: hatch (PEP 517) or python -m build

```bash
hatch build                        # builds sdist + wheel under dist/
python -m build                    # alternative; same outputs
twine upload dist/*                # publish to PyPI (after build)
```

## Type Checking: mypy --strict

```bash
mypy --strict src/
```

`--strict` enables: no untyped defs, no implicit Optional, warn on unused `# type: ignore`, etc. Pin versions; mypy releases occasionally tighten checks.

## Linting + Formatting: ruff

```bash
ruff check src/                    # lint
ruff check --fix src/              # autofix
ruff format src/                   # format (replaces black)
```

`pyproject.toml::[tool.ruff]` to configure rules.

## Common Pitfalls

1. **Mutable default arguments**: `def f(x=[])` — the list is shared across all calls. Use `def f(x=None): x = x or []`.
2. **Bare `except:`** — catches `KeyboardInterrupt` and `SystemExit`. Use `except Exception:` (and per `rules/zero-tolerance.md` Rule 3, NOT `except: pass`).
3. **Circular imports** — top-level imports run at module load. Move offending imports inside functions, or restructure to break the cycle.
4. **`from x import *`** — pollutes namespace, masks origin of names. Always explicit.
5. **`eval(user_input)`** / `exec(user_input)` — arbitrary code execution. Per `rules/security.md`, BLOCKED.
6. **Forgetting `__init__.py`** in non-namespace packages — leads to "module not found" surprises. Modern PEP 420 namespace packages mostly avoid this, but explicit `__init__.py` is still safer for libraries.
7. **String formatting in logging** — `logger.info(f"got {x}")` evaluates eagerly even when log level disables. Prefer `logger.info("got %s", x)`.

## Most-Used Patterns

### 1. Dataclasses for Value Types

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Point:
    x: float
    y: float
```

`frozen=True` makes instances hashable and prevents accidental mutation. `kw_only=True` (3.10+) enforces keyword-only construction.

### 2. Context Managers for Resources

```python
from contextlib import contextmanager

@contextmanager
def open_session():
    s = make_session()
    try:
        yield s
    finally:
        s.close()

with open_session() as s:
    s.query(...)
```

### 3. Generators for Streaming

```python
def read_lines(path):
    with open(path) as f:
        for line in f:
            yield line.rstrip()
```

Memory-efficient — no list materialization. Compose with `itertools.islice`, `map`, `filter`.

### 4. Type Hints + `from __future__ import annotations`

```python
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .other_module import OtherClass

def f(x: OtherClass) -> int: ...
```

Lazy evaluation of annotations; supports forward refs without quotes; reduces import overhead.

### 5. Pydantic for Input Validation (when not using stdlib dataclasses)

```python
from pydantic import BaseModel, Field

class CreateUser(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)
    name: str
    age: int = Field(..., ge=0, le=150)
```

Pydantic v2 is fast (Rust-backed) and has the best-in-class JSON-schema support.

## CO/COC Phase Mapping

- **`/analyze`** — `pytest --collect-only -q` to inventory tests; `mypy --strict` to surface type-graph issues; `ruff check` to flag lint violations across the surface.
- **`/todos`** — sharding by package (`src/<pkg>/`); each shard ≤500 LOC load-bearing logic per `rules/autonomous-execution.md`.
- **`/implement`** — `pytest -x` per shard (fail-fast); `mypy --strict` on the shard's package; commit cadence per `rules/git.md`.
- **`/redteam`** — mechanical sweep includes `mypy --strict`, `ruff check`, `pytest --collect-only -q` (zero-error exit), `pip check` (no version conflicts).
- **`/codify`** — proposal entries reference Python-specific patterns (e.g. "use `frozen=True` dataclass for X"); per `rules/agent-reasoning.md`, agent-routing logic stays LLM-first.
- **`/release`** — `hatch build`; verify `dist/*.whl` and `dist/*.tar.gz`; `twine check dist/*` before upload; `__version__` and `pyproject.toml::version` updated atomically per `rules/zero-tolerance.md` Rule 5.

## Related

- `agents/generic/db-specialist.md` — for Python DB drivers (psycopg, asyncpg, sqlalchemy)
- `agents/generic/api-specialist.md` — for Python HTTP frameworks (FastAPI, Flask, Django)
- `agents/generic/ai-specialist.md` — for Python LLM SDKs (openai, anthropic, litellm)

## Phase 2

Deepen with: async patterns (asyncio + aiohttp + asyncpg); packaging for distribution (sdist vs wheel; cross-platform wheels via cibuildwheel); profiling (`cProfile`, `py-spy`).

Origin: 2026-05-06 v2.21.0 base-variant Phase 1 STARTER.
