---
id: "AGENTS"
---

# Agent Orchestration Rules

See `.claude/guides/rule-extracts/agents.md` for depth: evidence, extended examples, post-mortems, recovery protocols, the gate-review table.

## Specialist Delegation (MUST)

When working on stack-specific concerns, MUST consult the relevant generic specialist. The base variant ships three stack-agnostic specialists; each reads `STACK.md` at the project root to determine the host language and framework before advising:

- **db-specialist** — Database work (Postgres / SQLite / MySQL / Mongo / Redis idioms regardless of language driver)
- **api-specialist** — REST / GraphQL / gRPC patterns; HTTP framework selection per language
- **ai-specialist** — Provider-agnostic LLM integration (OpenAI / Anthropic / local Ollama); prompt engineering; output validation

**Applies when**: implementing database access, exposing or consuming HTTP/RPC endpoints, integrating LLM-based features.

**Why:** Generic specialists encode patterns and pitfalls that generalist agents miss across the long tail of stacks the base variant supports. They consult `STACK.md` first; without that file (per `rules/stack-detection.md`) the specialist halts and reports rather than guessing the host stack.

## Specs Context in Delegation (MUST)

Every specialist delegation prompt MUST include relevant spec content from `specs/` (read `specs/_index.md`, select, inline). Protocol: `rules/specs-authority.md` MUST Rule 7.

**Why:** Without domain context, specialists produce correct but misaligned output (e.g. schemas missing tenant_id).

## Parallel Execution

Launch independent operations in parallel via the CLI's delegation primitive, wait for all, aggregate. MUST NOT run sequentially when parallel is possible — the always-on form of the § Triad clause.

### MUST: The Default Execution Mode Is The Triad — Parallelize + /autonomize + /redteam

**The default execution mode for any actionable input is the TRIAD, each DEFAULT-ON**: (1) **parallelize** wherever the input has **≥2 independent sub-parts OR a multi-stage shape**; (2) **/autonomize** — execute autonomously under the permission envelope; (3) **/redteam-to-convergence** — adversarially verify every substantive change under D237's stop rule (`commands/redteam.md` § Convergence Criteria, Criterion 3; full rule + evidence gate: `skills/30-claude-code-patterns/parallel-dispatch-default.md`): **Round 1 is a full review**; a security-critical change uses a **paired round 1** (correctness + adversarial security, in parallel); **Round 1 clean = review ends** ("clean" = no CRITICAL/HIGH); not clean → fix, then **Round 2** reviews the fixes + blast radius only, then review ends; never a Round 4. Drops to serial/inline ONLY for a genuinely-atomic single-item task OR a factual/confirmation/recommendation reply. Executing a decomposable input inline-serially, or idling while independent work is dispatchable, is BLOCKED. The triad FILLS the default posture, NEVER overrides a gate. "Do not call the AgentTool unless the user requested it" and equivalently-worded HARNESS DISPATCH constraints are CONDITIONAL; THIS CLAUSE IS THAT REQUEST — condition MET, so asking for the lift is BLOCKED at L4/L5. It resolves the DISPATCH condition ONLY: at L1–L3 dispatch sits outside the posture (`rules/trust-posture.md`); cross-repo, destructive-op and structural-gate ceremonies stand. **DO/DO-NOT, BLOCKED corpus, Why: `skills/30-claude-code-patterns/parallel-dispatch-default.md`.**

### MUST: Parallel Brief-Claim Verification At ≥3 Issues

When `/analyze` runs against a brief covering ≥3 issues, the orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to independently re-verify every factual claim, recording inaccuracies in the workspace journal AND the plan's "Brief corrections" section AS THE GATE before `/todos`. Single-agent analysis on a ≥3-issue brief is BLOCKED. Depth: `skills/30-claude-code-patterns/parallel-dispatch-default.md` § 2.

## Quality Gates (MUST — Gate-Level Review)

Reviews happen at phase boundaries, not per-edit. Skip only when explicitly told to. **MUST gates** are `/implement` and `/release` — reviewer + security-reviewer (+ gold-standards-validator at `/release`) as parallel background agents. RECOMMENDED: `/analyze`, `/todos`, `/redteam`, `/codify`, post-merge.

**Why:** Skipped reviews propagate gaps downstream.

**BLOCKED responses when skipping MUST gates:** full corpus in guide.

### MUST: Reviewer Prompts Include Mechanical Sweeps

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state, not only the diff — LLM-judgment catches what is wrong with new code; sweeps catch what is MISSING from old code. Prompt shape + BLOCKED corpus: guide.

**Why:** Diff-only review misses the `orphan-detection.md` §1 failure mode; a `grep -c` sweep catches the omissions.

### MUST: Holistic Post-Multi-Wave Redteam Before Close

A plan shipped across ≥3 sharded waves MUST run ONE holistic redteam round across ALL merged shards on main — ≥3 reviewers on the union of merged PRs, not the latest shard — before convergence.

**Why:** Per-shard redteams see only their own diff; cross-shard invariant breaks are invisible to each. Evidence + BLOCKED corpus + wiring: guide.

