---
priority: 10
scope: path-scoped
paths: ["**/*.py", "packages/**"]
---

# Refactor Invariant Rules


<!-- slot:neutral-body -->

Every refactor that claims to shrink a file MUST land a numeric invariant test in the same commit. Without the test, the next session's merge or edit silently re-inlines the extracted code with no signal.

Origin: Observed regression where a file was refactored from 2,103 to 994 LOC, a planned invariant test was never committed, and a subsequent worktree merge silently re-inlined 1,079 LOC of extracted code — growing the file back to 2,103 LOC with zero test failure.

## MUST Rules

### 1. LOC Invariant Test in the Same Commit as the Refactor

When a refactor reduces a file's line count, a test MUST be added in the same commit that asserts the file stays below a threshold. The threshold MUST be the post-refactor line count plus a small margin (10-15%).

```python
# DO — invariant test lands with the refactor
@pytest.mark.invariant
def test_base_agent_loc_invariant():
    """Guard: base_agent.py must stay under 1100 LOC after extraction."""
    path = Path("src/myapp/agents/base_agent.py")
    line_count = len(path.read_text().splitlines())
    assert line_count <= 1100, (
        f"base_agent.py has {line_count} lines (limit: 1100). "
        f"If code was extracted, it may have been re-inlined by a merge. "
        f"Check git log for unexpected growth."
    )

# DO NOT — plan the test, commit the refactor, never commit the test
# TODO: "Add LOC invariant test for base_agent.py" — status: planned
```

**Why:** The refactor commit is the only moment where the threshold is known and the intent is clear. Deferring the test means the guard never exists, and the next edit that grows the file has no signal.

### 2. Invariant Tests in CI Default Path

LOC invariant tests MUST be in the default `pytest` collection (no special marker exclusion, no separate test directory that CI skips). They MUST run on every CI build.

```python
# DO — in tests/unit/ or tests/regression/, collected by default
# tests/regression/test_loc_invariants.py

# DO NOT — in a special directory that CI skips
# tests/invariants/test_loc.py  (not in CI's pytest path)
```

**Why:** An invariant test that doesn't run in CI is decoration. The merge that re-inlines code passes CI, the test never fires, and the regression ships.

### 3. Stale-Base Detection Gate

Before merging any branch that touches a file with a LOC invariant, MUST verify the branch is rebased on the current main. Merging a stale branch that predates the extraction can re-inline the extracted code.

**Why:** The origin regression was caused by a worktree merge of a branch that forked before the extraction. The merge brought back the pre-extraction version of the file because git saw it as the "newer" change.

## MUST NOT

- Commit a refactor that reduces LOC without a corresponding invariant test

**Why:** The refactor without a guard is a temporary achievement that the next merge undoes. The test is the refactor's insurance policy.

- Place invariant tests outside the CI default test path

**Why:** An invariant test that doesn't run is a stub (zero-tolerance Rule 2).

- Merge branches that predate a file extraction without rebasing

**Why:** Git's 3-way merge sees the pre-extraction file as the "newer" version and silently re-inlines the extracted code.

<!-- /slot:neutral-body -->
