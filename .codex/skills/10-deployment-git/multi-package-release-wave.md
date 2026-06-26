# Multi-Package Atomic Release Wave

When a single feature spans multiple SDK packages (DataFlow schema + ml engines + Nexus endpoints + Kaizen agents + Align integration + PACT envelopes), the release is **atomic** — every package in the wave MUST bump version, update CHANGELOG, and publish to PyPI in reverse dep-graph order within one session, or the ecosystem ships with version-skew bugs (`kailash-ml 1.0.0` imports from `kailash 2.8.12` which lacks the new `kailash.ml` namespace).

This file documents the atomic-wave protocol, validated by the kailash-ml 1.0.0 M1 release wave (session 2026-04-23, 7 packages).

## Reverse Dep-Graph Publish Order

Publish order is strict: every dependency MUST be on PyPI before its dependents. For the 7-package Kailash platform:

```
kailash                    ← root (everyone depends on it)
  ↓
kailash-dataflow           ← depends on kailash
kailash-nexus              ← depends on kailash
kailash-kaizen             ← depends on kailash
kailash-pact               ← depends on kailash (+ governance)
  ↓
kailash-align              ← depends on kailash + kaizen (alignment uses Kaizen agents)
  ↓
kailash-ml                 ← depends on kailash + dataflow + nexus + kaizen + pact + align
```

**Publish order for a full wave:** `kailash → dataflow → nexus → kaizen → pact → align → ml`.

Each step: `python -m build` → `twine upload --repository testpypi dist/*.whl` → smoke-test install in clean venv → `twine upload dist/*.whl` → verify `pip install <pkg>==<new-version>` in clean venv.

**Why:** A dependent package published before its dependency fails on `pip install` for every user in the window between publish #N and publish #N+1. For a 7-package wave that window can be 10-20 minutes; users hit 503 / `No matching distribution found` errors during that window.

## Per-Package Version Owner (Parallel-Worktree Rule)

When parallel worktree agents touch the same sub-package, ONE agent is designated **version owner** and every other agent's prompt MUST include:

> "do NOT edit `packages/<pkg>/pyproject.toml`, `packages/<pkg>/src/<pkg>/__init__.py::__version__`, or `packages/<pkg>/CHANGELOG.md`"

See `rules/agents.md` § "MUST: Parallel-Worktree Package Ownership Coordination" for the load-bearing clause and `skills/30-claude-code-patterns/worktree-orchestration.md` Rule 5 for the full parallel-release evidence.

**Session 2026-04-23 kailash-ml M1 wave:** 7 packages, 6 M10 shards + W33/W33b/W33c. Each shard owned exactly one package's version bump; orchestrator handled the post-merge `__all__` reconciliation (commit fa300831) that spans multiple shards.

## Sole CHANGELOG Owner Rule

For each package in the wave, ONE shard writes the `## [X.Y.Z] — YYYY-MM-DD` entry. Other shards that contribute to the same version MUST NOT write their own top-level CHANGELOG entry; they provide the orchestrator with bullet points, and the orchestrator merges them into the single entry.

```markdown
# DO — single [1.0.0] entry, bullets from all contributing shards

## [1.0.0] — 2026-04-23

### Added (W33)

- km.\* canonical 41-symbol public API surface (specs/ml-engines-v2.md §15.9)

### Added (W33b)

- MIGRATION.md 0.x → 1.0.0 sunset contract
- Release-blocking README Quick Start regression (SHA-256 fingerprint)

### Fixed (W33c)

- km.register async consistency with km.train (commit fdd3040e)

# DO NOT — multiple top-level entries, one per shard

## [1.0.0] — 2026-04-23

### W33 Changes

...

## [1.0.0] — 2026-04-23

### W33b Changes

...

# ↑ git picks one entry at merge, silently drops the others
```

## Pre-Flight: Build + Twine + TestPyPI Dry-Run

Before the human-gated PyPI publish step, the orchestrator MUST run (for each package in the wave):

