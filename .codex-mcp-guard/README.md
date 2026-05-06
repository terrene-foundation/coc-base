# Codex MCP Guardrail Companion

This directory contains an MCP server that enforces the same policies as `.claude/hooks/*.js`, emitted as a **fallback path** when the Codex CLI's native `hooks.json` binding is marked `under_development`.

## Why this exists

Codex's native hook mechanism (`hooks.json`) is flagged `codex_hooks = under_development` in Codex 0.122. Shipping `hooks.json` to a user running that version would either silently fail (the hook file is ignored) or fail loudly on schema validation — neither is acceptable for a guardrail layer.

This companion exposes the same policy predicates through the MCP tool protocol. Codex invokes `apply_patch`, `unified_exec`, and `shell` via MCP; the MCP server intercepts, runs the policy, and returns a structured pass/block decision. The user's guardrail contract is preserved.

## What's covered vs. not

**In scope (wrapped):** `apply_patch`, `unified_exec`, `shell` — the three mutating primitives where guardrails are load-bearing.

**Out of scope:** Read-path tools (`read`, `grep_tool`, `glob_tool`, `web_fetch`, `web_search`). Hooks with read-only policies are SKIPPED on Codex under this fallback. A user installing the USE template with `codex_hooks=under_development` receives weaker read-path coverage than the equivalent CC install. This is an explicit trade-off — see `sync-manifest.yaml` `cli_variants.hooks/*.js.codex.wraps`.

## Parity guarantee

The `/sync` emit-time validator 13 enforces AST predicate-set equivalence between `.claude/hooks/*.js` and `server.js`'s `POLICIES` table. Every reject-condition in a hook file MUST have a matching entry here. Divergence blocks sync.

## Flag graduation

When Codex graduates `codex_hooks` from `under_development` to `stable`:

1. `/cli-audit` detects the graduation on the next sync.
2. The emitter switches to native `hooks.json` emission for the MCP-guard'd rules.
3. `.codex-mcp-guard/` is marked **deprecated** in the USE template with a banner.
4. One release later, `.codex-mcp-guard/` is removed and `hooks.json` becomes the sole Codex guardrail path.

Users are expected to re-run `/sync` after a Codex-CLI upgrade to pick up the graduation.

## Behavioral differences vs. hooks.json

| Dimension      | `hooks.json` (native)      | MCP companion (fallback)      |
| -------------- | -------------------------- | ----------------------------- |
| Latency        | ~sub-ms (in-process check) | ~10-50 ms (MCP round-trip)    |
| Error format   | `reason` field in JSON     | MCP `isError: true` + content |
| Read-path cov. | All tools                  | Mutating tools only           |
| Process model  | Codex in-band              | Separate MCP server process   |

Users on the fallback path WILL observe slightly higher tool-call latency. This is acceptable for a guardrail that would otherwise be absent.

## Authoring

This server is scaffolded at the interface level. The `POLICIES` table contains placeholder predicate entries; `/sync` validator 13 is responsible for populating actual predicates from the hooks/\*.js AST. Do NOT edit policy predicates by hand in this file — they are regenerated on every sync from the single source of truth in `.claude/hooks/`.

## Validator 13 — predicate extractor (Phase E6)

`extract-policies.mjs` implements the v6 §4.4 three-shape predicate extraction:

| Shape | Pattern                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------- |
| A     | `process.exit(N)` with `N >= 2` literal in function body                                             |
| B     | `exitCode: N` with `N >= 2` (literal or via ternary/expr) in returned object, caller pipes to `exit` |
| C     | `return { isError: true, content: [...] }` (MCP response form)                                       |

Usage:

```bash
node .claude/codex-mcp-guard/extract-policies.mjs <hook-dir> [--json | --pretty]
```

Output is a POLICIES-shape JSON enumerating every predicate. The bijection invariant (spec v6 §4.4) is that every predicate function in the hook source appears EXACTLY ONCE in the output — missing or extra entries HARD BLOCK sync.

### Acceptance test

`test-extract-policies.mjs` verifies bijection against `workspaces/multi-cli-coc/fixtures/validator-13/expected-policies.json`. Run on every change to the extractor:

```bash
node .claude/codex-mcp-guard/test-extract-policies.mjs
```

### Real-world baseline (2026-04-22)

Run against `.claude/hooks/` (14 files), the extractor finds 5 predicates — matching the spec's "Why Shape B is load-bearing" empirical audit (v6 §4.4):

| Shape | Predicate               | Source                       | Disposition                                            |
| ----- | ----------------------- | ---------------------------- | ------------------------------------------------------ |
| A     | `main`                  | `validate-prod-deploy.js`    | Orchestrator — filtered as non-policy at emission time |
| B     | `validateBashCommand`   | `validate-bash-command.js`   | Real policy — candidate for POLICIES["shell"]          |
| B     | `validateDeployment`    | `validate-deployment.js`     | Real policy — candidate for POLICIES["shell"]          |
| B     | `checkForRawFrameworks` | `enforce-framework-first.js` | Real policy — candidate for POLICIES["apply_patch"]    |
| B     | `validateFile`          | `validate-workflow.js`       | Real policy — candidate for POLICIES["apply_patch"]    |

Orchestrator filtering + tool-binding assignment belong to the emitter (Phase E4), not the extractor itself. The extractor's contract is: enumerate all predicate functions; classification + binding is the emitter's responsibility.

### Parse strategy

The extractor uses regex + brace-depth counting rather than a proper AST parser (acorn / @babel/parser). Sufficient for the current hook shapes and the 3 fixture cases; upgrade to AST if real-world hook complexity outgrows regex (Phase F+ follow-up).

## References

- `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md` §4.4 — validator 13 three-shape contract
- `workspaces/multi-cli-coc/fixtures/validator-13/` — acceptance fixtures (shape-a / shape-b / shape-c + expected-policies.json)
- `.claude/hooks/lib/runtime.js` — shared COC_RUNTIME enum + parseHook contract
