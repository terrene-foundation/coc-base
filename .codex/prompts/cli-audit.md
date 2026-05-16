---
name: cli-audit
description: "Multi-CLI parity + drift audit. Dispatches 3 architects in parallel; runs emitter validators + cross-CLI drift check."
---

# Multi-CLI Audit

Dispatch entry point for `cli-orchestrator.audits` per spec v6 §6.2. Reviews the full multi-CLI emission pipeline (source rules → slot overlays → abridgement → per-CLI target files) for parity, drift, and cap compliance across CC, Codex, and Gemini.

## Your Role

Specify scope: `all` (default), `emission`, `parity`, `drift`, or `validators`.

## Dispatch Contract (v6 §6.2)

You MUST dispatch `cc-architect`, `codex-architect`, and `gemini-architect` via the Task tool in the SAME TURN with `run_in_background: true` (parallel launch per `rules/agents.md` § Parallel Execution). Sequential dispatch is BLOCKED — it bypasses the parallel-execution multiplier and re-runs the same audit three times in series.

```
# DO — single turn, three parallel architects
Agent(subagent_type="cc-architect", run_in_background=true, prompt="...CC audit brief with emission report...")
Agent(subagent_type="codex-architect", run_in_background=true, prompt="...Codex audit brief with AGENTS.md...")
Agent(subagent_type="gemini-architect", run_in_background=true, prompt="...Gemini audit brief with GEMINI.md...")

# DO NOT — sequential
Agent(subagent_type="cc-architect", ...)     # wait for return
Agent(subagent_type="codex-architect", ...)  # then this
```

## Phase 1: Produce the emission (dry-run)

Run the E4 emitter in dry-run mode to produce per-CLI baseline emissions the architects will audit:

```bash
node .claude/bin/emit.mjs --all --out /tmp/cli-audit-$(date +%s) -v
```

This writes:

- `/tmp/cli-audit-<ts>/codex/AGENTS.md` + `emit-report-codex.json`
- `/tmp/cli-audit-<ts>/gemini/GEMINI.md` + `emit-report-gemini.json`
- `/tmp/cli-audit-<ts>/codex-mcp-guard/policies.json` (V13 POLICIES table)
- `/tmp/cli-audit-<ts>/emit-telemetry.json` — consolidated headroom summary (per-CLI bytes, tier, headroom_bytes, headroom_pct) keyed off `warn_cap_bytes` + `block_cap_bytes` loaded from `sync-manifest.yaml`. Surfaces the trend metric for Risk-0004 (baseline-cap headroom ~4%).

Exit code ≠ 0 means V12 slot-round-trip failed, V13 MCP bijection failed, or the emission exceeded `block_cap_bytes`. A non-zero exit is a HARD BLOCK on this audit — fix before dispatching architects.

## Phase 2: Parallel architect dispatch

For each architect, the brief includes:

- the emission target file it owns (`AGENTS.md`, `GEMINI.md`, or `.claude/**` source)
- the `emit-report-<cli>.json` for its CLI
- the `cli_variants` + `parity_enforcement` sub-sections of `.claude/sync-manifest.yaml`
- the expected parity contract from `.claude/rules/cross-cli-parity.md`

Each architect returns a structured JSON report enumerating findings in its ownership tree.

## Phase 3: cli-orchestrator.sees — cross-CLI drift

Independent of the architects (which each see only their own CLI), run the `sees` verb to check for drift ACROSS CLIs per `parity_enforcement.cross_cli_drift_audit`. The audit is executed by `tools/cli-drift-audit.mjs` — replaces the volatile `/tmp/loom-matrix-poc-v5-*` PoC referenced in spec v6 §6.2 + workspaces/multi-cli-coc todos E6c.

```bash
# Default — audit real .claude/rules/ at priority:0; JSON report alongside Phase-1 output.
node tools/cli-drift-audit.mjs --json /tmp/cli-audit-$(date +%s)/drift-report.json

# Fixture-mode — exercise the executor against known-shape fixtures.
node tools/cli-drift-audit.mjs --fixtures .claude/audit-fixtures/cross-cli-drift/fixture-clean
```

The executor implements the four-step contract from v6 §6.2:

1. Loads `.claude/sync-manifest.yaml → parity_enforcement.cross_cli_drift_audit` (`compare_slots`, `scrub_tokens`, `fail_on_drift_in_slots`, `warn_on_drift_in_slots`).
2. For each CRIT rule (`priority: 0` in frontmatter), composes the rule body under each CLI via `.claude/bin/emit.mjs::composeRule(rule, cli, null)`; extracts slots via `parseSlotsV5`.
3. Applies `scrub_tokens` to each slot body; byte-compares across (cc, codex, gemini). Drift in `fail_on_drift_in_slots` → `CRITICAL`; drift in `warn_on_drift_in_slots` → `WARN`.
4. Compares `frontmatter.priority` and `frontmatter.scope` byte-identically (rule-authoring.md Rule 7 — a rule cannot be CRIT baseline on one CLI and path-scoped on another).

