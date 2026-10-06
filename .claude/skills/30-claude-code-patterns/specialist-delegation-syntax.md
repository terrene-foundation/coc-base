# Specialist Delegation Syntax — Worked Examples

Procedural depth for the numbered examples referenced by the MUST clauses in `.claude/rules/agents.md`. The load-bearing MUST clauses (parallel brief-claim verification, background reviewer dispatch, mechanical-sweep prompts, closure-parity specialist tool-inventory) live in the rule; this sub-file carries the worked CLI-specific delegation-syntax examples those clauses reference by number.

## Why this lives in a skill (not the rule)

The MUST clauses are load-bearing baseline content that emit to every CLI's always-on rule surface. The worked syntax examples are reference material the agent needs when it is ABOUT to delegate — not on every session start. Per `cc-artifacts.md` MUST NOT "No knowledge dumps … extract reference to skills" + `rule-authoring.md` Rule 10 (paired extraction), the examples moved here to keep the always-on baseline within the per-CLI headroom floor (v6.2 Risk-0004); the load-bearing tripwire stays in the rule. The examples below are given per CLI: the Claude Code `Agent(subagent_type=…)` primitive first, then the Codex and Gemini equivalents. **Codex** selects the exact native agent name from `.codex/agents/<name>.toml`; compatibility operating-spec text remains under `.codex/prompts/` for explicit fallback. **Gemini** maps each to `@specialist` invocation (see gemini-templates). The MUST clauses are the CLI-neutral contract; the syntax below is the CC implementation.

## CC delegation syntax (`Agent(subagent_type=…)`)

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```python
# DO — parallel deep-dive verification for ≥3-issue brief
# (one agent per claim cluster, run concurrently)
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.""")
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.""")
Agent(subagent_type="general-purpose", run_in_background=True, prompt="""
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.""")
# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
Agent(subagent_type="analyst", prompt="Analyze the brief and produce architecture plan.")
# (the analyst inherits whatever framing the brief asserts; brief inaccuracies
# propagate into the plan, the plan into /todos, and three sessions later
# the workstream is solving the wrong problem.)
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates — review costs near-zero parent context
Agent({subagent_type: "reviewer", run_in_background: true, prompt: "Review all changes since last gate..."})
Agent({subagent_type: "security-reviewer", run_in_background: true, prompt: "Security audit all changes..."})
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```python
# DO — reviewer prompt enumerates mechanical sweeps
Agent(subagent_type="reviewer", prompt="""
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep (`grep -c`) on critical call-site patterns
2. `pytest --collect-only -q` exit 0 across all test dirs
3. Every public symbol in __all__ added by this PR has an eager import
""")

# DO NOT — reviewer prompt only includes diff context
Agent(subagent_type="reviewer", prompt="Review the diff between main and feat/X.")
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```python
# DO — pact-specialist or general-purpose for Round-2+ closure-parity verification
Agent(subagent_type="pact-specialist", prompt="""
Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep, pytest --collect-only,
ast.parse() for __all__ enumeration. Convert FORWARDED rows to VERIFIED with command output.""")

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
Agent(subagent_type="analyst", prompt="Verify W5→W6 closure parity...")
```

### Example 5 — Delegation-Time Closure-Parity Scan

```python
# DO — orchestrator detects closure-parity markers in draft prompt, picks Bash+Read specialist
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
Agent(subagent_type="pact-specialist", prompt=draft_prompt)

# DO NOT — orchestrator drafts a closure-parity prompt and delegates to read-only analyst
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
Agent(subagent_type="analyst", prompt=draft_prompt)
# (analyst lacks Bash; will FORWARD the gh-pr-view rows; round burned)
```

## Codex delegation syntax (native named agents)

Current as of 2026-09-28: select the emitted exact name, such as `analyst`,
`reviewer`, `security-reviewer` or `pact-specialist`. Do not use compatibility
filenames such as `specialist-pact` as native role names. Named agents work in
interactive and headless sessions when project trust permits registration.
Models and reasoning effort inherit from the parent unless explicitly configured;
the emitter does not translate Claude model aliases. Positively read-only source
inventories emit `sandbox_mode = "read-only"`; other agents inherit the parent
sandbox. The source `tools:` inventory describes operating authority, not a native
Codex per-tool allowlist. Choose a role whose source inventory permits the task.

Include relevant spec content inline with each task. Establish an isolated worktree
before delegating edits or builds; naming a native agent does not create one.

