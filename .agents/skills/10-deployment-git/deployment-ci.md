# CI/CD Infrastructure for Python SDK

> **IMPORTANT**: These are REFERENCE PATTERNS only. Do NOT automatically create `.github/workflows/` files.
> GitHub Actions minutes are a paid, finite resource. Always ask the user first and present
> cost implications before creating any workflow. See `/deploy` command's "CI/CD GitHub Actions"
> section for the required approval flow.

Patterns and principles for CI/CD pipelines. Covers GitHub Actions workflows, multi-platform wheel building, test matrices, documentation deployment, and release automation. Use these patterns as templates when the user explicitly requests CI/CD setup.

## GitHub Actions Workflow Patterns

### Test Workflow (on every push/PR)

```yaml
name: Tests
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    strategy:
      matrix:
        python-version: ["3.10", "3.11", "3.12"]
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Install dependencies
        run: pip install -e ".[dev]"
      - name: Lint
        run: ruff check . && ruff format --check .
      - name: Test
        run: pytest --tb=short
```

### Multi-Platform Wheel Build

For Rust-backed Python packages (using maturin):

```yaml
name: Build Wheels
on:
  push:
    tags: ["v*"]

jobs:
  build-wheels:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: ubuntu-latest
            target: aarch64-unknown-linux-gnu
          - os: macos-latest
            target: x86_64-apple-darwin
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Build wheels
        uses: PyO3/maturin-action@v1
        with:
          target: ${{ matrix.target }}
          args: --release --out dist
      - uses: actions/upload-artifact@v4
        with:
          name: wheels-${{ matrix.target }}
          path: dist/*.whl
```

For pure Python packages:

```yaml
build:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: "3.12"
    - run: pip install build
    - run: python -m build
    - uses: actions/upload-artifact@v4
      with:
        name: dist
        path: dist/
```

### Tag-Triggered Publishing

```yaml
name: Publish
on:
  push:
    tags: ["v*"]

jobs:
  # ... build jobs above ...

  publish-testpypi:
    needs: [build-wheels] # or [build] for pure Python
    runs-on: ubuntu-latest
    environment: testpypi
    permissions:
      id-token: write # for trusted publisher (OIDC)
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: wheels-*
          merge-multiple: true
          path: dist/
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          repository-url: https://test.pypi.org/legacy/

  publish-pypi:
    needs: [publish-testpypi]
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: wheels-*
          merge-multiple: true
          path: dist/
      - uses: pypa/gh-action-pypi-publish@release/v1

  github-release:
    needs: [publish-pypi]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - name: Create GitHub Release
        run: gh release create ${{ github.ref_name }} --generate-notes
        env:
          GH_TOKEN: ${{ github.token }}
```

## CI Efficiency Patterns

### Agent-Side CI Watching MUST NOT Tight-Poll The REST API (MUST)

