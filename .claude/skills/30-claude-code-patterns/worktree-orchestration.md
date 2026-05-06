# Worktree Orchestration Reference

Detailed evidence and post-mortems backing the 5 worktree rules in `rules/agents.md`. The rules contain the load-bearing MUST clauses + DO/DO NOT; this file holds the institutional memory (failure stories, counterfactuals, prompt templates).

## Rule 1 — Worktree Isolation For Compiling Agents

**Rule:** `rules/agents.md` § "MUST: Worktree Isolation for Compiling Agents".

**Why it exists:** Cargo uses an exclusive filesystem lock on `target/`. Two cargo processes in the same directory serialize completely, turning parallel agents into sequential execution. Worktrees give each agent its own `target/` directory.

**Cross-language applicability:** Rust (cargo `target/` lock) is the clearest case. Python does NOT have the same compiler lock, but worktree isolation still prevents agents from stepping on each other's file edits and produces cleanly-merge-able commit branches — both significant benefits. JavaScript/TypeScript also benefit because `node_modules/` can be contention-sensitive during install.

**Full protocol:** `isolation: "worktree"` is necessary but not sufficient. Combine with:

1. Relative paths only in the agent prompt (Rule 2 below)
2. Explicit commit-as-you-go discipline (Rule 3 below)
3. Post-exit file existence verification (Rule 4 below)
4. Cross-agent package ownership declared (Rule 5 below)

Without all 5 layers, agents drift back to the main checkout silently, lose work to auto-cleanup, or race on version-bump files.

## Rule 2 — Worktree Prompts Use Relative Paths Only

**Rule:** `rules/agents.md` § "MUST: Worktree Prompts Use Relative Paths Only".

### Failure mode evidence

