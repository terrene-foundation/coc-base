---
priority: 10
scope: path-scoped
paths:
  - "workspaces/**/*.md"
  - "briefs/**/*.md"
---

# Cross-CLI Artifact Hygiene

Project artifacts (workspace plans, journals, briefs, todos, redteam reports) are read by every CLI a session may run under — Claude Code, Codex, Gemini. When an artifact authored under one CLI bakes that CLI's native delegation syntax (`Agent(subagent_type=...)`), tool names (`Read tool`, `Bash tool`), hook event names (`SessionStart`), or baseline-file references (`CLAUDE.md` as authority) into prescriptive prose, the next reader running a different CLI silently misreads the acceptance criteria. Sits below `rules/cross-cli-parity.md` (rule-layer parity) and above `rules/upstream-issue-hygiene.md` (public-issue layer); this rule controls the project-artifact layer in between.

Origin: 2026-05-06 — audit of `workspaces/**/*.md` across kailash-py / kailash-rs surfaced widespread leakage of CC-native delegation syntax (`Agent(subagent_type=...)`, `run_in_background=true`), CC tool nouns (`Read tool`, `Edit tool`), and CC baseline-file authority claims (`per CLAUDE.md`) in todos, journal entries, and redteam reports. A Codex / Gemini reader inheriting any of these workspaces reads acceptance criteria written in syntax their CLI cannot parse — silently misled.

## MUST Rules

### 1. Delegation Syntax Is CLI-Neutral

Every prescriptive reference to specialist delegation in a workspace artifact MUST use neutral phrasing — "delegate to security-reviewer", "dispatch reviewer + security-reviewer in parallel", "run gold-standards-validator". CC-native syntax (`Agent(subagent_type=...)`, `Agent({subagent_type: "...", run_in_background: true})`, `Task(...)`, `TaskCreate`, `TaskUpdate`) baked into prescriptive prose is BLOCKED.

```markdown
# DO — neutral delegation

- Reviewer agent approves the diff
- Dispatch reviewer + security-reviewer in parallel; both MUST approve before merge
- Delegate to gold-standards-validator at /release

# DO NOT — CC-native syntax in prescriptive prose

- Reviewer agent approves (`Agent({subagent_type: "reviewer", ...})`)
- `Agent(subagent_type="security-reviewer", run_in_background=true, prompt="...")`
- Run `TaskCreate` against the test suite
```

**BLOCKED rationalizations:**

- "Most readers are on Claude Code, the syntax is fine"
- "The reader will understand it's just illustrative"
- "Codex / Gemini users can mentally translate"
- "The neutral phrasing loses the precision of the actual API call"
- "We'll add a translation table at the top of the file"
- "Workspace artifacts are session-local, the next session uses the same CLI"

**Why:** Workspace artifacts cross CLI boundaries every time a different CLI is opened against the same repo. A Codex session reading `Agent(subagent_type="reviewer")` cannot run that primitive — Codex translates delegation through `/prompts:reviewer` (or its native surface); Gemini through `@reviewer`. The neutral phrase ("delegate to reviewer") is the contract; the per-CLI syntax is the implementation. Encoding the implementation in workspace prose weakens the contract for every non-CC reader.

### 2. Tool Names Are Neutral In Prescriptive Prose

References to file-reading, file-writing, and shell-execution tools MUST use neutral phrasing — "read the file", "edit the file", "run the build" — NOT CC's tool nouns (`Read tool`, `Write tool`, `Edit tool`, `Bash tool`) presented as prescriptive verbs. Historical citations within a quoted journal entry that already names the CC session ("the CC session used the Read tool") are acceptable when qualified.

```markdown
# DO — neutral verb form

- Read the spec at `specs/_index.md` before action
- Run `pytest tests/integration/` and capture failures
- Edit the file to add the missing branch

# DO — historical citation, qualified

> 2026-05-01 (CC session): the agent invoked the Read tool against
> specs/auth.md before delegating.

# DO NOT — CC tool noun in prescriptive prose

- Use the Read tool on `specs/auth.md` before delegating
- Invoke the Bash tool to run `pytest`
- The Edit tool MUST be used to fix the typo
```

**BLOCKED rationalizations:**

