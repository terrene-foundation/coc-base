# Todo ↔ GitHub Issues Synchronization Guide

**Last Updated**: 2025-10-13
**Purpose**: Maintain perfect 1:1 sync between local todo system and GitHub issues/projects

---

## 🎯 Core Principles

### 1. Single Source of Truth per Concern
- **Local Todos** (`todos/`): Detailed implementation plans, ADRs, checklists
- **GitHub Issues**: Public tracking, team coordination, story points, sprint assignment
- **Both Must Sync**: Status, story points, dependencies, completion dates

### 2. Naming Conventions

#### User Stories (Primary Todos)
**Format**: `TODO-XXX-feature-name.md` → `Story X: Feature Name (N pts)`

**Examples:**
```
TODO-001-search-filter-contacts.md
  → Issue #1: "Story 1: Search & Filter Centralised Contacts (8 pts)"

TODO-017-core-intelligence-infrastructure.md
  → Issue #21: "Story 17: Core Intelligence Infrastructure (13 pts)"
```

**Rules:**
- **CRITICAL**: Story number MUST EXACTLY match TODO number. NO EXCEPTIONS.
  - TODO-001 = Story 1
  - TODO-016 = Story 16
  - TODO-031 = Story 31 (NOT Story 22, NOT Story 20, exactly 31)
  - TODO-032 = Story 32 (NOT Story 23, exactly 32)
  - TODO-033 = Story 33 (NOT Story 20, exactly 33)
  - TODO-034 = Story 34 (NOT Story 21, exactly 34)
  - **Sub-issues have TODO numbers and uses "Story N (sub-issue):" titles**
  - Sub-issues use descriptive titles like "P0: Feature Name" with parent:story-X labels
  - **This rule is MANDATORY and STRICTLY ENFORCED. Violations must be corrected immediately.**
- Title MUST include story points in parentheses
- Title MUST be descriptive of the feature
- NO "TODO-" prefix in GitHub issue titles (use "Story X" instead for user stories)

#### Sub-Issues (Implementation Tasks)
**Format**: `Story N (sub-issue): Descriptive Title (X pts)`

**Examples:**
```
"Story 1 (sub-issue): P0 Search Contacts - Critical UX Fixes (5 pts)"
  → Sub-issue of Issue #1 (Story 1: Search & Filter)
  → Label: "parent:story-1"

"Story 7 (sub-issue): Backend Login Workflow Implementation (8 pts)"
  → Sub-issue of Issue #7 (Story 7: RBAC)
  → Label: "parent:story-7"
```

**Rules:**
- **CRITICAL**: Title MUST start with "Story N (sub-issue):" where N is the parent story number
- This makes tracking much easier - you can immediately see which story a sub-issue belongs to
- MUST have `parent:story-N` label linking to parent issue
- CAN have story points if they're part of the parent's total
- CAN use prefixes after sub-issue marker: "Story 1 (sub-issue): P0:", "Story 7 (sub-issue): Enhancement:", etc.

### 3. Story Number Mapping

| Local TODO | GitHub Issue | Story # | Status |
|------------|--------------|---------|--------|

**Notes**:
- Story numbers STRICTLY match TODO numbers
- Sub-issues are titled "Story N (sub-issue): Description" for easy tracking
- Sub-issues keep their TODO numbers (TODO-020, TODO-021, etc.)

---

## 📋 Synchronization Workflows

### Workflow 1: Creating a New User Story

**Local (todo-manager)**:
1. Create `todos/active/TODO-XXX-feature-name.md`
2. Add to `todos/000-master.md` with:
   - Story points
   - Priority (P0/P1/P2)
   - Phase assignment
   - Dependencies
   - GitHub Issue: `#TBD`

**GitHub (gh-manager)**:
3. Create issue with title: `Story X: Feature Name (N pts)`
4. Add labels:
   - Priority: `p0`, `p1`, or `P0-critical`, `P1-important`, `P2-polish`
   - Phase: `phase-1-foundation`, `phase-2-core`, `phase-3-quality`, `phase-4-intelligence`
   - Sprint: `sprint-1`, `sprint-2`, `sprint-3` (if assigned)
   - Status: `ready-to-start`
