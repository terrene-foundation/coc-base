# Hook Authoring — Portability, Predicate Shapes And Audit Depth

Depth moved out of `SKILL.md` (which had grown past the 250-line skill cap). Every MUST below is
restated, in one line, in `SKILL.md` § "Moved Depth"; this file carries the worked detail. Read it
when resolving a project directory outside CC, adding a reject branch the MCP guard must mirror,
overlaying a hook per CLI, committing detector fixtures, or walking `workspaces/`.

## Path Resolution Across CLIs

Project-dir resolution is the #1 portability pitfall. Only CC and Gemini export a project-dir env var; Codex does not. The hook resolves the project root in this order:

```javascript
const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  process.env.GEMINI_PROJECT_DIR ||
  payload.cwd; // from stdin — Codex fallback
```

The native payload's `cwd` identifies the session working directory, which may be nested below the repo root. The bridge establishes COC project context before invoking shared hooks. A cwd-relative launch still needs to locate the bridge before payload processing can help; validate nested-cwd launches against the delivered registration. Do not assume the historical root-cwd observation is a runtime guarantee. This Node bridge is distinct from phase dispatch through `bin/coc`.

## Severity Grounding — Worked Example

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

## Predicate Function Shapes (Validator-13 Bijection)

A predicate function is any function whose body produces a reject decision. The MCP guard's AST extraction recognizes three structural shapes:

- **Shape A** — `process.exit(N)` with `N >= 2` in the function body.
- **Shape B** — returns `{ exitCode: N, ... }` with `N >= 2`; at least one caller routes that return into a `process.exit(<field>)` call in the same file. The data-flow check is per-predicate (tightened in v6.1).
- **Shape C** — returns `{ isError: true, content: [...] }` — the MCP response form used by the guard server.

Fixtures live at `.claude/fixtures/validator-13/`. Adding a new predicate that the extractor cannot match (a fourth shape, or a borrowed pattern from elsewhere) is BLOCKED until the extractor and fixture set are updated together. Predicate shape is part of the public contract between the hook layer and the MCP guard.

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

Hook-level Bash wrappers were briefly authored at Phase J1 to bridge missing Codex hook events via shell shims, but **wrapper emission was deferred at Shard C (2026-05-10)** per `journal/0006-DECISION-wrapper-emission-disposition-strip.md`. That historical deferral concerned per-hook shell wrappers. Current native coverage is described in `SKILL.md` § "Codex Native Coverage and Compatibility"; `bin/coc` is a separate phase dispatcher.

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
