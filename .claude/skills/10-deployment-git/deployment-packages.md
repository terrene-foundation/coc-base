# Package Release Workflow

Stable patterns for releasing the `kailash` Python SDK packages to PyPI and creating GitHub releases.

## Pre-Release Checklist

1. **Update documentation**
   - README.md — version badge, new features, breaking changes
   - CHANGELOG.md — add release entry with date
   - Build docs if using sphinx (`cd docs && make html`) or mkdocs (`mkdocs build`)

2. **Run full quality pipeline**

   ```bash
   ruff format . && ruff check . && pytest
   ```

3. **Run security review**
   - Delegate to security-reviewer agent before proceeding

4. **Bump version**
   - Update version in `pyproject.toml`
   - Update any `__version__` in `__init__.py` files
   - Update any version badges in README.md
   - Ensure all version references are consistent

## Multi-Package Coordination

When releasing the `kailash` SDK with sub-packages (`kailash-dataflow`, `kailash-nexus`, `kailash-kaizen`):

### Version Consistency Check

```bash
# Check all package versions match (if lockstep versioning)
grep -r 'version\s*=' */pyproject.toml
grep -r '__version__' */__init__.py
```

### Dependency Compatibility

- Verify cross-package dependency pins are compatible
- If `kailash-dataflow` depends on `kailash>=X.Y.Z`, ensure the core version satisfies this
- Update dependency pins when bumping versions

### Publish Order

Always publish in dependency order:
1. `kailash` (core) — no internal dependencies
2. `kailash-dataflow` — depends on core
3. `kailash-nexus` — depends on core
4. `kailash-kaizen` — depends on core (and possibly others)

Wait for each package to be available on PyPI before publishing dependents:
```bash
# Poll until package is available
pip install kailash==X.Y.Z --dry-run
```

## Git Workflow

### Direct Push (if allowed)

```bash
git add .
git commit -m "chore: release vX.Y.Z"
git push
```

### Protected Branch (PR workflow)

```bash
git checkout -b release/vX.Y.Z
git add .
git commit -m "chore: release vX.Y.Z"
git push -u origin release/vX.Y.Z
gh pr create --title "Release vX.Y.Z" --body "Release vX.Y.Z"
# Watch CI, merge when green
```

## GitHub Release

```bash
# Create tag
git tag vX.Y.Z
git push origin vX.Y.Z

# Create GitHub release
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

## PyPI Publish

### Build

```bash
# Standard Python package
python -m build

# Rust-backed package (if using maturin)
maturin build --release
```

### Upload

```bash
# Test on TestPyPI first (REQUIRED for major/minor releases)
twine upload --repository testpypi dist/*.whl
pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ kailash==X.Y.Z

# Upload wheels only (NEVER upload sdist for proprietary code)
twine upload dist/*.whl

# Or if sdist is safe (open source)
twine upload dist/*
```

**Credentials**: Use `~/.pypirc`, CI secrets, or trusted publisher (OIDC). Never pass credentials as command-line arguments. Never commit credentials to source.

### Verify

```bash
# Install in clean environment
python -m venv /tmp/verify-release --clear
/tmp/verify-release/bin/pip install kailash==X.Y.Z
/tmp/verify-release/bin/python -c "import kailash; print(kailash.__version__)"
```

## CI-Triggered Release (Preferred)

For the `kailash` SDK build repository, CI-triggered releases are the preferred approach:

1. Developer pushes version tag → CI builds wheels for all platforms
2. CI runs tests on built wheels
3. CI publishes to TestPyPI (automated validation)
4. CI publishes to production PyPI
5. CI creates GitHub Release with artifacts and auto-generated notes

The agent should monitor CI after tagging:

```bash
# Watch the CI run triggered by the tag
gh run list --limit 5
gh run watch [run-id]
```

See `deployment-ci.md` for GitHub Actions workflow patterns.

## Rollback

### PyPI

- Yank the version on PyPI (Project Settings > Yank Version) — PyPI does not allow deletion
- Publish corrected version with bumped patch number

### GitHub

```bash
gh release delete vX.Y.Z --yes
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

## Critical Rules

- NEVER publish without running tests first
- NEVER publish without security review
- NEVER skip TestPyPI for major/minor releases
- ALWAYS verify the published package installs correctly
- ALWAYS create a GitHub release with release notes
- ALWAYS publish in dependency order for multi-package releases
- For proprietary code: NEVER upload sdist, only wheels
