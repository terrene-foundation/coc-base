---
description: "Certify a new dev/consultant on this repo's critical knowledge before they claim work. Three-phase Brief → Probe → Gate at 100%."
---

Certify the operator's knowledge of THIS repo's critical paths before they may claim work. Three phases — **Brief → Probe → Gate** — gated at 100% on the probe. The operator answers the gate phase SOLO (no Claude assistance); the orchestrator only walks the brief and judges answers.

**Usage**: `/certify` (no args; runs in current repo) — uses the per-repo question bank at `specs/_certification.yaml`.

**Pairs with `/onboard`**: `/onboard` is the deterministic read-path (who am I + what's the team state, read-only, ~5 min). `/certify` is the knowledge-gate (what does the new operator KNOW about the critical surface, ~30–60 min, write-receipts at brief + journal entry at pass). Run `/onboard` first; then `/certify` before the operator claims any non-trivial work.

## Process

`/certify` is a structured walk-then-test. The procedure detail (brief read-order, probe presentation, gate retry loop, YAML schema) lives in the skill `.claude/skills/42-certify/SKILL.md`; this command is the entry point.

### 1. Identify the operator + confirm prerequisites

Resolve identity structurally — NOT by prose-claim. The orchestrator MUST run the following Bash invocation and parse the JSON, refusing to proceed on any non-rostered shape:

```bash
node -e 'const r = require("./.claude/hooks/lib/operator-id.js").resolveIdentity(process.cwd()); process.stdout.write(JSON.stringify(r));'
```

Treat as STOP (do NOT fall through to Phase A) when the parsed JSON has ANY of: `verified_id == null`, `person_id == null`, `posture == "L2_SUPERVISED"` AND no roster row, OR a non-zero exit code from the node invocation. On STOP, surface to the operator: "Identity check failed: you are not rostered (`/whoami --register` first) — `/certify` needs a roster row to record the pass against." Do NOT proceed prose-only; the structural Bash check IS the gate.

After identity passes, validate the bank file structurally:

```bash
node .claude/bin/validate-cert-bank.mjs specs/_certification.yaml
```

Treat as STOP on non-zero exit (any CRIT/HIGH finding). The validator covers: bank existence + YAML validity, schema shape (version, sections, per-question id/kind/expected), citation-path allowlist (`{specs,rules,.claude}/**` only — no `..` traversal, no absolute paths), length caps on prompt/options/rubric/expected, prompt-injection signal scan, and secret-shaped-token rejection. A bank that fails any check is institutionally untrusted; do NOT proceed to brief.

Then read the operator's required consent (the bank's `version` + `bank_version` + record-of-pass-tied-to-verified_id implications):

```
Surface to operator (Step 1.c consent gate):
  "/certify will record a per-question pass/fail tally tied to your
   verified_id in a committed journal entry. The bank version is
   <bank_version>. Proceed? (y/N)"
```

STOP unless the operator answers `y` — explicit per-operator consent is required before institutional knowledge about the operator's competency lands in the audit trail.

All three STOP conditions are structural (exit code + file existence + explicit user input), not LLM-judgment. A future session that ignores this command's prose still fails the gate because the structural checks return failure on the wire.

### 2. Phase A — Brief (read receipts)

Walk the operator through the critical-knowledge surface in fixed order: `specs/_index.md` (if present) → repo `CLAUDE.md` → CO-category rules (`rules/autonomous-execution.md`, `rules/agent-reasoning.md`, `rules/artifact-flow.md`) → `/posture show` (trust posture state) → `.claude/team-memory/` index → last 5 `journal/DECISION-*.md` entries. For each section, summarize in plain language and write a "read receipt" to `workspaces/_certify/journal/.pending/certify-brief-<display_id>-<date>.md`. Receipts are scrubbed per `rules/user-flow-validation.md` MUST-6 before write (no secrets, no downstream client tokens).

### 3. Phase B — Probe (one question at a time)

