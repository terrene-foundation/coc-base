# Codex operations reference

Companion to [the COC guide](README.md). Command shapes were checked with installed
CLI **0.158.0** on 2026-09-28; official references were read on the same date.
Examples describe available actions, not changes performed by sync. Live remote
pairing, plugin installation and interactive feature behavior are **UNRUN** here.
For independent-session routing, read the
[coordination skill](../../skills/codex-coordination/SKILL.md).

## Configuration and permissions

Highest precedence first: CLI overrides; trusted project config nearest cwd;
selected profile; user config; cloud defaults; system config; built-in defaults.
Managed requirements constrain what those settings can permit. `/debug-config`
shows layers and requirements; `--strict-config` rejects unknown keys rather than
proving policy enforcement. [Configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic).

`codex --profile NAME` layers `$CODEX_HOME/NAME.config.toml` over base user config.
A profile file is different from a named permission profile. Use `/permissions`
and the installed command's help for supported permission selection; do not assume
`--permission-profile` exists on every command. Preserve the operator's actual
settings. A supported top-level example is `approval_policy = "on-request"`;
this documentation does not select it for the operator.
[Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

Context limits belong at TOML top level, before any `[table]`. Illustrative values
only, for a model/provider that actually supports an 800,000-token window:

```toml
model_context_window = 800000
model_auto_compact_token_limit = 700000
model_auto_compact_token_limit_scope = "total"
```

An override cannot enlarge a provider's actual limit. The lower threshold leaves
headroom for continuation and tools. The default `total` scope counts active context;
`body_after_prefix` counts growth after the carried compaction-window prefix.
This is not cumulative account usage or a goal budget. Unset values use model
defaults. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

`codex features list` reports maturity and effective state; enabling a flag edits
configuration and is a separate decision. Experimental availability is not a COC
requirement. Test-only homes must be explicit temporary directories independent of
the real home. COC automation does not default to ignored rules/user config,
unrestricted execution or bypassed hook trust. Emitted agent defaults do not
certify the effective sandbox of a spawned child; inspect its runtime settings.

## Sessions, goals and worktrees

`codex resume SESSION_ID` continues a saved session; `codex fork SESSION_ID` creates
a separate session. Inspect cwd when resuming or forking; `--cd DIR` selects the
working root on supported commands. Use saved IDs/exact names rather than branch
names, child IDs or terminal PIDs. Resolve the appropriate Codex home before acting.

`codex archive SESSION` preserves saved history while archiving it;
`codex unarchive SESSION` restores it. `codex delete SESSION` permanently deletes
saved history and descendants: obtain explicit deletion authorization and verify
the exact target. Session deletion is not a Git worktree cleanup procedure.
Installed help establishes these command forms.

Create a persistent goal only when the user explicitly asks. Include outcome,
constraints and completion evidence. `/goal` supports viewing/editing and
pause/resume/clear; a normal work request does not authorize creating a persistent
goal. Clearing a goal does not revert files. Continue the same session for steering.
[Long-running work](https://learn.chatgpt.com/docs/long-running-work).

Installed 0.158.0 exposes `--worktree` on interactive and `exec` entry points.
Verify the resolved checkout (`pwd -P`, `git rev-parse --show-toplevel`,
`git worktree list --porcelain`) before edits, retain path ownership and repository
isolation rules, and check clean status plus integrated commits before cleanup.
Native child delegation alone does not prove a new worktree exists. Product support
and feature maturity can change; check installed help before using another version.

## Headless runs and result delivery

`codex exec "TASK"` uses an argument; `codex exec - < task.txt` reads stdin.
With both an argument and piped stdin, installed help says stdin is appended as a
separate input block. Quote arguments; do not interpolate untrusted task text into
shell code. For COC phases, use `bin/coc` so the procedure/schema contract travels.

```bash
codex exec --json --output-schema result.schema.json \
  --output-last-message result.json - < task.txt > events.jsonl
run_status=$?
```

Supply a real JSON Schema file and authorized task. `--json` is a JSONL event stream;
`--output-schema` constrains the final response shape; `--output-last-message` saves
the final message separately. Check `run_status`, event errors, schema validity and
actual artifacts before reporting success. Return their paths and verification
results through the agreed channel; an exit-zero process alone is not task evidence.
`--ephemeral` avoids persisted session files, but does not undo tool side effects.

Installed help also exposes `codex exec resume SESSION_ID "TASK"` and
`codex exec fork SESSION_ID "TASK"`; inspect each subcommand's options separately.
A resumed session needs persisted history, so do not promise resuming an ephemeral
run. Headless work cannot obtain a fresh interactive approval unless its host has
an applicable approval channel; report refusal instead of adding bypass flags.

## Plugins, MCP and remote services

`codex plugin list` and `codex plugin marketplace list` inspect available packages
and sources. `plugin add/remove` changes installation; `plugin marketplace
add/remove/upgrade` changes sources or refreshes Git snapshots. Refreshing a
marketplace is not proof of installed-code reload: inspect the active plugin and
its components after the documented reload/restart. Avoid automatic installations.
[Plugins](https://learn.chatgpt.com/docs/plugins).

`codex mcp list/get` inspect service configuration; `add/remove` alter it and
`login/logout` handle supported authentication. A plugin installation, an MCP
service connection, and trusting exact hook definitions are separate actions.
The installed command list has no `codex mcp-server` entry point; older tutorials
using Codex itself as an MCP server are not current setup instructions.

The experimental `codex app-server daemon` exposes `start`, `restart`, `stop`,
`update`, `bootstrap`, `version`, and remote-control enable/disable commands.
`version` reports local client and running daemon versions; updating the client
alone need not update a running server. Start/restart/update can affect other work.
Inspect `codex doctor --summary` (or redacted `--json`) before changing service state.

`codex remote-control start/stop/pair` manages optional remote control and pairing.
For direct app-server transport, help lists stdio, Unix sockets and WebSocket
listeners with explicit WebSocket authentication options. Use the configured
transport/authentication; a local CODEX_HOME override is not remote routing.
Do not enable listeners, bootstrap a service, pair accounts or copy credentials
as part of a docs refresh. [App server](https://learn.chatgpt.com/docs/app-server).

## Interactive controls and maintenance

Use `/status` for session settings and `/usage` for account usage. `/model` and
`/fast` change runtime choices. Enter steers active work; Tab queues a follow-up.
`/side` opens a separate ephemeral side conversation. `/ps` inspects background
terminals; `/stop` stops them, so check what is running first. `/copy` copies the
latest completed response; `/import` can write imported setup and local files.
`/keymap` and `/vim` alter interaction settings. Availability depends on the host.
[Interactive commands](https://learn.chatgpt.com/docs/developer-commands).

Voice and fullscreen features vary by client, platform and release. This CLI
0.158.0 help check did not establish a voice/fullscreen launch flag; no universal
flag or verified runtime behavior is claimed. Inspect the current UI/settings and
release documentation before promising them; their live behavior remains UNRUN.

Routine inspection: `codex --version`, command-specific `--help`,
`codex doctor --summary`, `codex features list`. `codex update` changes the installed
binary: run it only when authorized, then recheck client/daemon versions and the
relevant behavior. Do not upgrade, change homes or relax policies to make an
old example appear to work.

For COC installation or refresh, follow the canonical migration procedure in
`.claude/skills/30-claude-code-patterns/multi-cli-migration.md`. Its preliminary
copy checks must precede writes. Native agents are reconciled by
`.claude/bin/coc-native-agent-delivery.mjs` using the destination's own receipt;
do not import another installation's receipt or adopt custom agents by filename.
