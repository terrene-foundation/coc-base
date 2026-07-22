---
id: "ANALYZE"
name: analyze
description: "Load phase 01 (analyze) for the current workspace"
---

## Workspace Resolution

1. If `$ARGUMENTS` specifies a project name, use `workspaces/$ARGUMENTS/`
2. Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/` and leading-underscore meta-dirs like `_archive`/`_template`, per `cc-artifacts.md` Rule 8 — this matches the `analyze-completeness-guard.js` resolver so the gate and the command select the same workspace)
3. If no workspace exists, ask the user to create one first
4. Read all files in `workspaces/<project>/briefs/` for user context (this is the user's input surface)

## Phase Check

- Output goes into `workspaces/<project>/01-analysis/`, `workspaces/<project>/02-plans/`, and `workspaces/<project>/03-user-flows/`

## Execution Model

This phase executes under the **autonomous execution model** (see `rules/autonomous-execution.md`). All analysis, deliberation, and recommendations MUST assume autonomous AI agent execution — not human team constraints. Do not estimate effort in human-days. Do not constrain recommendations by team size or hiring. Recommend the technically optimal approach; agents scale horizontally.

## Workflow

### 1. Be explicit about objectives and expectations

Understand the product idea before diving into research.

### 2. Perform Deep Research

Document in detail in `workspaces/<project>/01-analysis/01-research`.

- Use as many subdirectories and files as required
- Name them sequentially as 01-, 02-, etc, for easy referencing

### 3. Ensure strong product focus

Keep this soft rule in mind for everything:

- 80% of the codebase/features/efforts can be reused (agnostic)
- 15% of client specific requirements goes into consideration for self-service functionalities that can be reused (agnostic)
- 5% customization

Steps:

1. Research thoroughly and distill value propositions and UNIQUE SELLING POINTS
   - Scrutinize and critique the intent and vision, focusing on perfect product-market fit
   - Research competing products, gaps, painpoints, and any other information that helps build solid value propositions
   - Define unique selling points (not the same as value propositions) — be extremely critical and scrutinize them
2. Evaluate using platform model thinking
   - Seamless direct transactions between users (producers, consumers, partners)
     - Producers: Users who offer/deliver a product or service
     - Consumers: Users who consume a product or service
     - Partners: To facilitate the transaction between producers and consumers
3. Evaluate using the AAA framework
   - Automate: Reduce operational costs
   - Augment: Reduce decision-making costs
   - Amplify: Reduce expertise costs (for scaling)
4. Features must cover network behaviors for strong network effects
   - Accessibility: Easy for users to complete a transaction (activity between producer and consumer, not necessarily monetary)
   - Engagement: Information useful to users for completing a transaction
   - Personalization: Information curated for an intended use
   - Connection: Information sources connected to the platform (one or two-way)
   - Collaboration: Producers and consumers can jointly work seamlessly

### 4. Document everything

Document analysis in `workspaces/<project>/01-analysis/`, plans in `workspaces/<project>/02-plans/`, and user flows in `workspaces/<project>/03-user-flows/`.

- Use as many subdirectories and files as required
- Name them sequentially as 01-, 02-, etc, for easy referencing

### 5. Create specs/ (MUST — before red team)

Create `specs/` at the project root with detailed domain specification files. Specs are organized by the project's domain ontology (components, modules, features, user needs), NOT by process stages. See `rules/specs-authority.md`.

1. **Create `specs/_index.md`** — a lean manifest listing every spec file with domain and one-line description
2. **Create domain spec files** — one per major domain area discovered during analysis. Each file must be detailed enough to be the authority on its topic: every flow, contract, constraint, edge case, and decision.
3. **Brief traceability** — for each requirement sentence in `briefs/`, confirm a corresponding spec file section exists. Missing mappings are BLOCKING — they become the requirements that silently disappear.

The structure is project-defined. Examples:

- SaaS: `authentication.md`, `billing.md`, `data-model.md`, `notifications.md`
- SDK: `core-api.md`, `configuration.md`, `error-handling.md`, `extensibility.md`
- ML: `data-pipeline.md`, `model-architecture.md`, `training.md`, `serving.md`
- Non-coding: organized by whatever domain structure fits

### 6. Red team

Work with red team agents to scrutinize analysis, plans, user flows, AND specs.

- Identify any gaps, regardless how small
- Always go back to first principles, identify the roots, and plan the most optimal and elegant implementations
- Analysis, user flows must flow into plans
- Verify every brief requirement appears in at least one spec file

### 7. Conformance Walk (standing capability)

Run the Conformance Walk enumerator over every testable surface the project exposes → surface the INVENTORY + baseline coverage (the un-expectationed frontier) into `01-analysis/`. This front-loads which actionable units exist and which carry no expectation yet, before planning. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (analyze).

## Agent Teams

Deploy these agents as a team for analysis:

- **analyst** — Failure analysis, complexity assessment, identify risks
- **analyst** — Break down requirements, create ADRs, define scope
- `co-reference` skill — Ground analysis in COC methodology; identify institutional knowledge gaps and guard against the three fault lines (amnesia, convention drift, security blindness)
- **`decide-framework` skill** — Choose implementation approach (if applicable)

For product/market analysis, additionally deploy:

- **value-auditor** — Evaluate from enterprise buyer perspective, critique value propositions

For frontend projects, additionally deploy:

- **uiux-designer** — Information architecture, visual hierarchy, design system planning
- **uiux-designer** — AI interaction patterns (if the project involves AI interfaces)

Red team the analysis with agents until they confirm no gaps remain in research, plans, and user flows.

### Journal (MUST — phase-complete gate)

Before reporting `/analyze` complete, create journal entries for journal-worthy findings produced this phase:

- **DISCOVERY** — key findings, patterns, or domain knowledge uncovered during research
- **GAP** — missing information, unvalidated assumptions, or areas needing follow-up research
- **CONNECTION** — non-obvious relationships between requirements, components, or findings

Use `/journal new <TYPE> <slug>` (or write directly to `workspaces/<project>/journal/NNNN-TYPE-slug.md`). Skip only when the phase genuinely produced nothing journal-worthy — use judgment, not formulas. Do not batch: create each entry as you recognize it, not at the end.

### Output-Completeness Gate (MUST — phase-complete + advance gate)

`/analyze` MUST NOT be declared complete, and `/todos`/`/implement` MUST NOT advance, while any compulsory output tree is empty. Prose naming the outputs is insufficient — they were named above and still got skipped; the gate is mechanical. Run the `find` battery; ANY `INCOMPLETE` line BLOCKS completion AND blocks advancing to `/todos`:

```bash
W="workspaces/<project>"   # the resolved workspace
for tree in 01-analysis 02-plans 03-user-flows; do
  find "$W/$tree" -type f -name '*.md' ! -name '.gitkeep' 2>/dev/null | grep -q . \
    || echo "INCOMPLETE: $W/$tree has no non-.gitkeep .md output"
done
# specs/ is satisfied by EITHER location (the corpus is ambiguous —
# specs-authority.md Rule 1 says project root, Rule 9 says workspaces/<project>/specs/):
{ find "$W/specs" -type f -name '*.md' ! -name '.gitkeep' 2>/dev/null
  find specs -type f -name '*.md' ! -name '.gitkeep' 2>/dev/null; } | grep -q . \
  || echo "INCOMPLETE: specs/ empty at BOTH $W/specs and repo-root specs/"
```

The `03-user-flows/` tree is compulsory. A change with genuinely no user-facing surface (a pure back-end refactor) does NOT skip it silently — write `03-user-flows/00-no-user-flows.md` stating WHY no flows apply. That documented-rationale file is a real `.md` and satisfies the gate; a silent-empty tree does not.

This gate is also enforced structurally by `hooks/analyze-completeness-guard.js` (a `PreToolUse(Skill)` gate that DENIES `/todos`/`/implement` when analysis has started but a compulsory tree is empty) per `rules/analyze-output-completeness.md`.
