---
name: hook-authoring
description: "Authoring or auditing hooks (CC/Codex/Gemini). hooks.json registration, COC_RUNTIME, instructAndWait emit, Codex native tool bridge + policy parity, timeout fallback."
---

# Hook Authoring

Reference for authoring and auditing event hooks across CC, Codex, and Gemini. Hooks are L3 (Guardrails) artifacts in the COC 5-layer architecture per `rules/cc-artifacts.md` — alongside rules, but distinguished by deterministic runtime invocation on tool / session lifecycle events. Sibling to skill-authoring (F1) and command-authoring (F2).

## When To Use

Authoring a new hook script under `.claude/hooks/`. Auditing an existing hook for timeout discipline, output shape, severity grounding, predicate bijection with the MCP guard, or path resolution across CLIs. Deciding whether enforcement belongs in a hook (runtime tripwire, deterministic), an agent (judgment, tools), or a rule (always-on prose guardrail).

## Quick Reference

| CLI    | Registration                                               | Event surface                                                              | Path env                               |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| CC     | `.claude/hooks/dispatch-registry.json` (run in-process by `dispatch.js <Event>`) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`    | `$CLAUDE_PROJECT_DIR` exported         |
| Codex  | `.codex/hooks.json` (repo) or `~/.codex/hooks.json` (user) | Shared core names; native Bash, patch, MCP, and local-tool events   | NOT exported; resolve via cwd-relative |
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
- Codex reads `.codex/hooks.json` and invokes each registered native hook through the COC_RUNTIME-delivery wrapper: `node "$(git rev-parse --show-toplevel)/.claude/hooks/lib/codex-hook-runtime.js" ./.claude/hooks/<name>.js` (the wrapper stamps `COC_RUNTIME=codex` + `CLAUDE_PROJECT_DIR`, then delegates to the hook as a native child process — see § The COC_RUNTIME Contract). Codex does NOT export a project-dir env var; the wrapper's `CLAUDE_PROJECT_DIR` stamp AND the hook's own `cwd` extraction from the stdin payload both resolve the project root.
- Gemini reads `.gemini/settings.json` `hooks` (the `hooks` object) and renames events to its own taxonomy (`BeforeTool`, `AfterTool`). Gemini exports `GEMINI_PROJECT_DIR`.

The single-source contract means every hook MUST work under all three runtimes without per-CLI source forks. The shared library `lib/runtime.js::parseHook()` validates the `COC_RUNTIME` env var (closed enum: `cc` / `codex` / `gemini`) and returns a canonical payload shape regardless of source.

## Register A Detector, Not A Process (CC)

loom's CC hooks run through ONE process per event: `settings.json` registers `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" <Event>`, and `dispatch.js` loads every hook `.claude/hooks/dispatch-registry.json` lists for that event and runs it in-process under `hooks/lib/hook-engine.js` (its own stdin, stdout/stderr capture, `process.exit` capture, time budget and error boundary; any deny wins and every reason reaches the agent in one message). A new hook therefore:

1. Is added as a group entry in `dispatch-registry.json` under its event — same `matcher`/`command`/`timeout` shape a settings.json group had. A new DIRECT `settings.json` hook entry is BLOCKED by `hook-registration-regrowth.test.mjs` (the two settings-deny guards stay direct by design: they verify their own registration).
2. Exports `hookMain()` holding everything the script used to do at load time — timeout fallback, stdin read, the decision — and ends with a CLI guard (`if (require.main === module) hookMain();`). A `require()` of the file MUST have no side effects (`hook-dispatch-registry.test.mjs` loads every registered hook and fails on any output or armed timer).
3. Reads shared git answers through the event context (`hooks/lib/event-git.js`, used by `state-resolver.js::safeExec` and `operator-id.js`): one answer per distinct git question per event, a failure stays a failure. Never add a file-keyed git memo.
4. Asks first whether it belongs on a tool call at all: a lexical, advisory-only detector is a gate-review check (`rules/probe-driven-verification.md` MUST-4), not a per-call hook.

Tooling that asks "which hooks are registered" reads the EXPANDED view (`hooks/lib/dispatch-registry.js::expandSettingsHooks`, which ships everywhere; loom additionally carries a bin-side wrapper over it that does not ship), never raw `settings.json`.

