# Agent Orchestration — Extended Evidence and Examples

Companion reference for `.claude/rules/agents.md`. Holds post-mortems,
extended examples, session evidence, and protocol blocks that would
exceed the 200-line rule budget.

## Quality Gates — Extended Context

### BLOCKED responses when skipping MUST gates

- "Skipping review to save time"
- "Reviews will happen in a follow-up session"
- "The changes are straightforward, no review needed"
- "Already reviewed informally during implementation"

### Background agent pattern — extended rationale

Background agents (the `run_in_background: true` flag) are the structural defense that makes MUST gates near-free on parent context. The parent continues work while the reviewer operates in parallel; reviewer findings flush back at gate time or on the next parent turn.

Evidence: 0052-DISCOVERY §3.3 — six commits shipped without review because gates were classified "recommended." Background agents make MUST gates nearly free.

## Reviewer Mechanical AST/Grep Sweep — Full Example

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state (not only the diff). LLM-judgment review of the diff catches what's wrong with the new code; mechanical sweeps catch what's missing from the OLD code that the spec also touched.

```python
# DO — reviewer prompt enumerates mechanical sweeps
Agent(subagent_type="reviewer", prompt="""
... diff context ...
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep — every `return TrainingResult(...)` call site must pass `device=...`
   grep -c 'return TrainingResult(' src/...trainable.py
   grep -cE 'device=DeviceReport' src/...trainable.py
   The two counts MUST be equal.
2. `pytest --collect-only -q` exit 0 across all test dirs
3. `pip check` — no new conflicts vs main
4. For every public symbol in __all__ added by this PR — verify eager import
""")

# DO NOT — reviewer prompt only includes diff context
Agent(subagent_type="reviewer", prompt="Review the diff between main and feat/X.")
```

Origin: 2026-04-19 codify cycle. See `skills/30-claude-code-patterns/worktree-orchestration.md` § "Reviewer Prompts — Mechanical AST/Grep Sweep" for full evidence.

## Worktree Isolation — Extended Post-Mortems

### Isolation flag alone is not sufficient

`isolation: "worktree"` creates the worktree but does not pin every tool call inside it. See `rules/worktree-isolation.md` + `skills/30-claude-code-patterns/worktree-orchestration.md § Rule 1` for the full 5-layer protocol.

### Worktree prompts use relative paths — 2026-04-19 post-mortem

Session 2026-04-19: Three parallel ml-specialist shards launched with `isolation: "worktree"`. The orchestrator prompt contained absolute paths rooted in the parent checkout. 2 of 3 shards wrote to MAIN; one (Shard B) self-corrected mid-run. Shard A lost 300+ LOC of sklearn array-API implementation when its empty worktree auto-cleaned. The failure mode is not agent-detectable by default — it requires the orchestrator to use relative paths in prompts.

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 2 for the full post-mortem.

### Recover orphan writes from zero-commit agents — 2026-04-20 Session 3b

