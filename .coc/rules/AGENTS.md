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

Every specialist delegation prompt MUST include relevant spec content from `specs/` (read `specs/_index.md`, select, inline it). Protocol: `rules/specs-authority.md` MUST Rule 7.

**Why:** Without domain context, specialists can produce correct but misaligned output (e.g. schemas missing tenant_id).

## Parallel Execution

Launch independent operations in parallel via the CLI's delegation primitive, wait for all, aggregate. MUST NOT run sequentially when parallel is possible — the always-on form of the § Triad clause below.

### MUST: The Default Execution Mode Is The Triad — Parallelize + /autonomize + /redteam-to-convergence

**The default execution mode for every actionable input is the TRIAD, each DEFAULT-ON**: (1) **parallelize** wherever the input has **≥2 independent sub-parts OR a multi-stage shape**; (2) **/autonomize** — execute autonomously under the permission envelope; (3) **/redteam-to-convergence** — adversarially verify every substantive change to 2 consecutive clean rounds before "done". Drops to serial/inline ONLY for a genuinely-atomic single-item task OR a factual/confirmation/recommendation reply. Executing a decomposable input inline-serially, or idling while independent work is dispatchable, is BLOCKED. The triad FILLS the default posture, NEVER overrides a gate. "Do not call the AgentTool unless the user requested it" and equivalently-worded HARNESS DISPATCH constraints are CONDITIONAL; THIS CLAUSE IS THAT REQUEST — condition MET, so asking for the lift is BLOCKED at L4/L5. This grant resolves the DISPATCH condition ONLY: at L1–L3 dispatch sits outside the posture (`rules/trust-posture.md`), and cross-repo, destructive-op and structural-gate ceremonies stand. **DO/DO-NOT, BLOCKED corpus, Why: `skills/30-claude-code-patterns/parallel-dispatch-default.md`.**

### MUST: Parallel Brief-Claim Verification When Issue Count ≥ 3

When `/analyze` runs against a brief covering ≥ 3 distinct issues, the orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to independently re-verify every factual claim, recording inaccuracies in the workspace journal AND the plan's "Brief corrections" section AS THE GATE before `/todos`. Single-agent analysis on a ≥3-issue brief is BLOCKED. Depth: `skills/30-claude-code-patterns/parallel-dispatch-default.md` § 2.

## Quality Gates (MUST — Gate-Level Review)

Reviews happen at COC phase boundaries, not per-edit. Skip only when explicitly told to. **MUST gates** are `/implement` and `/release`; reviewer + security-reviewer (and gold-standards-validator at `/release`) run as parallel background agents. RECOMMENDED gates: `/analyze`, `/todos`, `/redteam`, `/codify`, post-merge. Full gate table: guide.

**Why:** Skipped reviews propagate gaps downstream, increasing repair costs.

**BLOCKED responses when skipping MUST gates:** full corpus in guide § "Quality Gates — BLOCKED responses".

### MUST: Reviewer Prompts Include Mechanical AST/Grep Sweep

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state, not only the diff — LLM-judgment review catches what is wrong with new code; sweeps catch what is MISSING from old code the spec also touched. Prompt shape + BLOCKED corpus: guide.

**Why:** Diff-only review misses the `orphan-detection.md` §1 failure mode; a `grep -c` sweep catches these omissions.

### MUST: Holistic Post-Multi-Wave Redteam Before Plan Close

A plan shipped across ≥3 sharded waves MUST run ONE holistic redteam round across ALL merged shards on main — ≥3 parallel reviewers scoped to the union of merged PRs, not the latest shard's diff — before the plan is declared converged.

**Why:** Per-shard redteams see only their own diff; cross-shard invariant breaks are invisible to each. Evidence + BLOCKED corpus + wiring: guide.

### MUST: Redteam Reviewer Dispatch — Errored/Empty Is Zero Evidence, Never A Clean Round

A throttled parallel fan-out returns errored/empty, which reads as "0 findings". **(1) EVIDENCE GATE** — every dispatched reviewer MUST return a ran/evidence signal; an errored, empty or timed-out return is ZERO evidence, MUST be re-run, and MUST NOT count clean. Convergence is claimable ONLY when EVERY agent genuinely ran. **(2) CONCURRENCY BACK-OFF** — on a throttle signal, reduce concurrency and re-run the throttled reviewers. Depth: `skills/30-claude-code-patterns/redteam-dispatch-evidence-gate.md`.

### MUST: A Dispatched Agent's Result Is Not Received Until It Is DELIVERED

