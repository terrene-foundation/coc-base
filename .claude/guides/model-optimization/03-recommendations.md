# Model Assignment Recommendations

**Date**: 2026-03-11
**Principle**: Performance first. Sonnet only where evidence shows equivalent or better results.

---

## Summary of Changes

| Repo                     | Current Sonnet | Recommended Sonnet | Agents Changed    |
| ------------------------ | -------------- | ------------------ | ----------------- |
| Terrene Foundation       | 2              | **3**              | +1 (todo-manager) |
| Kailash Python SDK BUILD | 1              | **7**              | +6                |
| Kailash Python USE       | 2              | **8**              | +6                |
| Kailash Rust BUILD/USE   | 2              | **8**              | +6                |
| **Total**                | **7**          | **26**             | **+19**           |

This moves from **6.9% Sonnet** to **25.7% Sonnet** — a conservative optimization focused on agents performing mechanical, pattern-matching, or search tasks where Sonnet performs equivalently or better than Opus.

---

## Agent Classification Logic

### Keep on Opus (performance gap documented)

| Agent                    | Task Type        | Why Opus                                                      |
| ------------------------ | ---------------- | ------------------------------------------------------------- |
| analyst             | Deep reasoning   | GPQA +17 pts; architectural dependency mapping                |
| analyst     | Analysis         | Multi-document synthesis; assumption surfacing                |
| pattern-expert           | Domain expertise | SDK pattern knowledge + debugging requires tracing            |
| `decide-framework` skill        | Architecture     | Framework selection = layered reasoning                       |
| security-reviewer        | Security         | 500+ vulns found by Opus; multi-file flow tracing             |
| reviewer    | Quality review   | Catches integration issues across components                  |
| gold-standards-validator | Compliance       | Completeness validation where missing items have consequences |
| testing-specialist       | Test strategy    | Integration test design requires system understanding         |
| tdd-implementer          | TDD              | Test-first requires understanding what to test                |
| value-auditor            | Enterprise audit | Deep reasoning about value chain, UX, business impact         |
| dataflow-specialist      | Framework        | Complex query patterns, migration edge cases                  |
| nexus-specialist         | Framework        | Multi-channel orchestration reasoning                         |
| kaizen-specialist        | Framework        | AI agent coordination, multi-modal reasoning                  |
| mcp-specialist           | Framework        | Transport/auth integration reasoning                          |
| open-source-strategist   | Strategy         | Multi-source synthesis (Terrene only)                         |
| react-specialist         | Frontend         | Integration with backend frameworks; architecture decisions   |
| flutter-specialist       | Frontend         | Cross-platform reasoning; state management                    |
| uiux-designer            | Design           | Enterprise UX requires reasoning about user flows             |
| uiux-designer           | AI UX            | Novel AI interaction patterns; reasoning about trust          |

### Move to Sonnet (equivalent or better performance)

| Agent                       | Task Type        | Why Sonnet is safe                                    | Evidence                                    |
| --------------------------- | ---------------- | ----------------------------------------------------- | ------------------------------------------- |
| **todo-manager**            | Task tracking    | CRUD operations on task lists; mechanical             | GDPval-AA: Sonnet +27 Elo on office work    |
| **release-specialist**   | Deployment ops   | Mechanical: Docker commands, K8s configs, env setup   | Routine operations; Sonnet faster           |
| **reviewer** | Doc checking     | Pattern matching: "does this code example work?"      | Shallow validation; Sonnet sufficient       |
| **build-fix**               | Minimal fixes    | Explicitly scoped: "NO refactoring, smallest changes" | Pattern matching; Sonnet +27 Elo on routine |
| **testing-specialist**              | Test execution   | Playwright test generation; mechanical orchestration  | TerminalBench: Sonnet +7 pts on agentic     |

### Already on Sonnet (confirmed correct)

| Agent                      | Why Sonnet is correct                             |
| -------------------------- | ------------------------------------------------- |
| **release-specialist** | Branch management, commit validation — mechanical |
| **gh-manager**             | GitHub API calls, issue creation — mechanical     |

### Keep on Inherit (standards experts)

| Agent               | Why Inherit                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `co-reference` skill         | Read-only knowledge oracle; inherits parent model                |
| `co-reference` skill         | Read-only knowledge oracle; inherits parent model                |
| `co-reference` skill           | Read-only knowledge oracle; inherits parent model (Terrene only) |
| `co-reference` skill          | Read-only knowledge oracle; inherits parent model                |
| constitution-expert | Read-only knowledge oracle; inherits parent model (Terrene only) |

**Note on inherit**: These agents use only Read/Grep/Glob tools. When the parent context is Opus, they run on Opus — appropriate because their consultations happen during deep reasoning tasks. When spawned from a Sonnet subagent, they'd run on Sonnet — also fine since they're just retrieving reference text.

