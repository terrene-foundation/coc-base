---
id: "AGENTS"
---

# Agent Orchestration Rules

See `.claude/guides/rule-extracts/agents.md` for full evidence, extended examples, post-mortems, recovery-protocol commands, the gate-review table, and CLI-syntax variants.



## Specialist Delegation (MUST)

When working on stack-specific concerns, MUST consult the relevant generic specialist. The base variant ships three stack-agnostic specialists; each reads `STACK.md` at the project root to determine the host language and framework before advising:

- **db-specialist** — Database work (Postgres / SQLite / MySQL / Mongo / Redis idioms regardless of language driver)
- **api-specialist** — REST / GraphQL / gRPC patterns; HTTP framework selection per language
- **ai-specialist** — Provider-agnostic LLM integration (OpenAI / Anthropic / local Ollama); prompt engineering; output validation

**Applies when**: implementing database access, exposing or consuming HTTP/RPC endpoints, integrating LLM-based features.

**Why:** Generic specialists encode patterns and pitfalls that generalist agents miss across the long tail of stacks the base variant supports. They consult `STACK.md` first; without that file (per `rules/stack-detection.md`) the specialist halts and reports rather than guessing the host stack.

## Specs Context in Delegation (MUST)

Every specialist delegation prompt MUST include relevant spec file content from `specs/`. Read `specs/_index.md`, select relevant files, include them inline. See `rules/specs-authority.md` MUST Rule 7 for the full protocol.