When an agent watches a CI run to completion, it MUST use `gh run watch <run-id> --exit-status` (server-side long-poll: ONE REST call that blocks until the run finishes and sets the exit status) OR the harness `Monitor` primitive. A loop of `gh run view` / `gh run list` / `gh pr checks` is BLOCKED — each iteration is ONE authenticated **REST core** call, and a tight loop drains the entire 5000-requests/hour core quota in minutes, after which every `gh` core operation (including teammates' sessions) fails until the hourly reset. If `gh run watch` is genuinely unavailable, poll with `sleep 60` between checks — never sub-minute.

```bash
# DO — one long-poll call, blocks until done, exit status reflects success/failure
gh run watch "$RUN_ID" --exit-status

# DO — if you must poll, sleep ≥60s between checks
while :; do gh run view "$RUN_ID" --json status -q .status | grep -q completed && break; sleep 60; done

# DO NOT — tight-poll: drains core 5000/hr in minutes (observed 2026-05-31: core 0/5000)
while :; do gh run view "$RUN_ID"; done          # one REST core call PER iteration
gh pr checks "$PR" ; gh pr checks "$PR" ; ...     # repeated checks without watch
```

**BLOCKED rationalizations:** "I'll just poll `gh run view` every few seconds to see when it's done" / "polling is simpler than watch" / "the run-id isn't known yet" (`gh run watch` resolves the latest run, or accepts the run id from the push you just made) / "watch isn't available in this gh version" (it has shipped since gh 2.x; verify before falling back to sleep-60 polling) / "it's just one build, a few extra calls won't matter".

**Why:** `gh run view`/`gh run list`/`gh pr checks` each consume one REST **core** token; the authenticated bucket is 5000/hour and is SHARED across every `gh` core call the operator (and concurrent teammates) make. A tight watch-loop exhausts it in minutes — turning a non-blocker (watching a build) into an hour-long outage of all `gh` core operations. `gh run watch` long-polls server-side (one call, blocks), and `git push` + `gh pr create` (GraphQL) use separate buckets — so the correct primitive costs ~1 core call for an entire build watch. Origin: journal/0181 (2026-05-31) — release-specialist sub-agents tight-polled `gh run view` and exhausted core 0/5000.

### Every Workflow MUST Have

1. **Concurrency group** — prevents queue flooding on rapid pushes:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true
```

2. **`workflow_dispatch`** — allows manual triggering for debugging. Every workflow with path filters MUST also have `workflow_dispatch:` so it can be run manually when path filters would otherwise skip it.

3. **Path filtering** on `push`/`pull_request` — skip CI on irrelevant changes:

```yaml
on:
  push:
    branches: [feat/*, fix/*]
    paths:
      - "src/**"
      - "packages/**"
      - "tests/**"
      - "pyproject.toml"
      - "uv.lock"
  workflow_dispatch: # Always pair with path filters
```

### uv Dependency Caching

Add after `setup-uv` step. Saves ~3-4 minutes per matrix job:

```yaml
- name: Restore uv cache
  uses: actions/cache@v4
  with:
    path: |
      ~/.cache/uv
      .venv
    key: ${{ runner.os }}-uv-py${{ matrix.python-version }}-${{ hashFiles('pyproject.toml', 'uv.lock') }}
    restore-keys: |
      ${{ runner.os }}-uv-py${{ matrix.python-version }}-
```

### Matrix Version Alignment

Python versions in CI matrix MUST match `requires-python` in `pyproject.toml`. Do NOT test versions below the minimum:

```yaml
# pyproject.toml says requires-python = ">=3.11"
# DO:
matrix:
  python-version: ["3.11", "3.12", "3.13"]

# DO NOT:
matrix:
  python-version: ["3.8", "3.9", "3.10", "3.11"]  # Wastes 3x matrix jobs
```

### Avoid Heavy Downloads in Validation

Do NOT download large models/binaries (Ollama, Docker images) in syntax/import validation workflows. Only download when actually executing the code that needs them.

## Test Matrix Design

### Python Version Strategy

| Python Version | Support Level     | Notes                  |
| -------------- | ----------------- | ---------------------- |
| 3.10           | Minimum supported | Test on CI             |
| 3.11           | Supported         | Test on CI             |
| 3.12           | Primary / Latest  | Test on CI, build docs |
| 3.13+          | Future            | Add when stable        |

### OS Strategy

| OS                       | When to Include                            | Notes            |
| ------------------------ | ------------------------------------------ | ---------------- |
| Linux (ubuntu-latest)    | Always                                     | Primary platform |
| macOS (macos-latest)     | If platform-specific code or Rust bindings | ARM (M1+)        |
| Windows (windows-latest) | If platform-specific code or Rust bindings | MSVC toolchain   |

### Matrix Optimization

- Use `fail-fast: false` to see all failures, not just the first
- Run linting only on one Python version (fastest feedback)
- Run full test suite on all matrix combinations
- Cache pip dependencies for faster runs

## Documentation Deployment

### ReadTheDocs

```yaml
# .readthedocs.yaml
version: 2
build:
  os: ubuntu-22.04
  tools:
    python: "3.12"
sphinx:
  configuration: docs/conf.py
python:
  install:
    - method: pip
      path: .
      extra_requirements:
        - docs
```

### GitHub Pages (via GitHub Actions)

```yaml
name: Deploy Docs
on:
  push:
    branches: [main]

jobs:
  deploy-docs:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -e ".[docs]"
      - run: cd docs && make html # or: mkdocs build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/_build/html # or: site/
      - uses: actions/deploy-pages@v4
```

## Release Automation Patterns

### Preferred: Tag-Triggered Pipeline

The recommended pattern for SDK repositories:

1. Developer bumps version and updates CHANGELOG
2. Developer pushes a version tag: `git tag v1.2.3 && git push origin v1.2.3`
3. CI automatically:
   - Builds wheels for all platforms
   - Runs tests on built wheels
   - Publishes to TestPyPI
   - Publishes to production PyPI
   - Creates GitHub Release with auto-generated notes

### Alternative: Manual Workflow Dispatch

```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        description: "Version to release (e.g., 1.2.3)"
        required: true
      skip_testpypi:
        description: "Skip TestPyPI (patch releases only)"
        type: boolean
        default: false
```

## Self-Hosted Runner Considerations

Consider self-hosted runners when:

- **Rust compilation is slow** on GitHub-hosted runners
- **Platform-specific hardware** is needed (e.g., GPU testing)
- **Large test suites** exceed GitHub Actions time limits
- **Private dependencies** require network access not available on hosted runners

Runner setup:

```bash
# Install runner (follow GitHub's current instructions)
# Research: https://docs.github.com/en/actions/hosting-your-own-runners

# Label runners for targeted job assignment
# runs-on: [self-hosted, linux, x64, rust-builder]
```

## CI Debugging

### Common Failure Patterns

| Symptom                        | Likely Cause             | Fix                                    |
| ------------------------------ | ------------------------ | -------------------------------------- |
| Wheel build fails on Linux     | Missing system deps      | Add `apt-get install` step             |
| Wheel build fails on macOS     | Wrong SDK version        | Pin macOS runner version               |
| Tests pass locally, fail on CI | Environment difference   | Check Python version, OS, env vars     |
| Publishing fails               | Auth misconfigured       | Check trusted publisher or token setup |
| Cross-compile fails            | Missing target toolchain | Use appropriate cross-compile action   |

### Debugging Commands

```bash
# List recent CI runs
gh run list --limit 10

# Watch a specific run
gh run watch <run-id>

# Download CI logs
gh run download <run-id> --name logs

# Re-run failed jobs
gh run rerun <run-id> --failed
```

## What to Research Live

The agent should always research these before configuring — they change frequently:

- Current GitHub Actions action versions (@v4 vs @v5, etc.)
- Current `maturin-action` version and options
- Current `gh-action-pypi-publish` version and OIDC setup
- Current ReadTheDocs build configuration format
- Current best practices for trusted publisher (OIDC) setup on PyPI

Use `web search` and CLI `--help` rather than relying on trained knowledge.
