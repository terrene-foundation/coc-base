---
id: "TEST-HARNESS-PROBE"
applies_to: ["claude-code"]
description: Score `needs_probe` rows from the most recent test-harness suite run via parallel subagent dispatch (per rules/probe-driven-verification.md MUST-1).
---

# /test-harness-probe

Loom-only. Two INPUT SHAPES, one scoring contract. Pick the mode by what
you are scoring:

| Mode | Input | Rows | Use when |
|------|-------|------|----------|
| **A — suite results** (default) | `.claude/test-harness/results/{compliance,safety}-*.jsonl` | `state === "needs_probe"` | scoring a CLI response captured by `run-all.sh` |
| **B — artifact-eval suites** (`--artifacts`) | the suites registered in `.claude/test-harness/eval-manifest.json` | every row of every registered `*.probes.json` | scoring whether a RULE fires / an ARTIFACT is meta-compliant |

Mode B is the SEMANTIC tier (Contract C3). Before loom#1465 it had no
adapter and was reproducible only BY HAND; `.claude/bin/coc-probe-dispatch.mjs`
is that adapter.

## Mode A — suite results

Reads the latest probe-bearing suite result file (compliance or safety;
capability has no probes) — or one specified as `$1` — under
`.claude/test-harness/results/`, finds rows where
`state === "needs_probe"`, dispatches one subagent per probe criterion
in parallel, validates each subagent's structured JSON answer against
the schema declared on the criterion, and writes
`<input-basename>.probes.jsonl` next to the input file.

## Mode B — artifact-eval suites (`/test-harness-probe --artifacts [<artifact_id>...]`)

```bash
# 1. PLAN — one fully-rendered judge prompt per registered probe row.
node .claude/bin/coc-probe-dispatch.mjs plan --out /tmp/plan.json
# 2. DISPATCH — one subagent per plan.dispatch[] entry, ALL IN ONE MESSAGE.
#    Each subagent's prompt is that entry's `prompt` verbatim; pin the model
#    to the entry's `judge_model`. Collect raw answer text per `row_id`.
# 3. SCORE — validate shape, apply the schema's scoringRule, report by PAIR.
node .claude/bin/coc-probe-dispatch.mjs score --plan /tmp/plan.json \
  --answers /tmp/answers.json --out /tmp/results.json
```

`answers.json` is
`[{"row_id": "<id>", "answer_text": "<raw>", "judge_model": "<model that answered>"}]`,
or `{"row_id": "<id>", "error": "<why>"}` for a dispatch that failed.
`judge_model` MUST be the model you actually dispatched to and MUST equal
the plan row's pin — a missing or mismatched attestation scores `error`,
never a pass. Both poles of a pair render an identical prompt except for
the candidate text; the schema's real name and its polarity never reach a
judge.

**Report BOTH axes separately.** The scorer prints efficacy-axis and
meta-axis pair separation as distinct lines. Collapsing them into one
headline number is the reporting error loom#1465 exists to correct — a
suite can be 3/3 on efficacy and 1/3 on meta, and "6/6 rows passed" hides
that a pair failed to separate at all.

**Cite `coverage_asserted`, never the exit code alone** (per
`rules/coc-artifact-eval-coverage.md` MUST-3): an UNRUN or ERRORED row is
ZERO evidence, and a plan of zero rows would exit 0 having verified nothing.

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
that skill and follow its `## Protocol` section verbatim (Mode A) or
its `## Protocol — Mode B` section (artifact-eval suites).

When the user invokes this command with `--artifacts`, follow Mode B
above and the skill's `## Protocol — Mode B`. Otherwise (Mode A):

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
