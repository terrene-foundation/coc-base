# SDK Release Onboarding Process

Interactive process for creating a project's `deploy/deployment-config.md`. The release-specialist agent drives this process with the human architect. Focused on SDK release infrastructure (PyPI publishing, CI, docs), not cloud deployment.

## When to Run

Run when `/deploy` is invoked and `deploy/deployment-config.md` does not exist at the project root.

## Step 1: Codebase Analysis

Analyze the project to understand what needs to be released. Check:

- **Packages**: Main package (`kailash`) and sub-packages (`kailash-dataflow`, `kailash-nexus`, `kailash-kaizen`)
- **Build system**: `pyproject.toml` (setuptools) — single source of truth (no setup.py/setup.cfg)
- **Existing CI**: `.github/workflows/` — what's already automated?
- **Documentation**: sphinx `conf.py`, mkdocs.yml, docs/ directory — what doc system is in use?
- **Test infrastructure**: pytest config, tox.ini, nox, test matrix setup
- **Version management**: where is version defined? single source or duplicated?
- **Existing release artifacts**: `dist/`, `MANIFEST.in`, `.pypirc` template, `CHANGELOG.md`

## Step 2: Structured Questions for the Human

### PyPI Publishing

- Package name(s) on PyPI?
- TestPyPI validation required before production PyPI?
- Wheel-only publishing (proprietary) or sdist included (open source)?
- API token setup: `~/.pypirc` file or CI secrets (e.g., GitHub Actions secrets)?
- Trusted publisher (OIDC) or token-based authentication?

### Multi-Package Versioning

- Lockstep versioning (all packages share same version) or independent?
- If independent: what's the compatibility matrix?
- Cross-package dependency pinning strategy (exact, compatible release, range)?

### Documentation

- Documentation tool: sphinx, mkdocs, or other?
- Hosting: ReadTheDocs, GitHub Pages, or other?
- Auto-deploy on merge to main, or manual trigger?
- API reference auto-generated from docstrings?

### CI System

- CI platform: GitHub Actions, GitLab CI, or other?
- Test matrix: which Python versions? which operating systems?
- Self-hosted runners needed (e.g., for Rust compilation)?
- Tag-triggered publishing or manual release?

### Release Process

- Changelog format: Keep a Changelog, conventional-changelog, or custom?
- Release cadence: on-demand, scheduled, or continuous?
- Release branch strategy: tag from main, release branches, or other?

## Step 3: Research

The agent MUST research current approaches rather than prescribe from stale knowledge:

- Web search for current PyPI publishing best practices (trusted publishers, OIDC, etc.)
- Current `build`, `twine`, `maturin` tool versions and syntax
- Current GitHub Actions patterns for Python package CI/CD
- Current ReadTheDocs or GitHub Pages setup patterns
- CLI `--help` for current tool syntax

## Step 4: Create deploy/ Directory

```
deploy/
  deployment-config.md    # Decisions + rationale + release runbook + rollback
  deployments/            # Release logs (created per release)
```

## Step 5: Human Review

Present the completed `deployment-config.md` to the human for review before any publishing.

## deployment-config.md Template

The onboarding process creates this file. Structure adapts to the project:

```markdown
# SDK Release Configuration

## Packages

| Package | PyPI Name   | Version Source    | Build Backend |
| ------- | ----------- | ----------------- | ------------- |
| [name]  | [pypi-name] | [path to version] | [backend]     |

## Versioning Strategy

- **Strategy**: [lockstep | independent]
- **Cross-package dependencies**: [pinning strategy]

## PyPI Publishing

- **Authentication**: [~/.pypirc | CI secrets | trusted publisher (OIDC)]
- **TestPyPI**: [required for major/minor | always | never]
- **Artifact type**: [wheel-only | wheel + sdist]

## CI/CD

- **Platform**: [GitHub Actions | GitLab CI]
- **Test matrix**: [Python versions] x [OS list]
- **Release trigger**: [tag-triggered | manual | on-merge]
- **Self-hosted runners**: [yes/no — reason]

## Documentation

- **Tool**: [sphinx | mkdocs]
- **Hosting**: [ReadTheDocs | GitHub Pages]
- **Deploy trigger**: [on-merge | on-release | manual]

## Release Runbook

### Pre-release

1. Run full test suite: `[test command]`
2. Run linting: `[lint command]`
3. Update CHANGELOG.md
4. Bump version in [location(s)]
5. Ensure version consistency across packages

### Build and Validate

1. Build: `python -m build`
2. Upload to TestPyPI: `twine upload --repository testpypi dist/*.whl`
3. Verify: `pip install --index-url https://test.pypi.org/simple/ [package]==X.Y.Z`

### Publish

1. Upload to PyPI: `twine upload dist/*.whl`
2. Verify: `pip install [package]==X.Y.Z`
3. Create GitHub Release: `gh release create vX.Y.Z --generate-notes`

### Post-release

1. Deploy documentation
2. Log release in `deploy/deployments/YYYY-MM-DD-vX.Y.Z.md`

## Rollback Procedure

1. Yank version on PyPI (Project Settings > Yank Version)
2. Publish corrective release with bumped patch number
3. Delete GitHub Release and tag if needed

## Release Checklist

- [ ] All tests pass (full matrix)
- [ ] Security review completed
- [ ] CHANGELOG.md updated
- [ ] Version consistency verified across packages
- [ ] TestPyPI validation passed
- [ ] Production PyPI publish successful
- [ ] Clean venv install verified
- [ ] GitHub Release created
- [ ] Documentation deployed
```
