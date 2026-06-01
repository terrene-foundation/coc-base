# Worktree Isolation — Extended Evidence and Examples

Companion reference for `.claude/rules/worktree-isolation.md`. Holds
extended post-mortem prose, full example code blocks, and session
evidence for Rules 1–6 that would exceed the 200-line rule budget.

## Rule 1 — Orchestrator Prompts Pin The Worktree Path

Extended example with complete verification protocol:

```python
# DO — explicit path + verification instruction
worktree = "/absolute/path/to/repo/.claude/worktrees/agent-shard-abc123"
Agent(
    isolation="worktree",
    prompt=f"""
Working directory: {worktree}

STEP 0 — verify isolation before touching any file:
  git -C {worktree} status
If the output shows "not a git repository" OR the branch does not
match the worktree's expected branch, STOP and report "worktree
isolation broken" — do NOT fall back to the main checkout.

All file paths you write MUST be absolute and begin with {worktree}/.
""",
)

# DO NOT — isolation flag without pinned path
Agent(
    isolation="worktree",
    prompt="Implement feature X — use the ml-specialist patterns.",
)
# Agent starts in process.cwd() (main checkout), edits main's tree,
# reports success. Worktree is empty; main has half-done code.
```

**Why (extended):** The `isolation: "worktree"` flag creates the worktree but does not pin every tool call inside it — file-writing tools that accept absolute paths will happily write to the main checkout if the orchestrator's prompt uses a main-checkout path. In the 2026-04-19 session, ml-specialist, dataflow-specialist, and kaizen-specialist each drifted back to the main tree at least once; the corruption was only caught by `git status` after the fact. One-line verification at agent start converts a silent corruption into a loud refusal.

## Rule 2 — Specialist Self-Verify

Full specialist agent file pattern:

```markdown
# DO — self-check baked into the agent file

## Step 0: Working Directory Self-Check

Before any file edit, run:

    git rev-parse --show-toplevel
    git rev-parse --abbrev-ref HEAD

If the top-level path does NOT match the worktree path passed in the
prompt, STOP and emit "worktree drift detected — refusing to edit
main checkout". Do NOT fall back to process.cwd().

# DO NOT — assume orchestrator pinned cwd

## Step 1: Read the task

Read the prompt, start editing files…
```

**Why (extended):** The orchestrator's pinned-path instruction can be lost to context compression across long delegation chains; a self-check inside the specialist file is a belt-and-suspenders guarantee that survives prompt truncation. Verified cost: one git call (~30 ms). Verified benefit: prevents the ml-specialist / dataflow-specialist / kaizen-specialist drift that shipped during the 2026-04-19 session.

## Rule 3 — Parent Verify Deliverables

```python
# DO — verify after agent returns
result = Agent(isolation="worktree", prompt=f"Write {worktree}/src/feature.py...")
assert_file_exists(f"{worktree}/src/feature.py")  # parent checks

# DO NOT — trust "done" and proceed
result = Agent(isolation="worktree", prompt="...")
# Parent commits based on result.completion_message without ls
```

**Why (extended):** Agents hit their budget mid-message and emit "Now let me write X..." without having written X. The 2026-04-19 session saw 2 occurrences (kaizen round 6, ml-specialist round 7); both reported success, both produced zero files. An `ls` check is O(1) and converts "silent no-op" into "loud retry".

## Rule 4 — Parallel-Launch Burst Size Limit (Waves of ≤3)

Full example with wave pattern:

```python
# DO — wave of 3, wait, then next wave
wave1 = [
    Agent(isolation="worktree", prompt="... W31a+d ..."),
    Agent(isolation="worktree", prompt="... W31b ..."),
    Agent(isolation="worktree", prompt="... W31c ..."),
]
# wait for wave1 to complete (or fail) before launching wave2
wave2 = [
    Agent(isolation="worktree", prompt="... W32a ..."),
    Agent(isolation="worktree", prompt="... W32b ..."),
    Agent(isolation="worktree", prompt="... W32c ..."),
]

# DO NOT — burst of 6 simultaneous Opus worktree agents
for shard in [W31a, W31b, W31c, W32a, W32b, W32c]:
    Agent(isolation="worktree", prompt=f"... {shard} ...")
# ↑ all 6 rate-limited at 34-45s, zero commits across all worktrees,
#   every shard's work is lost. Empirical: 2026-04-23 M10 launch.
```

**Why (extended):** Anthropic's server-side throttle on simultaneous Opus session starts is not documented as a hard limit, but empirically 4–6 concurrent Opus worktree agents from one parent exceeds it and every agent in the burst dies before committing. Recovery is worse than serialization: the orchestrator MUST re-launch every failed shard, and without commits (see § Rule 5) there is no partial-progress to salvage. Waves of ≤3 complete cleanly; the latency cost of waiting one wave is strictly less than the cost of a full re-launch plus orphan recovery.

