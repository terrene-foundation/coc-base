# SDK Release Runbook

Detailed version coordination and step-by-step release procedures for the Kailash Python SDK monorepo. Referenced by `/release` command and `release-specialist` agent.

## Version Locations (All Packages)

Every package has 2 version locations that MUST match. Framework packages also have an SDK dependency pin.

| Package          | pyproject.toml                    | __init__.py                  | SDK Dep Pin |
| ---------------- | --------------------------------- | ---------------------------- | ----------- |
| kailash          | `pyproject.toml`                  | `kailash/__init__.py`        | --          |
| kailash-dataflow | `kailash-dataflow/pyproject.toml` | `dataflow/__init__.py`       | `kailash>=` |
| kailash-kaizen   | `kailash-kaizen/pyproject.toml`   | `kaizen/__init__.py`         | `kailash>=` |
| kailash-nexus    | `kailash-nexus/pyproject.toml`    | `nexus/__init__.py`          | `kailash>=` |

### SDK Dependency Pin Rule

When core SDK version is bumped, ALL framework packages MUST update their `kailash>=` pin -- even if the framework itself is not releasing. Also update the main SDK's optional extras in `pyproject.toml`.

### Version Consistency Verification

```bash
# Core SDK -- both must match
grep 'version' pyproject.toml | head -1
grep '__version__' kailash/__init__.py

# Each framework -- version + dependency must be correct
for fw in kailash-dataflow kailash-kaizen kailash-nexus; do
  echo "=== $fw ==="
  grep 'version' $fw/pyproject.toml | head -1
  grep '__version__' $fw/src/*/__init__.py
  grep 'kailash>=' $fw/pyproject.toml
done
```

BLOCK release if any mismatch is found.

## Pre-Release Prep

1. Run full test suite across all supported Python versions
2. Run linting and formatting checks (`black --check`, `ruff check`)
3. Update CHANGELOG.md for each package being released
4. Security review (MANDATORY)
5. **Update README.md** (MANDATORY for minor/major releases -- BLOCKS release if skipped)
   - Verify "Why Kailash?" section reflects new capabilities
   - Update architecture diagram version number
   - Verify all feature claims match actual implementation
   - Check that new entry points, CLI commands, or REST endpoints are documented
   - Run: `grep -c 'v0.XX.X' README.md` to confirm version appears
6. **Verify Sphinx docs build** (MANDATORY -- BLOCKS release if build fails)
   - Run `cd docs && python build_docs.py` locally -- must succeed with zero errors
   - Verify new module docstrings appear in API reference (spot-check 3 new modules)
   - The `docs-deploy.yml` CI workflow auto-deploys on push to main

## Build and Validate

1. Build wheels (and sdist if open-source): `python -m build`
2. For frameworks: `cd kailash-<name> && python -m build`
3. Upload to TestPyPI: `twine upload --repository testpypi dist/*.whl`
4. Verify TestPyPI install in clean venv
5. For major/minor releases: run smoke tests against TestPyPI package

## Git Workflow

Main branch is protected -- all changes require a PR with review.

1. Create release branch: `git checkout -b release/vX.Y.Z`
2. Commit with conventional message: `chore: release vX.Y.Z`
3. Push branch: `git push -u origin release/vX.Y.Z`
4. Create PR: `gh pr create --title "chore: release vX.Y.Z" --body "..."`
5. Wait for CI to pass, then merge (admin can self-approve)
6. After merge, tag on main: `git checkout main && git pull && git tag -a vX.Y.Z -m "..." && git push --tags`
7. Tags trigger the publish-pypi.yml workflow automatically

## Publish to Production PyPI

Publish in dependency order -- core MUST be available before frameworks:

1. `kailash` (core) -> verify: `pip install kailash==X.Y.Z --dry-run`
2. `kailash-dataflow` -> verify available
3. `kailash-nexus` -> verify available
4. `kailash-kaizen` -> verify available

For each: upload wheels, verify production install in clean venv, create GitHub Release with tag.

## Post-Release

1. **Update COC template repo** (MANDATORY) -- Update `kailash-coc-claude-py/pyproject.toml` dependency pins to match published versions. Commit: `chore: bump SDK dependency pins to latest release`
2. **Verify documentation deployed** (MANDATORY)
   - Check `gh run list --workflow=docs-deploy.yml --limit=1` -- must be `completed success`
   - If failed: check logs with `gh run view <id> --log-failed`, fix, and re-trigger
   - GitHub Pages must be configured: Settings -> Pages -> Source: "GitHub Actions"
3. Document release in `deploy/deployments/YYYY-MM-DD-vX.Y.Z.md`
4. Announce if applicable

## CI Management

1. **Monitor CI runs** -- `gh run list`, `gh run watch`
2. **Debug CI failures** -- download logs, reproduce locally
3. **Manage workflows** -- update GitHub Actions, test matrix, runner config
