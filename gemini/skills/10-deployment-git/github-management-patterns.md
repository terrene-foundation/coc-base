---
name: github-management-patterns
description: "GitHub project and issue management patterns including issue templates, sync workflows, and project board organization. Use for 'GitHub issues', 'GitHub projects', 'issue templates', or 'project management'."
---

# GitHub Management Patterns

> **Skill Metadata**
> Category: `project-management`
> Priority: `MEDIUM`
> Tools: `gh` CLI

## Issue Templates

### User Story Format

```markdown
**User Story**: As a [persona], I want [goal] so that [benefit].

## Ready Criteria
- [ ] Specific prerequisite 1 (designs, decisions, etc.)
- [ ] Specific prerequisite 2
- [ ] Responsive UI mockups approved (if UI work)
- [ ] Technical dependencies identified

## Definition of Done

### Backend
- [ ] Specific backend task 1
- [ ] API endpoints implemented
- [ ] Database schema/migrations
- [ ] Unit and integration tests
- [ ] Documentation updated

### Frontend (if applicable)
- [ ] Responsive UI implementation
- [ ] Desktop layout (specify breakpoints)
- [ ] Mobile layout (specify breakpoints)
- [ ] Cross-device testing
- [ ] Accessibility compliance

## Story Points: X

**Rationale**: [Complexity explanation]

## Technical Notes
[Architecture decisions, integration points, risks]

## Related Issues
- Depends on: #XXX
- Blocks: #YYY
- Related to: #ZZZ
```

### Bug Issue Format

```markdown
## Description
[Clear description of the bug]

## Steps to Reproduce
1. Step one
2. Step two
3. Observed behavior

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happens]

## Environment
- OS: [e.g., macOS 14.0]
- Browser/Runtime: [e.g., Chrome 120, Python 3.11]
- Version: [e.g., v1.2.3]

## Additional Context
[Logs, screenshots, related issues]

## Acceptance Criteria
- [ ] Bug is reproducible
- [ ] Root cause identified
- [ ] Fix implemented and tested
- [ ] Regression test added
```

### Technical Task Format

```markdown
## Objective
[What needs to be accomplished]

## Context
[Why this is needed, background information]

## Acceptance Criteria
- [ ] Specific, measurable requirement 1
- [ ] Specific, measurable requirement 2
- [ ] All tests pass
- [ ] Documentation updated

## Technical Approach
[Proposed solution, architecture decisions]

## Dependencies
- [ ] Prerequisite task: #XXX
- [ ] External dependency: [description]

## Estimated Effort: [hours/days]
```

## Issue → Todo Sync Pattern

### Todo Creation from Issue

```markdown
# TODO-123: [Issue Title]

**GitHub Issue**: #123
**Issue URL**: https://github.com/org/repo/issues/123
**Status**: In Progress

## Description
[Copy from GitHub issue]

## Acceptance Criteria (from GitHub)
- [ ] Criterion 1 (links to GH issue)
- [ ] Criterion 2

## Implementation Subtasks
- [ ] Subtask 1 (Est: 2h) → Update GH on completion
- [ ] Subtask 2 (Est: 1h) → Update GH on completion

## Sync Points
- [ ] Update GH issue when starting: Comment "Started implementation"
- [ ] Update GH issue at 50% progress: Comment "Halfway through"
- [ ] Update GH issue when blocked: Add "blocked" label
- [ ] Close GH issue when all criteria met: Comment "Completed via [commit/PR]"
```

## GitHub CLI Commands

### Issue Creation

```bash
# Create issue with template
gh issue create \
  --repo org/repo \
  --title "Story X: Feature Name (Y pts)" \
  --body "$(cat <<'EOF'
[Structured user story content]
EOF
)"

# Add to project
gh project item-add <project-number> \
  --owner <org> \
  --url "https://github.com/org/repo/issues/<issue-number>"

# Set project field values
gh project item-edit \
  --id <item-id> \
  --project-id <project-id> \
  --field-id <field-id> \
  --text "In Progress"
```

### Status Sync Commands

```bash
# When starting a todo
gh issue comment <issue-number> --body "🔄 Implementation started in local todo system"

# When blocked
gh issue edit <issue-number> --add-label "blocked"
gh issue comment <issue-number> --body "⚠️ Blocked: [reason]"

# When completing
gh issue close <issue-number> --comment "✅ Completed. See [commit/PR link]"

# Progress updates
gh issue comment <issue-number> --body "📊 Progress: 50% complete. [Summary]"
```

### Query Sprint Issues

```bash
# Get sprint issues from project
gh project item-list <project-number> \
  --owner <org> \
  --format json \
  --limit 20
```

## Labeling Strategy

```
Type Labels:
- user-story, bug, task, epic, spike

Component Labels:
- backend, frontend, devops, documentation

Status Labels:
- blocked, needs-clarification, ready-for-review

Priority Labels:
- priority-critical, priority-high, priority-medium, priority-low
```

## Issue Workflow States

```
Backlog → Ready → In Progress → Review → Done

State Definitions:
- Backlog: Created but not prioritized
- Ready: Acceptance criteria defined, dependencies clear
- In Progress: Active development, has local todo
- Review: PR open, awaiting approval
- Done: Merged and deployed
```

## Epic → Story → Task Hierarchy

```
Epic #100: User Authentication System
├── Story #101: Login functionality (8 pts)
│   ├── Task #102: Backend API endpoints
│   └── Task #103: Frontend login form
└── Story #104: Password reset (5 pts)
    ├── Task #105: Email service integration
    └── Task #106: Reset flow UI
```

## Status Report Template

```markdown
## Project Status Report

### GitHub Project: [Project Name]
**URL**: [Project URL]
**Sprint**: [Current sprint]
**Date**: [Report date]

### Issue Summary
- Total Issues: X
- In Progress: Y (synced with Z local todos)
- Completed: A
- Blocked: B

### Sync Status
✅ Synced (both systems aligned): X issues
⚠️  Needs Sync (local changes not pushed): Y issues
❌ Conflict (divergent state): Z issues

### Active Work (Local Todos → GitHub Issues)
| Todo | GitHub Issue | Status | Last Sync |
|------|--------------|--------|-----------|
| TODO-123 | #123 | In Progress | 2h ago |

### Blockers Requiring Attention
1. Issue #XXX: [Blocker description] - Blocked for Xd

### Completed This Sprint
- Issue #AAA: [Feature] - Closed 2d ago
```

<!-- Trigger Keywords: GitHub issues, GitHub projects, issue templates, project management, gh cli, github sync, issue tracking, sprint planning -->
