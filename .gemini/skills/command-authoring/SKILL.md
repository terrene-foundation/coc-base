---
name: command-authoring
description: "Authoring or auditing commands (CC/Codex/Gemini). Frontmatter, ≤150-line body, neutral phrasing, native-primitive carve-outs, variant overlays."
tools:
  - Read
  - Glob
  - Grep
---

# Command Authoring

Reference for authoring and auditing slash commands across CC, Codex, and Gemini. Commands are L4 (Instructions) artifacts in the COC 5-layer architecture per `rules/cc-artifacts.md` — distinct from agents (L1 Intent), skills (L2 Context), and rules (L3 Guardrails). They inject as user-message prompts at invocation; every line competes with actual user intent for context.

## When To Use

Authoring a new slash command. Auditing an existing command for line cap, neutral phrasing, native-primitive carve-out drift, or cross-CLI parity. Deciding whether work belongs in a command (procedure invoked by name) versus an agent (specialist judgment + tools) or a skill (reference looked up on demand).

## Quick Reference

| CLI    | On-disk path                   | Format   | Slash invocation  | Frontmatter shape                                                             |
| ------ | ------------------------------ | -------- | ----------------- | ----------------------------------------------------------------------------- |
| CC     | `.gemini/commands/<name>.md`   | Markdown | `/<name>`         | YAML: `name:` + `description:` + optional `argument-hint:` / `allowed-tools:` |
| Codex  | `.codex/prompts/<name>.md`     | Markdown | `/prompts:<name>` | Same YAML, preserved from source                                              |
| Gemini | `.gemini/commands/<name>.toml` | TOML     | `/<name>`         | `name`, `description`, `prompt = '''…'''`, optional `tools = [...]`           |

| Constraint       | Value                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name:`          | Lowercase, hyphen-separated. Matches filename stem.                                                                                             |
| `description:`   | One short line. Failure-mode language. Per `rules/cc-artifacts.md` Rule 1 cap ≤120 chars for any frontmatter that flows into a listing surface. |
| Body length      | **≤150 lines** per `rules/cc-artifacts.md` Rule 3. Push reference content to skills, judgment to agents.                                        |
| Neutral phrasing | No CC-native delegation syntax (`Agent(subagent_type=…)`, `Task(…)`) in prescriptive prose — Codex and Gemini consume the same body.            |
| `argument-hint:` | Single line; used by CC to render the hint after `/name`.                                                                                       |

## Single Source, Three Emissions

The authoritative copy lives at `.gemini/commands/<name>.md`. The emitter `.claude/bin/emit-cli-artifacts.mjs` (driven by `coc-sync` Step 6.6) produces:

- `.codex/prompts/<name>.md` — Markdown passthrough with Codex-native adaptations from `variants/codex/commands/<name>.md` overlays (if any).
- `.gemini/commands/<name>.toml` — TOML wrap of the same body inside a triple-single-quote `prompt` block; YAML frontmatter is converted to TOML keys.

Both consumers read the source body. Anything CC-native that appears in the body — `Agent(subagent_type=…)`, `Task(…)`, `TodoWrite(…)` — leaks into Codex/Gemini emissions and is unparseable there.

## Frontmatter Discipline

```yaml
# DO — minimal, action-oriented
---
name: redteam
description: "Load phase 04 (validate) for the current workspace. Red team testing."
---
```

The `description:` is what appears in the CC `/help` listing and in Codex's `/prompts` enumeration. Failure-mode language ("Red team testing"; "Production hardening for frontend") wins over generic noun phrases ("Validation command"; "Hardening utility").

### Argument Hint

```yaml
---
name: implement
description: "Load phase 03 (implement) for the current workspace."
argument-hint: "[shard-id]"
---
```

`argument-hint:` renders inline after the command name during typeahead. Use bracketed placeholders for optional args, angle brackets for required.

### Allowed Tools (Rare)

`allowed-tools:` restricts which tools the agent may invoke during the command body. Default is unrestricted. Use only when the command genuinely shouldn't reach for, e.g., `Bash` or `Write`. Most commands omit it.

## Body Discipline — ≤150 Lines

Per `rules/cc-artifacts.md` Rule 3: commands inject as user messages and compete with the actual user prompt. Long commands crowd out user intent.

### What Belongs IN The Body

- Numbered workflow steps the agent executes ("1. Resolve workspace. 2. Read briefs. 3. Emit analysis to …").
- Exit conditions / phase gates ("Do not proceed to /todos without user approval").
- Output target paths (`workspaces/<project>/02-plans/analyze.md`).

### What Belongs ELSEWHERE

- Reference tables, taxonomies, exhaustive option lists → **skills** (loaded on demand via SKILL.md cross-reference).
- Review rubrics, scoring matrices, judgment criteria → **agents** (the specialist owns the criteria).
- Rule enforcement / boundary checks → **rules** (always-on, frontmatter-scoped).

If a command exceeds 150 lines, the fix is almost always extraction — move the reference block into a numbered skill the command references.

## Neutral Phrasing — Cross-CLI Hygiene

Commands ship to all three CLIs. Body content MUST NOT bake in CC-native syntax that breaks on Codex / Gemini. Per `rules/cross-cli-artifact-hygiene.md`:

```markdown
# DO — neutral phrasing