**Evidence:** kailash-ml-audit 2026-04-23 M10 launch — 6 Opus worktree agents (`ab9c2f7213c4a82ab`, `ae2f048829aa941a2`, `af15e0f9c3f2d16a3`, `a823d7ed912137852`, `a0e76f0996d1d9a4e`, `ad10591aa614deeae`) launched simultaneously, ALL 6 died at 34–45s with rate-limit error; fallback waves of 3 (`a506217c8640af1c0`, `a0831fc0ca6b9f6ae`, `a1027b84cb7c4f9d2` + `aa7fb6a6`, `a69473b3`, `aaecc695`) all completed and merged successfully.

## Rule 5 — Pre-Flight Merge-Base Check

Full bash example:

```bash
# DO — pin the base SHA at launch, verify merge-base matches HEAD
target_branch="feat/kailash-ml-1.0.0-m1-foundations"
target_head=$(git rev-parse "$target_branch")
git worktree add -b "feat/w31-core-ml-nodes" ".claude/worktrees/w31a" "$target_head"
merge_base=$(git merge-base "feat/w31-core-ml-nodes" "$target_branch")
[ "$merge_base" = "$target_head" ] || { echo "base drift — ABORT"; exit 1; }

# DO NOT — let the worktree default to a stale branch tip
git worktree add .claude/worktrees/w31a  # branches from whatever HEAD happens to be
# Agent's branch now forks from an OLD commit; merge silently picks
# either side on conflicts; package overlap = data loss.
```

**Why (extended):** `git worktree add` without an explicit base defaults to whatever branch HEAD was last set — which for a long-running session can be a pre-merge commit from hours ago. Worktrees created from a stale base merge cleanly ONLY when the packages they touch don't overlap; the moment two shards touch the same `pyproject.toml`, same `__init__.py`, or same CHANGELOG, the 3-way merge silently discards one shard's edits (see `rules/agents.md` § "Parallel-Worktree Package Ownership Coordination"). The merge-base check converts an invisible drift risk into a loud pre-flight abort.

**Evidence:** kailash-ml-audit 2026-04-23 M10 launch — 5 of 6 worktrees branched from `899ce3e5` (pre-W30-merge), only 1 branched from feat tip `41a217dc`. Worked this time only because packages didn't overlap; failure mode is permanent until structurally prevented.

## Rule 6 — Worktree Branch Name Matches Prompt

Full example:

```python
# DO — explicit branch name on worktree creation
worktree = ".claude/worktrees/w31a"
branch = "feat/w31-core-ml-nodes-observability"
subprocess.run(["git", "worktree", "add", "-b", branch, worktree, target_head])
Agent(
    isolation="worktree",
    prompt=f"""Working directory: {worktree}
Branch: {branch}

STEP 0 — verify branch name matches:
  actual=$(git -C {worktree} rev-parse --abbrev-ref HEAD)
  [ "$actual" = "{branch}" ] || {{ echo "branch-name drift"; exit 1; }}
""",
)

# DO NOT — let harness default assign worktree-agent-<hash>
Agent(isolation="worktree", prompt="Implement W31... use feat/w31-core-ml-nodes")
# ↑ 3 of 6 shards in the M10 launch ended up on worktree-agent-<hash>
#   branches because the prompt name-reference didn't force creation.
#   Post-merge grep for feat/w31-* missed those three.
```

**Why (extended):** Branch names are the primary `git log --grep` surface for tracing a shard back to its plan — `feat/w31-core-ml-nodes-observability` instantly surfaces in history; `worktree-agent-aa7fb6a6` surfaces only as a meaningless hash. When half the shards in a release wave use harness-default names, post-merge audits cannot enumerate "did every planned shard land?" via grep — they have to cross-reference the worktree list (which has already been auto-cleaned).

**Evidence:** kailash-ml-audit 2026-04-23 — 3 of 6 M10 shards honored `feat/<shard>` names (`feat/w31-core-ml-nodes-observability`, `feat/w31b-dataflow-ml-bridge`, `feat/w31c-nexus-ml-bridge`, `feat/w33b-migration-readme-regression`) while 3 got `worktree-agent-aa7fb6a6`, `worktree-agent-a69473b3`, `worktree-agent-aaecc695`, `worktree-agent-aa8e8995`, `worktree-agent-af0e8132`. Audit had to pull from the orchestrator's working-memory table.

## Relationship To Other Rules

- `rules/agents.md` § "MUST: Worktree Isolation for Compiling Agents" — companion rule; the worktree-isolation file is the verification layer for the isolation directive there.
- `rules/zero-tolerance.md` Rule 2 — a completed-looking file that doesn't exist is a stub under a different name.
- `rules/testing.md` § "Verified Numerical Claims In Session Notes" — same principle, applied to file deliverables.

## Origin

Session 2026-04-19 — ml-specialist, dataflow-specialist, and kaizen-specialist each drifted back to the main tree during PRs #502-#508; kaizen round 6 and ml-specialist round 7 reported "Now let me write X..." completions with no actual file writes. The self-verify + parent-verify protocol closed both failure modes. Rules 4–6 added 2026-04-23 from the kailash-ml-audit M10 release wave (6-agent burst rate-limit + 5-of-6 stale-base-SHA + 3-of-6 branch-name-default).