- "The reader knows what 'Read tool' means"
- "Codex has the same Read tool concept"
- "It's just shorter than 'use the file-reading tool'"
- "All three CLIs have file-reading tools, the noun is generic"
- "The capitalization signals it's a tool name, not English prose"

**Why:** "Read tool" is a CC API surface name (`Read`), not English. Codex exposes `read-file` / `cat`-equivalent shell calls; Gemini exposes `read_file` and `@filesystem.read`. Treating CC's tool-name capitalization as cross-CLI prose ships a false-cognate that the agent on the other CLI must mentally rewrite every read. Neutral verb form ("read the file", "run the build") works on every CLI without translation.

### 3. CLI Baseline-File References Are Conceptual, Not Authoritative

Prescriptive references to baseline rule files MUST use conceptual phrasing — "the baseline rules", "the always-on rules", "per the project's COC discipline" — NOT specific CLI baseline filenames (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) cited as the authority. Each CLI emits its own baseline file from the same neutral source; citing one filename as "the authority" silently asserts that CLI's emission is canonical.

```markdown
# DO — conceptual baseline reference

- Per the project's baseline rules, every release MUST run /release through the gate
- The always-on rules require gold-standards-validator approval before merge
- Per the COC artifact-flow discipline (rules/artifact-flow.md), only loom syncs

# DO — historical citation, qualified

> The CC session at 2026-04-12 cited `CLAUDE.md` line 42 when blocking the merge.

# DO NOT — CLI baseline file as prescriptive authority

- Per CLAUDE.md, every release MUST run /release through the gate
- CLAUDE.md is the authority; AGENTS.md is the legacy stub
- The CLAUDE.md baseline rule blocks this approach
- Update CLAUDE.md binding table
```

**BLOCKED rationalizations:**

- "CLAUDE.md is the canonical filename across the loom ecosystem"
- "The reader will understand any baseline file reference"
- "AGENTS.md and GEMINI.md inherit from CLAUDE.md anyway"
- "Specifying the file is more precise than 'baseline rules'"
- "The other CLIs read CLAUDE.md too" (false — Codex reads AGENTS.md, Gemini reads GEMINI.md; loom emits all three from the same neutral source)

**Why:** loom emits per-CLI baselines (CC: `CLAUDE.md`, Codex: `AGENTS.md`, Gemini: `GEMINI.md`) from the same neutral rule sources. A workspace todo that says "per CLAUDE.md" privileges the CC emission as the canonical authority — false. The authority is the neutral rule; each baseline file is a per-CLI emission of it. Cite the rule (`rules/zero-tolerance.md`), the concept ("the baseline rules"), or the spec (`specs/auth.md` §3.1) — never the CLI-specific baseline filename as prescriptive.

### 4. Hook Event Names Are Neutral

References to hook lifecycle events MUST use neutral phrasing — "the session-start hook", "the pre-tool-use guard", "the user-prompt-submit injection" — NOT CC's PascalCase event names (`SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`) cited as the prescriptive event identifier. Historical citation of a specific CC hook event is acceptable when qualified.

```markdown
# DO — neutral hook event phrasing

- The session-start hook injects the active-workspace banner
- The pre-tool-use guard blocks edits on .claude/learning/posture.json
- A user-prompt-submit injection enforces the `[ack: <rule>]` receipt

# DO — historical citation, qualified

> The CC SessionStart hook at .claude/hooks/coc-drift-warn.js (2026-05-02 session)
> reported the drift banner.

# DO NOT — CC PascalCase event name as prescriptive identifier

- The SessionStart hook injects the banner
- A PreToolUse guard blocks the write
- Wire UserPromptSubmit to enforce the receipt
```

**BLOCKED rationalizations:**

- "PascalCase event names are the documented contract"
- "Codex and Gemini have equivalent events with different names"
- "The reader translates from PascalCase to whatever their CLI uses"
- "The events are language-of-art, not CLI-specific"
- "Anthropic documented these names; they're the standard"

