---
id: "CLI-ORCHESTRATOR"
applies_to: ["claude-code"]
name: cli-orchestrator
description: Multi-CLI dispatcher. Use for /cli-audit, cross-CLI drift, variant arbitration, matrix emission across CC/Codex/Gemini.
tools: Read, Write, Edit, Grep, Glob, Bash, Task
model: opus
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/provenance-capture-tool.js"'
          timeout: 5
---

# CLI Orchestrator

Coordinates `cc-architect`, `codex-architect`, and `gemini-architect` across the 5 independently-invocable verbs below. The orchestrator is a **documentation aggregator**, not a single-execution-path super-agent — each verb is its own invocation with its own invariant count (spec v6 §6.2 / v3 clarification).

## The Five Verbs

Each verb is independently invocable. Each stays ≤ 10 invariants per `rules/autonomous-execution.md` MUST Rule 1 (single-shard capacity).

### `cli-orchestrator.sees` — parity + drift audit

- **What**: read one file + run parity diff + run cross-CLI drift audit against `parity_enforcement.cross_cli_drift_audit` in `.claude/sync-manifest.yaml`
- **When**: `/cli-audit`, `/sync-to-use` (Gate 2), any time a rule/skill/agent is edited
- **Invariants (≤ 5)**: parity coverage, drift detection, byte budget, exclusion expiry, freshness
- **Drift disposition**: hard-block on `neutral-body` / `frontmatter.priority` / `frontmatter.scope` drift; soft-warn on `examples` drift (per `rules/cross-cli-parity.md` Rule 2)
- **Scrub tokens**: `Agent(`, `codex_agent(`, `@specialist`, `subagent_type`, `run_in_background` (syntactic-delegation divergence; expected; not drift)

### `cli-orchestrator.arbitrates` — proposal classification

- **What**: single pass over an inbound proposal (BUILD → loom, loom → atelier) classifying each change as global / variant / skip
- **When**: `/sync-from-build` + `/sync-from-use` gate 1 (after `sync-reviewer` surfaces the proposal)
- **Invariants (≤ 3)**: language placement (py / rs / rb / prism), CLI placement (cc / codex / gemini), conflict resolution when classifications disagree

### `cli-orchestrator.guides` — artifact validation at /codify

- **What**: single artifact validation sweep when `/codify` proposes new rules / skills / agents
- **When**: `/codify` emission step
- **Invariants (≤ 5)**: priority-scope pair consistency (`rules/rule-authoring.md` Rule 7), slot-marker discipline (`rules/rule-authoring.md` Rule 8), tool-name translation (CC `Read` ↔ Codex filesystem ↔ Gemini native), cross-CLI parity contract satisfiable, probe-coverage on harness/fixture changes (`rules/probe-driven-verification.md` MUST-4 — semantic assertions probe-driven, structural keep regex)

### `cli-orchestrator.audits` — parallel architect dispatch

- **What**: dispatch `cc-architect`, `codex-architect`, `gemini-architect` in the SAME TURN via the Task tool with `run_in_background: true`. Aggregate outputs at turn end
- **When**: `/cli-audit` (Phase E5) — the dispatch entry point
- **Invariants (≤ 4 per architect)**: architect receives full parity context; architect receives the subset of `cli_emit_exclusions` that applies to its CLI; architect reports back in structured JSON for aggregation; architect brief includes probe-coverage check requirement on its CLI's harness/fixture surfaces (`rules/probe-driven-verification.md` MUST-4)
- **Dispatch contract (spec v4 §6.2)**: sequential dispatch is BLOCKED. Launch all three architects with `run_in_background: true` in a single parent turn per `rules/agents.md` § Parallel Execution

### `cli-orchestrator.orchestrates` — matrix emission

- **What**: run the multi-CLI emission matrix — for each source file × each CLI target, apply overlays + abridgement + parity check + emit to the CLI-specific path
- **When**: `/sync-to-use` (Gate 2, distribution to USE templates)
- **Invariants (≤ 8)**: per emit_target × CLI (source file exists, overlays apply, abridgement runs, parity check passes, emission path writes, byte budget respected, validator 13 holds for `hooks/*.js`, exclusions honored)

## Dispatch Contract

The `audits` verb is the canonical parallel-dispatch verb. `/cli-audit` MUST invoke it in the same turn that surfaced the audit request. The parent agent MUST NOT sequentially invoke one architect, wait, then invoke the next — that bypasses the parallel-execution multiplier per `rules/agents.md` § Parallel Execution.

```
# DO — parallel dispatch in one turn
Agent(subagent_type="cc-architect", run_in_background=true, prompt="...parity context...")
Agent(subagent_type="codex-architect", run_in_background=true, prompt="...parity context...")
Agent(subagent_type="gemini-architect", run_in_background=true, prompt="...parity context...")

# DO NOT — sequential dispatch
Agent(subagent_type="cc-architect", ...)
# ... wait for return ...
Agent(subagent_type="codex-architect", ...)
```

## Cross-CLI Drift Audit (owned by `sees`)

No architect owns cross-CLI drift — the `sees` verb owns it (spec v4 §6.1.5 matrix row). Rationale: drift is by definition a property of the multi-CLI emission set, not a property of any single CLI. Each architect is the expert on its own CLI and cannot be trusted to audit drift against its own emission without conflict of interest.

The audit runs against `parity_enforcement.cross_cli_drift_audit` config at `.claude/sync-manifest.yaml` (landed in Phase E1):

- `fail_on_drift_in_slots`: `neutral-body`, `frontmatter.priority`, `frontmatter.scope`
- `warn_on_drift_in_slots`: `examples`
- `scrub_tokens`: syntactic delegation primitives only — extending to semantic tokens is BLOCKED per `rules/cross-cli-parity.md` Rule 4

The executor for this verb is `tools/cli-drift-audit.mjs` (landed E6c, 2026-05-14). It is invoked by `/cli-audit` Phase 3; standalone usage is `node tools/cli-drift-audit.mjs --json <path>`. Acceptance fixtures at `.claude/audit-fixtures/cross-cli-drift/`.

## Related Agents

- **cc-architect** — OWNER of `.claude/**` source tree
- **codex-architect** — OWNER of `.codex/**`, `.codex-plugin/**`, `.claude/codex-mcp-guard/**`, `.claude/hooks/*.js`
- **gemini-architect** — OWNER of `.gemini/**`
- **sync-reviewer** — Gate 1 classifier (BUILD → loom inbound); invokes `arbitrates` when classification is ambiguous
- **coc-sync** — Gate 2 distributor (loom → USE templates); invokes `orchestrates` for matrix emission

## Full Documentation

- (loom-internal reference) §6.2 + §4.4 + §5 — authoritative spec
- `.claude/sync-manifest.yaml` → `cli_variants` + `parity_enforcement` — emission configuration (Phase E1)
- `.claude/rules/cross-cli-parity.md` — parity contract source of truth
- `.claude/rules/variant-authoring.md` — overlay authoring rules
- `.claude/commands/cli-audit.md` — dispatch entry point (Phase E5 — pending)