Load the question bank from `specs/_certification.yaml`. Present questions in declared order (easy → hard per the bank's intent). For each question, present the prompt + the cited spec section, then wait for the operator's answer. Multiple-choice: compare to `expected`. Short-answer: the orchestrator LLM judges against `expected` + the `grading_rubric:` lines, returning pass/fail with a one-sentence rationale.

**Probe-phase no-assist is STRUCTURALLY ENFORCED via lockfile + PreToolUse hook.** The orchestrator MUST create the lockfile at probe entry and MUST delete it at probe exit:

```bash
# Probe entry (Phase B start):
touch ".claude/.certify-in-probe-${VERIFIED_ID}.lock"

# Probe exit (Phase C complete OR abandoned mid-gate):
rm -f ".claude/.certify-in-probe-${VERIFIED_ID}.lock"
```

While the lockfile exists, `.claude/hooks/probe-phase-guard.js` (PreToolUse on Read/Grep/Glob/WebFetch) BLOCKS every orchestrator retrieval call with severity:block. This is structural, not prose — the hook fires whether the LLM "remembers" the no-assist rule or not. If the operator asks "can you explain that section again?" or "what's the answer?", the orchestrator MUST refuse with one sentence: "I cannot assist during the gate phase; re-read the cited section and answer when ready." Attempting Read/Grep/Glob/WebFetch will be hard-blocked by the hook.

If the orchestrator crashes mid-probe, the operator MUST manually remove the stale lockfile (`rm .claude/.certify-in-probe-*.lock`) before re-running `/certify`.

### 4. Phase C — Gate (100% required)

After the full pass, tally pass/fail per question. If 100% → record pass (Step 5). If <100% → list every failed question with "re-read §X" pointing at the cited spec section, allow the operator to re-read, then retry ONLY the failed questions. Loop until 100%. Each retry attempt is recorded with `attempts:` in the final journal entry.

### 5. Emit pass receipt + roster registration nudge

On pass: write a `journal/NNNN-DECISION-certify-<display_id>-<date>.md` entry naming the operator's `display_id` + `verified_id`, the bank version (`specs/_certification.yaml::version`), the per-question pass/fail/attempts tally, and the timestamp. Surface to the operator: "Certification passed. Next: `/whoami --register` (if not already rostered) → `/claim <path>` to start work." Until pass, the operator remains `L2_SUPERVISED` via the existing trust-posture machinery (no command-side change — `posture.json` already enforces L2 for unrostered operators per `rules/multi-operator-coordination.md` §1).

### Failure modes (typed errors — no silent fallbacks per `rules/zero-tolerance.md` Rule 3)

- Unregistered operator → STOP, instruct `/whoami --register`.
- Missing `specs/_certification.yaml` → STOP with seed-template instruction.
- Operator abandons mid-gate → write a `journal/NNNN-DEFER-certify-<display_id>-incomplete.md` with attempts-so-far; operator stays `L2_SUPERVISED`; re-running `/certify` resumes from question 1 (NOT mid-gate — the gate is full-bank).
- Bank schema invalid (missing `expected:`, missing `grading_rubric:` on short-answer) → STOP, surface the offending question id + instruction to fix the bank.

## Output format

Default markdown narrative. The brief phase writes per-section read receipts to `workspaces/_certify/journal/.pending/`. The probe + gate run inline in the session. The final pass writes a committed `journal/NNNN-DECISION-certify-<display_id>-<date>.md` entry per `rules/journal.md`.

## Next steps after certify

```
Next: /whoami --register (if not already rostered) → /onboard (re-read team state)
      → /claim <path> (when starting your first piece of work)
```

## Notes

- This command is a state-write command (writes brief receipts + a committed pass journal entry). It does NOT modify roster, posture, lease, or the coordination log — pass status is captured in the journal entry; subsequent commands (`/whoami --register`, `/claim`, `/codify`) handle roster and lease writes.
- Procedure detail (failure-mode handling, YAML schema, LLM-judge prompt shape, retry-loop discipline) lives in `.claude/skills/42-certify/SKILL.md`. Update the skill, not this command, when the procedure changes.
- The question bank itself (`specs/_certification.yaml`) lives in the CONSUMER repo, NOT loom. Loom ships a starter template at `.claude/templates/specs/_certification.yaml`; each downstream repo copies it once into `specs/` and curates its own questions citing its own critical spec sections.
- Curated bank, NOT LLM-generated: a 100% gate against hallucinated questions is unfair. Maintenance cost (spec edits flag stale citations) is the price of fairness.

## Origin

2026-05-25 co-owner-directed COC tooling (per `rules/artifact-flow.md` § Co-Owner-Directed Origination). Receipt: `journal/0158-DECISION-certify-onboarding-mechanism-2026-05-25.md`. Command body ≤150 lines per `rules/cc-artifacts.md` Rule 3; procedure detail in `skills/42-certify/SKILL.md`.