5. Set description with:
   - Phase and priority explanation
   - Dependencies (links to blocking issues)
   - What this unblocks (links to dependent issues)
   - Story points and effort estimate
   - Acceptance criteria

**Sync Back (todo-manager)**:
6. Update `TODO-XXX-feature-name.md` header:
   ```markdown
   - GitHub Issue: #YY
   ```
7. Update `todos/000-master.md`:
   ```markdown
   - TODO-XXX: Feature Name
     - GitHub Issue: #YY
   ```

### Workflow 2: Starting Work on a Story

**Local (todo-manager)**:
1. Move `TODO-XXX` from `todos/active/` to current sprint folder (if exists)
2. Update status in `000-master.md`: `Status: IN PROGRESS`
3. Create implementation checklist in `TODO-XXX` file

**GitHub (gh-manager)**:
4. Add comment: `"Started implementation - Sprint X Day Y"`
5. Update labels: Remove `ready-to-start`, add `in-progress`
6. Add to current sprint column in GitHub Project

### Workflow 3: Completing a Story

**Local (todo-manager)**:
1. Move `TODO-XXX` from `todos/active/` to `todos/completed/`
2. Add completion summary to file header:
   ```markdown
   **COMPLETED**: 2025-XX-XX (Sprint X)
   **Achievement Summary**:
   - [Key achievements]
   - [Metrics]
   - [Tests passing]
   - [Story points delivered]
   ```
3. Update `000-master.md`:
   - Mark with ✅
   - Update completion statistics
   - Update unblocked stories

**GitHub (gh-manager) - COMPREHENSIVE UPDATE REQUIRED**:
4. **Update issue body** (NOT just comments):
   - Mark all completed checklist items with [x]
   - Update status fields in issue description
   - Add "COMPLETED" banner at top of description
   - Update any "Status:" fields to show "COMPLETED"

5. **Fill in all GitHub fields**:
   - Assignees: Add developers who worked on it
   - Labels: Ensure `completed`, `sprint-X`, `phase-X-Y`, priority labels present
   - Remove: `in-progress`, `ready-to-start`, `blocked` labels
   - Milestone: Set to appropriate sprint/release milestone
   - Project: Update project board status to "Done"
   - Linked PRs: Link any related pull requests

6. **Add completion comment** with full template:
   ```markdown
   ## ✅ Story X Completed - Sprint Y

   **Completion Date**: 2025-XX-XX
   **Story Points Delivered**: [N] pts
   **Actual Effort**: [X] days

   ### Achievement Summary
   - [Key achievement 1]
   - [Key achievement 2]
   - [Performance metrics]
   - [Test results]

   ### Files Added/Modified
   - [List of key files]

   ### Unblocked Stories
   This completion unblocks:
   - #YY: Story Y
   - #ZZ: Story Z

   ### Documentation
   - [Link to implementation docs]
   - [Link to test results]
   ```

7. Close issue (only after steps 4-6 complete)

**CRITICAL**: Information must be in issue fields AND body, not just comments!

### Workflow 4: Creating a Sub-Issue

**When to Create Sub-Issues:**
- Implementation tasks within a user story
- Bug fixes related to a story
- Technical debt items within a story
- Enhancements that don't warrant full story

**GitHub (gh-manager)**:
1. Create issue with descriptive title (NOT "Story X" format)
2. Add labels:
   - `parent:story-X` (link to parent)
   - Priority: `p0`, `p1`, `P0-critical`, etc.
   - Type: `enhancement`, `bug`, `tech-debt`
3. Link to parent issue in description:
   ```markdown
   **Parent Story**: #X (Story X: Parent Name)
   ```
4. If has story points, note they're part of parent's total

**Local (todo-manager)**:
5. Add to parent `TODO-XXX` file under "Sub-Tasks" section:
   ```markdown
   ### Sub-Tasks
   - [ ] GitHub Issue #YY: Sub-task name
   ```