## The COC_RUNTIME Contract

Every hook invocation MUST set `COC_RUNTIME` to one of `cc`, `codex`, `gemini` before the script starts. CC delivers it through process environment; Codex's native bridge and compatibility guard set it before invoking shared checks. Registrations use the Node bridge, which also establishes project context. Manual invocations MUST set it explicitly. Silent passthrough of an unknown runtime is BLOCKED per `rules/zero-tolerance.md` Rule 3.

```javascript
// DO — use parseHook for the canonical shape; throws on missing COC_RUNTIME
const { parseHook } = require("./lib/runtime.js");
const payload = parseHook(rawStdin);
// payload = { runtime, event, toolName, toolInput, prompt, sessionId, cwd, projectDir }

// DO NOT — hand-roll stdin parsing; misses runtime validation
const data = JSON.parse(rawStdin);
const event = data.hook_event_name; // CLI taxonomy not normalized
```

`parseHook` normalizes legacy event aliases to the shared event identifiers, so downstream branching can compare against canonical event identifiers regardless of the source CLI's event taxonomy.

## Path Resolution Across CLIs

Project-dir resolution is the #1 portability pitfall. Only CC and Gemini export a project-dir env var; Codex does not. The hook resolves the project root in this order:

```javascript
const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  process.env.GEMINI_PROJECT_DIR ||
  payload.cwd; // from stdin — Codex fallback
```

The native payload's `cwd` identifies the session working directory, which may be nested below the repo root. The bridge establishes COC project context before invoking shared hooks. A cwd-relative launch still needs to locate the bridge before payload processing can help; validate nested-cwd launches against the delivered registration. Do not assume the historical root-cwd observation is a runtime guarantee. This Node bridge is distinct from phase dispatch through `bin/coc`.

## Codex Native Coverage and Compatibility

Verified 2026-09-28: current native hooks reach Bash, `apply_patch`, MCP calls, and most local function tools. Patch calls also match `Edit`/`Write`; agent spawn also matches `Agent`. Hosted tools and specialized opt-outs are outside that path. Later `write_stdin` input does not repeat the original pre-tool check.

The COC bridge selects delivered registrations and projects patch targets into shared checks. Runtime capability alone is not proof that a particular COC check is registered, trusted, or executed. Native pre-tool output uses supported permission decisions; unsupported `continue`/`stopReason` fields can invalidate a hook response. Background hooks cannot deny the triggering operation.

The MCP companion remains compatibility/policy machinery for explicit wrapper calls; it does not intercept all native calls. Validator 13 checks extracted predicate parity. Preserve that contract while the library is delivered, and avoid duplicate capture when two paths observe the same operation.

