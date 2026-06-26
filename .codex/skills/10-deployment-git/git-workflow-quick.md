---
name: git-workflow-quick
description: "Git workflow for SDK projects. Use when asking 'git workflow', 'branching strategy', or 'git best practices'."
---

# Git Workflow for SDK Projects

> **Skill Metadata**
> Category: `git`
> Priority: `MEDIUM`
> SDK Version: `0.9.25+`

## Branch Strategy

```bash
# Main branches
main          # Production-ready code
develop       # Integration branch

# Feature branches
feature/user-authentication
feature/payment-integration

# Release branches
release/v0.9.26

# Hotfix branches
hotfix/critical-bug
```

## Workflow

### 1. Start New Feature
```bash
# Create feature branch from develop
git checkout develop
git pull origin develop
git checkout -b feature/my-feature

# Make changes
git add .
git commit -m "feat: Add new feature"
git push origin feature/my-feature
```

### 2. Create Pull Request
```bash
# Use gh CLI
gh pr create --base develop --title "Add new feature" --body "Description..."

# Or via GitHub web UI
```

### 3. Merge to Develop
```bash
# After PR approval
git checkout develop
git merge feature/my-feature
git push origin develop
```

### 4. Release
```bash
# Create release branch
git checkout -b release/v0.9.26 develop

# Update version numbers, CHANGELOG
git commit -m "chore: Prepare v0.9.26 release"

# Merge to main
git checkout main
git merge release/v0.9.26
git tag v0.9.26
git push origin main --tags

# Merge back to develop
git checkout develop
git merge release/v0.9.26
```

## Commit Message Format

```bash
# Format: type(scope): description

feat(dataflow): Add PostgreSQL support
fix(runtime): Resolve threading bug
docs(readme): Update installation guide
test(workflows): Add integration tests
chore(deps): Bump dependencies
```

## Best Practices

1. **Feature branches** - One feature per branch
2. **Small commits** - Atomic, focused changes
3. **Descriptive messages** - Clear commit descriptions
4. **Pull requests** - Always use PRs for code review
5. **Tests pass** - Run tests before committing
6. **Sync often** - Pull from develop frequently

<!-- Trigger Keywords: git workflow, branching strategy, git best practices, git branching -->