```bash
cd packages/<pkg>
python -m build --wheel --sdist
twine check dist/*.whl              # metadata validation
twine upload --repository testpypi --skip-existing dist/*.whl
# In a clean venv:
uv venv .venv-verify
.venv-verify/bin/pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ <pkg>==<new-version>
.venv-verify/bin/python -c "import <pkg>; print(<pkg>.__version__)"
```

All dry-runs MUST succeed before the human is asked to authorize production PyPI. Failed dry-runs are fixed in the feat branch, not at publish time.

## Version Consistency Verification

Per `rules/zero-tolerance.md` Rule 5, every package has 2 version locations that MUST match:

```bash
for pkg in kailash kailash-dataflow kailash-nexus kailash-kaizen kailash-pact kailash-align kailash-ml; do
  echo "=== $pkg ==="
  if [ "$pkg" = "kailash" ]; then
    grep '^version' pyproject.toml | head -1
    grep '__version__' src/kailash/__init__.py
  else
    grep '^version' packages/$pkg/pyproject.toml | head -1
    grep '__version__' packages/$pkg/src/*/__init__.py
  fi
done
```

Any mismatch BLOCKS release. Also verify SDK dependency pins — when `kailash` bumps, every dependent package's `kailash>=` pin MUST bump to match (or exceed) the new version.

## Rollback Decision Tree

If a publish fails mid-wave (e.g., `kailash` + `dataflow` + `nexus` published, then `kaizen` fails):

1. **Stop the wave** — do NOT continue publishing downstream packages. Their tests assume kaizen's new version is available.
2. **Diagnose kaizen failure** — usually a failed twine upload (network, token, metadata). Fix + retry from `kaizen` onward.
3. **If kaizen requires a code fix** — bump kaizen's version again (e.g. 2.12.0 → 2.12.1), re-run the wave from kaizen onward. The published `kailash`, `dataflow`, `nexus` at their original versions remain valid; they don't need re-publishing.
4. **Do NOT yank** published packages unless they are structurally broken. Yanks invalidate install-lockfiles in downstream CI across the ecosystem.
5. **Record the rollback** in the session notes AND the downstream release post-mortem.

**Never silently skip a package in the wave.** A wave of 7 with `kaizen` skipped produces an ecosystem where `ml 1.0.0` can't satisfy its `kaizen>=2.12.0` pin.

## Atomic Wave Success — kailash-ml 1.0.0 M1 (2026-04-23)

Session 2026-04-23 shipped 7 packages on `feat/kailash-ml-1.0.0-m1-foundations` (local; W34 PyPI publish pending human auth):

| Pkg              | Version | Shard   | Tests |
| ---------------- | ------- | ------- | ----- |
| kailash          | 2.9.0   | W31a+d  | 33/33 |
| kailash-dataflow | 2.1.0   | W31b    | 41/41 |
| kailash-nexus    | 2.2.0   | W31c    | 27/27 |
| kailash-kaizen   | 2.12.0  | W32a    | 26/26 |
| kailash-align    | 0.6.0   | W32b    | 20/20 |
| kailash-pact     | 0.10.0  | W32c    | 42/42 |
| kailash-ml       | 1.0.0   | W33/33b | 38/38 |

**227 tests passing on feat branch.** Pattern validated: 6 M10 shards ran in two waves of 3 parallel worktrees (see `skills/30-claude-code-patterns/worktree-orchestration.md` Rule 6 on burst-size limit).

## Related

- `release-runbook.md` — step-by-step release procedures
- `deployment-packages.md` — single-package PyPI release workflow
- `rules/agents.md` § "MUST: Parallel-Worktree Package Ownership Coordination"
- `rules/zero-tolerance.md` Rule 5 — version consistency
- `skills/30-claude-code-patterns/worktree-orchestration.md` Rules 5 + 6
- `skills/34-kailash-ml/m1-release-wave.md` — M1-specific patterns
