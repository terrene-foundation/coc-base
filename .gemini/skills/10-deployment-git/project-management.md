# Project Management Guide: GitHub & Local Todo Synchronization

## Overview

This project uses a **dual-tracking system** that keeps GitHub Projects (for stakeholder visibility) synchronized with local todos (for developer implementation). This guide explains best practices for managing both systems effectively.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Project Management Flow                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Requirements/User Stories                                   │
│         ↓                                                    │
│  [gh-manager] → Creates GitHub Issues                        │
│         ↓                                                    │
│  GitHub Project (Stakeholder View)                           │
│         ↓                                                    │
│  [todo-manager] → Creates Local Todos                        │
│         ↓                                                    │
│  Local Todo System (Developer View)                          │
│         ↓                                                    │
│  Implementation Progress                                     │
│         ↓                                                    │
│  [todo-manager] → Syncs to [gh-manager]                      │
│         ↓                                                    │
│  GitHub Issues Updated (Real-time Status)                    │
│         ↓                                                    │
│  Project Board Reflects Current State                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Two Systems, One Source of Truth

### GitHub Issues (Project-Level Tracking)
**Purpose**: Stakeholder visibility, project management, requirements tracking

**Managed by**: `gh-manager` subagent

**Contains**:
- User stories with acceptance criteria
- Story point estimates
- Epic/story/task hierarchy
- Project milestones and sprints
- Stakeholder comments and decisions

**Source of Truth For**:
- Requirements and acceptance criteria
- Business priorities and story points
- Project-level dependencies
- Release planning

### Local Todos (Implementation Tracking)
**Purpose**: Developer task breakdown, implementation progress, technical details

**Managed by**: `todo-manager` subagent

**Contains**:
- Detailed implementation subtasks (1-2 hour chunks)
- Technical approach and architecture notes
- Test requirements and verification steps
- Risk assessment and mitigation
- Code-level dependencies

**Source of Truth For**:
- Implementation status and progress
- Technical approach and decisions
- Actual time spent vs estimated
- Implementation blockers and solutions

## Synchronization Rules

### Bidirectional Sync Model

```
GitHub Issues ←→ Local Todos
     ↓                ↓
Requirements    Implementation
(What & Why)    (How & Status)
```

### Sync Trigger Points

1. **Issue Created (GH → Local)**
   ```
   gh-manager creates issue → todo-manager creates TODO-{issue#}-feature.md
   ```

2. **Implementation Started (Local → GH)**
   ```
   todo-manager status: IN_PROGRESS → gh-manager comments: "🔄 Implementation started"
   ```

3. **Progress Update (Local → GH)**
   ```
   todo-manager 50% complete → gh-manager comments: "📊 Progress: 50% complete"
   ```

4. **Blocker Encountered (Local → GH)**
   ```
   todo-manager status: BLOCKED → gh-manager adds "blocked" label + comment
   ```

5. **Implementation Complete (Local → GH)**
   ```
   todo-manager status: COMPLETED → gh-manager closes issue with PR reference
   ```

### Conflict Resolution Priority

When GitHub and local todos diverge:

| Conflict Type | Resolution | Priority |
|--------------|------------|----------|
| **Requirements changed in GH** | Update local todo acceptance criteria | GitHub wins |
| **Acceptance criteria updated** | Sync to local todo | GitHub wins |
| **Implementation status differs** | Update GitHub from local | Local wins |
| **Technical approach changed** | Keep in local, notify in GH comment | Local wins |
| **Story points adjusted** | Update local estimate | GitHub wins |
| **Blocker added locally** | Sync to GitHub immediately | Local wins |

**Resolution Process**:
1. Detect conflict (automated or manual)
2. Determine conflict type (requirements vs status)
3. Apply priority rule (GitHub or Local wins)
4. Document resolution in both systems
5. Validate sync is restored

## Developer Workflows

### Workflow 1: Starting Work on a New Feature

```bash
# Step 1: Requirements analyst creates user stories
> Use the analyst subagent to break down [feature] into user stories

# Step 2: Create GitHub issues
> Use the gh-manager subagent to create GitHub issues from user stories and add to project

# Output: GitHub issues #101, #102, #103 created

# Step 3: Create local todos
> Use the todo-manager subagent to create local todos from GitHub issues #101-103

# Output: todos/active/TODO-101-feature.md (linked to GH #101)

# Step 4: Start implementation
# Developer updates TODO-101.md status to IN_PROGRESS
# todo-manager automatically syncs to GitHub via gh-manager

# Result: GitHub #101 shows "🔄 Implementation started" comment
```

### Workflow 2: Daily Development Cycle