Delegate to security-reviewer for parallel scan; dispatch reviewer and
gold-standards-validator in the same wave.

# DO NOT — CC-native delegation syntax in command body

Agent(subagent_type="security-reviewer", run_in_background=true, prompt=…)
Task(subagent_type="reviewer", …)
```

Codex reads natural-language specialist references and spawns subagents accordingly; Gemini uses `@<agent-name>` syntax. Both fail on literal `Agent(...)` / `Task(...)` calls embedded in prose. The same applies to hook event names — write "the SessionStart hook" rather than `hooks.SessionStart`.

## Variant Overlays

CLI-specific or language-specific bodies live at `.claude/variants/<axis>/commands/<name>.md` and overlay only the diverging slot. Axes:

- `variants/codex/` — Codex-only deltas (e.g. invoke `codex review` natively instead of redirecting)
- `variants/gemini/` — Gemini-only deltas
- `variants/py/`, `variants/rs/`, `variants/rb/`, `variants/prism/` — language deltas
- `variants/py-codex/`, `variants/rs-codex/`, `variants/py-gemini/`, `variants/rs-gemini/` — ternary overlays (language × CLI)

Slot-marker syntax matches the skill-authoring convention:

```markdown
<!-- slot:neutral-body -->

This content emits to all CLIs.

<!-- /slot:neutral-body -->

<!-- slot:examples -->

CLI-neutral examples — overridable per CLI.