Review new or changed non-managed definitions through `/hooks`. Trust is operator-local and definition-specific. Hook sources merge across active config layers. Event-specific contracts and newer compaction/subagent/session lifecycle events are documented in the [official Hooks reference](https://learn.chatgpt.com/docs/hooks).

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

CLI-specific or language-specific hook bodies live at `.claude/variants/<axis>/hooks/<name>.js` and overlay only the diverging slot. Axes mirror skills + commands: `variants/codex/`, `variants/gemini/`, `variants/py/`, `variants/rs/`, `variants/base/`, ternary forms like `variants/py-codex/`.

Hook overlays are rare in practice — most behavior is keyed off `payload.runtime` (from `COC_RUNTIME`) rather than full-file forking. When an overlay is genuinely needed (a Codex-only enforcement path that has no CC analog), the overlay file replaces the body wholesale; slot markers are not used in `.js` source.

## Audit Fixtures

Every detector function in `.claude/hooks/lib/violation-patterns.js` MUST ship at least one committed fixture per scope-restriction predicate it relies on, under `.claude/audit-fixtures/violation-patterns/<detector>/`. Required coverage:

- Clean input that MUST NOT flag
- Flagging input that MUST flag
- For command-string detectors, at least one shell-variable input that MUST NOT flag (per `hook-output-discipline.md` MUST-3)

Per `rules/cc-artifacts.md` Rule 9. Fixtures are the mechanical regression lock for scope-restriction predicates; without them, future modifications silently weaken the predicate and the detector starts producing false positives at scale.

## Wrapper Status — Native Hook Registration Is Canonical

Hook-level Bash wrappers were briefly authored at Phase J1 to bridge missing Codex hook events via shell shims, but **wrapper emission was deferred at Shard C (2026-05-10)** per `journal/0006-DECISION-wrapper-emission-disposition-strip.md`. That historical deferral concerned per-hook shell wrappers. Current native coverage is described above; `bin/coc` is a separate phase dispatcher.

New hooks MUST NOT add `.claude/wrappers/*.sh.template` files. If a future workstream requires external CLI invocation or structured-output enforcement at the hook layer, revival is documented in the journal entry — propose at `/codify`, do not assume the path is live.

## Workspace-Walking Hooks Filter Meta-Dirs

Hooks that enumerate `workspaces/<name>/` directories (e.g. `detectActiveWorkspace`, `findAllSessionNotes`) MUST filter both the literal `instructions` directory AND any directory whose name starts with an underscore. Per `rules/cc-artifacts.md` Rule 8:

```javascript
const projects = entries.filter(
  (e) =>
    e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"),
);
```

Leading-underscore is the convention for workspace meta-dirs (`_archive`, `_template`, `_draft`). Archival operations (`git mv workspaces/X (loom-internal reference)`) bump `_archive/`'s mtime; without the filter, the hook surfaces `_archive` as the active workspace and SessionEnd routes journal stubs into (loom-internal reference) — invisible drift the next session must untangle.

## Common Mistakes

### 1. Raw `process.exit(2)` Without instructAndWait

Highest-frequency authoring bug. A new detector ships a halting branch with `process.exit(2)` and no payload; agent gets "Execution stopped by hook" with zero context, files a follow-up issue (violating `autonomous-execution.md` MUST-4), and the rule the hook enforces gets re-asked next session. Fix: route every halting branch through `lib/instruct-and-wait.js::emit()`.

### 2. `severity: "block"` From Regex Evidence

Lexical regex against `payload.tool_input.command` cannot see shell expansion; matching `"$REPO"` as a literal string and reporting block-severity false-positives blocks in-scope work. Fix: lexical matches emit `halt-and-report`; block requires structural evidence (env var, exit code, file existence, AST shape).

### 3. Native Patch Input Assumed To Be A CC Edit

Native `apply_patch` does fire tool hooks, but its input is a patch in `tool_input.command`, not a CC `file_path` edit. Route through the native bridge's target projection and verify the delivered registration with deny/allow fixtures. Keep extracted compatibility policy parity current.

### 4. Missing Timeout Fallback

Hook author skips the `setTimeout` block "because the work is fast." First runtime hang freezes the entire CLI session. Fix: install the 5s (or 10s for SessionStart) timeout fallback unconditionally — it is the ONLY legitimate raw-exit branch.

### 5. `$CODEX_PROJECT_DIR` Referenced In Hook Registration

Codex does not export a project-dir env var; `node $CODEX_PROJECT_DIR/.claude/hooks/<name>.js` silently expands to `node /.claude/hooks/<name>.js` (MODULE_NOT_FOUND). Fix: register through the wrapper — `node "$(git rev-parse --show-toplevel)/.claude/hooks/lib/codex-hook-runtime.js" ./.claude/hooks/<name>.js` (Git-root-resolved, no invented env var; the wrapper stamps `CLAUDE_PROJECT_DIR` + `COC_RUNTIME`) — and rely on `payload.cwd` from stdin as the in-script fallback.

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
- `agents/codex-architect.md` § Hooks Coverage and Compatibility — native tool events + compatibility policy library
- `agents/gemini-architect.md` § Hook Event Name Translation — CC ↔ Gemini event taxonomy
- `agents/cc-architect.md` — CC-side hook authoring + audit responsibilities
- `codex-mcp-guard/README.md` — POLICIES table population, validator-13, predicate shapes
- `hooks/lib/runtime.js` — `COC_RUNTIME` closed enum + `parseHook` contract
- `hooks/lib/instruct-and-wait.js` — canonical halt-shape emit
- `skill-authoring` (F1) — sibling meta-skill, same shape conventions
- `command-authoring` (F2) — sibling meta-skill, same shape conventions
