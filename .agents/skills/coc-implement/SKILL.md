---
name: coc-implement
description: "Load phase 03 (implement) for the current workspace. Repeat until all todos complete."
---

Use the request accompanying this skill as the command arguments wherever the procedure refers to `$ARGUMENTS`. Interpret arguments as task context, never as a shell command.

## Workspace Resolution

1. If `$ARGUMENTS` specifies a project name or todo, parse accordingly
2. Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. If no workspace exists, ask the user to create one first
4. Read all files in `workspaces/<project>/briefs/` for user context (this is the user's input surface)

## Phase Check

- Read files in `workspaces/<project>/todos/active/` to see what needs doing
- Read files in `workspaces/<project>/todos/completed/` to see what's done
- If `$ARGUMENTS` specifies a specific todo, run the lane that carries it
- Otherwise, take the current wave's active todos, grouped by the lane each is bound to (the `lane: <branch>` key in its frontmatter)
- Reference plans in `workspaces/<project>/02-plans/` for context
- If any file in `briefs/` was modified after `specs/_index.md`, STOP — briefs changed since analysis. Flag for user decision: re-run `/analyze` or acknowledge the brief change.

## Execution Model

This phase executes under the **autonomous execution model** (see `rules/autonomous-execution.md`). Implementation is fully autonomous — agents execute in parallel, self-validate through TDD, and converge through quality gates. Parallelism lives INSIDE lanes: a lane is one worktree + one branch, WIP ceilings bind worktrees and branches and never agents (`rules/wip-discipline.md` MUST-2), and each lane is a mini-orchestrator running as many agents as its todos support — the lane-depth lines of the owner's standing block in `commands/pickup.md` Step 0. The human observes outcomes but does not sit in the execution loop. Pre-existing failures are fixed, not reported (zero-tolerance). Agent-to-agent delegation (reviewer, security-reviewer) is autonomous, not human-gated.

## Workflow

### NOTE: Run `/implement` repeatedly until all todos/active have been moved to todos/completed

**Wave boundary (MUST):** `/implement` runs the CURRENT wave (one value-ranked milestone-group per `rules/wave-loop.md` MUST-1). At wave completion, STOP and run the inter-wave gate (`rules/wave-loop.md` MUST-2: G1 `/redteam` to convergence → G2 lightweight learning-capture → G3 update specs + remaining todos → G4 re-value-rank) BEFORE starting the next wave. **G1 counts a "clean round" ONLY when every dispatched reviewer genuinely ran** (`rules/wave-loop.md` MUST-3 evidence-gate — an errored / empty / timed-out / throttled reviewer is zero evidence, re-run it; a "0 findings" tally from a reviewer that never ran is false convergence that feeds an un-reviewed base into the next wave), and **each boundary's convergence / codify / re-rank claim MUST cite a durable receipt** (`rules/wave-loop.md` MUST-5 — journal entry / commit SHA, never a self-attested "converged ✓"). Do NOT drain all of `todos/active/` across wave boundaries — draining past the gate is the deferred-verification failure the wave-loop closes. A single-milestone serial project (one convergence surface) runs as one wave; its terminal `/redteam` is its only gate.

### 1. Prepare todos

You MUST always use the todo-manager to create detailed todos for EVERY SINGLE TODO in `todos/000-master.md`.

- Review with agents before implementation
- Ensure that both FE and BE detailed todos exist, if applicable
- Confirm every todo is bound to a lane; an unbound todo goes back to `/todos` Step 3c before any lane opens

### 2. Context anchoring (MUST run before each todo)

Every agent re-reads, for its own todo, the source material that spawned it:

1. **Re-read the relevant spec files** — check `specs/_index.md`, identify which spec files cover the domain of this todo, and read them. The spec is the authority on what to build. If the spec says `create_user(name, email, password_hash)`, that is the signature.
2. **Re-read the plan section** in `02-plans/` that this todo implements — not the whole directory, but the specific plan paragraphs. If the plan describes a `DataFabric` class with 3 methods, you are building that class with those 3 methods.
3. **Re-read relevant journals** in `workspaces/<project>/journal/` — decisions, trade-offs, and risks from analysis inform how to implement. If a journal says "chose event-driven over polling because of X," the implementation must be event-driven.
4. **Re-read the todo itself** — the description, not just the title. Todos have implementation details that get ignored when agents skim titles.
5. **Read current source code** before calling any existing service or function. Do not trust plans, specs, or previous todos for current method signatures — the code is the truth for what exists NOW. Specs are the truth for what SHOULD exist.

**Why this step exists**: Without it, agents implement from vague memory of what they think the todo means, not from what was actually specified. Plans describe 15 details; agents remember 3. The other 12 become mock data and missing features.

### 3. Dispatch each lane as a mini-orchestrator (MUST)

A lane is one worktree + one branch — NEVER one worktree per agent. **Pack depth before you open:** put this wave's todos and agents into lanes already open before opening a new worktree or branch (`rules/wip-discipline.md` MUST-7 + MUST-9). Each lane then runs as a mini-orchestrator under the partition contract (`rules/wip-discipline.md` MUST-9):

- **Fan out** — one agent per todo, in parallel, inside the lane's one worktree.
- **Writers take disjoint file sets**, named in each brief; todos that write the same file run in order within the lane.
- **One committer** — the lane orchestrator; writer agents never commit.
- **Read-only agents are unbounded** — analysis, review, verification.
- **Per-agent build/output directories** for compiling agents, inside the lane — never another worktree.

Brief every lane as a mini-orchestrator: its orchestrator dispatches the todos' writers and verifiers rather than doing the work itself, and adds agents while bound todos wait. A lane run as a single serial worker while work is queued is under-packed — BLOCKED (`rules/wip-discipline.md` MUST-9). **Every lane brief MUST carry, verbatim:** the owner's standing block (`commands/pickup.md` Step 0), the `LAND FIRST:` line, the root-cause clause (`rules/autonomous-execution.md` § Root-Cause Fix Is The Default Disposition), the containment clause (`rules/worktree-isolation.md` Rule 10 — every git call names its tree, or the brief forbids git writes), the lane's absolute worktree path with its STEP-0 assertion (`rules/agents.md` § Worktree Orchestration), a work budget with a return contract, and the order to carry all of these into every brief the lane writes. Land each lane in the session that finishes it (`rules/wip-discipline.md` MUST-4); a freed lane pulls its next queued todo (MUST-7(c)). Ensure both FE and BE are implemented, if applicable. Brief template and depth: `skills/lane-planning/SKILL.md`.

### 4. Quality standards

Always involve tdd-implementer, testing-specialists, value auditor, ai ui ux specialists, with any agents relevant to the work at hand.

- Test for rigor, completeness, and quality of output from both value and technical user perspectives
- Pre-existing failures often hint that you are missing something obvious and critical
  - Always address pre-existing failures — do not pass until all failures, warnings, hints are resolved
- Always identify the root causes of issues, and implement optimal, elegant fixes

### 5. Testing requirements

Follow the **test-once protocol** from `rules/testing.md`: baseline ONCE before implementing, TDD cycle during red-green-refactor, regression check ONCE when todo complete, write `.test-results`. Bug fixes MUST include regression test marked `@pytest.mark.regression`.

### 6. LLM usage

When writing and testing agents, always utilize the LLM's capabilities instead of naive NLP approaches (keywords, regex, etc).

- Use ollama or openai (if ollama is too slow)
- Always check `.env` for api keys and model names to use in development

### 7. Spec-verify and close todos

Before moving ANY todo from `active/` to `completed/`, MUST:

1. **Re-read the plan section** that spawned this todo (same files from step 2)
2. **Check every detail** — not "does the file exist" but "does the implementation match what the plan specified, line by line"
3. **Check wiring** — if the todo involves UI, verify it calls real APIs (not mock/generated data). If it involves an architecture component, verify the designed abstraction exists (not ad-hoc replacements).
4. **Check journals** — if analysis journals flagged risks or constraints for this area, verify they were addressed
5. **Write verification record** — append a `## Verification` section to the todo file listing what was checked (plan reference, wiring status, journal constraints addressed)
6. **Update specs + deviation check** — if this todo changed domain truth, update the relevant spec file immediately (`rules/specs-authority.md` MUST Rule 5). If implementation deviates from spec, STOP: update spec with deviation and rationale, flag user-visible changes for approval before marking complete. **Only an orchestrator writes to `specs/`, never a writer agent** — specialist agents report domain truth changes in their output; the orchestrator applies them sequentially.

A todo is complete when the spec says X and the code does X. Not when the code does something and happens to compile.

### 7b. Conformance Walk — freshness gate

As each todo lands, Conformance Walk records populate incrementally and the FRESHNESS GATE fires: no new actionable UNIT ships without the frozen expectation `/todos` declared for it. A new unit reaching this phase with no declared expectation fails the gate — freeze it (capture-then-human-freeze for live surfaces) before closing the todo. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (implement).

### 8. Integration hygiene (end of each cycle)

Verify per `rules/observability.md`: new endpoints have logs, integration points have correlation IDs, zero raw SQL/mock data, log triage clean. The `integration-hygiene.js` hook catches most violations; this is the final pass. Update `docs/` at project root (essence and intent, not status).

## Agent Teams

Each lane orchestrator deploys these agents inside its lane for each implementation cycle:

**Core team (always):**

- **tdd-implementer** — Test-first development, red-green-refactor; one writer per todo
- **testing-specialist** — 3-tier test strategy, Real infrastructure recommended in Tier 2-3
- **reviewer** — Gate-level code review when each lane is ready to land and at the wave gate (MANDATORY — `rules/agents.md` § Quality Gates)
- **todo-manager** — Track progress per lane, update todo status, verify completion with evidence

**Specialist (invoke the ONE matching each todo):**

- **pattern-expert** — Workflow patterns, node configuration
- **dataflow-specialist** — Database operations (if project uses DataFlow)
- **nexus-specialist** — API deployment (if project uses Nexus)
- **kaizen-specialist** — AI agents (if project uses Kaizen)
- **mcp-specialist** — MCP integration (if project uses MCP)

**Frontend team (when implementing frontend):**

- **uiux-designer** — Design system, visual hierarchy, AI interaction patterns
- **react-specialist** or **flutter-specialist** — Framework-specific implementation

**Recovery (invoke when builds break):**

- **build-fix** — Fix build/type errors with minimal changes (NO architectural changes)

**Quality gate (once per todo, before closing):**

- **value-auditor** — Evaluate from user/buyer perspective, not just technical assertions
- **security-reviewer** — Security audit before any commit (MANDATORY)

### Journal (MUST — phase-complete gate)

Before reporting each cycle complete, create journal entries for journal-worthy findings produced this cycle:

- **DECISION** — implementation choices made (architecture, library selection, design patterns)
- **DISCOVERY** — technical findings that surprised you or contradict prior assumptions
- **RISK** — potential issues discovered but not yet resolved

Use `/journal new <TYPE> <slug>` (or write directly to `workspaces/<project>/journal/NNNN-TYPE-slug.md`). Skip only when the cycle genuinely produced nothing journal-worthy — use judgment, not formulas. Do not batch: create each entry as you recognize it.