<!-- /slot:examples -->
```

Variant files supply replacement bodies only for the slots that diverge. Unoverridden slots inherit the global file.

## Native-Primitive Carve-Outs

Some CC commands map to a CLI's own native primitive — emitting a `.codex/prompts/<name>.md` or `.gemini/commands/<name>.toml` for them would shadow the native path. Per `.gemini/agents/codex-architect.md` § Codex-Native Primitives:

- **`/review`** → `codex review --uncommitted --base main` (Codex native). Do NOT emit a `.codex/prompts/review.md`.
- **`/security-review`** → architect-decided; check the per-CLI exclusions list before adding.

The exclusion mechanism lives in `.claude/sync-manifest.yaml::cli_emit_exclusions.{codex,gemini}` as a glob list. New commands that have a native counterpart MUST add a `commands/<name>.md` exclusion entry for the relevant CLI.

## Wrapper Status — Native Prompts Are Canonical

Bash wrappers (`bin/coc-<name>`, e.g. `bin/coc-analyze` invoking `codex exec --json --output-schema=…`) were authored at Phase J1 but **wrapper emission was deferred at Shard C 2026-05-10** per `journal/0006-DECISION-wrapper-emission-disposition-strip.md`. Reasons: the wrappers' runtime dependency `.codex/developer-instructions/` was never authored; the native prompt surface covers all 28 commands; manifest emit_to declarations were stubs.

Treat `.claude/wrappers/*.sh.template` as historical. New commands MUST NOT add wrapper templates. If a future workstream requires structured-output enforcement or external CLI invocation, revival is documented in the journal entry — propose at `/codify`, do not assume it's live.

## Sync Manifest Wiring

Every new command MUST be added to `.claude/sync-manifest.yaml` under the appropriate tier block. The tiers determine which USE templates receive the command:

```yaml
# .claude/sync-manifest.yaml
tiers:
  co:
    - commands/<name>.md # ships everywhere CO baseline ships
  coc:
    - commands/<name>.md # ships to all COC consumers
  cc:
    - commands/<name>.md # CC-only (e.g. /review)
```

`repos.<target>.tier_subscriptions` controls which tiers a USE template receives. Per the emitter's `--target` flag, the per-repo subscription list IS the filter — a command in `co` but not in `repos.kailash-coc-py.tier_subscriptions` does not ship there.

### Codex / Gemini Exclusion (Native Override Case)

```yaml
cli_emit_exclusions:
  codex:
    - commands/review.md # codex review is native
  gemini:
    - commands/review.md # gemini has its own review path (if any)
```

Glob form is supported (`commands/i-*.md`). The emitter honors exclusions at source-tree scan time.

## Decision: Command vs Skill vs Agent

| Symptom                                                     | Belongs in |
| ----------------------------------------------------------- | ---------- |
| User types `/foo` to start a procedure                      | Command    |
| Reference content looked up on demand                       | Skill      |
| Specialist judgment with tools + delegation                 | Agent      |
| Always-on boundary enforcement                              | Rule       |
| Deterministic hook firing on tool event / session lifecycle | Hook       |

If a "command" file grows judgment rubrics, scoring criteria, or conditional branching with recovery paths, it's an agent in disguise. Move the body into `.gemini/agents/<name>.md` and shrink the command to a 20-line dispatch (`Delegate to <name>-specialist with the user's input as the prompt.`).

## Common Mistakes

### 1. Body > 150 Lines

Most frequent. Reference tables, exhaustive option lists, multi-page review rubrics inflate the body until command injection floods the user's prompt context. Fix: extract the reference content into a skill or agent.

### 2. CC-Native Delegation In Body

`Agent(subagent_type="…")` / `Task(…)` / `TodoWrite(…)` in prescriptive prose breaks Codex + Gemini emissions. Fix: rewrite as neutral instruction ("delegate to security-reviewer", "dispatch reviewer + gold-standards-validator in parallel").

### 3. Missing Sync-Manifest Entry

New command in `.gemini/commands/` but not in `sync-manifest.yaml` ships to nobody — emitter scans tier-listed files only. Fix: add `commands/<name>.md` to the correct tier; verify with a dry-run emission against one USE target.

### 4. Native-Primitive Shadow

Authoring `.gemini/commands/review.md` without an exclusion entry causes the emitter to overwrite Codex's native `codex review` invocation with a redirected prompt. Fix: add `commands/review.md` to `cli_emit_exclusions.codex` BEFORE the command lands.

### 5. Description As Sentence Paragraph

Multi-sentence descriptions waste listing-budget bytes and dilute the failure-mode signal. Fix: one short clause naming the situation the command addresses ("Production hardening for frontend"), not a paragraph.

### 6. `argument-hint:` Without Body Handling

Frontmatter hints at args, body never references `$ARGUMENTS` or the user's argv. Result: typeahead promises a feature the command doesn't deliver. Fix: either remove the hint or wire `$ARGUMENTS` resolution into the body.

## Audit Checklist

When auditing an existing command:

- [ ] `name:` matches filename stem
- [ ] `description:` one short line, failure-mode language
- [ ] Body ≤150 lines (count after stripping frontmatter)
- [ ] No CC-native delegation syntax in prescriptive prose
- [ ] No hook event names in PascalCase as prescriptive identifiers
- [ ] Reference content (tables, taxonomies) lives in skills, not body
- [ ] Listed in `sync-manifest.yaml` under correct tier
- [ ] If a CLI has a native equivalent, exclusion entry exists in `cli_emit_exclusions.<cli>`
- [ ] No wrapper template added at `.claude/wrappers/<name>.sh.template` (wrappers deferred per journal/0006)
- [ ] Variant overlays at `variants/<axis>/commands/<name>.md` use slot markers
- [ ] If `argument-hint:` set, body resolves `$ARGUMENTS`

## Related

- `rules/cc-artifacts.md` Rule 3 — ≤150-line cap on commands
- `rules/cc-artifacts.md` Rule 1 — description char caps + listing-budget pressure
- `rules/cross-cli-artifact-hygiene.md` — neutral phrasing requirement
- `rules/cross-cli-parity.md` — variant overlay semantics
- `agents/codex-architect.md` § Codex-Native Primitives — carve-out table
- `agents/gemini-architect.md` § Gemini-Native Primitives — Gemini equivalents
- `bin/emit-cli-artifacts.mjs` — emitter source of truth
- `skill-authoring` (F1) — sibling meta-skill, same shape conventions
- `hook-authoring` (F3, planned) — hook lifecycle + validator-13 bijection