6. **Do NOT** create separate TODO file for sub-issues

---

## 🏷️ Label System

### Priority Labels
- `P0-critical` or `p0`: Must have, blocks other work
- `P1-important` or `p1`: Should have, important feature
- `P2-polish` or `p2`: Nice to have, polish

### Phase Labels (Roadmap)
- `phase-1-foundation`: Weeks 1-2, foundational features
- `phase-2-core`: Weeks 3-4, core features
- `phase-3-quality`: Weeks 5-6, quality and polish
- `phase-4-intelligence`: Weeks 7-8, AI and analytics

### Sprint Labels
- `sprint-1`: Sprint 1 (Oct 8-12, 2025)
- `sprint-2`: Sprint 2 (Oct 13-19, 2025)
- `sprint-3`: Sprint 3 (Oct 20-26, 2025)
- etc.

### Status Labels
- `ready-to-start`: All dependencies met, ready for implementation
- `in-progress`: Currently being worked on
- `blocked`: Blocked by dependencies or issues
- `completed`: Work completed and validated

### Type Labels (for sub-issues)
- `enhancement`: Enhancement to existing feature
- `bug`: Bug fix
- `tech-debt`: Technical debt cleanup
- `documentation`: Documentation work

### Parent Link Labels (for sub-issues)
- `parent:story-1`, `parent:story-2`, etc.

### Technology Labels
- `backend`, `frontend`, `database`, `ai-ml`, `external-api`, etc.

---

## 🚨 Common Sync Issues and Fixes

### Issue 1: Duplicate Story Numbers
**Problem**: Multiple GitHub issues with same Story number (e.g., two "Story 18" issues)

**Root Cause**:
- Issue created before TODO renumbering
- Issue created with wrong Story number

**Fix**:
1. Identify which is the correct mapping (check `000-master.md`)
2. Close the incorrect issue with comment:
   ```
   Closing as duplicate. This story is tracked in #XX (correct issue).
   ```
3. Add `duplicate` label to closed issue
4. Update correct issue to match TODO file

### Issue 2: TODO-to-Issue Mismatch
**Problem**: TODO-016 in local system maps to Issue #20, but Issue #20 is closed

**Root Cause**:
- Story was redefined/replaced
- Old issue not updated

**Fix**:
1. Check `000-master.md` for correct mapping
2. If story was replaced:
   - Add comment to old issue: `"This story was replaced by TODO-XXX (Issue #YY)"`
   - Close old issue
   - Create new issue for new story
3. Update `000-master.md` with correct mapping

### Issue 3: Sub-Issue Has "Story X" Title
**Problem**: Sub-issue titled "Story 18: Feature" instead of descriptive name

**Root Cause**: Created with wrong naming convention

**Fix**:
1. Rename issue to descriptive title
2. Add `parent:story-X` label
3. Add parent link in description
4. Remove "Story X" format from title

### Issue 4: Missing GitHub Issue Reference
**Problem**: `TODO-XXX` file exists but has `GitHub Issue: #TBD`

**Fix**:
1. Search GitHub for issue with matching story number
2. If exists: Update TODO file with correct issue number
3. If doesn't exist: Create issue following Workflow 1

### Issue 5: Status Mismatch
**Problem**: Local TODO is completed but GitHub issue is open (or vice versa)

**Fix**:
1. Determine correct status (check git history, verify completion)
2. Sync both systems to match correct status
3. If completed: Add completion summary to both
4. If still active: Remove completion marks, reopen issue

---

## 🔄 Periodic Sync Checklist

### Daily (During Active Development)
- [ ] Check all `in-progress` issues have matching active TODOs
- [ ] Update issue comments with daily progress
- [ ] Mark completed sub-tasks in both systems

### End of Sprint
- [ ] Move completed TODOs to `todos/completed/`
- [ ] Close completed GitHub issues with summaries
- [ ] Update `000-master.md` completion statistics
- [ ] Verify all issue-TODO mappings are correct
- [ ] Update GitHub Project board status