**Why:** CC's hook event names (`SessionStart`, `PreToolUse`, etc.) are CC-specific identifiers. Codex and Gemini expose lifecycle hooks under different names and shapes (Codex: `pre-prompt`, `pre-tool`, `session-init`; Gemini: `@hooks.session_start`, `@hooks.tool_use`). Workspace prose that says "wire SessionStart" prescribes a CC primitive; on Codex / Gemini that string is meaningless. Neutral phrasing ("the session-start hook") names the lifecycle moment without assuming the implementation surface.

### 5. CLI Mentions Are Qualified When Historical, Prohibited When Prescriptive

Mentions of "Claude Code" / "Codex" / "Gemini" MUST be qualified historically ("the Claude Code session that authored this todo on 2026-05-01") and MUST NOT be prescriptive ("Claude Code is the runtime", "this MUST run under Claude Code"). Workspace artifacts are CLI-portable by design; a prescriptive CLI mention asserts the artifact is CLI-bound.

```markdown
# DO — historical qualification

- The Claude Code session that ran /implement on 2026-05-01 produced this todo.
- Codex session 2026-05-03 added the redteam findings in this file.
- Note: this journal entry was written under Gemini and uses @specialist syntax in
  the verbatim quotes below.

# DO — neutral prescriptive prose

- The /implement runtime dispatches reviewer in parallel
- The session under whatever CLI runs /redteam MUST file findings here

# DO NOT — prescriptive CLI binding

- Claude Code is the runtime for this workspace
- This todo MUST be executed under Claude Code
- Claude Code reads CLAUDE.md and respects the agent allowlist
- The Claude Code architect agent owns this review
```

**BLOCKED rationalizations:**

- "We're a CC shop; the prescriptive mention is accurate"
- "Codex / Gemini users will know to substitute their CLI"
- "Naming the runtime is more precise than 'the runtime'"
- "Claude Code is the most-used CLI, the default reference is fine"
- "Historical and prescriptive are the same intent"

**Why:** Workspace artifacts outlive the session that authored them. A todo that says "Claude Code is the runtime" tells the next session — possibly running on Codex or Gemini — that the todo's acceptance criteria assume CC primitives. The next session either ignores the criterion (silent skip) or rewrites it (silent drift). Historical mentions ("the CC session that wrote this") preserve provenance without binding the future. Prescriptive mentions bind the artifact to one CLI and break portability.

## Trust Posture Wiring

- **Severity:** `advisory` for all 5 MUST clauses. Lint reports leaks; user adjudicates rewrite vs qualify. Workspace artifacts are session records; advisory severity matches CARE Principle 7 graduated-trust posture for content that affects framing without affecting runtime directly.
- **Grace period:** 14 days. Existing artifacts in `kailash-py/workspaces/` and `kailash-rs/workspaces/` carry pre-rule leakage; lint surfaces them as advisory until swept.
- **Regression-within-grace:** any new artifact authored after rule-land that introduces a flagged pattern triggers `regression_within_grace` per `trust-posture.md` MUST Rule 4. New leaks are loud; old leaks are advisory.
- **Receipt requirement:** none — rule is path-scoped to artifact paths and surfaces via `tools/lint-workspaces.js` + `/cli-audit` Phase 4.
- **Detection mechanism:** `node tools/lint-workspaces.js workspaces/` enumerates artifacts and greps for the BLOCKED patterns from MUST clauses 1–5. `/cli-audit` Phase 4 invokes the same lint. Fixtures at `.claude/audit-fixtures/cross-cli-artifact-hygiene/` exercise every flag + every clean-pass case.

## MUST NOT

- Bake any CC-native delegation syntax (`Agent(...)`, `Task(...)`, `subagent_type=`, `run_in_background=`, `isolation:`) into a prescriptive workspace artifact line

**Why:** Codex and Gemini cannot parse those identifiers; the line silently fails as acceptance criterion on those CLIs.

- Cite a CLI baseline filename (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) as prescriptive authority in workspace prose

**Why:** Each CLI emits its own baseline file from the same neutral source; privileging one filename asserts that CLI's emission is canonical and breaks portability.

- Mark workspace artifacts as CLI-bound ("this MUST run under Claude Code") absent explicit user instruction that they ARE CLI-bound

**Why:** The default contract for workspace artifacts is CLI-portable; CLI-bound is the exception and requires a written exception declaration in the artifact's frontmatter.
