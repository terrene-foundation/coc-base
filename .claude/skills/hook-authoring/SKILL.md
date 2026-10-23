---
name: hook-authoring
description: "Authoring or auditing hooks (CC/Codex/Gemini). hooks.json registration, COC_RUNTIME, instructAndWait emit, Codex native tool bridge + policy parity, fail-closed deny rows via runGuard."
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
| CC     | `.claude/hooks/dispatch-registry.json` (run in-process by `dispatch.js <Event>`) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`    | `$CLAUDE_PROJECT_DIR` exported         |
| Codex  | `.codex/hooks.json` (repo) or `~/.codex/hooks.json` (user) | Shared core names; native Bash, patch, MCP, and local-tool events   | Wrapper resolves the canonical checkout root |
| Gemini | `.gemini/settings.json` `hooks` object                     | `BeforeTool` / `AfterTool` / `BeforeAgent` / `SessionStart` / `SessionEnd` | `$GEMINI_PROJECT_DIR` exported         |

| Constraint                | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Script location           | `.claude/hooks/<name>.js` — Anthropic-documented path, shared across all three CLIs                                   |
| Module system             | CommonJS (`require`), matching repo convention                                                                        |
| Timeout / crash handling  | Per `rules/cc-artifacts.md` Rule 7 — deny row: `guard-runner.js::runGuard` (exit 2 on throw/budget/unreadable stdin); advisory row: `setTimeout` → `{continue: true}`, exit 1 |
| Stdin / stdout            | Read JSON payload from stdin; emit JSON on stdout                                                                     |
| Halting exit (PreToolUse) | `process.exit(2)` — but ONLY via `lib/instruct-and-wait.js::emit()` shape per `rules/hook-output-discipline.md`       |
| Halting return (post)     | `continue: false` — ONLY via the same emit() shape                                                                    |
| Block severity            | Requires structural / behavioral / AST signal — lexical regex match is BLOCKED per `hook-output-discipline.md` MUST-2 |

## Single Script, Three Runtimes

The authoritative copy of every hook lives at `.claude/hooks/<name>.js`. All three CLIs reference the same file by path; what differs is the registration manifest:

- CC reads `.claude/settings.json` `hooks` → command list. Working directory at hook launch is the project root; CC exports `CLAUDE_PROJECT_DIR`.
- Codex reads `.codex/hooks.json`. Preserve the canonical template launchers: they clear Node injection variables, discover the checkout through filesystem markers, and select `--native-policy` or `--native-event <Event>` before parsing input. Add detectors to the shared source registry; the adapter selects and supervises them. The wrapper supplies `COC_RUNTIME=codex` and project context; Codex does not export a project-directory variable (`.claude/codex-templates/hooks.json:1-137`, `.claude/hooks/lib/codex-native-events.js:143-190`).
- Gemini reads `.gemini/settings.json` `hooks` (the `hooks` object) and renames events to its own taxonomy (`BeforeTool`, `AfterTool`). Gemini exports `GEMINI_PROJECT_DIR`.

The single-source contract means every hook MUST work under all three runtimes without per-CLI source forks. The shared library `lib/runtime.js::parseHook()` validates the `COC_RUNTIME` env var (closed enum: `cc` / `codex` / `gemini`) and returns a canonical payload shape regardless of source.

## Register A Detector, Not A Process (CC)

loom's CC hooks run through ONE process per event: `settings.json` registers `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" <Event>`, and `dispatch.js` loads every hook `.claude/hooks/dispatch-registry.json` lists for that event and runs it in-process under `hooks/lib/hook-engine.js` (its own stdin, stdout/stderr capture, `process.exit` capture, time budget and error boundary; any deny wins and every reason reaches the agent in one message). A new hook therefore:

1. Is added as a group entry in `dispatch-registry.json` under its event — same `matcher`/`command`/`timeout` shape a settings.json group had. A new DIRECT `settings.json` hook entry is BLOCKED by `hook-registration-regrowth.test.mjs` (the two settings-deny guards stay direct by design: they verify their own registration).
2. Exports `hookMain()` holding everything the script used to do at load time — the run bound (`runGuard` for a deny row, the timeout fallback for an advisory one), stdin read, the decision — and ends with a CLI guard (`if (require.main === module) hookMain();`). A `require()` of the file MUST have no side effects (`hook-dispatch-registry.test.mjs` loads every registered hook and fails on any output or armed timer).
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

## Codex Native Coverage and Compatibility

Verified 2026-09-28: current native hooks reach Bash, `apply_patch`, MCP calls, and most local function tools. Patch calls also match `Edit`/`Write`; agent spawn also matches `Agent`. Hosted tools and specialized opt-outs are outside that path. Later `write_stdin` input does not repeat the original pre-tool check.

The COC bridge selects delivered registrations and projects patch targets into shared checks. Runtime capability alone is not proof that a particular COC check is registered, trusted, or executed. Native pre-tool output uses supported permission decisions; unsupported `continue`/`stopReason` fields can invalidate a hook response. Background hooks cannot deny the triggering operation.

The MCP companion remains compatibility/policy machinery for explicit wrapper calls; it does not intercept all native calls. Validator 13 checks extracted predicate parity. Preserve that contract while the library is delivered, and avoid duplicate capture when two paths observe the same operation.