If a native definition is unavailable, report that boundary and explicitly supply
its compatibility specification to an available general worker, preserving the
same scope and restrictions. A headless caller can instead inject the specification
into `bin/coc <supported-phase> "..."`; that starts a separate run, not a native
specialist spawn. Example: `pact-specialist` maps to the compatibility file
`.codex/prompts/specialist-pact.md`. Use `bin/coc --list-phases` to select a supported
phase. Neither fallback bypasses project trust or creates approval authority.

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```
# DO — spawn 3 parallel native analyst agents, one per claim cluster
# Include relevant spec content with each task.
Delegate to the native agent named analyst.
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.

Delegate to a second native analyst agent (in parallel).
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.

Delegate to a third native analyst agent (in parallel).
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.

# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
Ask one analyst to verify every claim serially.
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates
Delegate to the native agent named reviewer.
Task: Review all changes since last gate...

Delegate to the native agent named security-reviewer (in parallel).
Task: Security audit all changes...
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```
# DO — reviewer prompt enumerates mechanical sweeps
Delegate to the native agent named reviewer.
Task:
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep (`grep -c`) on critical call-site patterns
2. `pytest --collect-only -q` exit 0 across all test dirs
3. Every public symbol in __all__ added by this PR has an eager import

# DO NOT — reviewer prompt only includes diff context
Delegate to the native agent named reviewer.
Task: Review the diff between main and feat/X.
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```
# DO — pact specialist (or general-purpose) for Round-2+ closure-parity verification
Delegate to the native agent named pact-specialist.
Task: Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep,
pytest --collect-only, ast.parse() for __all__ enumeration. Convert
FORWARDED rows to VERIFIED with command output.

# DO NOT — select analyst for Bash-required work outside its source inventory
Delegate to the native agent named analyst.
Task: Verify W5→W6 closure parity...
```

### Example 5 — Delegation-Time Closure-Parity Scan

```
# DO — orchestrator detects closure-parity markers in draft task, picks Bash+Read specialist
draft_task = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
Delegate to the native agent named pact-specialist.
Task: <draft_task>

# DO NOT — orchestrator drafts a closure-parity task and delegates to read-only analyst
Delegate to the native agent named analyst.
Task: <draft_task>
# (the analyst source inventory does not authorize the required Bash work)
```

## Gemini delegation syntax (`@<agent-name>`)

### Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

```
# DO — parallel deep-dive verification for ≥3-issue brief
# (one agent per claim cluster, run concurrently)
@general-purpose background: true
prompt: |
  Verify brief claim #1: 'ExperimentTracker creates _kml_model_versions'.
  Re-grep the source tree; cite file:line. Report TRUE / FALSE / UNCLEAR.

@general-purpose background: true
prompt: |
  Verify brief claim #2: 'InferenceServer at engines/inference_server.py'.
  Re-grep + re-read the cited path. Report TRUE / FALSE / UNCLEAR.

@general-purpose background: true
prompt: |
  Verify brief claim #3: '1.1.x kwargs silently dropped in 1.5.x'.
  Re-read the 1.5.x signature; check raise vs silent-drop. Report.

# Wait for all three; reconcile findings; record corrections in journal +
# architecture plan BEFORE /todos.

# DO NOT — single-agent analysis on a ≥3-issue brief
@analyst
prompt: "Analyze the brief and produce architecture plan."
# (the analyst inherits whatever framing the brief asserts; brief inaccuracies
# propagate into the plan, the plan into /todos, and three sessions later
# the workstream is solving the wrong problem.)
```

### Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates — review costs near-zero parent context
@reviewer background: true
prompt: "Review all changes since last gate..."

@security-reviewer background: true
prompt: "Security audit all changes..."
```

### Example 3 — Mechanical Sweep in Reviewer Prompt

```
# DO — reviewer prompt enumerates mechanical sweeps
@reviewer
prompt: |
  Mechanical sweeps (run BEFORE LLM judgment):
  1. Parity grep (`grep -c`) on critical call-site patterns
  2. `pytest --collect-only -q` exit 0 across all test dirs
  3. Every public symbol in __all__ added by this PR has an eager import

# DO NOT — reviewer prompt only includes diff context
@reviewer
prompt: "Review the diff between main and feat/X."
```

### Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```
# DO — pact-specialist or general-purpose for Round-2+ closure-parity verification
@pact-specialist
prompt: |
  Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep, pytest --collect-only,
  ast.parse() for __all__ enumeration. Convert FORWARDED rows to VERIFIED with command output.

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
@analyst
prompt: "Verify W5→W6 closure parity..."
```

### Example 5 — Delegation-Time Closure-Parity Scan

```
# DO — orchestrator detects closure-parity markers in draft prompt, picks Bash+Read specialist
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
# scan: contains "closure parity" + "gh pr view" + "ast.parse(" → MUST use Bash+Read
@pact-specialist
prompt: draft_prompt

# DO NOT — orchestrator drafts a closure-parity prompt and delegates to read-only analyst
draft_prompt = "Verify W5→W6 closure parity. Run gh pr view, ast.parse() for __all__..."
@analyst
prompt: draft_prompt
# (analyst lacks Bash; will FORWARD the gh-pr-view rows; round burned)
```
