# Specialist Delegation Syntax — Worked Examples

Procedural depth for the numbered examples referenced by the MUST clauses in `.claude/rules/agents.md`. The load-bearing MUST clauses (parallel brief-claim verification, background reviewer dispatch, mechanical-sweep prompts, closure-parity specialist tool-inventory) live in the rule; this sub-file carries the worked CLI-specific delegation-syntax examples those clauses reference by number.

## Why this lives in a skill (not the rule)

The MUST clauses are load-bearing baseline content that emit to every CLI's always-on rule surface. The worked syntax examples are reference material the agent needs when it is ABOUT to delegate — not on every session start. Per `cc-artifacts.md` MUST NOT "No knowledge dumps … extract reference to skills" + `rule-authoring.md` Rule 10 (paired extraction), the examples moved here to keep the always-on baseline within the per-CLI headroom floor (v6.2 Risk-0004); the load-bearing tripwire stays in the rule. The examples below show the Claude Code `Agent(subagent_type=…)` delegation primitive. **Codex** maps each to inline-cat injection via `bin/coc <phase> "$(cat .codex/prompts/specialist-<name>.md)\n\nTask: …"` (see codex-templates); **Gemini** maps each to `@specialist` invocation (see gemini-templates). The MUST clauses are the CLI-neutral contract; the syntax below is the CC implementation.

## Example 1 — Parallel Brief-Claim Verification (≥3-issue brief)

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

## Example 2 — Background Reviewer Dispatch (Quality Gates)

```
# Background agent pattern for MUST gates — review costs near-zero parent context
Agent({subagent_type: "reviewer", run_in_background: true, prompt: "Review all changes since last gate..."})
Agent({subagent_type: "security-reviewer", run_in_background: true, prompt: "Security audit all changes..."})
```

## Example 3 — Mechanical Sweep in Reviewer Prompt

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

## Example 4 — Closure-Parity Specialist Dispatch (Bash+Read required)

```python
# DO — pact-specialist or general-purpose for Round-2+ closure-parity verification
Agent(subagent_type="pact-specialist", prompt="""
Verify W5→W6 closure parity. Run gh pr view, gh pr diff, grep, pytest --collect-only,
ast.parse() for __all__ enumeration. Convert FORWARDED rows to VERIFIED with command output.""")

# DO NOT — analyst (Read/Grep/Glob only) — cannot run gh / pytest / ast.parse()
Agent(subagent_type="analyst", prompt="Verify W5→W6 closure parity...")
```

## Example 5 — Delegation-Time Closure-Parity Scan

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