```bash
# Morning: Check GitHub for requirement updates
gh issue view 101  # Check for comments/changes

# If requirements changed:
> Use the todo-manager subagent to update TODO-101 acceptance criteria from GH #101

# During development: Update progress
# At 50% completion, update TODO-101.md progress
> Use the todo-manager subagent to sync progress to GitHub #101

# Result: GitHub #101 shows "📊 Progress: 50% complete" comment

# If blocked:
# Update TODO-101.md with blocker details
> Use the todo-manager subagent to mark TODO-101 as blocked and sync to GH

# Result: GitHub #101 has "blocked" label + blocker description
```

### Workflow 3: Completing Work

```bash
# Step 1: Verify all acceptance criteria met
# Check TODO-101.md acceptance criteria against implementation

# Step 2: Run tests and validation
pytest tests/  # Ensure all tests pass

# Step 3: Update todo as complete
> Use the todo-manager subagent to mark TODO-101 as completed

# Step 4: Create PR
> Use the release-specialist subagent to create PR for feature

# Step 5: Close GitHub issue
> Use the gh-manager subagent to close #101 with PR reference

# Result:
# - Local: TODO-101.md moved to todos/completed/
# - GitHub: Issue #101 closed with "✅ Completed via PR #456"
# - Project: Card moved to "Done" column
```

### Workflow 4: Sprint Planning

```bash
# Step 1: Prioritize backlog in GitHub
> Use the gh-manager subagent to organize sprint items in GitHub project

# Step 2: Create sprint todos
> Use the todo-manager subagent to create local todos for sprint items

# Output: Local todos created for all sprint issues

# Step 3: Review task breakdown
> Use the reviewer subagent to validate todo completeness

# Step 4: Begin implementation
# Developers work through todos with automatic sync to GitHub
```

### Workflow 5: Handling Blockers

```bash
# Developer encounters blocker during implementation

# Step 1: Update local todo
# Edit TODO-101.md, add blocker details in Risk Assessment section
# Change status to BLOCKED

# Step 2: Sync to GitHub
> Use the todo-manager subagent to sync blocker to GitHub #101

# Result:
# - GitHub #101 gets "blocked" label
# - Comment added: "⚠️ Blocked: [description]"
# - Stakeholders notified via GitHub

# Step 3: Work with team to resolve
# When blocker resolved, update TODO-101.md status back to IN_PROGRESS

# Step 4: Sync resolution
> Use the todo-manager subagent to update GH #101 with resolution

# Result:
# - "blocked" label removed
# - Comment added: "✅ Blocker resolved: [solution]"
```

## Best Practices

### For GitHub Issues (gh-manager)

1. **Consistent Naming**
   - User Stories: `Story X: Feature Name (Y pts)`
   - Bugs: `Bug: Short description`
   - Tasks: `Task: Objective`

2. **Complete Structure**
   - Always include acceptance criteria
   - Document story points in title
   - Link related issues (depends on, blocks, related to)
   - Add appropriate labels (type, component, priority)

3. **Regular Updates**
   - Comment on significant progress (25%, 50%, 75%)
   - Document decisions made during implementation
   - Update when blockers encountered or resolved
   - Close with PR reference when complete

### For Local Todos (todo-manager)

1. **Link to GitHub**
   - Always include GitHub issue number at top
   - Use format: `TODO-{issue-number}-feature-name.md`
   - Reference issue URL for easy access

2. **Detailed Breakdown**
   - Break into 1-2 hour subtasks
   - Include verification criteria for each subtask
   - Document technical approach and decisions
   - Track actual vs estimated time

3. **Sync Discipline**
   - Update status immediately when starting work
   - Sync at 50% completion milestone
   - Mark blocked immediately with details
   - Archive to completed/ when done

### For Synchronization

1. **Proactive Sync**
   - Don't wait for daily standup to sync status
   - Update GitHub immediately on significant changes
   - Use automated sync at trigger points

2. **Conflict Prevention**
   - Check GitHub for updates before starting work
   - Communicate requirement changes in both systems
   - Document conflicts immediately when detected

3. **Traceability**
   - Every commit message references issue: `Fixes #101`, `Relates to #102`
   - Every PR linked to issues it addresses
   - Every todo linked to its GitHub issue

## Common Anti-Patterns to Avoid

### ❌ Don't Do This

1. **Divergent Systems**
   ```
   ❌ Update local todo but forget to sync to GitHub
   ❌ Close GitHub issue but leave local todo active
   ❌ Create local todo without GitHub issue for project work
   ```

2. **Poor Linking**
   ```
   ❌ Create TODO-001.md without GitHub issue reference
   ❌ Use generic names: TODO-feature.md instead of TODO-101-feature.md
   ❌ Forget to reference PR when closing issues
   ```

