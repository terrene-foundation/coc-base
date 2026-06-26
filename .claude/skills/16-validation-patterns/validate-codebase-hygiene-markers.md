# Validate Codebase Hygiene Markers

A validation pattern for scrubbing internal-tracker markers (`TODO-NNN`, `FIXME-NNN`, `HACK-NNN`, deprecated-API references, post-migration internal IDs) from production source AND preventing future reintroduction via a three-layer canonical-regex gate.

This skill captures the methodology developed for issue #781 (TODO-NNN cleanup workstream, 272 markers triaged across 5 packages, May 2026). The same pattern applies to any future workstream that needs to gate a regex out of production source.

## When to Use

Apply this pattern when:

- A class of comment markers (`TODO-NNN`, `FIXME-NNN`, internal tracker IDs from a deprecated tracker namespace, `// REVIEW`, etc.) accumulated in production source over time and now violates `rules/zero-tolerance.md` Rule 2 / Rule 6.
- The cleanup needs to be permanent — future PRs must NOT be able to reintroduce the pattern.
- The cleanup spans multiple packages and requires per-shard disposition (per `rules/autonomous-execution.md` Per-Session Capacity Budget).

## The 4-Class Disposition Catalog

Most "TODO marker" populations are NOT homogenous. The methodology splits markers into 4 classes based on their syntactic shape and semantic intent:

### Class 1a — header banner / group label / inline-shipped marker

**Shape:** `# === <Topic> (v<X.Y.Z>, TODO-NNN) ===` or `# === <Topic> (TODO-NNN) ===` or `# Topic (TODO-NNN)` (inline group label).

**Semantics:** The marker labels SHIPPED code; the surrounding code implements the named topic. The tracker tag is provenance, not pending work.

**Disposition rule:**

- If a version is paired (`vX.Y.Z`): rewrite `(TODO-NNN)` → `(SHIPPED-vX.Y.Z)`. The version pairing is the only case where retaining a parenthetical adds grep-able forensic value.
- Otherwise (most cases): drop the `(TODO-NNN)` parenthetical entirely. Keep the banner text. The git log and CHANGELOG are the right home for "which workstream produced this".

### Class 1b — module/class docstring provenance

**Shape:** `Module Foo - TODO-NNN Phase X` or `Created: <date> (Phase 3, Day 2, TODO-NNN)` in module docstrings, OR `See: TODO-NNN` / `Related: TODO-NNN` see-also lines.

**Semantics:** Provenance metadata about which workstream produced the file.

**Disposition rule:**

- Strip `TODO-NNN Phase X` (or the equivalent see-also line) entirely. Module docstrings describe what the module does; provenance lives in `git log` and CHANGELOG.
- Exception: if the marker pairs with an ADR (e.g., `ADR-013 Specialist System`), preserve the ADR reference and strip only the TODO-NNN.

### Class 2 — active iterative TODO

**Shape:** `# TODO-NNN: <description of unfinished work>` introducing a comment that describes work the file has NOT done.

**Disposition rule:** Per `rules/zero-tolerance.md` Rule 6 (iterative TODOs permitted only when actively tracked), each MUST acquire a same-line tracker link. Format: `# TODO-NNN: <description> (tracked: gh#NNN)` or `(tracked: workspaces/<project>/todos/active/<file>.md)`.

If no tracker exists, the choice is **binary**: open a tracker AND link, OR delete the comment. "Will track later" is the institutional ratchet `zero-tolerance.md` Rule 1 prevents.

**Common false-positive:** Many comments shaped like Class 2 (`# TODO-NNN: <topic>`) turn out to be Class 1a in disguise — the comment is a group label inside `__all__` and the named symbol IS exported and IS implemented. Per-hit triage: read ±10 lines after the marker. If they implement the topic, it's Class 1a; if they punt or stub, it's Class 2.

### Class 3 — forwarded reference to external tracker

**Shape:** `# Integration with X (TODO-N1, TODO-N2, TODO-N3)` or References blocks like `- TODO-157: Phase 3 Tasks 3S.2-3S.5`. Marker appears mid-comment as a parenthetical cross-reference.

**Disposition rule:** Strip the `(TODO-NNN)` references. The substantive prose (class names, concept names) stays. The internal tracker namespace is workspace-only and not grep-able for outside contributors.

### Ambiguous Class-1/2 boundary

**Shape:** `# TODO-NNN: <topic>` precedes either a fully-shipped block (Class 1a in disguise) or actually-unfinished work (Class 2). Pattern-matching alone cannot disambiguate.

**Disposition rule:** Per-hit triage during cleanup. Heuristic: read the next ~30 lines after the marker. If they implement the topic, it's Class 1a; if they punt or stub, it's Class 2.

## The Three-Layer Hygiene Gate

