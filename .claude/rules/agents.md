---
priority: 0
scope: baseline
---

# Agent Orchestration Rules

See `.claude/guides/rule-extracts/agents.md` for full evidence, extended examples, post-mortems, recovery-protocol commands, the gate-review table, and CLI-syntax variants.

<!-- slot:neutral-body -->


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

## MUST: Worktree Isolation for Compiling Agents

Agents that compile MUST use the CLI's worktree-isolation primitive to avoid build-directory lock contention. The exact build-cache lock varies by stack (Rust: `target/`; Python editable installs: `.venv/`; Go: `$GOCACHE`; TypeScript: `node_modules/.cache/`); the principle is uniform.

**Why:** Compilers and package managers hold exclusive filesystem locks on their build caches. Worktrees give each agent its own cache. See `skills/30-claude-code-patterns/worktree-orchestration.md` for the full 5-layer protocol — worktree isolation is necessary but not sufficient.

## MUST: Worktree Prompts Use Relative Paths Only

When prompting an agent with worktree isolation, the orchestrator MUST reference files via paths RELATIVE to the repo root — never absolute paths.

**BLOCKED rationalizations:** "Absolute paths are unambiguous" / "The agent should figure out its own cwd" / "This worked the one time I tested it".

**Why:** Worktree isolation sets cwd to the worktree; absolute paths point back to the parent checkout, silently defeating isolation.

## MUST: Recover Orphan Writes From Zero-Commit Worktree Agents

When a worktree-isolated agent reports completion but the branch has zero commits AND the worktree has been auto-cleaned, the parent MUST inspect the MAIN checkout for orphaned untracked files BEFORE concluding the work was lost. Absolute-path writes from the agent resolve to the MAIN checkout cwd — the files are NOT lost; they are orphaned, uncommitted, and reachable via `git status` on the parent.

**BLOCKED rationalizations:** "The agent said it was done, the work must be committed somewhere" / "Re-launching is cleaner" / "If the branch has zero commits, the work is gone" / "The main checkout is clean" / "recovery/ branches are a workaround; feat/ is more correct".

**Why:** Re-launching abandons real work every time an absolute-path agent truncates. `git status` reveals the orphans; `recovery/` grep surfaces this class of rescue across history.

## MUST: Worktree Agents Commit Incremental Progress

Every worktree-isolated agent MUST receive an explicit instruction in its prompt to `git commit` after each milestone. The orchestrator MUST verify the branch has ≥1 commit before declaring the agent's work landed.

**BLOCKED rationalizations:** "The agent will commit at the end" / "Splitting adds overhead" / "The parent can recover from the worktree after exit".

**Why:** Worktrees with zero commits are silently deleted.

## MUST: Verify Agent Deliverables Exist After Exit

When an agent reports completion of a file-writing task, the parent MUST `ls` or `Read` the claimed file before trusting the completion claim.

**BLOCKED rationalizations:** "The agent said 'done', that's good enough" / "Now let me write the file…" (with no subsequent tool call).

**Why:** Budget exhaustion truncates writes mid-message. The `ls` check is O(1) and converts silent no-op into loud retry.

## MUST: Parallel-Worktree Package Ownership Coordination

When launching ≥2 parallel agents whose worktrees touch the SAME sub-package, the orchestrator MUST designate ONE agent as **version owner** (manifest version anchor + CHANGELOG) AND tell every sibling explicitly: "do NOT edit those files". Integration belongs to the orchestrator. Per-language anchors: Python (`pyproject.toml` + `__init__.py::__version__`); Rust (`Cargo.toml` + `lib.rs` `pub const VERSION`); Go (`go.mod` + module-level `const`); TypeScript (`package.json::version`).

**BLOCKED rationalizations:** "Both agents are smart enough to see the existing version" / "We'll resolve at merge time" / "Each agent owns a section of the CHANGELOG".

**Why:** Parallel agents see the same base SHA; each independently bumps `version` and writes a CHANGELOG entry. Merge picks one — discarding the other's prose silently.

## MUST NOT

- **Stack-coupled work without consulting `STACK.md`** — the generic specialists fall back to LOW-confidence advice; the agent is responsible for either confirming the stack or running the `/onboard-stack` command first.
- **Sequential when parallel is possible** — wastes the autonomous execution multiplier.

Origin: 2026-04-19 worktree drift + 2026-04-20 parallel-release + 2026-04-27 W6 closure-parity. Base-variant adaptation 2026-05-06: stack-specialist names neutralized to db/api/ai-specialist trio reading `STACK.md`.

<!-- /slot:neutral-body -->
