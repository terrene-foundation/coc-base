---
name: todos
description: "Load phase 02 (todos) for the current workspace"
---

## Workspace Resolution

1. If `$ARGUMENTS` specifies a project name, use `workspaces/$ARGUMENTS/`
2. Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. If no workspace exists, ask the user to create one first
4. Read all files in `workspaces/<project>/briefs/` for user context (this is the user's input surface)

## Phase Check

- Read files in `workspaces/<project>/02-plans/` for context
- Read `specs/_index.md` and all relevant spec files for domain truth (MUST — see `rules/specs-authority.md`). **If `specs/_index.md` does not exist, STOP — return to `/analyze` Step 5. Do NOT create specs during /todos.**
- Read ALL journal entries from `/analyze` phase — especially DECISION, TRADE-OFF, and DISCOVERY types. Journal is a read-gate, not just a write-gate.
- Check if `todos/active/` already has files (resuming)
- All todos go into `workspaces/<project>/todos/active/`

## Execution Model

This phase executes under the **autonomous execution model** (see `rules/autonomous-execution.md`). All effort estimates in todos MUST use autonomous execution cycles, not human-days. When referencing external plans that estimate in human-days, apply the 10x multiplier to translate. Do not phase work based on "team bandwidth" — phase based on dependency order and validation gates.

**Per-session capacity budget (MUST):** Each todo MUST fit within a single session's capacity — ≤500 LOC load-bearing logic, ≤5–10 simultaneous invariants, ≤3–4 call-graph hops, describable in 3 sentences. See `rules/autonomous-execution.md` § Per-Session Capacity Budget. Todos that exceed the budget MUST be sharded at this phase, not deferred to `/implement`.

**The /todos approval gate is a structural gate**: the human approves the plan (what and why), not the execution (how and when). Once approved, /implement executes autonomously.

## Workflow

### 1. Review plans with specialists

Reference plans in `workspaces/<project>/02-plans/` and work through every single file.

- **(Backend)** Work with framework specialists (kailash, kaizen, dataflow, nexus). Follow procedural directives. Review and revise plans as required.
- **(Frontend)** Work with frontend agents. Review implementation plans and todos for frontends. Use a consistent set of design principles for all FE interfaces. Use the latest modern UI/UX principles/components/widgets.

### 2. Codebase locations (project root, not workspace)

- `src/...` for all backend codebase
- `apps/web` for all web FE codebase
- `apps/mobile` for all mobile FE codebase

### 3. Create comprehensive todos

**CRITICAL: Write ALL todos for the ENTIRE project.**

- Do NOT limit to "phase 1" or "what should be done now"
- Do NOT FILTER — write EVERY task required to complete the full project. **DO value-rank** within the all-tasks list per `rules/value-prioritization.md` MUST-1: each milestone group MUST be ordered by user value (cite the brief / spec § / `briefs/` / journal `DECISION-` entry that anchors the rank). Filtering scope is BLOCKED; value-ranking within scope is REQUIRED.
- Cover backend, frontend, testing, deployment, documentation — everything
- Each todo should be detailed enough to implement independently
- If the plans reference it, there must be a todo for it
- For large projects (20+ todos), organize into numbered milestones/groups for clarity.
- **Declare the wave sequence — COMPULSORY for EVERY plan, not just large ones** (`rules/wave-loop.md` MUST-1). Each value-ranked milestone-group IS a wave. Every plan MUST declare an explicit Wave 1…N sequence: a project with ≥2 value-distinct milestone-groups (or a group whose cumulative invariant surface exceeds one convergence pass) MUST be ≥2 waves so an inter-wave gate fires before the terminal redteam; size each wave so its invariant surface fits one convergence pass (split a value-coherent but high-invariant group at the invariant boundary). A genuinely single-milestone, single-convergence-surface project declares ONE wave WITH its stated serial-carve-out justification. **A flat todo list with no declared wave sequence is BLOCKED** — it makes the inter-wave gate inert (no boundary to fire at).
- **Later waves are PROVISIONAL, not frozen** (`rules/wave-loop.md` MUST-4): write ALL todos now (the forest MUST stay visible per `rules/value-prioritization.md` MUST-1), but todos in not-yet-started waves are re-validated + re-ranked at each inter-wave gate — never frozen-final, never deleted down to "wave 1 only".
- Each todo MUST reference which spec file(s) it implements (e.g., "Implements: specs/authentication.md §Login Flow")
- Update spec files if /todos planning reveals new contracts or interfaces (first-instance update discipline)

**CRITICAL: Integration wiring is a separate todo.** Every component that consumes or produces data MUST have TWO todos:

1. **Build** — create the component with structure and logic (`"Build carpark page"`, `"Build prediction handler"`)
2. **Wire** — connect to real data sources, replace all mock/hardcoded data with live calls (`"Wire carpark page to backend API"`, `"Wire prediction handler to ML service"`)

This applies to frontend (pages calling APIs) AND backend (handlers calling services, databases, or external APIs). A handler returning `{"predictions": [0.9, 0.8]}` instead of calling the ML service is the same bug as a page using `generateHourlyOccupancy()`.

A "build" todo is complete when the component runs. A "wire" todo is complete when real data flows end-to-end with zero mock data remaining. These are NOT the same task and MUST NOT be collapsed.

**CRITICAL: Architecture plans are contractual.** Every abstraction in `02-plans/` (data fabric, ML fabric, service layers, etc.) MUST have a corresponding implementation todo. If a plan describes a `DataFabric` class, there must be a todo to build that class — not just ad-hoc calls that bypass the design.

Create detailed todos for EVERY task required. Place them in `todos/active/`.

### 4. Red team the todo list

Review with red team agents continuously until they are satisfied there are no gaps remaining.

### 5. Surface forest-vs-trees check before STOP

Per `rules/value-prioritization.md` MUST-1, surface the **value-ranked top-3 candidate workstreams** with user-anchored rationale BEFORE the human gate. Each candidate carries: (a) primary anchor (brief / spec § / journal DECISION), (b) shard-fit disposition (single-shard / decompose-into-N), (c) named trade-off if recommending the smaller fittable item over a higher-value-needs-decomposition item. Silent fittability-pick at this gate is BLOCKED.

### 6. STOP — wait for human approval before proceeding to implementation.

## Agent Teams

Deploy these agents as a team for todo creation:

- **todo-manager** — Create and organize the detailed todos, ensure completeness
- **analyst** — Break down requirements, identify missing tasks
- **analyst** — Identify failure points, dependencies, and gaps
- `co-reference` skill — Ensure todos include context/guardrails/learning work, not just features (COC five-layer completeness)
- **`decide-framework` skill** — Ensure todos cover the right framework choices (if applicable)

For frontend projects, additionally deploy:

- **uiux-designer** — Ensure UI/UX todos cover design system, responsive layouts, accessibility
- **flutter-specialist** or **react-specialist** — Framework-specific frontend todos

Red team the todo list with agents until they confirm no gaps remain.

### Journal (MUST — phase-complete gate)

Before reporting `/todos` complete, create journal entries for journal-worthy decisions made during planning:

- **DECISION** — scope choices, prioritization rationale, architectural direction
- **TRADE-OFF** — competing approaches evaluated and why one was chosen
- **RISK** — risks identified during planning (scope, dependency, schedule, technical)

Use `/journal new <TYPE> <slug>` (or write directly to `workspaces/<project>/journal/NNNN-TYPE-slug.md`). Skip only when the phase genuinely produced nothing journal-worthy — use judgment, not formulas. Do not batch: create each entry as you recognize it, not at the end.
