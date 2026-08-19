---
name: deployment-git
description: "Kailash deployment + Git — PyPI publish, CI/CD, wheels, version bumps, multi-package."
---

# SDK Release & Git Workflows

Comprehensive guides for releasing the Kailash Python SDK to PyPI, managing CI/CD pipelines, deploying documentation, and Git workflow best practices.

## Overview

SDK release and development infrastructure patterns for:

- PyPI package publishing (TestPyPI + production)
- CI/CD pipelines (GitHub Actions)
- Multi-platform wheel building
- Documentation deployment
- Git workflows and branching strategies
- Multi-package version coordination

## Reference Documentation

### Deployment Lifecycle

- **[deployment-onboarding](deployment-onboarding.md)** - SDK release onboarding process
  - Codebase analysis (packages, build system, CI, docs)
  - Structured questions for human architect
  - Research current PyPI/CI best practices
  - Create deployment-config.md

- **[release-runbook](release-runbook.md)** - SDK release runbook (detailed procedures)
  - Version locations for all packages (pyproject.toml + **init**.py)
  - SDK dependency pin rules
  - Version consistency verification commands
  - Pre-release, build, publish, post-release step-by-step procedures

- **[deployment-packages](deployment-packages.md)** - Package release workflow
  - PyPI and GitHub release process
  - Multi-package coordination and publish order
  - Version bumping and changelog
  - CI-triggered releases
  - TestPyPI validation
  - Rollback procedures

- **[deployment-ci](deployment-ci.md)** - CI/CD infrastructure
  - GitHub Actions workflows for Python packages
  - Multi-platform wheel building
  - Test matrix (Python versions x OS)
  - Tag-triggered publishing pipeline
  - Documentation deployment (ReadTheDocs, GitHub Pages)
  - Self-hosted runner management

- **[python-version-bump](python-version-bump.md)** - Python minor-version bump playbook
  - When to declare a new CPython release (3.X stable + ≥1 patch)
  - 3-step recipe: pyproject classifiers → CI matrices → `uv pip install --dry-run --python 3.X` verification
  - Concrete file list for all 10 packages and 4 CI matrix files
  - Common gotcha: stale literal version assertions in test fixtures (durable cross-surface contract pattern)
  - ML stack wheel-lag guidance (torch / transformers / accelerate)

- **[multi-package-release-wave](multi-package-release-wave.md)** - Atomic 7-package release coordination
  - Reverse dep-graph publish order (`kailash → dataflow → nexus → kaizen → pact → align → ml`)
  - Per-package version owner + sole CHANGELOG owner rules (parallel-worktree safe)
  - Pre-flight build + twine + TestPyPI dry-run for every package in the wave
  - Version consistency verification across 14 version locations
  - Rollback decision tree (mid-wave failure handling)
  - kailash-ml 1.0.0 M1 atomic wave (2026-04-23, 7 packages, 227 tests)

### Docker

- **[deployment-docker-quick](deployment-docker-quick.md)** - Docker deployment patterns
  - Dockerfile setup for Kailash apps
  - Docker Compose configurations
  - Multi-stage builds
  - Health checks

### Kubernetes

- **[deployment-kubernetes-quick](deployment-kubernetes-quick.md)** - Kubernetes deployment patterns
  - Deployment manifests
  - Service configuration
  - Scaling strategies

### Git Workflow

- **[git-workflow-quick](git-workflow-quick.md)** - Git workflow best practices
  - Branching strategies
  - Commit conventions
  - Pull request workflow
  - Code review process
  - Release management
  - Hotfix procedures

### GitHub Management

- **[github-management-patterns](github-management-patterns.md)** - GitHub project and issue management
  - Issue templates (User Story, Bug, Technical Task)
  - Story points and estimation
  - Project board organization
  - Label system

### Project Management

- **[project-management](project-management.md)** - Project management architecture
  - Dual-tracking system overview
  - GitHub Issues vs Local Todos
  - Agent coordination flow
  - Sprint management

- **[todo-github-sync](todo-github-sync.md)** - Todo ↔ GitHub issues sync patterns
  - Naming conventions (Story X format)
  - Workflow for creating, starting, completing stories
  - Sub-issue management
  - Label system
  - Periodic sync checklists
  - Agent coordination (todo-manager ↔ gh-manager)

## SDK Release Patterns

### Release Flow

```
Version bump + CHANGELOG → Build wheels → TestPyPI → Verify → PyPI → GitHub Release → Deploy Docs
```

### CI-Triggered Release (Preferred)

```
git tag v1.2.3 → push tag → CI builds wheels → CI tests → CI publishes TestPyPI → CI publishes PyPI → CI creates GitHub Release
```

### Multi-Package Release Order

```
kailash (core)
  ↓
kailash-dataflow (depends on core)
kailash-nexus (depends on core)
kailash-kaizen (depends on core)
```

## Git Workflow Patterns

### Branch Strategy

```
main (production)
  ↓
develop (integration)
  ↓
feature/* (new features)
hotfix/* (urgent fixes)
release/* (release prep)
```

### Commit Conventions

```
feat: Add user authentication workflow
fix: Resolve async runtime threading issue
docs: Update DataFlow integration guide
test: Add cycle workflow test cases
chore: Bump version to 0.9.25
```

## Critical Rules

### SDK Release

- Run full test suite before any release
- TestPyPI validation required for major/minor releases
- Wheel-only publishing for proprietary code
- Version consistency across all sub-packages
- Publish in dependency order (core first)
- Security review before every publish
- NEVER commit PyPI tokens to source
- NEVER publish with failing CI

### Git

- Use feature branches for development
- Write descriptive commit messages
- Squash commits before merging
- Use pull requests for code review
- Tag releases semantically
- NEVER commit directly to main
- NEVER force push to shared branches
- NEVER commit sensitive data

## When to Use This Skill

Use this skill when you need to:

- Run SDK release onboarding for a new project
- Release packages to PyPI or GitHub
- Set up or debug CI/CD pipelines
- Configure GitHub Actions workflows
- Build multi-platform wheels
- Deploy documentation
- Coordinate multi-package releases
- Establish Git workflows
- Manage test matrices

## Related Skills

- **[03-nexus](../03-nexus/SKILL.md)** - Application deployment (end-user)
- **[02-dataflow](../02-dataflow/SKILL.md)** - Database operations
- **[01-core-sdk](../01-core-sdk/SKILL.md)** - Runtime selection
- **[17-gold-standards](../17-gold-standards/SKILL.md)** - Release best practices

## Support

For SDK release help, invoke:

- `release-specialist` - Release onboarding, PyPI publishing, CI management
- `release-specialist` - Git workflows, releases, version management