3. **Information Silos**
   ```
   ❌ Keep technical decisions only in local todos
   ❌ Discuss blockers only in GitHub without updating local todos
   ❌ Track progress only locally without syncing to GitHub
   ```

### ✅ Do This Instead

1. **Synchronized Updates**
   ```
   ✅ Update local todo → immediately sync to GitHub
   ✅ See GH requirement change → update local todo acceptance criteria
   ✅ Complete PR → close both local todo and GitHub issue
   ```

2. **Proper Linking**
   ```
   ✅ Create TODO-101-feature.md with GitHub issue #101 at top
   ✅ Include issue URL in todo for easy navigation
   ✅ Reference commits and PRs when closing issues
   ```

3. **Shared Context**
   ```
   ✅ Document important decisions in both systems
   ✅ Sync blocker details to GitHub for team visibility
   ✅ Keep stakeholders informed via GitHub, devs informed via todos
   ```

## Subagent Usage Guide

### When to Use gh-manager

```bash
# Creating project artifacts
> Use gh-manager to create GitHub issues from requirements
> Use gh-manager to add issues to project board
> Use gh-manager to generate sprint status reports

# Updating project status
> Use gh-manager to close issues with PR references
> Use gh-manager to add labels (blocked, needs-review)
> Use gh-manager to update project board status
```

### When to Use todo-manager

```bash
# Local development tracking
> Use todo-manager to create todos from GitHub issues
> Use todo-manager to break down tasks into subtasks
> Use todo-manager to track implementation progress

# Syncing to GitHub
> Use todo-manager to sync status changes to GH
> Use todo-manager to update GH with blocker details
> Use todo-manager to close GH issues on completion
```

### Agent Coordination

```bash
# Typical workflow coordination:

# 1. Create project structure
analyst → gh-manager → todo-manager

# 2. During implementation
tdd-implementer → pattern-expert → todo-manager (sync) → reviewer

# 3. On completion
release-specialist → gh-manager (close issues) → todo-manager (archive)
```

## Verification Checklist

Use this checklist to verify proper sync:

### Daily Verification
- [ ] All active local todos have GitHub issue references
- [ ] GitHub issues match local todo status (in-progress, blocked, etc.)
- [ ] No todos in `active/` with closed GitHub issues
- [ ] No closed GitHub issues with active local todos

### Sprint Boundaries
- [ ] All sprint issues have corresponding local todos
- [ ] All active todos link to sprint issues
- [ ] Completed todos archived, GitHub issues closed
- [ ] Project board reflects actual completion status

### Release Time
- [ ] All completed work has closed GitHub issues
- [ ] All closed issues have merged PRs
- [ ] All PRs reference their GitHub issues
- [ ] Project board shows accurate sprint completion

## Troubleshooting

### Issue: Todo and GitHub Status Diverged

**Symptoms**: Local todo shows "COMPLETED" but GitHub issue still open

**Diagnosis**:
```bash
# Check todo file
cat todos/active/TODO-101-feature.md | grep "Status:"

# Check GitHub issue
gh issue view 101 --json state
```

**Resolution**:
```bash
# Sync local completion to GitHub
> Use gh-manager to close issue #101 with completion details

# Or if GitHub is correct, update local
> Use todo-manager to sync status from GitHub #101
```

### Issue: Multiple Todos for Same Issue

**Symptoms**: Found TODO-101-feature.md and TODO-feature.md both referencing #101

**Resolution**:
```bash
# Identify the correct todo (one with full GitHub reference)
# Archive the duplicate
mv todos/active/TODO-feature.md todos/active/DUPLICATE-TODO-feature.md

# Document in both
echo "## Duplicate - See TODO-101-feature.md" >> todos/active/DUPLICATE-TODO-feature.md
```

### Issue: GitHub Issue Changed, Todo Outdated

**Symptoms**: Acceptance criteria in GitHub updated, local todo has old criteria

**Resolution**:
```bash
# Update local todo from GitHub
> Use todo-manager to update TODO-101 acceptance criteria from GH #101

# Verify sync
diff <(cat TODO-101.md | grep "Acceptance Criteria" -A 10) \
     <(gh issue view 101 | grep "Acceptance Criteria" -A 10)
```

## Summary

**Key Principles**:
1. **GitHub = Requirements**, Local Todos = Implementation
2. **Sync proactively**, don't wait for conflicts
3. **Link everything**, maintain traceability
4. **Use the right tool**: gh-manager for projects, todo-manager for tasks
5. **Keep both systems current**, they serve different audiences

**Remember**:
- Stakeholders look at GitHub for project status
- Developers use local todos for implementation details
- Both must stay synchronized for effective project management