After cleanup brings the tree to zero markers, ship a permanent gate so future PRs cannot reintroduce the pattern. Three layers, single source of truth (a shared bash script):

### Layer 1 — Pre-commit hook (`.pre-commit-config.yaml`)

```yaml
- repo: local
  hooks:
    - id: no-untracked-todo-nnn
      name: No untracked TODO-NNN markers in production source
      description: "Block reintroduction of TODO-NNN tags without same-line tracker links."
      entry: scripts/check_no_untracked_todo_nnn.sh
      language: system
      pass_filenames: false
      always_run: true
      stages: [pre-commit]
```

The hook runs locally on every commit AND in `pre-commit-ci` on every PR (provided the hook id is NOT in the `ci.skip:` list). No new GitHub Actions workflow needed — pre-commit-ci already handles the CI surface.

### Layer 2 — Shared script (`scripts/check_<name>.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# `grep -I` skips binary files (transient *.pyc under __pycache__).
# Exclusions:
#   :\s*///       Rust doc-comments
#   :\s*//!       Rust inner doc-comments
#   /build/       transient build artifacts
#   tracked:      explicit tracker link — Class 2 exception per Rule 6
#   \.egg-info/   setuptools-generated SOURCES.txt — references filenames not code
hits=$(grep -rInE 'TODO-[0-9]+' src/ packages/*/src/ 2>/dev/null \
       | grep -vE ':\s*///|:\s*//!|/build/|tracked:|\.egg-info/' \
       || true)

if [ -n "$hits" ]; then
    {
        echo "Untracked TODO-NNN markers in production source:"
        echo "$hits"
        echo ""
        echo "Each must either (1) carry a same-line (tracked: gh#NNN) link"
        echo "or (2) be deleted. See .claude/rules/zero-tolerance.md Rule 2 + Rule 6."
    } >&2
    exit 1