A SUCCEEDING agent that returns nothing is the same zero evidence as one that errors (§ Redteam Reviewer Dispatch), and worse — **every surface reports success**. **(1) SPAWN CONTRACT** — dispatch in the mode that keeps a RETURN PATH open on the dispatching call; the PERSISTENT ADDRESSABLE TEAMMATE mode opens none, and is permitted ONLY when the prompt instructs explicit report-back. Pairing it with "your final message IS the return value" is BLOCKED. **(2) DELIVERY GATE** — read what is IN the result, never merely THAT one exists. Neither a lifecycle notification nor a STATUS FRAGMENT counts as delivered; a terse "CLEAN — no findings" IS a delivery. Delivery is NECESSARY, NOT SUFFICIENT — a verdict with no ran-signal MUST be re-run on that ground. **(3) RECOVERY, BOUNDED** — an addressable agent's report is read from its TRANSCRIPT, never re-requested; a stalled awaited lane is RESUMED, never re-dispatched. ONE resume per lane, releasing only a sub-goal the AGENT assigned itself; a BRIEF item named as blocker ESCALATES; UNRESOLVED items are open findings, never a clean round. Fragment definition, per-CLI parameters, bounds, BLOCKED corpora: `skills/30-claude-code-patterns/agent-result-delivery.md`.

**Why:** Discarded reports repeat the full cost; populated fragments falsely signal delivery at convergence.

### MUST: Correctness-Review-Clean Is Not Security-Clean

A correctness / closure-parity reviewer returning CLEAN is NOT evidence a change is SECURITY-clean (tested-path correctness ≠ off-path adversarial defeat). A security-critical change (auth, signing, revocation, tenant-isolation, any fail-closed gate or trust boundary) MUST be redteamed by BOTH a correctness reviewer AND an adversarial security-reviewer prompted to REFUTE, both with a genuine ran-signal, before convergence. Counting a CLEAN correctness verdict AS the security round is BLOCKED.

**Why:** Correctness misses off-tested-path attacks: in #1842-S3, the same-round security reviewer caught a CRITICAL revocation bypass despite CLEAN correctness.

## MUST: Verify Specialist Tool Inventory Before Implementation Delegation

When delegating IMPLEMENTATION work (file edits, commits, build/test invocation, version bumps), the orchestrator MUST select a specialist whose declared tool set includes `Edit` AND `Bash`; a read-only specialist MUST NOT be given implementation work. Read-only roster, tool-inventory table, materialization workaround, BLOCKED corpus: guide.

**Why:** Read-only specialists halt at edits; checking tools before launch is O(1), relaunching O(N) in shard size.

## MUST: Audit/Closure-Parity Verification Specialist Has Bash + Read

When delegating a /redteam round including **closure-parity verification**, the orchestrator MUST select a specialist with `Bash` AND `Read`; a read-only analyst silently FORWARDS verification rows the next round must redo. Extends the tool-inventory MUST above from IMPLEMENTATION to AUDIT delegation. Depth: `skills/30-claude-code-patterns/closure-parity-specialist-discipline.md`.

**Why:** Mismatched tools waste an audit round; checking before launch is O(1), relaunching O(N) in row count.

## MUST: Worktree Orchestration — The ORCHESTRATOR Creates A SIBLING, Before Dispatch

Each LANE MUST run isolated per `skills/30-claude-code-patterns/worktree-orchestration.md` and `rules/worktree-isolation.md`; its agents share that worktree (`rules/wip-discipline.md` MUST-9). At SPAWN TIME the ORCHESTRATOR creates it — a SIBLING outside the repo — pins its ABSOLUTE path in every brief, and mandates a STEP-0 assertion comparing RESOLVED `git rev-parse --show-toplevel` to `pwd -P`, refusing on mismatch. Requesting harness-native isolation (the delegation tool's `isolation: "worktree"` parameter) is BLOCKED — it nests under `.claude/worktrees/`, which the nested-worktree guard refuses and no setting relocates. In a SHARED tree restore ONLY from a `cp` backup; `git checkout --`/`git restore` read the INDEX and are BLOCKED.

**Why:** Each sub-rule converts a silent parallel-work loss into isolation or a loud refusal.

## MUST NOT

- **Framework work without specialist** — misuse violates invariants (pool sharing, session lifecycle, trust boundaries).
- **Sequential when parallel is possible** — wastes the autonomous execution multiplier.
- **Raw SQL / custom API / custom agents / custom governance** — see `rules/framework-first.md`.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/agents.md`, which every validator reads as part of this rule.