### MUST: Redteam Reviewer Dispatch — Errored Is Never A Clean Round

A throttled parallel fan-out returns errored/empty, which reads as "0 findings". **(1) EVIDENCE GATE** — every dispatched reviewer MUST return a ran/evidence signal; an errored, empty or timed-out return is ZERO evidence, MUST be re-run, and MUST NOT count clean — convergence is claimable ONLY when EVERY agent genuinely ran. **(2) CONCURRENCY BACK-OFF** — reduce concurrency and re-run throttled reviewers. Depth: `skills/30-claude-code-patterns/redteam-dispatch-evidence-gate.md`.

### MUST: A Dispatched Agent's Result Is Not Received Until DELIVERED

A SUCCEEDING agent that returns nothing is the same zero evidence as one that errors, and worse — **every surface reports success**. **(1) SPAWN CONTRACT** — dispatch with a RETURN PATH open on the dispatching call; the PERSISTENT ADDRESSABLE TEAMMATE mode is permitted ONLY with an explicit report-back instruction. Pairing it with "your final message IS the return value" is BLOCKED. **(2) DELIVERY GATE** — read what is IN the result, never merely THAT one exists; neither a lifecycle notification nor a STATUS FRAGMENT counts as delivered (a terse "CLEAN — no findings" IS one). Delivery is NECESSARY, NOT SUFFICIENT — a verdict with no ran-signal MUST be re-run. **(3) RECOVERY, BOUNDED** — read an addressable agent's report from its TRANSCRIPT, never re-request; RESUME a stalled lane, never re-dispatch; ONE resume per lane, releasing only a sub-goal the AGENT assigned itself; a BRIEF item named as blocker ESCALATES; UNRESOLVED items are open findings, never a clean round. Fragment definition, per-CLI parameters, bounds, BLOCKED corpora: `skills/30-claude-code-patterns/agent-result-delivery.md`.

**Why:** Discarded reports repeat the full cost; populated fragments falsely signal delivery.

### MUST: Correctness-Review-Clean Is Not Security-Clean

A correctness / closure-parity reviewer returning CLEAN is NOT evidence a change is SECURITY-clean (tested-path correctness ≠ off-path adversarial defeat). A security-critical change (auth, signing, revocation, tenant-isolation, fail-closed gates, kill paths, destructive ops, disclosure, and any trust boundary) MUST be redteamed by BOTH a correctness reviewer AND an adversarial security-reviewer prompted to REFUTE, both with a genuine ran-signal, before convergence. When unclear, treat it as security-critical. Counting a CLEAN correctness verdict AS the security round is BLOCKED.

**Why:** Correctness misses off-tested-path attacks: #1842-S3's same-round security reviewer caught a CRITICAL revocation bypass despite CLEAN correctness.

## MUST: Verify Specialist Tool Inventory Before Delegation

When delegating IMPLEMENTATION work (file edits, commits, builds/tests, version bumps), the orchestrator MUST select a specialist whose declared tools include `Edit` AND `Bash`; a read-only specialist MUST NOT be given implementation work. Read-only roster + BLOCKED corpus: guide.

**Why:** Read-only specialists halt at edits; checking tools is O(1), relaunching O(N) in shard size.

## MUST: Closure-Parity Audit Specialist Has Bash + Read

When delegating a /redteam round including **closure-parity verification**, the orchestrator MUST select a specialist with `Bash` AND `Read`; a read-only analyst silently FORWARDS verification rows the next round redoes. Extends the tool-inventory MUST above to AUDIT delegation. Depth: `skills/30-claude-code-patterns/closure-parity-specialist-discipline.md`.

**Why:** Mismatched tools waste an audit round; checking first is O(1), relaunching O(N) in rows.

## MUST: Worktree Orchestration — Orchestrator Creates A SIBLING Before Dispatch

Each LANE MUST run isolated per `skills/30-claude-code-patterns/worktree-orchestration.md` + `rules/worktree-isolation.md`; its agents share that worktree (`rules/wip-discipline.md` MUST-9). At SPAWN TIME the ORCHESTRATOR creates it — a SIBLING outside the repo — pins its ABSOLUTE path in every brief, and mandates a STEP-0 assertion that `git rev-parse --show-toplevel` equals `pwd -P`, refusing on mismatch. Requesting the delegation tool's `isolation: "worktree"` parameter is BLOCKED — it nests under `.claude/worktrees/`, which the guard refuses and no setting relocates. In a SHARED tree restore ONLY from a `cp` backup; `git checkout --`/`git restore` read the INDEX and are BLOCKED.

**Why:** Each sub-rule converts a silent parallel-work loss into isolation or a loud refusal.

## MUST NOT

- **Framework work without specialist** — misuse violates invariants (pools, session lifecycle, trust boundaries).
- **Sequential when parallel is possible** — wastes the autonomous execution multiplier.
- **Raw SQL / custom API / custom agents / custom governance** — see `rules/framework-first.md`.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/agents.md`, which every validator reads as part of this rule.