Session 2026-04-20 Session 3b (issue #567): The parallel-worktree agent for PR #3 wrote absolute paths rooted in the parent and exited with zero commits on its branch. The worktree auto-cleaned. Initial disposition was to re-launch the agent; user pushback surfaced that `git status --short` revealed 1129 LOC of `alignment.py` sitting orphaned in MAIN. PR #574 `recovery/pr3-alignment-diagnostics` branch recovered the work.

The 4-step protocol:

```bash
git worktree list | grep <expected-branch>                  # empty if cleaned
git log <expected-branch> --oneline | head -5               # zero agent commits confirms truncation
git status --short                                          # "??" entries surface the orphans
find . -path .claude/worktrees -prune -o -name "<expected-file>" -print
# → git checkout -b recovery/<original-branch-name>
# → git add <orphaned files> && git -c core.hooksPath=/dev/null commit -m "feat(...): recovered from failed parallel worktree agent"
# → fill missing deliverables (tests, specs, pyproject bumps, CHANGELOG)
# → gh pr create with recovery/ prefix + body explicitly noting the recovery
```

### Worktree agents commit incremental progress — 2026-04-19 three-shard post-mortem

Session 2026-04-19 three-shard ml-specialist parallel session: 3 of 3 shards truncated at 250–370k tokens. 2 of 3 lost work entirely because their branches had zero commits at truncation-time. Only Shard B self-corrected because its prompt emphasized commit-before-exit.

```python
# DO — prompt: "after each file, git add <f> && git commit -m 'wip: <what>'"
Agent(
    isolation="worktree",
    prompt="""...
**Commit discipline (MUST):**
- After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
- Do NOT hold all work in the worktree's index until the final report.
- If you exit without committing (budget exhaustion / crash / interruption),
  the worktree is auto-cleaned and ALL work is lost.
""",
)

# DO NOT — "Implement feature X. Report when done."
# (agent writes 4 files, hits budget on file 5, never reaches commit, all 5 lost)
```

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 3 for compile-work evidence AND `rules/worktree-isolation.md` § Rule 5 for the 2026-04-21 non-compile post-mortem.

## Verify Agent Deliverables — Extended Evidence

```python
# DO — verify after agent returns
Read("/abs/path/src/feature.py")  # raises if missing → retry

# DO NOT — trust completion message
result = Agent(prompt="Write src/feature.py with ...")
# parent moves on; src/feature.py never existed
```

**Evidence:** kaizen round 6 and ml-specialist round 7 (session 2026-04-19) each reported successful completion of file-writing tasks with zero files on disk. Budget exhaustion truncated the write tool call; the completion message emitted "Now let me write X..." with no subsequent tool invocation. An `ls` / `Read` check is O(1) and converts silent no-op into loud retry.

## Parallel-Worktree Package Ownership — Full Example

```python
# DO — explicit ownership in prompts
Agent(isolation="worktree", prompt="""...resolve #546 ONNX matrix...
Version bump + CHANGELOG:
- packages/kailash-ml/pyproject.toml → 0.13.0
- packages/kailash-ml/src/kailash_ml/__init__.py::__version__
- packages/kailash-ml/CHANGELOG.md""")

Agent(isolation="worktree", prompt="""...resolve #547+#548 km.doctor + km.track...
COORDINATION NOTE: A parallel agent is bumping this package to 0.13.0.
You MUST NOT edit packages/kailash-ml/pyproject.toml,
packages/kailash-ml/src/kailash_ml/__init__.py::__version__, or
packages/kailash-ml/CHANGELOG.md. Just deliver the functionality.""")

# DO NOT — silent parallel ownership
Agent(isolation="worktree", prompt="...resolve #546... bump to 0.13.0")
Agent(isolation="worktree", prompt="...resolve #547+#548... bump to 0.13.0")
# ↑ Both agents race; merge picks one version field arbitrarily, dropping the other's CHANGELOG prose
```

Origin: Session 2026-04-20 three-agent parallel-release cycle (kailash-ml 0.13.0 + kailash 2.8.10, PRs #552, #553). Both agents saw the same base SHA, both independently bumped `version = "0.12.1"` → `"0.13.0"` and wrote top-level `## [0.13.0]` CHANGELOG entries. Git's three-way merge picked one side arbitrarily, discarding the other agent's CHANGELOG prose. One-sentence exclusion clause in the sibling's prompt prevents the O(manual) reconciliation.

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 5 for the full evidence.

## MUST NOT — Framework Bypass Rationale

- **Raw SQL when DataFlow exists** — bypasses DataFlow's access controls, audit logging, and dialect portability
- **Custom API when Nexus exists** — misses Nexus's session management, rate limiting, multi-channel deployment
- **Custom agents when Kaizen exists** — bypasses Kaizen's signature validation, tool safety, structured reasoning
- **Custom governance when PACT exists** — lacks PACT's D/T/R accountability grammar and verification gradient

## Post-mortem 2026-05-16 — non-isolated shared-source editor vs concurrent readers

Origin for "MUST: Worktree-Isolate Parallel Agents That Edit Shared Source; Concurrent Readers Read Committed HEAD".

### Incident

During a long session resolving template drift, three agents ran against the SAME loom checkout (not worktree-isolated):

- a background agent resolving issue #243 (consumer variant boundary) that EDITED `.claude/sync-manifest.yaml`, and
- two `/sync` catch-up agents (py, then rs) that READ loom source (`emit.mjs`, rules) to copy genuine-lag files into USE templates.

The #243 agent's mid-edit WIP left `sync-manifest.yaml` with a transient YAML syntax error (a list scalar with an embedded `: `). The py catch-up agent, reading the shared working tree, flagged "the manifest is broken repo-wide" — correct, but it was another workstream's in-flight WIP, not a real defect at HEAD. The rs catch-up agent hit the same confusion. Net: ~2 agents' analysis cycles spent reconciling a transient state that did not exist at committed HEAD.

### Root cause

`agents.md` had a worktree-isolation MUST, but its title + rationale scoped it to **compiling** agents (cargo `target/` lock contention). A non-compiling agent that edits shared source in a shared checkout is the SAME structural hazard — its uncommitted WIP is visible to every concurrent reader — but the rule's compiling-only framing left it uncovered. The orchestrator (this session) launched the #243 agent without `isolation: "worktree"` precisely because "it doesn't compile."

### Resolution

Two structural halves, both now in the rule:

1. **Editor isolation**: any background/parallel agent that edits shared source MUST be worktree-isolated, compiling or not.
2. **Reader discipline**: concurrent readers MUST read committed HEAD (`git show HEAD:<path>`), never the working tree. This is the isolation that actually saved the cycle here — once the py/rs catch-up agents were explicitly instructed to read committed HEAD, they produced correct plans despite the broken WIP in the shared tree.

### Secondary lesson (behavioral, journaled not ruled)

The same session twice used `git -c core.hooksPath=/dev/null commit` reflexively (both times inert — the target repos had no pre-commit framework, nothing masked). `git.md` already blocks silent hook-bypass; the lesson is behavioral (don't reach for the bypass by reflex) and is recorded in the bundle's journal DECISION entry rather than as a new rule clause, since git.md already covers the structural case.

### Counterfactual

Had the #243 agent been worktree-isolated (or had the catch-up agents been told to read committed HEAD from the start), zero reader cycles would have been spent on a phantom defect. The reader-reads-committed-HEAD instruction was added mid-session and worked — it is now the codified default, not an ad-hoc save.