fi
```

The script is the single source of truth for the canonical regex AND the exclusion list. Both the pre-commit hook AND the regression test invoke this script (or equivalent logic), so changes to the contract land in one file.

### Layer 3 — Regression test (`tests/regression/test_no_untracked_*.py`)

Belt-and-suspenders against pre-commit/CI drift. The test mirrors the same canonical condition the hook enforces, so a regression slips through only if BOTH layers fail simultaneously.

```python
@pytest.mark.regression
def test_no_untracked_todo_nnn_in_production_source() -> None:
    """No TODO-NNN markers in production source without (tracked: ...) links."""
    REPO_ROOT = Path(__file__).resolve().parents[2]
    CANONICAL_REGEX = r"TODO-[0-9]+"
    EXCLUDE_PATTERNS = [r":\s*///", r":\s*//!", r"/build/", r"tracked:", r"\.egg-info/"]

    roots = [REPO_ROOT / "src"] + list((REPO_ROOT / "packages").glob("*/src"))

    # `-I` skips binary files (transient *.pyc under __pycache__).
    result = subprocess.run(
        ["grep", "-rInE", CANONICAL_REGEX, *(str(r) for r in roots)],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    survivors = [
        line for line in result.stdout.splitlines()
        if line and not any(re.search(p, line) for p in EXCLUDE_PATTERNS)
    ]
    if survivors:
        pytest.fail(f"Found {len(survivors)} untracked TODO-NNN markers: ...")
```

The regression test lives in `tests/regression/` (collected by default pytest) so it runs in every CI build. Per `rules/refactor-invariants.md` Rule 2, invariant tests outside the CI default test path are decoration.

## Synthetic-PR Validation Protocol

Before merging the gate-shipping PR, validate the gate works by intentionally injecting a synthetic violation:

```bash
# 1. Hook + test on clean tree (expect PASS)
pre-commit run no-untracked-todo-nnn --all-files
uv run pytest tests/regression/test_no_untracked_todo_nnn.py -x

# 2. Inject synthetic untracked TODO into a production source file
echo "# TODO-999: synthetic gate test" >> src/<package>/__init__.py

# 3. Hook + test now (expect FAIL on both)
pre-commit run no-untracked-todo-nnn --all-files   # exit 1
uv run pytest tests/regression/test_no_untracked_todo_nnn.py -x  # FAILED

# 4. Add tracker link
sed -i 's|# TODO-999: synthetic gate test|# TODO-999: synthetic gate test (tracked: gh#999)|' src/<package>/__init__.py

# 5. Hook + test now (expect PASS on both)
pre-commit run no-untracked-todo-nnn --all-files   # exit 0
uv run pytest tests/regression/test_no_untracked_todo_nnn.py -x  # PASSED

# 6. Revert
git checkout src/<package>/__init__.py
```

The inverse-then-revert sequence proves the gate cannot be silently bypassed by adding-and-removing the tracker on the same line.

## Authoring Gotchas

### YAML scalar fragility with embedded colons in pre-commit `entry:`

When the hook `entry:` field uses inline bash with regex containing colons (`grep -vE ':\s*///'`), the YAML parser raises `InvalidConfigError: mapping values are not allowed in this context`. The colons are interpreted as YAML key:value separators inside the scalar.

```yaml
# DO NOT — inline bash with embedded colons
entry: bash -c 'grep ... | grep -vE ":\s*///" || true'
# → InvalidConfigError on pre-commit run

# DO — extract to a script file, reference by path
entry: scripts/check_no_untracked_todo_nnn.sh
# → YAML parses cleanly; script is also more maintainable
```

The scalar form (no quoting / quoting / block scalar) is irrelevant — the colon-as-key-separator parser ambiguity surfaces in every form. Extracting to a script file is the structural fix.

### `grep -r` matches binary files by default

`grep -rnE 'TODO-[0-9]+' src/` recurses into `__pycache__/*.pyc` and reports `Binary file ... matches` lines that pollute the output and break the regression test's count assertion. Use `grep -rInE` (the `-I` flag skips binary files).

### Egg-info `SOURCES.txt` references filenames

Setuptools-generated `packages/<pkg>/src/<pkg>.egg-info/SOURCES.txt` lists every file shipped in the wheel — including any documentation file or example whose filename contains the canonical regex (e.g., `docs/architecture/adr/TODO-158-PHASE-3-HOOKS-SYSTEM-REQUIREMENTS.md`). These are NOT code comments and MUST be excluded via `\.egg-info/` in the exclusion list. The regex `\.egg-info/` (escaped dot, trailing slash) matches `kailash_kaizen.egg-info/` correctly; the naïve `/egg-info/` does NOT (the path segment is preceded by `_kaizen.`, not `/`).

## Multi-Shard Cleanup Strategy

For populations larger than ~50 markers across multiple packages, shard per-package. Each shard:

1. Builds a per-package disposition catalog mirroring the canonical T1 catalog format (file:line, snippet, class, disposition, notes).
2. Applies edits per class. Comment-only edits CANNOT introduce import / signature / unbound-variable errors — pyright diagnostics that surface during shard work are pre-existing per `rules/zero-tolerance.md` Rule 1c (SHA-grounded provenance required).
3. Verifies `grep -rInE '<canonical regex>' packages/<pkg>/src/` returns 0 hits (or only `tracked:` exceptions).
4. Runs the package's own pytest suite. Pre-existing failures get SHA-grounded provenance per Rule 1c; do NOT defer "pre-existing" without git-log evidence.
5. Documents the disposition table in PR body (per-class counts + any class-2 deletion rationales + pre-existing pyright diagnostics + pre-existing test failures with SHAs).

The closing shard ships the gate (Layers 1+2+3 above). Order matters: gate ships LAST so the cleanup-then-gate ratchet holds — landing the gate before cleanup blocks every legitimate cleanup PR.

## Release-Cycle Integration

When the cleanup workstream completes across multiple packages, the next BUILD-repo session MUST proceed through `/release` per `rules/build-repo-release-discipline.md` Rule 1. Comment-only changes are still byte-changes worth surfacing through PyPI so downstream consumers pick up the cleaned tree AND the new gate.

Release plan checklist for hygiene-only cleanup releases:

- [ ] Patch bump for every package whose `src/` was touched (per Rule 5 — sub-package src changes require same-PR version bump)
- [ ] SDK dep pin (`kailash>=`) bumped in ALL framework packages, even those not being released this cycle (per /release Step 2 SDK Dependency Pin Update Rule)
- [ ] CHANGELOG entry per released package describing the per-class disposition counts + the gate (if shipping)
- [ ] Single release-prep PR on `release/v*` branch (auto-skips PR-gate matrix on metadata-only diff per `rules/git.md`)
- [ ] Sequential tag pushes after admin-merge (batch push silently drops triggers per `rules/deployment.md`)
- [ ] Clean-venv install verification per package per `rules/build-repo-release-discipline.md` Rule 2

## Origin

Methodology developed for issue #781 (TODO-NNN cleanup, May 2026):

- 5 cleanup shards (T1 dataflow / T2 kaizen / T3 kaizen-agents / T4 core+nexus / T5 CI gate) merged via PRs #804/#805/#806/#807/#808
- 272 markers triaged across kailash-dataflow, kailash-kaizen, kaizen-agents, kailash-nexus, src/kailash
- Gate shipped via PR #808 (pre-commit hook + regression test + shared script)
- Released via PR #809 — kailash 2.13.4, kailash-dataflow 2.7.6, kailash-kaizen 2.18.1, kailash-nexus 2.6.1, kaizen-agents 0.9.5, kailash-mcp 0.2.11 (sibling sweep per build-repo-release-discipline.md Rule 1)
- Workspace plan + per-shard disposition catalogs at `workspaces/issue-781-todo-nnn-cleanup/`
