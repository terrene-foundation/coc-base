---
id: "TEST-HARNESS-PROBE"
applies_to: ["claude-code"]
description: Score `needs_probe` rows from the most recent test-harness suite run via parallel subagent dispatch (per rules/probe-driven-verification.md MUST-1).
---

# /test-harness-probe

Loom-only. Reads the latest probe-bearing suite result file (compliance
or safety; capability has no probes) — or one specified as `$1` — under
`.claude/test-harness/results/`, finds rows where
`state === "needs_probe"`, dispatches one subagent per probe criterion
in parallel, validates each subagent's structured JSON answer against
the schema declared on the criterion, and writes
`<input-basename>.probes.jsonl` next to the input file.

The harness's regex layer (`run-all.sh` → `suites/*.mjs`) deliberately
does NOT score probe criteria — `kind: "probe"` rows are emitted with
`state: "needs_probe"` so the slash command can reach them. Per
`rules/probe-driven-verification.md` MUST-1 regex-on-semantic is
BLOCKED, so the orchestrator MUST NOT fall back to regex-scoring the
candidate text if subagent dispatch fails. Schema-validation failure
IS the verdict.

## Procedure

The full runbook — target-file resolution, `needs_probe` row
extraction, schema-rubric lookup, parallel subagent dispatch shape,
JSON-answer schema validation, companion-file format, and the summary
table — lives in `.claude/skills/test-harness-probe/SKILL.md`. Load
that skill and follow its `## Protocol` section verbatim.

When the user invokes this command:

1. Resolve the target results file. If `$1` is supplied, resolve it
   (absolute path as-is, else basename under
   `.claude/test-harness/results/`); if empty, select the most recent
   probe-bearing result:

   ```bash
   ls -t .claude/test-harness/results/{compliance,safety}-*.jsonl 2>/dev/null \
     | grep -v '\.probes\.jsonl$' \
     | head -1
   ```

   No match → halt: "no probe-bearing suite results to score — run
   `./run-all.sh` first."

2. Follow the skill's Protocol steps 2–7 (extract → resolve schemas →
   parallel dispatch → validate → write companion → print summary).

## Non-negotiable guardrails (full list in the skill's `## Rules`)

- DO NOT regex-score candidate text if dispatch fails — verdict is
  "skipped: probe-unavailable" per `rules/probe-driven-verification.md`
  MUST-3, NEVER a regex proxy.
- DO NOT retry silently on schema-validation failure — the failure IS
  the verdict.
- DO NOT modify the input results file — the `.probes.jsonl` companion
  is the audit trail; the original JSONL stays immutable.
- DO dispatch all subagents in a SINGLE message with multiple Agent
  tool calls — sequential dispatch wastes the parallel multiplier per
  `rules/agents.md` § Parallel Execution.
- DO NOT widen scope beyond the probed rows — `state: "fail"` /
  `state: "pass"` rows were scored by the regex layer; that verdict is
  final for this run.