### Monthly (Housekeeping)
- [ ] Audit all TODO files for correct GitHub issue references
- [ ] Audit all GitHub issues for correct Story numbers
- [ ] Close duplicate issues with proper comments
- [ ] Fix any naming convention violations
- [ ] Update this guide with new patterns/issues discovered

---

## 🤖 Agent Roles

### todo-manager Agent
**Responsibilities:**
- Manages `todos/` directory structure
- Updates `000-master.md` master list
- Moves TODOs between active/completed folders
- Maintains local implementation details and ADRs
- Validates story points and dependencies locally

**Key Files:**
- `todos/000-master.md` (master list)
- `todos/active/TODO-*.md` (active stories)
- `todos/completed/TODO-*.md` (completed stories)
- `todos/EXECUTION_PLAN.md` (sprint planning)

### gh-manager Agent
**Responsibilities:**
- Creates/updates GitHub issues
- Applies labels and milestones
- Manages GitHub Project board
- Closes issues with completion summaries
- Validates issue-TODO mapping

**Key Operations:**
- `gh issue create` - Create new issue
- `gh issue edit` - Update title, labels, assignees
- `gh issue close` - Close with comment
- `gh issue list` - Audit current state
- `gh project item-add` - Add to project board

### Coordination Protocol
1. **todo-manager** updates local files first
2. **gh-manager** syncs GitHub to match local state
3. Both validate each other's changes
4. Conflicts resolved by checking `000-master.md` (source of truth for mapping)

---

## 📝 Templates

### New User Story Issue Template
```markdown
## Story X: [Feature Name] ([N] pts)

**Phase**: [Phase 1/2/3/4]
**Priority**: [P0/P1/P2]
**Sprint**: [Sprint X] (if assigned)
**Local TODO**: `TODO-XXX-feature-name.md`

## Context
[Why this story exists, business value]

## Dependencies
**Blocked By**:
- #XX: [Story Name]

**Blocks**:
- #YY: [Story Name]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Technical Approach
[High-level technical approach]

## Story Points: [N]
**Effort Estimate**: [X] days
**Complexity**: [Low/Medium/High]

## Related Sub-Issues
- #ZZ: [Sub-issue name]
```

### Completion Comment Template
```markdown
## ✅ Story X Completed - Sprint Y

**Completion Date**: 2025-XX-XX
**Story Points Delivered**: [N] pts
**Actual Effort**: [X] days

### Achievement Summary
- [Key achievement 1]
- [Key achievement 2]
- [Performance metrics]
- [Test results]

### Files Added/Modified
- [List of key files]

### Unblocked Stories
This completion unblocks:
- #YY: Story Y
- #ZZ: Story Z

### Documentation
- [Link to implementation docs]
- [Link to API docs]
- [Link to test results]

**Sprint Summary**: [Link to sprint summary doc]
```

---

## 🎯 Success Metrics

### Perfect Sync Indicators
- ✅ Every `TODO-XXX` file has correct `GitHub Issue: #YY`
- ✅ Every GitHub issue has matching local TODO file (or is marked as sub-issue)
- ✅ Story numbers match (TODO-001 = Story 1 = Issue #X)
- ✅ Status matches (completed locally = closed on GitHub)
- ✅ Story points match in both systems
- ✅ Dependencies listed in both systems
- ✅ No duplicate Story numbers in GitHub

### Audit Commands
```bash
# Check for TODOs without GitHub issues
grep -r "GitHub Issue: #TBD" todos/active/

# Check for mismatched status
diff <(grep "Status: COMPLETED" todos/000-master.md) <(gh issue list --state closed)

# Check for duplicate Story numbers in GitHub
gh issue list --limit 100 | grep "Story" | sort | uniq -d
```

---

## 📚 References

- **Local Todos**: `
- **GitHub Repository**: `<your-org>/<your-project>`
- **GitHub Project**: `https://github.com/orgs/<your-org>/projects/<project-number>`
- **This Guide**: `.claude/guides/todo-github-sync-guide.md`

---

**Last Updated**: 2025-10-13
**Maintained By**: todo-manager + gh-manager agents
**Version**: 1.0
