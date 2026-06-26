---
name: git-release-patterns
description: "Git release patterns including pre-commit validation, branch workflows, and release procedures. Use for 'pre-commit', 'release checklist', 'version bump', or 'PR workflow'."
---

# Git Release Patterns

> **Skill Metadata**
> Category: `git`
> Priority: `HIGH`
> Tools: git, black, isort, ruff, pytest

## Pre-Commit Validation

### Quality Pipeline (MANDATORY)

```bash
# Run before EVERY commit
black .            # Python code formatting
isort .            # Import sorting
ruff check .       # Fast Python linting
pytest             # Run tests

# All-in-one check
black . && isort . && ruff check . && pytest && echo "✅ Ready to commit"
```

### Quality Gate Checklist

```
- [ ] black . → No formatting changes needed
- [ ] isort . → No import sorting changes needed
- [ ] ruff check . → No linting violations
- [ ] pytest → All tests pass
- [ ] git status → All changes staged
```

## FORBIDDEN Git Commands

```bash
# ❌ NEVER USE - Destructive operations
git reset --hard    # Can lose work
git reset --soft    # Can lose work

# ✅ SAFE ALTERNATIVES
git stash          # Temporarily save changes
git commit         # Commit changes safely
```

## Branch Workflow

### Feature Development

```bash
# 1. Create Feature Branch (REQUIRED)
git checkout main
git pull origin main
git checkout -b feature/[descriptive-name]

# 2. Development Loop
# Make changes
black . && isort . && ruff check .  # MANDATORY formatting
pytest                              # MANDATORY testing
git add .                          # Stage all changes
git commit -m "feat: implement [feature description]"

# 3. Pre-Push Validation (MANDATORY)
black . && isort . && ruff check . && pytest
cd docs && python build_docs.py
```

### PR Creation (Cannot Push to Main)

```bash
# Push Feature Branch
git push -u origin feature/[name]

# Title format: [type]: [description]
# Examples:
# feat: add user authentication system
# fix: resolve parameter validation issue
# docs: update quickstart guide
```

### PR Description Template

```markdown
## Summary
[Brief description of changes and why they're needed]

## Changes Made
- [ ] Feature implementation completed
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Examples updated (if applicable)

## Breaking Changes
- [ ] None
- [ ] [List any breaking changes with migration guide]

## Ready for Review
- [ ] Code quality pipeline passes
- [ ] All tests pass locally
- [ ] Documentation is complete
```

## Version Management

### Update ALL Version Locations

```bash
# Main SDK
vim pyproject.toml              # [project] version = "x.y.z"
vim kailash/__init__.py     # __version__ = "x.y.z"

# Bundled packages
vim kailash-dataflow/pyproject.toml
vim kailash-dataflow/src/dataflow/__init__.py

vim kailash-nexus/pyproject.toml
vim kailash-nexus/src/nexus/__init__.py

vim kailash-kaizen/pyproject.toml
vim kailash-kaizen/src/kaizen/__init__.py
```

## Release Branch Workflow

```bash
# 1. Create Release Branch
git checkout main
git pull origin main
git checkout -b release/v[version]

# 2. Pre-Release Validation
black . && isort . && ruff check .
pytest
cd docs && python build_docs.py

# 3. Build and Test Distribution
rm -rf dist/ build/ *.egg-info
python -m build

# Test installation
python -m venv test-release
source test-release/bin/activate
pip install dist/kailash-*.whl
python -c "import kailash; print(kailash.__version__)"
deactivate && rm -rf test-release

# 4. Push Release Branch
git push -u origin release/v[version]
```

## GitHub Release Process

```bash
# 1. After PR Merge
git checkout main
git pull origin main
git tag v[version]
git push origin v[version]

# 2. Create GitHub Release
# Go to: https://github.com/[org]/kailash_python_sdk/releases
# - Tag: v[version]
# - Target: main
# - Title: v[version] - [Brief Description]
# - Attach: dist/* files

# 3. PyPI Upload (order matters — core first, then extensions)
twine upload dist/*.whl                                    # Core SDK first
cd kailash-dataflow && twine upload dist/*.whl        # DataFlow second
cd ../kailash-nexus && twine upload dist/*.whl             # Nexus third
cd ../kailash-kaizen && twine upload dist/*.whl            # Kaizen fourth
```

## Validation Tiers

```bash
# Quick Check (5 minutes)
black . && isort . && ruff check .

# Standard Check (10 minutes)
black . && isort . && ruff check . && pytest

# Full Validation (20 minutes)
black . && isort . && ruff check . && pytest && \
cd docs && python build_docs.py

# Release Validation (30 minutes)
black . && isort . && ruff check . && pytest && \
cd examples && python _utils/test_all_examples.py && \
cd docs && python build_docs.py && \
python -m build && twine check dist/*
```

## Emergency Procedures

```bash
# Rollback Release
git tag -d v[version]                    # Delete local tag
git push origin :refs/tags/v[version]   # Delete remote tag

# Urgent Hotfix
git checkout main && git pull
git checkout -b hotfix/[critical-issue]
# Make minimal fix
black . && isort . && ruff check . && pytest
git push -u origin hotfix/[critical-issue]
# Create PR with "hotfix" label
```

## Common Fixes

```bash
# Black/isort Disagreement
isort . --profile black

# Ruff Auto-Fix
ruff check . --fix

# Debugging Tests
pytest tests/specific/test_file.py -v -s --tb=long

# Uncommitted Changes
git stash           # Save temporarily
# Do git operation
git stash pop       # Restore
```

<!-- Trigger Keywords: pre-commit, release checklist, version bump, PR workflow, git branching, feature branch, release branch, PyPI release -->
