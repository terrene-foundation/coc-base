# Parallel Worktree Merge Workflow

When multiple agents modify the same file in parallel worktrees, use this workflow to merge their changes deterministically.

## When to Use

- 3+ agents implementing independent features that all touch the same central file (e.g., `engine.py`, `base_agent.py`)
- Each agent's worktree passes its own tests in isolation
- The main tree has diverged from HEAD during the session (e.g., unrelated fixes applied)

## The Merge Protocol

### 1. Identify unique variants

Each worktree branches from the committed HEAD and applies ONE feature. Filter worktrees by feature marker:

```bash
for wt in .claude/worktrees/agent-*/; do
    f="${wt}src/kailash/trust/pact/engine.py"
    [ -f "$f" ] || continue
    n1=$(grep -c "KnowledgeFilter" "$f")
    n2=$(grep -c "_envelope_cache" "$f")
    n3=$(grep -c "suspend_plan" "$f")
    # One worktree per feature
    [ "$n1" -gt 0 ] && echo "$(basename $wt): N1"
done
```

### 2. Generate per-feature diffs vs HEAD

Each diff isolates one feature's additions without entanglement:

```bash
git show HEAD:src/kailash/trust/pact/engine.py > /tmp/engine_head.py
diff -u /tmp/engine_head.py .claude/worktrees/agent-XXX/src/kailash/trust/pact/engine.py > /tmp/n1.patch
```

### 3. Delegate the merge to a specialist

Do NOT try to apply patches with `patch` — line offsets will drift. Instead, hand the diffs to a specialist agent with explicit injection point documentation:

```
For each feature, tell the agent:
- Which imports to add
- Which __init__ params to add (and ordering)
- Which __init__ body fields to initialize
- Which methods to add (new)
- Which existing methods to modify (and where)
```

The agent reads the current main tree file and applies changes section by section using Edit.

### 4. Handle interaction points

Features that both touch the same method need explicit ordering instructions. Example from the PACT N1-N5 merge:

- N2 and N5 both add code to `grant_clearance`, `approve_bridge`, `set_role_envelope`
- N2 adds cache invalidation INSIDE the lock
- N5 adds observation emits OUTSIDE the lock (after audit)
- Both must be present; document the order explicitly

### 5. Verify with tests

Run the specialist's own test suite to verify the merge compiles and all features work together. Then run the project-wide suite to catch regressions from interaction points.

### 6. Stale-base detection (MUST — pre-merge gate)

Before merging a worktree branch, check if its merge-base is older than the target branch's latest changes to the same files. If the two sides differ by >200 lines on the same file, **STOP** and require human disambiguation.

```bash
# For each worktree about to merge, compare LOC of shared files
TARGET_FILE="packages/kailash-kaizen/src/kaizen/core/base_agent.py"
for wt in .claude/worktrees/agent-*/; do
    wt_file="${wt}${TARGET_FILE}"
    [ -f "$wt_file" ] || continue
    main_loc=$(wc -l < "$TARGET_FILE")
    wt_loc=$(wc -l < "$wt_file")
    delta=$(( wt_loc - main_loc ))
    abs_delta=${delta#-}
    if [ "$abs_delta" -gt 200 ]; then
        echo "STOP: $(basename $wt) diverges by ${abs_delta} lines on ${TARGET_FILE}"
        echo "  main: ${main_loc} LOC, worktree: ${wt_loc} LOC"
        echo "  Requires human disambiguation before merge"
    fi
done
```

**Why:** On 2026-04-10 a worktree based on a pre-slimming HEAD (3681 LOC) merged into a post-slimming target (994 LOC), silently re-inlining 1,079 lines. The 2,687-line delta would have triggered this gate.

### 7. Mandatory numeric invariants (MUST — same-commit rule)

Every refactor that shrinks, extracts, or consolidates a file MUST land a programmatic invariant test in the **same commit** as the extraction. The test MUST be in CI's default test path.

```python
# tests/invariants/test_<module>_line_count.py
import pathlib

TARGET = pathlib.Path("path/to/slimmed_module.py")
HARD_LIMIT = 1000  # set to ~120% of post-refactor LOC

def test_module_stays_under_budget():
    loc = len(TARGET.read_text().splitlines())
    assert loc < HARD_LIMIT, (
        f"{TARGET.name} grew to {loc} LOC (budget: <{HARD_LIMIT}). "
        f"Likely a merge regression re-inlined extracted code."
    )
```

**Why:** SPEC-04's TASK-04-50 planned this test but never committed it. The regression was invisible for two sessions because no test checked the line count.

### 8. Post-merge invariant re-check (MUST)

After each worktree merge, re-run the numeric invariants. A violation is a **STOP** signal — do not proceed to the next merge.

```bash
# Re-check after each merge
uv run pytest tests/invariants/ -x --tb=short -q
```

**Why:** Without per-merge checks, a regression from merge 2 compounds through merges 3-5 and is discovered only at the end of the session.

## Anti-Patterns

- **Sequential worktree rebasing**: Each rebase fights the previous merge's line shifts
- **Cherry-picking across worktrees**: Loses the per-feature test verification
- **Manual three-way merge**: Error-prone for 5+ concurrent features
- **Trusting the "individually passing" claim**: Interaction points are rarely tested in isolation — always re-run full suite after merge
- **Merging without stale-base check**: A worktree based on pre-refactor HEAD silently reverses the refactor on merge
- **Landing a refactor without a numeric invariant test**: The regression is invisible until someone manually checks the line count

## Origin

2026-04-10 session: 5 PACT conformance features (N1 KnowledgeFilter, N2 EnvelopeCache, N3 PlanSuspension, N4 AuditTiers, N5 ObservationSink) merged from 5 independent worktrees into `engine.py` (2329 → 3211 lines). All 1192 PACT tests passed on first merged run after specialist applied the changes with explicit injection-point documentation.

**Post-mortem addendum (2026-04-11):** This skill was created in the same session that produced a silent regression on `base_agent.py`. A worktree merge re-inlined 1,079 LOC of extracted MCPMixin methods because: (a) the worktree was based on a stale pre-slimming HEAD, (b) no LOC invariant test existed, and (c) this skill did not include stale-base detection. Steps 6-8 were added to prevent recurrence. See `journal/0003-RISK-spec04-silent-regression-via-parallel-merge.md`.