Review new or changed non-managed definitions through `/hooks`. Trust is operator-local and definition-specific. Hook sources merge across active config layers. Event-specific contracts and newer compaction/subagent/session lifecycle events are documented in the [official Hooks reference](https://learn.chatgpt.com/docs/hooks).

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

Command-string detectors MUST skip captured groups referencing unexpanded shell variables (`$VAR`, `${VAR}`, `$(...)`, backticks) with a structural `null` return (`rules/hook-output-discipline.md` MUST-3). Worked example: `portability-and-audit.md` § "Severity Grounding — Worked Example".

## Timeout Fallback

Every hook bounds its own run (`rules/cc-artifacts.md` Rule 7). What happens when the bound fires, or the hook throws, depends on whether the row can deny.

**Deny-capable row — FAILS CLOSED.** A row declaring `on_incomplete: "deny"` (`hooks/dispatch-registry.json`, or `hook-registry.json` for the directly registered settings-deny guard) builds its `hookMain` with `guard-runner.js::runGuard(name, main, {budgetMs, standalone})`:

```javascript
// DO — deny row: the runner owns the try/catch, the budget and the stdin read
const { runGuard } = require("./lib/guard-runner.js");
async function main(payload) {
  /* decide; deny through instruct-and-wait.js::emit, allow by returning */
}
const hookMain = runGuard("my-guard", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();

// DO NOT — a deny row that passes through when it breaks
setTimeout(() => { console.log(JSON.stringify({ continue: true })); process.exit(1); }, 5000);
try { /* decide */ } catch { process.exit(0); } // a crash becomes an allow
const payload = await readStdinBounded();       // resolves {} on timeout = "not my tool"
```

A throw, a rejected promise, a budget overrun or unreadable stdin (timeout, parse error, overflow) DENIES with exit 2 and a reply naming the guard; a budget overrun says it is a budget refusal, not a verdict, and to retry. In-process under `dispatch.js` the engine owns the budget and the runner arms no timer; `standalone: true` (a guard still registered directly, e.g. `settings-deny-edit-guard`) arms the budget timer and the `uncaughtException` / `unhandledRejection` handlers itself. A guard's own `process.exit(0)` inside the engine still passes — the runner re-throws the engine's exit sentinel rather than catching it. The deny-row fail-closed lint reds a deny-row file whose `hookMain` is not built by `runGuard(`, or that carries a `{continue: true}` / pass-through emitter inside a `catch`, `.catch(` or timer callback, or calls `readStdinBounded`.

**Advisory row — MAY FAIL OPEN.** A row declaring `on_incomplete: "continue"` (it cannot deny) keeps the classic fallback, armed inside `hookMain()`:

```javascript
const TIMEOUT_MS = 5000;
function hookMain() {
  setTimeout(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  // … read stdin, decide, emit …
}
```

`SessionStart` hooks may use `10000` (10s) for boot-time discovery; per-tool hooks (`PreToolUse`, `PostToolUse`) MUST stay at `5000` to avoid stalling interactive workflows. A hanging hook blocks the entire CLI session indefinitely — the bound is the only structural escape.

On an advisory row the `setTimeout`-fallback path is the ONE legitimate raw-exit branch; it MUST emit `{continue: true}` first. Raw `process.exit(N)` from any other branch is BLOCKED per `rules/hook-output-discipline.md` MUST-NOT-1. On a deny row there is no raw-exit branch at all: the runner emits.

## Gotchas — How A Deny Row Silently Fails Open

- ❌ **The fail-open template, copied onto a deny row.** Until 2026-10-19 Rule 7 itself prescribed `setTimeout → {continue: true}` for EVERY hook, so many older guards carry it, and a new guard copied from a neighbour inherits it. On a deny row that timer is an allow that fires exactly when the guard is starved. ✅ Check the row's `on_incomplete` first; `"deny"` means `runGuard`, with no timer of the guard's own.
- ❌ **A timer, or the deny decision, inside a `catch`.** A guard that arms its own `setTimeout` races the engine budget, and whatever the callback emits on expiry (`continue: true`, `exit(0)`) is the verdict. A guard that decides "deny" INSIDE a `catch` usually also has a pass-through on the catch's other branch. ✅ Delete the guard's timers (the runner or engine owns the budget) and lift any deny decision out of the `catch` into the normal flow, so the only thing an error path does is throw.
- ❌ **`readStdinBounded` resolving `{}`.** `hooks/lib/read-stdin-bounded.js::readStdinBounded` resolves its `fallback` (default `{}`) on a timeout, a parse error or an over-size payload, by contract. A guard reading `{}` finds no `tool_name` and returns "not my tool" — an allow built from no input at all. ✅ Let `runGuard` read the payload; it REJECTS on those three paths and the dispatcher refuses.
- ❌ **Reading the lint's green as "fails closed".** loom's deny-row fail-closed lint (it runs in loom CI and does not ship) is lexical over ONE file: it cannot see a pass-through emitter defined in another file, an `exit(code)` with a variable code, or a `catch` that sets a flag the verdict later reads as allowed (its header names these blind spots). ✅ Pair the lint with the guard's own throw probe: an env-gated throw through `dispatch.js` MUST return rc 2.

## Common Mistakes

### 1. Raw `process.exit(2)` Without instructAndWait

Highest-frequency authoring bug. A new detector ships a halting branch with `process.exit(2)` and no payload; agent gets "Execution stopped by hook" with zero context, files a follow-up issue (violating `autonomous-execution.md` MUST-4), and the rule the hook enforces gets re-asked next session. Fix: route every halting branch through `lib/instruct-and-wait.js::emit()`.

### 2. `severity: "block"` From Regex Evidence

Lexical regex against `payload.tool_input.command` cannot see shell expansion; matching `"$REPO"` as a literal string and reporting block-severity false-positives blocks in-scope work. Fix: lexical matches emit `halt-and-report`; block requires structural evidence (env var, exit code, file existence, AST shape).

### 3. Native Patch Input Assumed To Be A CC Edit

Native `apply_patch` does fire tool hooks, but its input is a patch in `tool_input.command`, not a CC `file_path` edit. Route through the native bridge's target projection and verify the delivered registration with deny/allow fixtures. Keep extracted compatibility policy parity current.

### 4. Missing Bound, Or A Fail-Open Bound On A Deny Row

Hook author skips the bound "because the work is fast." First runtime hang freezes the entire CLI session. Fix: an advisory row installs the 5s (or 10s for SessionStart) timeout fallback unconditionally. The opposite mistake is as common: a deny row copies that fail-open fallback (or a `catch` that exits 0), so the guard silently allows whatever arrives while it is crashed or starved. Fix: build a deny row's `hookMain` with `guard-runner.js::runGuard` and delete its own timers, pass-through catches and `readStdinBounded` (§ "Gotchas").

### 5. `$CODEX_PROJECT_DIR` Referenced In Hook Registration

Codex does not export a project-dir env var. Use the event-bound canonical template registration rather than constructing a launcher from an assumed variable or Git environment. Filesystem-marker discovery and the runtime establish project context; detector code consumes the normalized payload (`.claude/codex-templates/hooks.json:1-137`, `.claude/hooks/lib/codex-hook-runtime.js:435-508`).

### 6. Gemini Event Names As CC Aliases

Author writes `.gemini/settings.json` with `PreToolUse` / `PostToolUse` keys; Gemini silently ignores them and the hook never fires. Fix: translate to `BeforeTool` / `AfterTool`. CC's `Stop` maps to Gemini's `SessionEnd`; CC's `UserPromptSubmit` has no exact Gemini equivalent (closest is `BeforeModel`).

### 7. Semantic Analysis In Hooks

Hook attempts to reason about the meaning of agent prose, file contents, or commit messages. Hooks run synchronously with hard timeouts; semantic analysis is slow and non-deterministic, producing spurious failures that block the session. Fix: hooks check structure (path prefix, env var, exit code, AST shape); agents check semantics at gate review.

### 8. Lexical Hook Detector Without Probe Counterpart

Per `rules/probe-driven-verification.md` MUST-4, every lexical hook detector MUST have a probe-driven gate-review counterpart at `/codify` validation. Hook-only verification of a semantic property is BLOCKED — hooks alone produce false positives at scale; probes alone miss the cumulative-violation count for trust-posture downgrade math. Both layers required.

## Moved Depth

Full Documentation: `.claude/skills/hook-authoring/portability-and-audit.md` carries the worked detail for six topics; each MUST they carry is restated here so this file still states the whole contract:

- **Path resolution** — resolve the project root as `CLAUDE_PROJECT_DIR || GEMINI_PROJECT_DIR || payload.cwd`; Codex exports no project-dir variable.
- **Predicate shapes (validator-13)** — a reject predicate MUST match Shape A / B / C; a new shape is BLOCKED until the extractor and `.claude/fixtures/validator-13/` change together.
- **Variant overlays** — `.claude/variants/<axis>/hooks/<name>.js` replaces the body wholesale; prefer branching on `payload.runtime`.
- **Audit fixtures** — every `violation-patterns.js` detector MUST ship clean + flag (+ shell-variable) fixtures under `.claude/audit-fixtures/violation-patterns/<detector>/` (`rules/cc-artifacts.md` Rule 9).
- **Wrappers** — new hooks MUST NOT add `.claude/wrappers/*.sh.template` (deferred per `journal/0006`).
- **Workspace walks** — MUST filter `instructions` AND every leading-underscore directory (`rules/cc-artifacts.md` Rule 8).

## Audit Checklist

When auditing an existing hook:

- [ ] File location is `.claude/hooks/<name>.js` (NOT `scripts/hooks/` — obsolete pre-v2.8.31)
- [ ] Deny row (`on_incomplete: "deny"`): `hookMain` built by `guard-runner.js::runGuard`; no own timer, no pass-through `catch`, no `readStdinBounded`; the deny-row fail-closed lint is green
- [ ] Advisory row: timeout fallback installed: `setTimeout` → `{continue: true}` → `process.exit(1)`
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

- `rules/cc-artifacts.md` Rule 7 — run-bound mandate: deny rows fail closed via `runGuard`, advisory rows may fail open
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
- `hooks/lib/guard-runner.js::runGuard` — the fail-closed run boundary every deny row is built on
- `skill-authoring` (F1) — sibling meta-skill, same shape conventions
- `command-authoring` (F2) — sibling meta-skill, same shape conventions
