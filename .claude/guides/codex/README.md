# Working with Codex CLI on loom COC

The installed version and `exec --help` were rechecked on 2026-10-02:
`codex-cli 0.159.3`. Native hook contracts were checked against the official
documentation on the same date. Earlier version-specific runtime probes below
retain their original scope; an installed version is not a public release claim.
Use `codex --version` and command-specific `--help` on another installation.

## Start and inspect a session

```bash
codex --version
codex doctor --summary
codex --strict-config
```

`doctor` checks the local installation and configuration; `--strict-config` rejects
unknown configuration keys. Neither proves that a policy hook blocks the intended
operation. Project configuration is loaded through trusted `.codex/` layers;
operator credentials and personal preferences remain local. Installation and current
options: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli),
[command reference](https://learn.chatgpt.com/docs/developer-commands).

## COC surfaces

| Purpose | Source | Delivered surface |
| --- | --- | --- |
| Baseline instructions | `.claude/rules/` | `AGENTS.md` |
| Shared configuration and hook registration | `.claude/codex-templates/` | `.codex/config.toml`, `.codex/hooks.json` |
| Domain skills | `.claude/skills/` | `.agents/skills/<name>/SKILL.md` |
| Explicit phase procedures | `.claude/commands/` | `.agents/skills/coc-<phase>/SKILL.md` |
| Named specialists | `.claude/agents/` | `.codex/agents/<name>.toml` |
| Headless phases | `.claude/codex-templates/bin/coc` | `bin/coc`, `bin/coc-<phase>` |
| Compatibility procedure/spec text | commands and agents | `.codex/prompts/*.md` |
| Compatibility MCP wrapper | `.claude/codex-mcp-guard/` | `.codex-mcp-guard/` in consumers |

Native skill delivery requires both Codex in the target CLI set and
`repos.<target>.codex_native_skills: true` (default false; currently base/py/rs elect
it). A catalog copied to disk is not automatically a presented skill for every role.

Distribution and presentation are separate: copying an artifact does not grant a
role access to its presentation surface. Emission preserves the source exclusions
and role rules. Personal config, credentials, hook-trust decisions, and installed
plugins are not copied into consumers.

Loom's explicitly elected local-authoring profile exposes its full authoring
catalog. Consumer emission retains its own exclusions and role selection; it
cannot activate this source-only profile
(`.claude/bin/lib/local-authoring-projection.mjs:7-63`).

## Invoke a phase or skill

In an interactive prompt, type `$coc-analyze`, `$coc-todos`, or `$coc-implement`, then
supply the task. These phase skills are explicit-only so an ordinary task does not
silently select a lifecycle phase. Domain skills remain discoverable by description;
use `/skills` or `$` to select one yourself.

For noninteractive automation:

```bash
bin/coc analyze "Audit the connection-pool surface."
bin/coc implement "Wire the approved auth change."
# Equivalent phase shim:
bin/coc-analyze "Audit the connection-pool surface."
```

The dispatcher supplies the phase procedure and JSON output contract to `codex exec`
through `phase_procedure` and its exec call (`.claude/codex-templates/bin/coc:36-41,118-142`). It requires the CLI on `PATH` and delivered procedure/schema files (`.claude/codex-templates/bin/coc:89-96,118-142`).
That exec call starts a separate run; it does not switch an already-running interactive session's phase.
Final results are validated separately from the event stream. Completion requires
observed evidence and phase-consistent results; pending gates and unfinished
implementation cannot be labeled completed. Human-only certification returns an
explicit input request instead of invoking the provider
(`validateResult`, `.claude/bin/lib/codex-command-catalog.mjs:114-150`;
`humanGate`, `.claude/bin/lib/codex-command-catalog.mjs:152-160`;
the dispatcher's `MODE` branch, `.claude/codex-templates/bin/coc:125-129`).

`.agents/skills` is the current catalog. Avoid a second copy of the same catalog in
`.codex/skills`; duplicate names can appear separately. Skill discovery, optional
`<skill>/agents/openai.yaml` metadata inside each skill directory, and explicit invocation are described in
[Build skills](https://learn.chatgpt.com/docs/build-skills).

Custom prompts were deprecated upstream on **2026-01-22**. Loom's 2026-05-28 #385
migration was its local response. `.codex/prompts/` remains compatibility reference
and headless procedure input; it is not the native interactive command surface.
[Deprecation receipt](https://learn.chatgpt.com/docs/changelog#custom-prompts-deprecated).

## Delegate to specialists

Ask Codex to delegate to the emitted named specialist, supplying the task and relevant
spec content. Native definitions in `.codex/agents/*.toml` contain `name`, `description`,
and `developer_instructions`; they inherit settings unless overridden by their config.
The compatibility `.codex/prompts/specialist-<name>.md` files can still be read when
working with an older delivery. A persona pasted into a parent prompt is not a separate
agent or a permission boundary.

Source model/tool/hook declarations are retained in the generated agent contract.
Tool inventories constrain instructions; they are not a native enforced allowlist.
Native read-only defaults are requests, and provider model behavior is not assumed
equivalent (`.claude/bin/lib/codex-agent-contracts.mjs:15-37`).
A controlled CLI 0.158.0 execution probe observed an analyst
child with `workspace-write` despite its emitted `read-only` setting; verify actual
child policy before relying on a role default for isolation.

Current clients support subagent workflows, including noninteractive flows. An action
requiring a fresh approval fails when that run cannot surface approval; the error
returns to the parent. Inspect threads with `/agent` or `/subagents`. Native delegation
does not itself establish an isolated Git checkout. Follow the repository's worktree
procedure before assigning concurrent writes. See
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Coordinate independent sessions

Child delegation uses the current runtime's collaboration tools. `codex agents`
browses independent sessions; `codex queue` sends to an existing one. For separate
local homes, the address is **recipient CODEX_HOME plus session UUID/exact name**.
Include the sender home and session as the return route; scope the home override
to the single command. Queue acceptance does not prove recipient acknowledgement
or completed work. See the [coordination skill](../../skills/codex-coordination/SKILL.md)
for the message contract, quoted examples, replies and remote distinction.

Native read-only agent defaults are configuration intent, not proof of the child's
effective sandbox. Inspect that runtime before relying on permission isolation.

For configuration precedence, context/compaction limits, session lifecycle,
headless output, plugin/MCP distinctions, daemon operations and interactive
controls, use the [operations reference](operations.md).

## Hooks and enforcement

Use `/hooks` to inspect registrations and review new or changed hook definitions.
Non-managed hooks need trust for their exact definition; a sync that changes them can
leave them skipped until reviewed. Project trust and hook trust are distinct.

Inspect the loaded definition's `sourcePath`, `currentHash`, `trustStatus` and
`timeoutSec` before testing candidate hooks. A CLI 0.158.0 scratch probe found that
a linked Git worktree loaded its main checkout's `.codex/hooks.json`; changing only
the worktree definition did not change the loaded hash or timeout. Use a standalone
scratch repository for isolated candidate tests and label that evidence accordingly.
Do not change the real main checkout or copy trust grants merely to make a test load.

Native tool hooks cover shell commands (`Bash`), `apply_patch` (`Edit`/`Write` aliases),
MCP calls, and most local function tools; `spawn_agent` also matches `Agent`. Hosted
web tools and specialized opt-outs remain outside that path. `write_stdin` does not
re-run the original command's pre-tool check. The shipped registration and adapter,
not mere runtime support, determine which COC checks actually run.

The bridge adapts event input/output and selects eligible delivered checks. Patch
checks receive typed targets and added/changed text; moved destinations use bounded
published bytes after the edit. Unsupported rewrites are refused
(`.claude/hooks/lib/codex-native-policy.js::projectPayloads`, `.claude/hooks/lib/codex-native-policy.js::publishedMoveContent`, `.claude/hooks/lib/codex-native-policy.js::evaluateNative`). Lifecycle launchers bind their
event before reading input, preserving the correct failure response even for
malformed or unfinished input: `main` selects the launcher event and failure
response, and `dispatch` validates the binding. Shutdown checks report incomplete
work within their short host budget
(`.claude/hooks/lib/codex-hook-runtime.js:1012-1021`,
`.claude/hooks/lib/codex-hook-runtime.js:885-890`,
`.claude/hooks/lib/codex-native-events.js:143-188`). Consult the event-specific
[Hooks reference](https://learn.chatgpt.com/docs/hooks) when authoring a hook.

A CLI 0.158.0 native app-server probe found that a startup delay can exhaust the
client’s outer hook timeout before the adapter runs: a 4-second delay under a
2-second scratch registration timed out, yet the shell tool still executed. This
was continuation, not a policy denial. The adapter’s internal budget begins after
entry and cannot cover startup time before it runs. The shipped 550-second internal
budget and 600-second registration remain unchanged; this scaled probe does not
certify their behavior under production load.

The MCP companion governs calls sent to its wrapper tools. Installing it does not
intercept every native tool. Its compatibility policy checks complement registered
native checks; neither is a complete sandbox or a universal enforcement boundary.

## Instructions and configuration

Codex loads `AGENTS.md` through the root-to-working-directory hierarchy, preferring
`AGENTS.override.md` at a given directory. The combined default limit is 32 KiB;
Loom's dispatcher raises `project_doc_max_bytes` to 65536. Check the delivered config
for the interactive setting. Nested files share the combined budget.
[AGENTS.md reference](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

The project bridge adds path-rule activation for typed file operations and parsed
patches when its hook is installed and trusted. It verifies catalog membership,
matching metadata and source hashes before injecting the actual matching text.
Shell programs with computed targets and hosted retrieval still require manual rule
discovery; see `collectRuleContext`
(`.claude/hooks/lib/codex-rule-context.js:98-155`). The generated index
and rules-reference skill remain available for that purpose.

Profiles are optional operator choices. `--profile` selects configuration while
`--permission-profile` selects permission policy on commands that expose it; inspect
your installed command's help before assuming support or an older profile layout. Shared repo defaults do not authorize
changes to personal authentication, sandbox, model, or approval choices.

## Review and continue work

Choose one review target:

```bash
codex review --uncommitted
codex review --base main
codex review --commit HEAD
```

Those targets and a custom review prompt are mutually exclusive. `codex resume`
continues saved work; `codex fork` starts a separate chat from earlier context. `/plan`
opens planning mode. A user can explicitly set `/goal <objective>` and subsequently
view, edit, pause, resume, or clear it. COC authorization and completion checks still
apply. [Commands](https://learn.chatgpt.com/docs/developer-commands).

## Optional capabilities

- **Plugins:** `/plugins` and `codex plugin` manage reusable packages. A plugin may
  bundle skills, MCP, and hooks; installation does not automatically trust hooks.
  Loom does not install plugins or copy personal plugin settings during sync.
  [Plugin packaging](https://developers.openai.com/plugins/build/plugins).
- **Worktrees:** the installed CLI 0.158.0 exposes `codex --worktree` to start a
  session in a new managed Git worktree (`codex --help`, checked 2026-09-28).
  Use that entry point or the repository’s established worktree procedure.
  Spawning a specialist inside an existing session does not itself prove isolation.
  The desktop app also supports [worktree chats](https://learn.chatgpt.com/docs/environments/git-worktrees).

- **Remote control:** `codex remote-control` is an optional experimental surface in
  the current command reference. Pairing, account access, and remote exposure are
  operator decisions, not requirements for COC phases.
  [Command reference](https://learn.chatgpt.com/docs/developer-commands).

For authoring contracts see `.claude/agents/codex-architect.md`; for the dispatcher
see `.claude/codex-templates/bin/README.md`. Historical audit journals retain their
original observations; this guide describes the current capability model.