Exit code 0 ⇔ zero CRITICAL findings (sync may proceed). Exit code 1 ⇔ one or more CRITICAL findings — sync HARD BLOCKED per `rules/cross-cli-parity.md` MUST 1+2. Exit code 2 ⇔ usage / config error (malformed manifest, unwritable `--json` path, unknown flag).

Acceptance fixtures at `.claude/audit-fixtures/cross-cli-drift/` exercise each branch (clean, neutral-body drift, frontmatter drift, examples-only drift). Run them all + unit branches for compose-failure and parse-failure via `node tools/cli-drift-audit-test.mjs` (7 cases, exit 0 on full pass).

## Phase 4: Project-artifact content sweep

Per `rules/cross-cli-artifact-hygiene.md`, workspace artifacts (`workspaces/**/*.md`, `briefs/**/*.md`) MUST stay CLI-neutral — no CC-native delegation syntax (`Agent(subagent_type=...)`, `run_in_background`, `isolation: "worktree"`, `TaskCreate`, `TaskUpdate`, `ExitPlanMode`), no CC tool nouns (`Read tool`, `Write tool`, `Edit tool`, `Bash tool`, `Grep tool`, `Glob tool`), no CC PascalCase hook event names (`SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`), and no CLI baseline-file authority leaks (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/(agents|skills|commands)`) in prescriptive prose.

Run the lint:

```bash
node tools/lint-workspaces.js workspaces/ briefs/
```

Output is one line per finding: `<file>:<line>: <pattern> — <snippet>`. Exit 1 indicates findings (advisory severity per the rule's Trust Posture Wiring); exit 0 indicates clean. Lines containing `(historical)`, `(historical citation)`, or `<!-- cli-portable-exception -->` are skipped per MUST 5 (qualified-historical mentions are acceptable). Fixtures at `.claude/audit-fixtures/cross-cli-artifact-hygiene/` exercise every flagged pattern (3 flag files) plus 2 clean files.

## Phase 4.5: Probe-coverage sweep (`rules/probe-driven-verification.md` MUST-4)

Independent of per-CLI architect findings, run the probe-coverage sweep against any harness or fixture surface touched by the multi-CLI emission set. Per `probe-driven-verification.md` MUST-1, semantic assertions in test harnesses MUST be probe-driven; regex-on-semantic-claim is BLOCKED.

```bash
grep -rEn 'def (verify|score|assert|check|probe)_[A-Za-z_]*(recommend|refus|complian|respons|intent|semantic|quality|outcome|narrative|reasoning)' \
  .claude/test-harness/ .claude/audit-fixtures/ 2>/dev/null \
  | xargs -I {} grep -lE 'kind:\s*"contains"|re\.(search|match|findall)|str\.contains' {} 2>/dev/null
```

Each hit MUST cite a probe schema. Regex-on-semantic = HIGH per Phase 5 severity taxonomy. Structural assertions (canary token presence, marker grep, exit code, file existence) are exempt and keep regex per MUST-3.

## Phase 5: Aggregate + report

Combine architect findings + drift-audit result + probe-coverage findings into a single report with severity taxonomy:

- **CRITICAL** — V12 slot round-trip failure, V13 MCP bijection failure, `block_cap_bytes` exceeded, `neutral-body` drift, `frontmatter.priority|scope` drift, overlay introduces a slot not in global.
- **HIGH** — V13 POLICIES bijection spurious/missing entry, per-rule budget exceeds `+30%` tolerance, `warn_cap_bytes` exceeded, `emit-telemetry.json` shows any per-CLI `headroom_pct < 10%` (Risk-0004 early-warning band), regex-on-semantic-claim in any harness assertion (Phase 4.5).
- **NOTE** — expected `examples` slot drift, per-rule budget within tolerance but trending up, orchestrator filter applied (e.g. `main` in `validate-prod-deploy.js`).

### Headroom trend (baseline_emission_bytes)

Read `/tmp/cli-audit-<ts>/emit-telemetry.json` and summarize per-CLI headroom in the report:

```
codex:  53,620 B / 61,440 cap → 12.73% headroom (WARN tier)
gemini: 53,620 B / 61,440 cap → 12.73% headroom (WARN tier)
```

When any CLI's `headroom_pct` drops below 10%, flag as HIGH and recommend the v6 §A.2 remediation path (demote a CRIT rule to path-scoped, tighten a per-rule budget, or trim the ruleset). The aim is for operators to see the cap approaching long before a sync hits BLOCK.

Run iteratively until zero CRITICAL and zero HIGH remain. Each iteration MUST re-derive the emission + re-dispatch the three architects (parallel) + re-run `sees`. Do NOT trust a prior turn's verdict — the audit's strength is its repeatability.

## References

- `.codex/agents/cli-orchestrator.md` — the 5 verbs; `/cli-audit` dispatches `audits` + `sees`
- `.codex/agents/{cc,codex,gemini}-architect.md` — parallel audit targets
- `.claude/bin/emit.mjs` — Phase E4 emitter (V12 + V13 built-in)
- `.claude/sync-manifest.yaml` → `cli_variants` + `parity_enforcement` — emission + audit config
- `.claude/rules/cross-cli-parity.md` — parity contract source of truth
- (loom-internal reference) §4.4 + §6.2 — authoritative dispatch contract