Session 2026-04-19 logged: 2 of 3 parallel shards wrote to MAIN before self-correcting (Shard B) or losing work entirely (Shard A's 300+ LOC of sklearn array-API impl was lost when its empty worktree auto-cleaned). Only one self-corrected; the failure mode is not agent-detectable by default.

Post-mortem: `workspaces/kailash-ml-gpu-stack/journal/0004-RISK-torch-lightning-deviceReport-orphan.md` — full post-mortem of the write-to-main leak AND the subsequent spec-compliance finding it masked.

### Why relative paths are load-bearing

`isolation: "worktree"` creates a nested git worktree under `.claude/worktrees/agent-XXXX/`, then runs the agent with cwd set to that worktree. Relative paths resolve correctly; absolute paths point back to the parent checkout the orchestrator is using, silently defeating isolation.

### Prompt template (safe)

```python
Agent(
    isolation="worktree",
    prompt="""
    Resolve <issue>.

    Files you may edit (relative paths only; NEVER absolute):
    - packages/kailash-ml/src/kailash_ml/foo.py
    - packages/kailash-ml/tests/integration/test_foo.py

    ...
    """,
)
```

## Rule 3 — Worktree Agents Commit Incremental Progress

**Rule:** `rules/agents.md` § "MUST: Worktree Agents Commit Incremental Progress".

### Failure mode evidence

Session 2026-04-19 ML GPU-first Phase 1 parallel-shard experiment:

- Shard A's agent wrote a complete SklearnTrainable Array-API rewrite, then truncated on "Now let me rewrite fit:" with zero commits. Worktree auto-deleted. ~300 LOC of load-bearing work had to be recovered serendipitously from Shard B's scope-creeped worktree.
- Shard C was rescued by an explicit WIP commit from the orchestrator immediately after notification.
- Only Shard B self-corrected — because its prompt happened to emphasize "commit before exit" as a byproduct.

Three of three parallel agents truncated at 250-370k tokens; two lost work to auto-cleanup.

### Why incremental commits are load-bearing

Worktree auto-cleanup silently deletes worktrees with zero commits on their branch. An agent that writes perfect code but truncates mid-message before committing loses 100% of its output. Post-hoc file-existence verification (Rule 4 below) catches orphan files in main but CANNOT recover files that were only in a cleaned-up worktree.

### Prompt template

```python
Agent(
    isolation="worktree",
    prompt="""
    ...

    **Commit discipline (MUST):**
    - After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
    - Do NOT hold all work in the worktree's index until the final report.
    - If you exit without committing (budget exhaustion / crash / interruption),
      the worktree is auto-cleaned and ALL work is lost.
    """,
)
```

## Rule 4 — Verify Agent Deliverables Exist After Exit

**Rule:** `rules/agents.md` § "MUST: Verify Agent Deliverables Exist After Exit".

### Failure mode evidence

Session 2026-04-19 logged 2 occurrences (kaizen round 6, ml-specialist round 7) where an agent hit its budget mid-message and reported success with zero files on disk. The agent emitted "Now let me write X..." with no tool call behind it.

The `ls` check is O(1) and converts silent no-op into loud retry.

### Combined protocol

- Rule 3 (commit discipline) protects against worktree auto-cleanup
- Rule 4 (post-exit verify) protects against the main checkout
- Both are needed: Rule 3 alone misses truncated-in-main cases; Rule 4 alone misses truncated-worktree cases

## Rule 5 — Parallel-Worktree Package Ownership Coordination

**Rule:** `rules/agents.md` § "MUST: Parallel-Worktree Package Ownership Coordination".

### Positive evidence (coordination succeeded)

Session 2026-04-20 kailash-ml 0.13.0 + kailash 2.8.10 parallel-release cycle (PRs #552, #553). Three parallel worktree agents resolved issues #546 (ONNX matrix), #547+#548 (km.doctor + km.track), and #550 (quote_identifier). Clean integration because:

- **Agent 1** designated version-owner for kailash-ml pyproject.toml + CHANGELOG
- **Agent 2** prompt included the verbatim exclusion: "COORDINATION NOTE: A parallel agent is resolving #546 (ONNX bridge matrix) in another worktree and will ALSO bump version to 0.13.0 + write CHANGELOG. To avoid merge conflicts, you (this agent) MUST NOT edit packages/kailash-ml/pyproject.toml, packages/kailash-ml/src/kailash_ml/**init**.py::**version**, or packages/kailash-ml/CHANGELOG.md."
- **Agent 3** worked on a different package (core kailash/, 2.8.10) — no overlap

Result: merge integration was mechanical. One trivial CHANGELOG conflict on the root file, zero conflicts on package pyproject.toml or package CHANGELOG. Integration step (owned by orchestrator) added `km-doctor` console script + expanded CHANGELOG (which Agent 1 correctly seeded with ONNX entries only) to cover all three issues.

### Counterfactual

Without the exclusion clause, Agent 2 would have independently bumped 0.12.1 → 0.13.0 and written its own top-level `## [0.13.0]` CHANGELOG entry. At merge time git would have picked one agent's version field (arbitrary) and one agent's CHANGELOG header (arbitrary), silently dropping the other's prose. The cost of the exclusion clause is one sentence per sibling prompt; the cost of the collision is manual CHANGELOG reconciliation plus risk of dropped coverage notes.

### Integration step belongs to orchestrator

The post-merge fixup (adding cross-agent artifacts that neither agent owned) is the orchestrator's responsibility, not an agent's:

- `km-doctor` console script entry in `pyproject.toml [project.scripts]` — spans agents 1 and 2's work
- Expanded CHANGELOG entries covering all 3 issues — agent 1 wrote the ONNX section; orchestrator added km.track + km.doctor sections
- Cross-package version floor updates (sibling package bumps, lockstep coordination)

Agents MUST NOT attempt integration work because they cannot see each other's worktrees until the merge lands.

## Reviewer Prompts — Mechanical AST/Grep Sweep

**Rule:** `rules/agents.md` § "MUST: Reviewer Prompts Include Mechanical AST/Grep Sweep".

### Failure mode evidence

Session 2026-04-19 ML GPU-first Phase 1 codify cycle — code reviewer APPROVED 0.12.0 with one minor finding (missing test); the subsequent `/redteam` mechanical sweep caught TorchTrainable + LightningTrainable missing `device=DeviceReport` (2 of 7 return sites). The reviewer never ran the parity grep.

See `workspaces/kailash-ml-gpu-stack/journal/0004-RISK-torch-lightning-deviceReport-orphan.md` § "Why it slipped past the round-3 reviewer" for the full analysis.

### Why mechanical sweeps are load-bearing

Gate reviewers are constrained by the diff they're shown. The orphan failure mode of `rules/orphan-detection.md` §1 is invisible at diff-level — the new entries look complete; the OLD entries that were never updated for the new public surface stay invisible. A 4-second `grep -c` sweep catches what 5 minutes of LLM judgment misses. Without the sweep, the reviewer agent's APPROVE verdict is necessary but not sufficient.

### Reviewer prompt template (with sweeps)

```python
Agent(subagent_type="reviewer", prompt="""
... diff context ...

Mechanical sweeps (run BEFORE LLM judgment):
1. `grep -c "return TrainingResult(" src/...trainable.py` — must equal
   `grep -cE "device=DeviceReport|device=device_report" src/...trainable.py`
2. `pytest --collect-only -q` exit 0 across all test dirs
3. `pip check` — no new conflicts vs main
4. For every public symbol in __all__ added by this PR — verify
   eager import (per orphan-detection §6)
""")
```

## Rule 6 — Parallel-Launch Burst Size Limit (≤3 Opus agents per wave)

**Rule:** Orchestrators MUST cap concurrent worktree agent launches at **3 Opus-tier agents per wave**. Launching 4+ simultaneously is BLOCKED — Anthropic's service-side rate limiter returns `API Error: Server is temporarily limiting requests` and every agent in the burst fails with no partial progress.

### Failure mode evidence

Session 2026-04-23 kailash-ml 1.0.0 M1 `/implement` for branch `feat/kailash-ml-1.0.0-m1-foundations` attempted to launch all 6 M10 shards (W31a/b/c + W32a/b/c) simultaneously. **All 6 agents** returned `API Error: Server is temporarily limiting requests` within seconds of launch. Fell back to two sequential waves of 3; both waves landed cleanly (6 shards merged, 189 M10 tests passing).

### Why ≤3 is the ceiling

Each Opus worktree agent consumes a full Anthropic API session plus its tool calls. Six simultaneous sessions against the same account key trigger burst-window throttling at the service tier. The throttle is ALL-OR-NOTHING per burst — no partial backoff, no queueing — so a 6-agent launch produces 6 failures, not 3 successes + 3 retries.

### Prompt template

```python
# DO — two waves of 3, second wave launched after first wave reports
for wave in [shards[0:3], shards[3:6]]:
    agents = [Agent(isolation="worktree", prompt=s.prompt) for s in wave]
    wait_for_all(agents)  # wave barrier

# DO NOT — single 6-agent burst
agents = [Agent(isolation="worktree", prompt=s.prompt) for s in all_6_shards]
# → all 6 hit "Server is temporarily limiting requests" simultaneously
```

**BLOCKED rationalizations:** "Anthropic's limits are generous" / "5 worked last week, 6 should too" / "A retry loop will handle throttles" / "Parallelism maximizes throughput regardless of cap".

**Why:** The cap is empirically grounded in a single session's reproducible failure. Waves of 3 are both the observed success threshold AND a safe margin — the second wave starts only after the first wave's agents have all reported, giving the rate-limit window time to close.

Origin: Session 2026-04-23 kailash-ml-audit M1 — 6-agent burst 100% failure, 3+3 wave pattern 100% success.

## Rule 7 — Pre-Flight Merge-Base Check Before Launch

**Rule:** Before launching parallel worktree agents that will eventually merge back to the same integration branch, the orchestrator MUST verify every worktree's branch is created FROM THE CURRENT TIP of the integration branch — not from an older ancestor. Branching from an older ancestor is silently valid until merge time, at which point the shards diverge from each other AND from intermediate reconciliation commits.

### Failure mode evidence

Session 2026-04-23 M10 wave: **5 of 6 worktree agents** branched their shard from an older ancestor of `feat/kailash-ml-1.0.0-m1-foundations` instead of the current tip. Detected only at post-merge reconciliation (commit fa300831) when `__all__` reconciliation revealed each shard had landed its own version of the canonical list, diverging from the W33 shard that had correctly branched from tip.

### Why the check is load-bearing

`Agent(isolation="worktree", prompt="...")` creates the worktree via `git worktree add` with a default base; unless the orchestrator passes `--force-checkout <SHA>` or similar, the base is whatever ref HEAD points at when the harness runs, which can be stale if the integration branch has advanced since the orchestrator's last `git fetch`. The drift is invisible at shard-time because each shard passes its own tests; the collision only surfaces when 6 shards land top-level `__all__` entries on top of 6 different parent trees.

### Prompt template (pre-flight)

```bash
# DO — orchestrator computes the tip explicitly, passes it to each agent
INTEGRATION_TIP=$(git rev-parse feat/kailash-ml-1.0.0-m1-foundations)
for shard in shards; do
  git worktree add -b "feat/${shard}" ".claude/worktrees/${shard}" "${INTEGRATION_TIP}"
done

# DO NOT — let the harness pick the base silently
# Each worktree branches from whatever the harness sees as HEAD; 5/6 can
# land on an ancestor that is 2 commits behind the true tip.
```

**BLOCKED rationalizations:** "Worktrees always branch from HEAD" / "Merge reconciliation will surface the drift" / "A git fetch before launch is redundant".

**Why:** The reconciliation cost of 5/6 misaligned shards is a full `__all__` merge pass (commit fa300831 canonical 41 + 7 Phase-1 adapters = 48 total) done manually post-merge. A 1-second `git rev-parse` + explicit base-SHA pass converts it into 0 work.

Origin: Session 2026-04-23 M10 wave — 5/6 shards branched from older ancestor; post-merge `__all__` reconciliation commit fa300831 required.

## Rule 8 — Explicit Branch Naming In Prompts

**Rule:** Every worktree-isolation delegation MUST include an explicit `feat/<shard-name>` (or equivalent semantic prefix per `rules/git.md` conventional commits) in the prompt. Omitting the branch name is BLOCKED — the harness falls back to `worktree-agent-<hash>` which is neither greppable nor conventional-commit-compliant, breaking changelog tooling and release-trace auditability.

### Failure mode evidence

Session 2026-04-23 initial launch attempted: `Agent(isolation="worktree", prompt="Implement W33 km.* wrappers...")` without branch name. Harness assigned `worktree-agent-a3f9c1` as the branch. Post-merge `git log --grep="W33"` returned zero matches; the shard was findable only by commit SHA. Fixed by re-launching with explicit `Branch: feat/W33-km-wrappers` in the prompt header.

### Why the name is load-bearing

Conventional-commit `feat/<shard-name>` branch names serve four downstream consumers:

1. **Release changelog generation** — `git log --grep="^feat(<shard>)"` drives CHANGELOG entries
2. **Traceability** — `git branch --list 'feat/W*'` surfaces all shards in a wave
3. **Reviewer context** — PR titles inherit branch names; `worktree-agent-a3f9c1` communicates nothing
4. **Post-mortem search** — future sessions find this session's work via `git log --grep`

Hash-based names fail all four.

### Prompt template

```python
# DO — explicit branch name in prompt header
Agent(isolation="worktree", prompt="""
Branch: feat/W33-km-wrappers
Worktree: .claude/worktrees/W33-km-wrappers

Implement W33 km.* public-API wrappers per specs/ml-engines-v2.md §15.9.
Commit discipline: after each file, git commit -m "feat(W33): <what>"
""")

# DO NOT — omit branch, let harness pick
Agent(isolation="worktree", prompt="Implement W33 km.* wrappers...")
# → branch = worktree-agent-a3f9c1; grep -irn "W33" in history returns nothing
```

**BLOCKED rationalizations:** "The harness default works" / "We'll rename the branch at merge time" / "The commit bodies mention W33, grep works on those".

**Why:** Grep on commit bodies is slower (scans every commit, not just branch names) and noisier (false positives from unrelated mentions). Branch names are the cheapest index; losing them costs every future `git log --grep` 10× the tokens.

Origin: Session 2026-04-23 — W33 initial launch lost to `worktree-agent-<hash>`; re-launched with explicit `feat/W33-km-wrappers`.

## Related rules & skills

- `rules/agents.md` — the load-bearing MUST clauses for all 5 worktree rules
- `rules/orphan-detection.md` — §1 (facade call site) and §6 (`__all__` eager import) are what the mechanical sweep verifies
- `skills/30-claude-code-patterns/parallel-merge-workflow.md` — merge-step patterns for collecting worktree branches into an integration branch
- `guides/deterministic-quality/02-session-architecture.md` — session-level architecture for multi-agent orchestration
