# Codex MCP Guardrail Companion

This directory contains an MCP server that enforces the same policies as `.claude/hooks/*.js`, emitted as a **fallback path** when the Codex CLI's native `hooks.json` binding is marked `under_development`.

## Installation

The guard depends on `@modelcontextprotocol/sdk` (declared in `package.json`; pinned via `package-lock.json`). On a fresh USE-template install — or after a `/sync` that refreshes this directory — run:

```bash
cd .codex-mcp-guard && npm ci
```

`npm ci` (not `npm install`) is required: it installs the exact versions declared in `package-lock.json` and refuses to mutate the lockfile. This is the **reproducible** install path — every Codex consumer of every USE template gets the same SDK build that loom audited at lockfile-commit time. Running `npm install` instead would silently re-resolve the dependency tree against npm's latest matching versions, breaking the audit chain.

This installs the SDK into `.codex-mcp-guard/node_modules/` so `server.js` can lazy-load it on Codex startup. Without this step, Codex emits:

```
codex-mcp-guard: @modelcontextprotocol/sdk not installed (...).
Install via the USE template's package.json before running stdio mode.
```

…and `MCP client for 'codex-mcp-guard' failed to start: handshaking with MCP server failed: connection closed: initialize response`. This is the **fail-closed** mode (per `zero-tolerance.md` Rule 2) — the guard refuses to start rather than running fail-open. The fix is one `npm install`; the gap is not silent corruption.

`engines.node >= 18` per `package.json`. The package itself is `private: true` — it is never published to npm; only consumed in-place via the USE template's `.codex-mcp-guard/` directory.

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

The `POLICIES` table is generated from the hooks/\*.js AST + the project's `settings.json` matcher map by `extract-policies.mjs --write-policies`, which emits a sibling `policies.json`. `server.js` loads `policies.json` at startup; `POLICIES_POPULATED` flips true iff at least one wrapped Codex tool has ≥1 policy entry. Do NOT edit `policies.json` by hand — it is regenerated on every `/sync` from the single source of truth in `.claude/hooks/`.

### apply_patch edit-gate lane (the `@coc-codex-edit-gate` marker) — FF-AC6-1

`apply_patch` is the Codex file-edit primitive. A CC hook registered under the edit matcher (`Edit|Write|NotebookEdit`; MultiEdit removed from CC per journal/0276, with a legacy MultiEdit→apply_patch mapping retained in `matcherToCodexTools()` for older consumer settings) fans out to the `apply_patch` policy lane **only when its source carries the `@coc-codex-edit-gate` JSDoc marker**. The marker declares the hook a STATELESS trust gate (posture / 4-eyes / signing) safe to replay against a non-enrolled Codex consumer's file-edits. It is the CONSUMER-AVAILABLE selectivity signal: it lives in the synced hook source because `sync-manifest.yaml`'s `mcp-guard` lane is NOT synced to consumers where the extractor regenerates `policies.json`. The cc-only coordination guards (`adjacency-leasecheck`, `journal-write-guard`, `integrity-guard`) deliberately OMIT the marker — they require the multi-operator roster/claim/journal-slot substrate a consumer lacks and would halt every Codex edit. Default is fail-safe-for-functionality: a new edit hook with no marker is EXCLUDED (so a forgotten coordination guard never halts Codex). Adding/auditing a marker on any of the 3 gates fires the `self-referential-codify.md` multi-agent gate. The marker contract lives at `extract-policies.mjs::CODEX_APPLY_PATCH_GATE_MARKER`.

### Policy execution model

When the MCP server receives an `apply_patch` / `unified_exec` / `shell` invocation:

1. Synthesize a CC-shaped PreToolUse JSON payload (`{ tool_name, tool_input, hook_event_name, cwd, session_id }`). The Codex tool name is translated to the CC-native name the hooks classify by (`shell`/`unified_exec` → `Bash`, `apply_patch` → `Edit`) via `CODEX_TO_CC_TOOL`, and the input is FIELDED-projected (`synthesizePolicyInputs`) to a LIST of CC shapes — one `{ file_path }` per `apply_patch` V4A target (so multi-file patches are gated per-target), `{ command }` for the Bash lane. The projection drops raw patch content (secrets fence, mirroring `synthesizeCaptureInput`).
2. For each policy entry registered for that Codex tool, spawn the underlying hook script as a Node subprocess (`node ../hooks/<source_file>`) with the payload on stdin and a 5-second timeout (`cc-artifacts.md` Rule 7).
3. Read the subprocess exit code:
   - `0` → allow this policy; continue to the next.
   - `2` → deny; translate the hook's stdout (canonical `instructAndWait` shape) into an MCP `isError: true` response and short-circuit.
   - other / timeout / spawn error → allow (fail-open) and append a `codex_mcp_guard_*` entry to `.claude/learning/violations.jsonl`.
4. If all policies allow, forward the original tool call as `permit`.

### Self-check

```bash
node .claude/codex-mcp-guard/server.js --self-check
```

Prints the per-tool policy entry counts, hook-dir resolution, timeout setting, and exits 0 if `POLICIES_POPULATED` is true (2 if false).

### Acceptance fixtures

`.claude/audit-fixtures/codex-mcp-guard/` ships the four canonical scenarios per `cc-artifacts.md` Rule 9: `clean-shell.json` (allow), `flag-shell-rm-rf.json` (deny → validate-bash-command), `flag-shell-force-push-main.json` (deny → validate-bash-command), and `timeout-shell.json` (subprocess hangs → allow + log). Run via `node .claude/codex-mcp-guard/test-server.mjs`.

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
