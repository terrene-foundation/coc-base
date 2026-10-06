---
priority: 10
scope: path-scoped
paths:
  - "workspaces/**/*.md"
  - "briefs/**/*.md"
---

# Cross-CLI Artifact Hygiene

Depth companion — cited below as **the extract** — is `.claude/guides/rule-extracts/cross-cli-artifact-hygiene.md`: per-CLI translation mechanics, the correct-citation example, the measured Wiring narratives, layer positioning, and Origin.

Project artifacts (workspace plans, journals, briefs, todos, redteam reports) are read by every CLI a session may run under — Claude Code, Codex, Gemini. When an artifact authored under one CLI bakes that CLI's native delegation syntax (`Agent(subagent_type=...)`), tool names (`Read tool`, `Bash tool`), hook event names (`SessionStart`), or baseline-file references (`CLAUDE.md` as authority) into prescriptive prose, the next reader running a different CLI silently misreads the acceptance criteria. Layer positioning between `rules/cross-cli-parity.md` (rule layer) and `rules/upstream-issue-hygiene.md` (public-issue layer): the extract § Layer Positioning.

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

**Why:** Workspace artifacts cross CLI boundaries every time a different CLI is opened against the same repo. A Codex session reading `Agent(subagent_type="reviewer")` cannot run that primitive. The neutral phrase ("delegate to reviewer") is the contract; the per-CLI syntax is the implementation. Encoding the implementation in workspace prose weakens the contract for every non-CC reader. Per-CLI translation mechanics: the extract § MUST-1.

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

**Why:** "Read tool" is a CC API surface name (`Read`), not English. Treating CC's tool-name capitalization as cross-CLI prose ships a false-cognate that the agent on the other CLI must mentally rewrite every read. Neutral verb form ("read the file", "run the build") works on every CLI without translation. Per-CLI file-tool surface names: the extract § MUST-2.

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

**Why:** loom emits per-CLI baselines (CC: `CLAUDE.md`, Codex: `AGENTS.md`, Gemini: `GEMINI.md`) from the same neutral rule sources. A workspace todo that says "per CLAUDE.md" privileges the CC emission as the canonical authority — false. The authority is the neutral rule; each baseline file is a per-CLI emission of it. The three correct citation forms: the extract § MUST-3.

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

**Why:** Lifecycle event names and payload contracts are runtime-specific: current Codex shares names such as `SessionStart` and `PreToolUse` with CC, while Gemini uses a different taxonomy. A shared spelling alone does not establish equivalent behavior. Neutral phrasing ("the session-start hook") names the lifecycle moment without assuming the implementation surface. Per-CLI event-name inventory: the extract § MUST-4.

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

- **Severity:** `advisory` for all 5 MUST clauses. Lint reports leaks; user adjudicates rewrite vs qualify. Rationale: the extract § "Severity — Why Advisory".
- **Grace period:** 14 days. Pre-rule leakage backlog: the extract § "Grace Period — The Pre-Rule Leakage Backlog".
- **Regression-within-grace:** any new artifact authored after rule-land that introduces a flagged pattern triggers `regression_within_grace` per `trust-posture.md` MUST Rule 4. New leaks are loud; old leaks are advisory.
- **Receipt requirement:** none — rule is path-scoped to artifact paths and surfaces via the lint named below.
- **Detection mechanism:** **NO HOOK LAYER — this rule claims none; the lint is operator-invoked, never event-dispatched.** AT LOOM: `node tools/lint-workspaces.js workspaces/ briefs/` enumerates artifacts and greps for the BLOCKED patterns from MUST clauses 1–5 (exit 1 = findings, advisory); `/cli-audit` Phase 4 invokes the same lint. **A clean exit is only evidence if files were actually enumerated** — a nonexistent or mistyped target path also prints `0 findings` and exits 0 (`instrument-discipline.md` MUST-1). Fixtures `.claude/audit-fixtures/cross-cli-artifact-hygiene/` cover only SOME pattern labels — a green run is evidence about those ONLY (measured split: the extract § "Detection Mechanism — Fixture-Coverage Measurement"). **AT A CONSUMER: NEITHER SURFACE EXISTS** — gate-review is the ONLY coverage there (the extract § "Detection Mechanism — Consumer-Side Coverage Asymmetry"). Do not read the loom-side lint as consumer-side enforcement; closing that asymmetry needs a distribution decision per `knowledge-cascade-routing.md` MUST-2, not a wording change here. **Probes: REGISTERED — `.claude/test-harness/probes/cross-cli-artifact-hygiene.probes.json`**, 14 rows in 7 bipolar `pair_id` pairs: one firing pair per derived clause (MUST-1..MUST-5 plus the `## MUST NOT` section read as a SET) and a surface-equalized meta-compliance pair, with candidate fixtures + `.expected` answer-key sidecars at `.claude/audit-fixtures/cross-cli-artifact-hygiene/`. Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, and declared in `clause-coverage-baseline.json` with ZERO deferred clauses; the `probe_authorship_deferrals` row that named this authorship as its own graduation condition is DELETED in the same change. The probe CANDIDATES are session TRANSCRIPTS in which an agent authors the workspace artifact and quotes its body inside its own tool call — NOT the five `.md` snapshots in that same directory, which are LINT fixtures for `tools/lint-workspaces.js` whose `.expected` sidecars are lint-output expectations and whose H1 lines announce their own verdict. The MUST-5 and `## MUST NOT` pairs are the load-bearing ones for the asymmetry named above: the lint carries NO pattern for a prescriptive CLI mention or a self-authorized CLI-bound marking, so BOTH poles of each print `0 findings` and exit 0, and only a judge separates them. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives the suite; at those targets this SEMANTIC tier is not a live gate either, which compounds rather than closes the consumer-side asymmetry above.

## MUST NOT

- Bake any CC-native delegation syntax (`Agent(...)`, `Task(...)`, `subagent_type=`, `run_in_background=`, `isolation:`) into a prescriptive workspace artifact line

**Why:** Codex and Gemini cannot parse those identifiers; the line silently fails as acceptance criterion on those CLIs.

- Cite a CLI baseline filename (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) as prescriptive authority in workspace prose

**Why:** Each CLI emits its own baseline file from the same neutral source; privileging one filename asserts that CLI's emission is canonical and breaks portability.

- Mark workspace artifacts as CLI-bound ("this MUST run under Claude Code") absent explicit user instruction that they ARE CLI-bound

**Why:** The default contract for workspace artifacts is CLI-portable; CLI-bound is the exception and requires a written exception declaration in the artifact's frontmatter.

Origin: 2026-05-06 — a `workspaces/**/*.md` audit across two BUILD repos surfaced widespread CC-native leakage in todos, journals and redteam reports. Full narrative: the extract § Origin.

**Extraction record** (ZERO de-scoping — every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and every `**Why:**` failure-mode statement stayed here verbatim; the Wiring block kept all five field labels it carries, each with its normative statement, and no label was added to the grandfathered block): 2026-08-19 structural cleanup — layer positioning, the per-CLI runnable detail from the MUST-1/2/4 `**Why:**` tails, MUST-3's citation example, the Severity/Grace/Detection measured narratives, and the Origin narrative moved verbatim to `.claude/guides/rule-extracts/cross-cli-artifact-hygiene.md` (per-topic §§ named at each pointer). `rule-authoring.md` Rule 10 / Rule 11 do NOT fire — Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is `scope: path-scoped`, so this is STRUCTURAL CLEANUP, not a Rule-10 paired extraction and therefore not Rule-11 recurrence input (the `journal/0148` disposition).
