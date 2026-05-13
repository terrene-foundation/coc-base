---
name: hook-authoring
description: "Authoring or auditing hooks (CC/Codex/Gemini). hooks.json registration, COC_RUNTIME, instructAndWait emit, Codex Bash-only gap + MCP-guard bijection, timeout fallback."
tools:
  - Read
  - Glob
  - Grep
---

# Hook Authoring

Reference for authoring and auditing event hooks across CC, Codex, and Gemini. Hooks are L3 (Guardrails) artifacts in the COC 5-layer architecture per `rules/cc-artifacts.md` — alongside rules, but distinguished by deterministic runtime invocation on tool / session lifecycle events. Sibling to skill-authoring (F1) and command-authoring (F2).

## When To Use

Authoring a new hook script under `.claude/hooks/`. Auditing an existing hook for timeout discipline, output shape, severity grounding, predicate bijection with the MCP guard, or path resolution across CLIs. Deciding whether enforcement belongs in a hook (runtime tripwire, deterministic), an agent (judgment, tools), or a rule (always-on prose guardrail).

## Quick Reference

| CLI    | Registration                                               | Event surface                                                              | Path env                               |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| CC     | `.claude/settings.json` `hooks` block                      | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`    | `$CLAUDE_PROJECT_DIR` exported         |
| Codex  | `.codex/hooks.json` (repo) or `~/.codex/hooks.json` (user) | Same names; **Bash tool only** — `apply_patch` / Write / MCP do NOT fire   | NOT exported; resolve via cwd-relative |
| Gemini | `.gemini/settings.json` `hooks` object                     | `BeforeTool` / `AfterTool` / `BeforeAgent` / `SessionStart` / `SessionEnd` | `$GEMINI_PROJECT_DIR` exported         |

| Constraint                | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Script location           | `.claude/hooks/<name>.js` — Anthropic-documented path, shared across all three CLIs                                   |
| Module system             | CommonJS (`require`), matching repo convention                                                                        |
| Timeout fallback          | Mandatory per `rules/cc-artifacts.md` Rule 7 — `setTimeout` → emit `{continue: true}`, `process.exit(1)`              |
| Stdin / stdout            | Read JSON payload from stdin; emit JSON on stdout                                                                     |
| Halting exit (PreToolUse) | `process.exit(2)` — but ONLY via `lib/instruct-and-wait.js::emit()` shape per `rules/hook-output-discipline.md`       |
| Halting return (post)     | `continue: false` — ONLY via the same emit() shape                                                                    |
| Block severity            | Requires structural / behavioral / AST signal — lexical regex match is BLOCKED per `hook-output-discipline.md` MUST-2 |

## Single Script, Three Runtimes

The authoritative copy of every hook lives at `.claude/hooks/<name>.js`. All three CLIs reference the same file by path; what differs is the registration manifest:

- CC reads `.claude/settings.json` `hooks` → command list. Working directory at hook launch is the project root; CC exports `CLAUDE_PROJECT_DIR`.
- Codex reads `.codex/hooks.json` and invokes the same script with `node ./.claude/hooks/<name>.js`. Codex does NOT export a project-dir env var; the hook MUST extract `cwd` from the stdin payload.
- Gemini reads `.gemini/settings.json` `hooks` (the `hooks` object) and renames events to its own taxonomy (`BeforeTool`, `AfterTool`). Gemini exports `GEMINI_PROJECT_DIR`.

The single-source contract means every hook MUST work under all three runtimes without per-CLI source forks. The shared library `lib/runtime.js::parseHook()` validates the `COC_RUNTIME` env var (closed enum: `cc` / `codex` / `gemini`) and returns a canonical payload shape regardless of source.

## The COC_RUNTIME Contract

Every hook invocation MUST set `COC_RUNTIME` to one of `cc`, `codex`, `gemini` before the script starts. The emitter-generated wrappers set it; manual invocations MUST set it explicitly. Silent passthrough of an unknown runtime is BLOCKED per `rules/zero-tolerance.md` Rule 3.

```javascript
// DO — use parseHook for the canonical shape; throws on missing COC_RUNTIME
const { parseHook } = require("./lib/runtime.js");
const payload = parseHook(rawStdin);
// payload = { runtime, event, toolName, toolInput, prompt, sessionId, cwd, projectDir }