---

## Per-Repo Recommendations

### 1. Terrene Foundation (Governance KB)

This repo is **already well-optimized**. Most work is governance analysis and strategy — tasks where Opus is clearly superior. Only one change:

| Agent        | Current   | Recommended | Change                      |
| ------------ | --------- | ----------- | --------------------------- |
| todo-manager | opus      | **sonnet**  | Task tracking is mechanical |
| _All others_ | _correct_ | _no change_ | —                           |

**Agents kept on Opus (12)**: analyst, analyst, reviewer, gold-standards-validator, security-reviewer, open-source-strategist + all standards experts (inherit)
**Agents on Sonnet (3)**: release-specialist, gh-manager, todo-manager

### 2. Kailash Python SDK BUILD

| Agent                   | Current   | Recommended | Change                    |
| ----------------------- | --------- | ----------- | ------------------------- |
| todo-manager            | opus      | **sonnet**  | Not present; add if using |
| release-specialist   | opus      | **sonnet**  | Mechanical                |
| reviewer | opus      | **sonnet**  | Pattern matching          |
| build-fix               | opus      | **sonnet**  | Explicitly minimal scope  |
| testing-specialist              | opus      | **sonnet**  | Mechanical execution      |
| _All others_            | _correct_ | _no change_ | —                         |

**Agents on Opus (16)**: analyst, analyst, reviewer, gold-standards-validator, security-reviewer, pattern-expert, `decide-framework` skill, testing-specialist, tdd-implementer, value-auditor, dataflow/nexus/kaizen/mcp-specialists, react-specialist, react-specialist, flutter-specialist

### 3. Kailash Python USE Template

Same as Python SDK BUILD, plus:

| Agent                   | Current | Recommended | Change               |
| ----------------------- | ------- | ----------- | -------------------- |
| todo-manager            | opus    | **sonnet**  | Task tracking        |
| gh-manager              | sonnet  | sonnet      | Already correct      |
| release-specialist   | opus    | **sonnet**  | Mechanical           |
| reviewer | opus    | **sonnet**  | Pattern matching     |
| build-fix               | opus    | **sonnet**  | Explicitly minimal   |
| testing-specialist              | opus    | **sonnet**  | Mechanical execution |

**Agents on Opus (22)**: All deep reasoning + framework + frontend + review agents
**Agents on Inherit (3)**: care/eatp/`co-reference` skills

### 4. Kailash Rust BUILD/USE

Same pattern as Python USE (since it's both BUILD and USE):

| Agent                   | Current | Recommended | Change               |
| ----------------------- | ------- | ----------- | -------------------- |
| todo-manager            | opus    | **sonnet**  | Task tracking        |
| release-specialist   | opus    | **sonnet**  | Mechanical           |
| reviewer | opus    | **sonnet**  | Pattern matching     |
| build-fix               | opus    | **sonnet**  | Explicitly minimal   |
| testing-specialist              | opus    | **sonnet**  | Mechanical execution |

**Agents on Opus (20)**: All deep reasoning + framework + frontend + review agents
**Agents on Inherit (3)**: care/eatp/`co-reference` skills

---

## Borderline Decisions (Kept on Opus)

These agents could potentially run on Sonnet, but evidence is marginal. Given "do not sacrifice ANY performance," they stay on Opus:

| Agent                    | Why Considered       | Why Kept on Opus                                                 |
| ------------------------ | -------------------- | ---------------------------------------------------------------- |
| react-specialist       | Near-parity code gen | Integrates with Kailash backends; needs framework context        |
| react-specialist         | Near-parity code gen | React Flow + TanStack + Nexus integration is multi-component     |
| flutter-specialist       | Near-parity code gen | Riverpod + design system requires architectural understanding    |
| gold-standards-validator | Mostly checklist     | Completeness validation where missing items have consequences    |
| reviewer    | Could be routine     | But catches integration issues that require cross-file reasoning |

**Revisit these if**: Sonnet 4.7+ closes the gap on multi-file integration reasoning, or if user experience shows these agents performing adequately on Sonnet.

---

## Cost Impact Estimate

API pricing: Opus = $15/$75 per M tokens (input/output), Sonnet = $3/$15 per M tokens.

Moving 19 agents from Opus to Sonnet reduces cost for those agents by **~80%** (5x ratio). Since these agents handle ~25-35% of total agent invocations (management, navigation, deployment, validation), the overall cost reduction is approximately **20-28%** while maintaining full Opus performance on all reasoning-heavy tasks.

---

## Explore Agent Type Note

The `Explore` subagent type used for codebase exploration defaults to the parent model. Since exploration is search-oriented (models equivalent), consider using `model: "sonnet"` when spawning Explore agents via the Agent tool. This is a calling-pattern optimization, not an agent definition change.