**Why:** Specialists without domain context produce technically correct but intent-misaligned output (e.g., schemas without tenant_id because multi-tenancy wasn't communicated).

## Analysis Chain (Complex Features)

1. **analyst** → Identify failure points
2. **analyst** → Break down requirements
3. **`decide-framework` skill** → Choose approach (when applicable; base variant's `decide-framework` is stack-aware via `STACK.md`)
4. Then appropriate generic specialist

## Parallel Execution

When multiple independent operations are needed, launch agents in parallel via the CLI's delegation primitive, wait for all, aggregate results. MUST NOT run sequentially when parallel is possible.

**Why:** Sequential execution of independent operations wastes the autonomous execution multiplier, turning a 1-session task into a multi-session bottleneck.

### MUST: Decompose Onto The Parallel Primitive By Default When The Work Earns It

When the work surface is **≥3 independent items** OR has a **multi-stage shape** (analyze → implement → verify), the orchestrator MUST decompose onto the runtime's parallel orchestration primitive by DEFAULT — not only under `/autonomize`. The trigger is a real gate: a genuinely serial single-item task MUST stay serial. Governance per `rules/governed-throughput.md`; concurrency throttle-aware per `rules/worktree-isolation.md` Rule 4.

```text
# DO — 3 independent shards (W3,W4,W5) → one parallel wave (1 wall-clock unit)
# DO NOT — 1 serial state-machine rewrite → stay serial (decomposing adds only latency)
```

**BLOCKED rationalizations:** "parallel-by-default needs `/autonomize`" / "serial is simpler, I'll decompose later" / "the ≥3-item trigger is my call each session".

**Why:** Parallel decomposition is the baseline throughput response, not a per-session opt-in; the serial-single-item gate prevents over-decomposition of genuinely sequential work.

### MUST: Parallel Brief-Claim Verification When Issue Count ≥ 3

When `/analyze` runs against a brief covering ≥ 3 distinct issues / failure modes / workstreams, the orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to independently re-grep / re-read every factual claim in the brief tagged with file:line citations. Inaccuracies surfaced by the deep-dive sweep MUST be recorded in the workspace journal AND in the architecture plan's "Brief corrections" section AS THE GATE before `/todos`. Single-agent analysis on a ≥3-issue brief is BLOCKED — the framing inherited from the brief is the failure mode this rule prevents.

**BLOCKED rationalizations:** "The brief was authored by the user, it must be accurate" / "Sequential single-agent analysis catches inaccuracies anyway" / "Three parallel agents triple the cost for the same conclusion" / "I'll spot-check a couple of claims, that's good enough" / "Brief verification is /redteam's job, not /analyze's" / "The brief's claims are 'mostly correct', the rounding errors don't change the plan".

**Why:** Briefs are written from the human's mental model of the system, which decays silently as the code evolves. A ≥3-issue brief carries ≥3× the surface area for stale citations and misframed root causes; single-agent analysis cannot resist the brief's framing because the agent has no independent reading. Parallel deep-dive verification is the structural defense.

## Quality Gates (MUST — Gate-Level Review)

Reviews happen at COC phase boundaries, not per-edit. Skip only when explicitly told to. **MUST gates** are `/implement` and `/release`; reviewer + security-reviewer (and gold-standards-validator at `/release`) run as parallel background agents. RECOMMENDED gates run at `/analyze`, `/todos`, `/redteam`, `/codify`, and post-merge.

**Why:** Skipping gate reviews lets analysis gaps, security holes, and naming violations propagate to downstream consumers where they are far more expensive to fix.

**BLOCKED responses when skipping MUST gates:** "Skipping review to save time" / "Reviews will happen in a follow-up session" / "The changes are straightforward, no review needed" / "Already reviewed informally during implementation".

### MUST: Reviewer Prompts Include Mechanical AST/Grep Sweep

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state (not only the diff). LLM-judgment review catches what's wrong with new code; mechanical sweeps catch what's missing from OLD code the spec also touched. Sweeps MUST be tailored to the host stack declared in `STACK.md` (e.g. `pytest --collect-only -q` for Python; `cargo check --workspace` for Rust; `go vet ./...` for Go; `tsc --noEmit` for TypeScript).

**BLOCKED rationalizations:** "The reviewer is smart enough to spot orphans" / "Mechanical sweeps are /redteam's job" / "Adding sweeps is repetitive".

**Why:** Reviewers are constrained by the diff. The orphan failure mode is invisible at diff-level. A 4-second `grep -c` catches what 5 minutes of LLM judgment misses.

## Zero-Tolerance

Pre-existing failures MUST be fixed (`rules/zero-tolerance.md` Rule 1).

## MUST: Verify Specialist Tool Inventory Before Implementation Delegation

When delegating IMPLEMENTATION work (file edits, commits, build/test invocation, version bumps), the orchestrator MUST select a specialist whose declared tool set includes `Edit` AND `Bash`. Read-only specialists (`security-reviewer`, `analyst`, `reviewer`, `gold-standards-validator`, `value-auditor`) MUST NOT be delegated implementation tasks. Pure-research / pure-review delegations are fine.

**BLOCKED rationalizations:** "security-reviewer is the security domain, so security-relevant edits go there" / "The agent will figure out its tool limitations" / "I'll re-launch with a different specialist if it halts" / "Read-only review IS implementation when the diff is trivial" / "The agent has Write — that's enough for code edits".

**Why:** Read-only specialists halt mid-instruction at file-edit boundaries — the agent emits "Now let me wire X" then exits with zero tool calls because Edit is unavailable. Verifying tool inventory pre-launch is O(1); re-launch is O(N) on shard size.

## MUST: Audit/Closure-Parity Verification Specialist Has Bash + Read

When delegating a /redteam round whose mission includes **closure-parity verification** (mapping prior-wave findings to delivered code via `gh pr view`, test-collection commands, `grep`, AST inspection, `find`), the orchestrator MUST select a specialist whose tool set includes `Bash` AND `Read`. Read-only analyst (`Read, Grep, Glob`) MUST NOT be assigned closure-parity verification — its tool set silently FORWARDS verification rows the next round must redo.

**BLOCKED rationalizations:** "Analyst is the audit specialist; closure parity IS audit" / "The reviewer round can pick up the FORWARDED rows" / "I'll instruct the analyst to skip rows it can't verify" / "Read+Grep+Glob covers most verification".

**Why:** Tool-inventory mismatch costs one full audit round. Verifying pre-launch is O(1); re-launch is O(N) on row count.

## MUST: Worktree Orchestration

Depth (protocol, prompt templates, BLOCKED corpora, post-mortems): `skills/30-claude-code-patterns/worktree-orchestration.md`. Each bullet is a full MUST:

- **Isolate compiling agents** — build caches hold exclusive filesystem locks (Rust `target/`; Python editable `.venv/`; Go `$GOCACHE`; TypeScript `node_modules/.cache/`); one worktree per compiling agent (skill Rule 1).
- **Isolate ANY shared-source editor** (manifest, rules, config, generated artifacts), compiling or not; concurrent readers read committed HEAD via `git show HEAD:<path>`, never the working tree (skill Rule 9).
- **Relative paths only in worktree prompts** — absolute paths resolve to the parent checkout, silently defeating isolation (skill Rule 2).
- **Commit per milestone; verify ≥1 commit** before declaring work landed — zero-commit worktrees auto-delete (skill Rule 3).
- **Verify deliverables exist after exit** (`ls`/`Read` the claimed files) — budget exhaustion truncates writes mid-message (skill Rule 4).
- **Recover orphan writes** of zero-commit auto-cleaned worktrees from the MAIN checkout onto `recovery/<branch>` (skill Rule 4a).
- **One version owner per sub-package** when ≥2 parallel agents touch it; siblings are told "do NOT edit" the version anchor + CHANGELOG (Python `pyproject.toml` + `__version__`; Rust `Cargo.toml` + `pub const VERSION`; Go `go.mod` const; TypeScript `package.json::version`) (skill Rule 5).
- **Binding/package-scoped shard PRs touch only their own package** — sibling-package fixes ship as a separate PR; bundling is BLOCKED (skill Rule 10).

```text
# DO — isolated editor; HEAD-pinned readers; relative paths; per-milestone commits
# DO NOT — shared-checkout editor + working-tree readers + absolute paths + 0 commits
```

**Why:** Each clause converts a silent parallel-work loss — lock serialization, phantom reads, checkout drift, auto-cleanup loss, truncated writes, version clobber, shard conflicts — into clean isolation or a loud refusal.

**BLOCKED rationalizations:**

- "It's not a compiling agent, the worktree rule doesn't apply"
- "The edit is quick, a collision is unlikely" / "Both agents are careful"
- "Absolute paths are unambiguous" / "The agent should figure out its own cwd"
- "The agent said 'done', that's good enough"
- "Both agents are smart enough to see the existing version" / "We'll resolve at merge time"
- "It's only a one-liner sibling-package fix" / "Concurrent PRs on different files don't conflict"

## MUST NOT

- **Stack-coupled work without consulting `STACK.md`** — the generic specialists fall back to LOW-confidence advice; the agent is responsible for either confirming the stack or running the `/onboard-stack` command first.
- **Sequential when parallel is possible** — wastes the autonomous execution multiplier.

Origin: 2026-04-19 worktree drift + 2026-04-20 parallel-release + 2026-04-27 W6 closure-parity. Base-variant adaptation 2026-05-06: stack-specialist names neutralized to db/api/ai-specialist trio reading `STACK.md`. Worktree-cluster compression mirrored from global 2026-06-12 (#491, journal/0271) — also restores the binding-scoped-shard-PR clause the base overlay had drifted without.



## Examples (CLI-specific delegation syntax)

The MUST clauses in the neutral-body section reference numbered examples here. Each example shows the CC `Agent(subagent_type=...)` delegation primitive; the Codex variant of this rule (`.claude/variants/codex/rules/agents.md`) replaces these with `codex_agent(agent=...)` syntax, and the Gemini variant uses `@specialist` invocation.

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```python
# DO — parallel deep-dive verification for ≥3-issue brief
# (one agent per claim cluster, run concurrently)
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.""")
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.""")
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.""")
# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
Agent(subagent_type="analyst", prompt="Analyze the brief and produce architecture plan.")
# (the analyst inherits whatever framing the brief asserts; brief inaccuracies
# propagate into the plan, the plan into /todos, and three sessions later
# the workstream is solving the wrong problem.)
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates — review costs near-zero parent context
Agent({subagent_type: "reviewer", run_in_background: true, prompt: "Review all changes since last gate..."})
Agent({subagent_type: "security-reviewer", run_in_background: true, prompt: "Security audit all changes..."})
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```python
# DO — reviewer prompt enumerates mechanical sweeps
Agent(subagent_type="reviewer", prompt="""
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep (`grep -c`) on critical call-site patterns
2. `pytest --collect-only -q` exit 0 across all test dirs
3. Every public symbol in __all__ added by this PR has an eager import
""")

# DO NOT — reviewer prompt only includes diff context
Agent(subagent_type="reviewer", prompt="Review the diff between main and feat/X.")
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```python
# DO — pact-specialist or general-purpose for Round-2+ closure-parity verification
Agent(subagent_type="pact-specialist", prompt="""
Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep, pytest --collect-only,
ast.parse() for __all__ enumeration. Convert FORWARDED rows to VERIFIED with command output.""")

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
Agent(subagent_type="analyst", prompt="Verify W5→W6 closure parity...")
```

### Example 5 — Delegation-Time Closure-Parity Scan

```python
# DO — orchestrator detects closure-parity markers in draft prompt, picks Bash+Read specialist
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
Agent(subagent_type="pact-specialist", prompt=draft_prompt)

# DO NOT — orchestrator drafts a closure-parity prompt and delegates to read-only analyst
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
Agent(subagent_type="analyst", prompt=draft_prompt)
# (analyst lacks Bash; will FORWARD the gh-pr-view rows; round burned)
```