// DO NOT — hand-roll stdin parsing; misses runtime validation
const data = JSON.parse(rawStdin);
const event = data.hook_event_name; // CLI taxonomy not normalized
```

`parseHook` normalizes Codex / Gemini snake_case event names back to PascalCase, so downstream branching can compare against canonical event identifiers regardless of the source CLI's event taxonomy.

## Path Resolution Across CLIs

Project-dir resolution is the #1 portability pitfall. Only CC and Gemini export a project-dir env var; Codex does not. The hook resolves the project root in this order:

```javascript
const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  process.env.GEMINI_PROJECT_DIR ||
  payload.cwd; // from stdin — Codex fallback
```

Codex invokes hooks with `cwd = project_root` (verified 2026-04-23) but the docs do not explicitly guarantee this. The hook MUST extract `cwd` from the stdin payload as the durable fallback. A `.codex/hooks.json` command of `node $CODEX_PROJECT_DIR/.claude/hooks/<name>.js` silently expands to `node /.claude/hooks/<name>.js` and exits `MODULE_NOT_FOUND` — the correct form is `node ./.claude/hooks/<name>.js`.

## Hook Coverage Gap — Codex Bash-Only

Codex hooks fire on **Bash / shell tool invocations only**. The following surfaces are NOT reachable from `.codex/hooks.json`:

- `apply_patch` (Codex's file-write primitive)
- Write tool equivalents
- MCP tool calls (servers wrapping file writes, network, etc.)
- `web_search` / `web_fetch`

For these surfaces, the `.claude/codex-mcp-guard/` MCP server is the only enforcement point — it wraps every non-Bash tool at the MCP layer and re-runs the same predicate set the Bash-layer hooks would have applied. Both surfaces together cover the full tool envelope; either alone leaves a gap.

The bijection requirement is enforced by validator 13 at `/sync` emit time: every predicate function in `.claude/hooks/*.js` MUST have a coverage-equivalent reject-condition in `.claude/codex-mcp-guard/policies.json`. Divergence hard-blocks the sync.

## Predicate Function Shapes (Validator-13 Bijection)

A predicate function is any function whose body produces a reject decision. The MCP guard's AST extraction recognizes three structural shapes:

- **Shape A** — `process.exit(N)` with `N >= 2` in the function body.
- **Shape B** — returns `{ exitCode: N, ... }` with `N >= 2`; at least one caller routes that return into a `process.exit(<field>)` call in the same file. The data-flow check is per-predicate (tightened in v6.1).
- **Shape C** — returns `{ isError: true, content: [...] }` — the MCP response form used by the guard server.

Fixtures live at `.claude/fixtures/validator-13/`. Adding a new predicate that the extractor cannot match (a fourth shape, or a borrowed pattern from elsewhere) is BLOCKED until the extractor and fixture set are updated together. Predicate shape is part of the public contract between the hook layer and the MCP guard.

## Output Discipline — instructAndWait

Every halting branch (PostToolUse `continue: false`; PreToolUse `process.exit(2)`) MUST go through `lib/instruct-and-wait.js::emit()` with all six fields populated: `severity`, `what_happened`, `why`, `agent_must_report` (≥1 entry), `agent_must_wait`, `user_summary`. Raw `process.exit(2)` and bare `{continue: false}` writes are BLOCKED per `rules/hook-output-discipline.md` MUST-1.

```javascript
// DO — canonical shape, agent gets actionable report
const { emit } = require("./lib/instruct-and-wait.js");
emit({
  hookEvent: "PostToolUse",
  severity: "halt-and-report",
  what_happened: "Bash command flagged — off-repo write attempt",
  why: "repo-scope-discipline/MUST-NOT-1",
  agent_must_report: [
    "Quote the exact command that triggered detection",
    "State which rule was violated and its origin date",
    "Propose remediation in this turn — no follow-up issue",
  ],
  agent_must_wait: "Do not retry until the user instructs.",
  user_summary: "repo-scope-discipline/MUST-NOT-1 — off-repo gh write",
});

// DO NOT — bare exit, agent sees only "Execution stopped by hook"
process.stdout.write(JSON.stringify({ continue: false }) + "\n");
process.exit(2);
```

The CC UI shows the user "Execution stopped by PostToolUse hook" — useless without the `user_summary` stderr line. The shape converts a silent flow-stop into a structured handoff so user + agent can both act.

## Severity Grounding — No Block From Regex

A finding with `severity: "block"` MUST be grounded in a structural / behavioral / AST / process-state signal that surface rewrites cannot evade. Lexical regex matches against shell command strings, file contents, or agent prose MUST emit `severity: "halt-and-report"` or `severity: "advisory"`, never `block`. Block severity is reserved for facts the agent cannot rationalize away — env vars, exit codes, file existence, AST shape.

```javascript
// DO — block grounded in env var + path prefix (structural)
if (
  process.env.CLAUDE_WORKTREE_PATH &&
  !filePath.startsWith(process.env.CLAUDE_WORKTREE_PATH)
) {
  return { rule_id: "worktree-isolation/MUST-1", severity: "block", evidence };
}

// DO — lexical regex → halt-and-report, never block
const m = command.match(/\bgh\b[^|;]*--repo\s+([^\s]+)/);
if (m && !m[1].includes(path.basename(cwd))) {
  return {
    rule_id: "repo-scope/MUST-NOT-1",
    severity: "halt-and-report",
    evidence,
  };
}
```

Command-string detectors MUST skip captured groups referencing unexpanded shell variables (`$VAR`, `${VAR}`, `$(...)`, backticks) — the pre-expansion form cannot be evaluated at hook invocation time. Per `rules/hook-output-discipline.md` MUST-3, the skip is a structural `null` return; no downgrade-to-advisory, no in-hook shell expansion (that path is a confused-deputy security hole).

## Timeout Fallback

Every hook MUST install a `setTimeout` that emits `{continue: true}` and exits before the runtime's kill window. Per `rules/cc-artifacts.md` Rule 7:

```javascript
const TIMEOUT_MS = 5000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);
```

`SessionStart` hooks may use `10000` (10s) for boot-time discovery; per-tool hooks (`PreToolUse`, `PostToolUse`) MUST stay at `5000` to avoid stalling interactive workflows. A hanging hook blocks the entire CLI session indefinitely — the timeout is the only structural escape.

The `setTimeout`-fallback path is the ONE legitimate raw-exit branch. It MUST emit `{continue: true}` first; raw `process.exit(N)` from any other branch is BLOCKED per `rules/hook-output-discipline.md` MUST-NOT-1.

## Variant Overlays

CLI-specific or language-specific hook bodies live at `.claude/variants/<axis>/hooks/<name>.js` and overlay only the diverging slot. Axes mirror skills + commands: `variants/codex/`, `variants/gemini/`, `variants/py/`, `variants/rs/`, `variants/rb/`, ternary forms like `variants/py-codex/`.

Hook overlays are rare in practice — most behavior is keyed off `payload.runtime` (from `COC_RUNTIME`) rather than full-file forking. When an overlay is genuinely needed (a Codex-only enforcement path that has no CC analog), the overlay file replaces the body wholesale; slot markers are not used in `.js` source.

## Audit Fixtures

Every detector function in `.claude/hooks/lib/violation-patterns.js` MUST ship at least one committed fixture per scope-restriction predicate it relies on, under `.claude/audit-fixtures/violation-patterns/<detector>/`. Required coverage:

- Clean input that MUST NOT flag
- Flagging input that MUST flag
- For command-string detectors, at least one shell-variable input that MUST NOT flag (per `hook-output-discipline.md` MUST-3)

Per `rules/cc-artifacts.md` Rule 9. Fixtures are the mechanical regression lock for scope-restriction predicates; without them, future modifications silently weaken the predicate and the detector starts producing false positives at scale.

## Wrapper Status — Native Hook Registration Is Canonical

Hook-level Bash wrappers were briefly authored at Phase J1 to bridge missing Codex hook events via shell shims, but **wrapper emission was deferred at Shard C (2026-05-10)** per `journal/0006-DECISION-wrapper-emission-disposition-strip.md`. The MCP-guard companion covers the non-Bash gap directly; wrappers added no coverage and required a separate runtime corpus that was never authored.

New hooks MUST NOT add `.claude/wrappers/*.sh.template` files. If a future workstream requires external CLI invocation or structured-output enforcement at the hook layer, revival is documented in the journal entry — propose at `/codify`, do not assume the path is live.

## Workspace-Walking Hooks Filter Meta-Dirs

Hooks that enumerate `workspaces/<name>/` directories (e.g. `detectActiveWorkspace`, `findAllSessionNotes`) MUST filter both the literal `instructions` directory AND any directory whose name starts with an underscore. Per `rules/cc-artifacts.md` Rule 8:

```javascript
const projects = entries.filter(
  (e) =>
    e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"),
);
```

Leading-underscore is the convention for workspace meta-dirs (`_archive`, `_template`, `_draft`). Archival operations (`git mv workspaces/X workspaces/_archive/X`) bump `_archive/`'s mtime; without the filter, the hook surfaces `_archive` as the active workspace and SessionEnd routes journal stubs into `workspaces/_archive/journal/.pending/` — invisible drift the next session must untangle.

## Common Mistakes

### 1. Raw `process.exit(2)` Without instructAndWait

Highest-frequency authoring bug. A new detector ships a halting branch with `process.exit(2)` and no payload; agent gets "Execution stopped by hook" with zero context, files a follow-up issue (violating `autonomous-execution.md` MUST-4), and the rule the hook enforces gets re-asked next session. Fix: route every halting branch through `lib/instruct-and-wait.js::emit()`.

### 2. `severity: "block"` From Regex Evidence

Lexical regex against `payload.tool_input.command` cannot see shell expansion; matching `"$REPO"` as a literal string and reporting block-severity false-positives blocks in-scope work. Fix: lexical matches emit `halt-and-report`; block requires structural evidence (env var, exit code, file existence, AST shape).

### 3. Bash-Only Coverage Assumed Across Tools

Author wires a Codex enforcement path through `.codex/hooks.json` expecting `PreToolUse` to fire on `apply_patch`; it doesn't. Fix: add the same predicate to `.claude/codex-mcp-guard/policies.json` so non-Bash surfaces are covered. Validator 13 will hard-block the sync if the bijection drifts.

### 4. Missing Timeout Fallback

Hook author skips the `setTimeout` block "because the work is fast." First runtime hang freezes the entire CLI session. Fix: install the 5s (or 10s for SessionStart) timeout fallback unconditionally — it is the ONLY legitimate raw-exit branch.

### 5. `$CODEX_PROJECT_DIR` Referenced In Hook Registration

Codex does not export a project-dir env var; `node $CODEX_PROJECT_DIR/.claude/hooks/<name>.js` silently expands to `node /.claude/hooks/<name>.js` (MODULE_NOT_FOUND). Fix: use `node ./.claude/hooks/<name>.js` in `.codex/hooks.json`; rely on `payload.cwd` from stdin for in-script path resolution.

### 6. Gemini Event Names As CC Aliases

Author writes `.gemini/settings.json` with `PreToolUse` / `PostToolUse` keys; Gemini silently ignores them and the hook never fires. Fix: translate to `BeforeTool` / `AfterTool`. CC's `Stop` maps to Gemini's `SessionEnd`; CC's `UserPromptSubmit` has no exact Gemini equivalent (closest is `BeforeModel`).

### 7. Semantic Analysis In Hooks

Hook attempts to reason about the meaning of agent prose, file contents, or commit messages. Hooks run synchronously with hard timeouts; semantic analysis is slow and non-deterministic, producing spurious failures that block the session. Fix: hooks check structure (path prefix, env var, exit code, AST shape); agents check semantics at gate review.

### 8. Lexical Hook Detector Without Probe Counterpart

Per `rules/probe-driven-verification.md` MUST-4, every lexical hook detector MUST have a probe-driven gate-review counterpart at `/codify` validation. Hook-only verification of a semantic property is BLOCKED — hooks alone produce false positives at scale; probes alone miss the cumulative-violation count for trust-posture downgrade math. Both layers required.

## Audit Checklist

When auditing an existing hook:

- [ ] File location is `.claude/hooks/<name>.js` (NOT `scripts/hooks/` — obsolete pre-v2.8.31)
- [ ] Timeout fallback installed: `setTimeout` → `{continue: true}` → `process.exit(1)`
- [ ] CC timeout 5s (per-tool) or 10s (SessionStart); never higher than 10s
- [ ] Every halting branch routes through `lib/instruct-and-wait.js::emit()` with all six fields
- [ ] No `severity: "block"` returns whose `evidence` is a regex span
- [ ] Command-string detectors skip shell-variable captures (`$VAR`, `${VAR}`, `$(...)`)
- [ ] `parseHook()` from `lib/runtime.js` used for stdin payload (validates COC_RUNTIME)
- [ ] Project-dir resolution: `CLAUDE_PROJECT_DIR || GEMINI_PROJECT_DIR || payload.cwd`
- [ ] Workspace-walking loops filter `instructions` AND leading-underscore meta-dirs
- [ ] If predicate adds a reject branch, equivalent entry exists in `codex-mcp-guard/policies.json`
- [ ] Predicate shape matches A / B / C per validator-13; new shapes update fixtures + extractor together
- [ ] Audit fixtures committed at `.claude/audit-fixtures/violation-patterns/<detector>/` (clean + flag + shell-var)
- [ ] No `.claude/wrappers/<name>.sh.template` added (wrappers deferred per journal/0006)
- [ ] Lexical detectors paired with a probe-driven gate-review counterpart per `probe-driven-verification.md` MUST-4

## Related

- `rules/cc-artifacts.md` Rule 7 — timeout fallback mandate
- `rules/cc-artifacts.md` Rule 8 — workspace meta-dir filter pattern
- `rules/cc-artifacts.md` Rule 9 — audit fixtures committed alongside detectors
- `rules/cc-artifacts.md` Rule 10 — positive-allowlist sweep pattern
- `rules/hook-output-discipline.md` — instructAndWait emit shape, no raw exit, severity grounding, shell-variable skip
- `rules/probe-driven-verification.md` MUST-4 — lexical hook detectors paired with probe-driven gate review
- `rules/trust-posture.md` — posture state read from main checkout; hooks are the only legitimate writers
- `agents/codex-architect.md` § Hooks Coverage — Bash-only event surface + MCP-guard fallback
- `agents/gemini-architect.md` § Hook Event Name Translation — CC ↔ Gemini event taxonomy
- `agents/cc-architect.md` — CC-side hook authoring + audit responsibilities
- `codex-mcp-guard/README.md` — POLICIES table population, validator-13, predicate shapes
- `hooks/lib/runtime.js` — `COC_RUNTIME` closed enum + `parseHook` contract
- `hooks/lib/instruct-and-wait.js` — canonical halt-shape emit
- `skill-authoring` (F1) — sibling meta-skill, same shape conventions
- `command-authoring` (F2) — sibling meta-skill, same shape conventions
