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
    - the ml package directory src/kailash_ml/foo.py
    - the ml package directory tests/integration/test_foo.py

    ...
    """,
)
```

**BLOCKED rationalizations:** "Absolute paths are unambiguous" / "The agent should figure out its own cwd" / "This worked the one time I tested it".

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

## Rule 3b — Continuation-Agent Recovery For Mid-Shard Agent Death

When a worktree agent dies mid-shard (server-side throttle, account session limit, swap, crash), Rule 3's commit-per-milestone discipline makes the relaunch LOSSLESS — if the orchestrator follows this recovery protocol instead of relaunching from scratch:

1. **Inspect before relaunching:** `git -C <dead-worktree> log main..HEAD --oneline` (committed milestones) + `git -C <dead-worktree> status --porcelain` (dangling WIP).
2. **Checkpoint the dangling WIP** as a commit in the dead worktree (`git add -A && git commit -m "wip: checkpoint from rate-limited agent"`) so the branch carries EVERYTHING — auto-clean only deletes zero-commit worktrees, and the branch survives even when the worktree is removed.
3. **Launch the continuation agent** (fresh worktree) with an explicit recovery step: `git merge <dead-agent-branch>` as STEP 1, then "READ what it already built before writing anything — audit, fix, fill; do not rewrite working code."
4. **Tell the continuation agent what the predecessor claimed** (its last commit subjects) so the audit is targeted.

Evidence: 2026-06-11 Wave-3 session — a rate-limited agent left 1 commit + uncommitted edits; checkpoint + merge-continuation recovered all of it, and the continuation agent completed the shard auditing rather than re-implementing (~1,400 LOC retained). Same protocol applied across the F16 W2 fix-wave (journal 0178 §FD: 3 of 4 agents died mid-run; resumption lossless).

## Rule 4 — Verify Agent Deliverables Exist After Exit

**Rule:** `rules/agents.md` § "MUST: Verify Agent Deliverables Exist After Exit".

### Failure mode evidence

Session 2026-04-19 logged 2 occurrences (kaizen round 6, ml-specialist round 7) where an agent hit its budget mid-message and reported success with zero files on disk. The agent emitted "Now let me write X..." with no tool call behind it.

The `ls` check is O(1) and converts silent no-op into loud retry.

### Combined protocol

- Rule 3 (commit discipline) protects against worktree auto-cleanup
- Rule 4 (post-exit verify) protects against the main checkout
- Both are needed: Rule 3 alone misses truncated-in-main cases; Rule 4 alone misses truncated-worktree cases
- Rule 4a (below) is the recovery path when Rule 3 was missed and the worktree is already cleaned

## Rule 4a — Recover Orphan Writes From Zero-Commit Worktree Agents

**Rule:** `rules/agents.md` § "MUST: Recover Orphan Writes From Zero-Commit Worktree Agents".

An agent that wrote via ABSOLUTE paths resolves those writes to the MAIN checkout cwd (not its worktree). When such an agent reports done but its branch has zero commits AND the worktree was auto-cleaned, the work is NOT lost — it is orphaned, uncommitted, and reachable in the main checkout.

### 4-step recovery protocol

```bash
git worktree list | grep <expected-branch>     # empty if cleaned
git status --short                              # "??" entries surface the orphans
git checkout -b recovery/<original-branch>      # rescue branch (greppable across history)
git add -- "<orphan-path>" && git commit -m "recover(<branch>): orphaned worktree writes"
```

Quote each orphan path and terminate option parsing with `--` (`git add -- "path/with spaces.py"`) — never substitute an unquoted `$(...)` expansion, which word-splits on spaces/shell-meta. Stage the explicit orphan paths from `git status --short`, NOT `git add .`/`-A` (which would sweep unrelated working-tree state per `git.md` § "Stage Explicit Paths").

### BLOCKED rationalizations

- "The agent said it was done, the work must be committed somewhere"
- "Re-launching is cleaner"
- "If the branch has zero commits, the work is gone"
- "The main checkout is clean"
- "recovery/ branches are a workaround; feat/ is more correct"

### Why it is load-bearing

Re-launching abandons real work every time an absolute-path agent truncates. `git status` reveals the orphans; the `recovery/` branch prefix surfaces this class of rescue across history. PR #574 recovered 1129 LOC of `alignment.py` this way.

## Rule 5 — Parallel-Worktree Package Ownership Coordination

**Rule:** `rules/agents.md` § "MUST: Parallel-Worktree Package Ownership Coordination".

### Positive evidence (coordination succeeded)

Session 2026-04-20 kailash-ml 0.13.0 + kailash 2.8.10 parallel-release cycle (PRs #552, #553). Three parallel worktree agents resolved issues #546 (ONNX matrix), #547+#548 (km.doctor + km.track), and #550 (quote_identifier). Clean integration because:

- **Agent 1** designated version-owner for kailash-ml pyproject.toml + CHANGELOG
- **Agent 2** prompt included the verbatim exclusion: "COORDINATION NOTE: A parallel agent is resolving #546 (ONNX bridge matrix) in another worktree and will ALSO bump version to 0.13.0 + write CHANGELOG. To avoid merge conflicts, you (this agent) MUST NOT edit the ml package directory pyproject.toml, the ml package directory src/kailash_ml/**init**.py::**version**, or the ml package directory CHANGELOG.md."
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

## Rule 6 — Parallel-Launch Concurrency Is Throttle-Aware Adaptive (cold-start ~3, back off on signal)

**Rule:** Orchestrators MUST govern concurrent agent launches by an ADAPTIVE back-off model, NOT a fixed cap and NOT the runtime's native ceiling. Cold start (no throttle signal this session): cap the first wave at **~3 Opus-tier agents** — NOT the runtime's native `min(16, cores−2)=14` (empirically too high — it throttles at sub-quota concurrency) and NOT unlimited. Back off to serial waves of ~3 ONLY on the falsifiable throttle signal; do NOT preemptively serialize below ~3, and do NOT assert "no cap." This mirrors `rules/worktree-isolation.md` Rule 4 (the rule body; this depth-file carries the how-to).

### The falsifiable throttle signal

Back off to waves of ~3 when AND ONLY when ≥2 agents in the same wave fail within a **~30–48s synchronized window** AND the failure carries the server string `Server is temporarily limiting requests` with `(not your usage limit)` / `Rate limited`. A single agent dying, an OOM, a 2-minute timeout, or a quota error that says "usage limit" is NOT this signal.

### Failure-mode evidence (two incidents)

1. **2026-04-23 kailash-ml M1:** a 6-agent worktree burst (W31a/b/c + W32a/b/c) — **all 6** returned `Server is temporarily limiting requests` within seconds; two sequential waves of 3 then landed cleanly (6 shards, 189 tests).
2. **2026-06-01 #419:** a **7-agent READ-ONLY fan-out** (zero compile contention, well under the native cap of 14) synchronized-died at ~37–48s with verbatim `(not your usage limit) · Rate limited`; waves-of-3 → 7/7 returned. This is the receipt that the binding constraint is server-side CONCURRENCY (sub-quota, sub-native-cap), NOT account quota and NOT a fixed batch number — #419 falsified #418's "trust the native cap."

### Prompt template

```python
# DO — cold-start wave of ~3; back off to waves of 3 ONLY on the synchronized-throttle signal
wave = launch(shards[:3])                    # cold start ~3, NOT native 14, NOT unlimited
wait_for_all(wave)                           # wave barrier
# if ≥2 of `wave` died within ~30-48s carrying "(not your usage limit)" → keep next waves ≤3
# else (clean) → the SIGNAL is the gate, not a fixed number

# DO NOT — trust the runtime's native min(16,cores-2)=14 cap
agents = [launch(s) for s in all_shards]     # 7 read-only agents synchronized-died at ~37-48s
# DO NOT — hardcode "always waves-of-3" with no throttle signal (over-serializes headroom)
```

**BLOCKED rationalizations:** "The native cap (14) is the ceiling to trust" (7 agents throttled sub-quota) / "It's a quota / usage-limit problem" (the string says `not your usage limit`) / "Always waves-of-3 is the safe rule" (over-serializes) / "A retry loop will handle throttles" / "5 worked last week, 6 should too".

**Why:** The throttle is server-side CONCURRENCY-shaped and time-windowed, NOT quota-shaped and NOT fixed-count. "No cap / trust native 14" re-ships the synchronized burst-death; "always ≤3" wastes the multiplier on low-contention sessions. The adaptive model (cold-start ~3, back off on the falsifiable synchronized-death + `not your usage limit` signal) is neither. Worktree isolation itself is unaffected — only the concurrency-governance mechanism is reframed.

Origin: Session 2026-04-23 kailash-ml-audit M1 (6-agent burst 100% failure, 3+3 success) + 2026-06-01 F110 / #419 reframe (7-read-only-agent sub-quota throttle falsified #418's native-cap trust). Receipts journal/0193 + journal/0194.

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

## Rule 9 — Worktree-Isolate Shared-Source Editors; Concurrent Readers Read Committed HEAD

**Rule:** `rules/agents.md` § Worktree Orchestration — shared-source editor isolation. Rule 1's isolation mandate generalizes beyond compilation: ANY background/parallel agent that EDITS shared repo source (`sync-manifest.yaml`, rules, `bin/`, config) MUST be worktree-isolated, even if it never compiles. Any concurrent agent that READS that source MUST read the committed HEAD (`git show HEAD:<path>`), never the working tree.

### Failure mode evidence (2026-05-16 post-mortem)

Three agents ran against the SAME loom checkout: a background agent EDITING `sync-manifest.yaml` (issue #243), and two `/sync` catch-up agents READING loom source. The editor's mid-edit WIP left the manifest with a transient YAML syntax error; both readers flagged "the manifest is broken repo-wide" — correct for the working tree, false at committed HEAD. ~2 agents' analysis cycles were spent reconciling a phantom defect. Root cause: the isolation MUST was framed compiling-only, so the orchestrator launched the editor non-isolated precisely because "it doesn't compile."

### The two structural halves

1. **Editor isolation** — any shared-source editor is worktree-isolated, compiling or not.
2. **Reader discipline** — concurrent readers read committed HEAD; this is the half that actually saved the cycle (once the catch-up agents were told to read `git show HEAD:<path>`, they produced correct plans despite the broken WIP in the shared tree).

### Prompt template

```python
# DO — a background agent that EDITS shared source is worktree-isolated
Agent(isolation="worktree", prompt="Edit sync-manifest.yaml: add consumer_overlays ...")
# DO — a concurrent agent that READS that source reads committed HEAD
Agent(prompt="""Catch-up sync. Read loom source via `git show HEAD:.claude/bin/emit.mjs`
(committed HEAD), NOT the working tree — a parallel agent may be mid-edit.""")

# DO NOT — non-isolated editor + working-tree reader, same checkout
Agent(prompt="Edit sync-manifest.yaml ...")          # mid-edit WIP visible to all
Agent(prompt="Catch-up: copy .claude/bin/emit.mjs")  # may copy broken mid-edit state
```

**BLOCKED rationalizations:** "It's not a compiling agent, the worktree rule doesn't apply" / "The edit is quick, a collision is unlikely" / "Both agents are careful" / "I'll serialize them in my head".

**Why:** A non-isolated editor's mid-edit WIP is visible in the shared checkout; a reader copying the working tree mid-edit ships the broken state. Had the editor been isolated (or the readers HEAD-pinned from the start), zero reader cycles would have been spent on a phantom defect.

Origin: 2026-05-16 loom session (issue #243 manifest editor vs py/rs catch-up readers); full post-mortem in `guides/rule-extracts/agents.md` § Post-mortem 2026-05-16.

## Rule 10 — Binding/Package-Scoped Shard PRs Touch Only Their Own Package

**Rule:** `rules/agents.md` § Worktree Orchestration — binding-scope discipline. When ≥2 parallel worktree agents each ship a binding/package-scoped shard, each shard's PR MUST limit its diff to its OWN binding/package directory. Incidental fixes to sibling-package files (clippy lints, fmt drift, doc typos) discovered mid-shard ship as a separate PR or a dedicated cross-package cleanup shard — bundling is BLOCKED. This is the file-overlap variant of Rule 5: that clause forbids two agents editing the version anchor; this one forbids two agents editing the same sibling-package source.

### Failure mode evidence

F9 Wave 3c (2026-05-22): PR #1084 (a Java MCP shard) bundled an incidental Ruby clippy fix on a Ruby binding source file; concurrent PR #1085 (a broader Ruby MCP shard) edited the same file; #1085's auto-merge hit a 3-way conflict resolved mid-flight at merge commit `69bed4e0` (~10 min of churn binding-scope discipline would have prevented). Same trap precedent: Wave 3b PR #1081 on the parity-matrix file.

### Detection sweep (reviewer mechanical sweep at /implement)

`git diff --name-only main...HEAD`, map each changed path to its top-2 directory components, flag any binding-scoped PR (title `feat(go|java|ruby|python|nodejs):`) whose changed-file roots span >1 binding directory WITHOUT a cross-package-cleanup title prefix (`chore(bindings):` / `fix(bindings):` are carved out — they MAY touch multiple binding dirs by design).

**BLOCKED rationalizations:** "It's only a one-liner lint fix" / "Both bindings rebuild anyway" / "Filing a separate PR is overhead for trivial drift" / "I'm already touching the workspace anyway" / "The fix is in a different file from the sibling shard" / "Concurrent PRs on different files don't conflict".

**Why:** When two concurrent binding-scoped shards touch the SAME sibling-package file (one shard's incidental fix + a concurrent shard that owns that file), the second-to-merge hits a 3-way conflict the orchestrator resolves mid-flight. Trust Posture Wiring for this clause: `guides/rule-extracts/agents.md` § Binding-Scoped Shard PRs.

Origin: F9 Wave 3c (2026-05-22), PR #1084/#1085 conflict on a Ruby binding source file.

## Related rules & skills

- `rules/agents.md` § Worktree Orchestration — the load-bearing MUST cluster this skill carries the depth for (one structural assertion per clause in the rule; protocol, templates, BLOCKED corpora + post-mortems here)
- `rules/orphan-detection.md` — §1 (facade call site) and §6 (`__all__` eager import) are what the mechanical sweep verifies
- `skills/30-claude-code-patterns/parallel-merge-workflow.md` — merge-step patterns for collecting worktree branches into an integration branch
- `guides/deterministic-quality/02-session-architecture.md` — session-level architecture for multi-agent orchestration
