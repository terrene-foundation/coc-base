---
name: certify
description: "/certify procedure: brief → probe → gate at 100%; loops failed questions until pass. NO Claude-assistance during gate phase. Curated bank, not LLM-generated."
---

# /certify — knowledge gate for new devs/consultants

This skill is the procedural detail for the `/certify` command (`.claude/commands/certify.md`). The command is the entry point; this skill is the runbook the orchestrator follows. Three phases — **Brief → Probe → Gate**, gated at 100%.

## When to use

- A new dev or consultant joins the repo and is about to claim their first piece of non-trivial work.
- An existing operator returns after a long absence (>30 days) and the question bank or critical-rule corpus has materially changed since their last certification.
- A repo owner wants to re-certify the whole team after a major architectural shift recorded in `specs/`.

`/certify` does NOT replace `/onboard` — `/onboard` answers "what's the current team state" (read-only, ~5 min). `/certify` answers "does this person KNOW the critical surface well enough to claim work" (write-receipts + journal pass, ~30–60 min). Run `/onboard` first; then `/certify`.

## Read-only vs state-write contract

`/certify` writes state, but a narrow set:

| Surface                                      | Phase                    | Write?                                                                          |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `workspaces/_certify/journal/.pending/*`     | Brief                    | Yes — per-section read receipts (scrubbed per `user-flow-validation.md` MUST-6) |
| In-session probe state                       | Probe                    | No persisted file; tally lives in orchestrator context                          |
| `journal/NNNN-DECISION-certify-*.md`         | Pass (gate met)          | Yes — committed pass receipt                                                    |
| `journal/NNNN-DEFER-certify-*-incomplete.md` | Abandon mid-gate         | Yes — deferral receipt; operator stays L2_SUPERVISED                            |
| `posture.json`                               | (n/a — no posture write) | No — trust-posture machinery already enforces L2 for unrostered operators       |
| `operators.roster.json`                      | (n/a — no roster write)  | No — pass nudges operator to `/whoami --register`                               |

Pass is captured in the journal entry, NOT in a roster row. The roster row is the separate operator-registration step; certification is the prerequisite recorded in `journal/`.

## Section-by-section runbook

### Phase A — Brief

Walk these surfaces in fixed order; for each, summarize in plain language (per `rules/communication.md`), then write a read receipt to `workspaces/_certify/journal/.pending/certify-brief-<display_id>-<YYYY-MM-DD>.md`:

1. `specs/_index.md` if present (domain truth surface). If absent, surface "this repo has no specs index; brief covers rules + journal only."
2. Repo `CLAUDE.md` — the always-loaded directives and navigation.
3. CO-category rules in this fixed order: `rules/autonomous-execution.md`, `rules/agent-reasoning.md`, `rules/artifact-flow.md`. These are the load-bearing CO rules; if the consumer repo lacks one, note it explicitly in the receipt.
4. `/posture show` output — current trust posture, repo floor, pending verifications.
5. `.claude/team-memory/` — list each `<slug>.md` with its signed/promoted_by metadata (skip `README.md`).
6. Last 5 `journal/DECISION-*.md` entries — read filename + first H2.

The receipt format per section: `## <section name>` heading + a 3–5 sentence plain-language summary + `Cite: <path>` line. Receipts are SCRUBBED before write per `rules/user-flow-validation.md` MUST-6 — no secrets, no downstream-client tokens, no PII.

### Phase B — Probe

Load `specs/_certification.yaml`. Validate the schema (see § Question bank schema). Present questions in YAML order — the bank's author ordered them easy → hard; the orchestrator MUST NOT re-order.

**Step 0 (probe entry): create the lockfile that activates `probe-phase-guard.js`:**

```bash
touch ".claude/.certify-in-probe-${VERIFIED_ID}.lock"
```

While this lockfile exists, the `.claude/hooks/probe-phase-guard.js` PreToolUse hook (registered in `.claude/settings.json` for matcher `Read|Grep|Glob|WebFetch`) emits `severity: block` on every orchestrator retrieval call. This is the structural defense backing the no-assist discipline below — the hook fires whether the orchestrator's prose-compliance is intact or not.

For each question:

1. Print the question id + prompt + `Cites: <spec-section>` so the operator knows which section they're being tested on.
2. For `multiple_choice`: print options A–N; wait for the operator's letter.
3. For `short_answer`: wait for the operator's prose answer.
4. Judge:
   - `multiple_choice`: exact match against `expected:`.
   - `short_answer`: orchestrator LLM judges the answer against `expected:` (canonical answer) + the `grading_rubric:` bullets (acceptance criteria). Return `{verdict: pass|fail, rationale: <one sentence>}`.
5. Record the per-question result in orchestrator context: `{id, verdict, attempts: 1}`.

**Step N (probe exit, end of Phase B before transition to Phase C): remove the lockfile:**

```bash
rm -f ".claude/.certify-in-probe-${VERIFIED_ID}.lock"
```

Phase C judgement does NOT require retrieval (the bank ships the canonical answer + rubric inline), so the lockfile MUST be removed before Phase C begins — otherwise Phase C's structural identity-write + journal-slot-reserve operations are unaffected (those are Bash + Write, not retrieval tools), but a future iteration of this skill that adds retrieval steps to Phase C would silently break unless this Step is honored.

**NO Claude-assistance during the probe.** If the operator asks "can you explain that section again?" or "what's the answer?", the orchestrator MUST refuse with one sentence: "I cannot assist during the gate phase; re-read the cited section and answer when ready." This refusal is now belt-and-suspenders — the structural hook is the primary defense; the prose refusal handles edge cases (operator pasting in a Read tool call directly via the orchestrator's tool surface would be blocked by the hook; operator asking for prose rephrasing is blocked by this refusal). Both layers fire together per `probe-driven-verification.md` MUST-4 (structural hook + prose-discipline gate-review counterpart).

### Phase C — Gate

After the full pass:

```
if all(q.verdict == "pass" for q in questions):
  → pass path (§ pass receipt below)
else:
  failed = [q for q in questions if q.verdict == "fail"]
  for q in failed:
    print(f"Re-read {q.cites_spec_section}. Then we'll retry question {q.id}.")
  wait for operator to indicate ready
  for q in failed:
    re-run probe on q  # increment q.attempts
  → loop until all pass
```

The gate is 100% strict. There is no partial credit, no "close enough", no "the operator clearly understands the concept but worded it differently." If the answer fails the rubric, it fails the gate. The operator re-reads the cited section and retries.

### Pass receipt

Pass-receipts MUST route through the canonical journal-slot reservation + signed body-anchor helpers per `rules/knowledge-convergence.md` MUST-2. Hand-writing the file directly is BLOCKED — a hand-written receipt is forgeable, breaks the per-emitter chain, and bypasses the body-anchor cryptographic gate that distinguishes a real pass from a fabricated one.

**Step 1 — Resolve identity for the receipt:**

```bash
node -e 'const r = require("./.claude/hooks/lib/operator-id.js").resolveIdentity(process.cwd()); process.stdout.write(JSON.stringify(r));'
```

Parse and bind `verified_id`, `person_id`, `display_id` from the JSON result. STOP if any are null.

**Step 2 — Reserve the slot via the fold-anchored helper:**

```bash
node -e '
const { reserveJournalSlot } = require("./.claude/hooks/lib/journal-reserve.js");
const identity = JSON.parse(process.env.IDENTITY_JSON);
const r = reserveJournalSlot("journal", {
  identity,
  type: "DECISION",
  topic: "certify-pass-" + identity.display_id
});
process.stdout.write(JSON.stringify(r));
' < /dev/null
```

The helper returns `{ slot: "NNNN", filename: "NNNN-<display_id>-DECISION-certify-pass-<display_id>.md", verified_id, person_id, display_id, type, topic }`. The slot comes from the FOLD-ACCEPTED coordination log (NOT a filesystem scan), so two concurrent `/certify` sessions remain distinguishable on disk.

**Step 3 — Write the journal file at the returned filename:**

```yaml
---
type: DECISION
date: <YYYY-MM-DD>
author: co-authored
project: <repo-name>
topic: "certify-pass: <display_id>"
phase: codify
tags: [certify, onboarding, roster-prerequisite]
verified_id: <from-Step-1>
person_id: <from-Step-1>
display_id: <from-Step-1>
bank_version: <specs/_certification.yaml::bank_version>
---
```

Body sections (REQUIRED): per-question tally (id, verdict-on-final-attempt, attempts), total wall-clock, scrubbed brief-receipt index, next-step instruction. Also REQUIRED: the `## For Discussion` section per `rules/journal.md` Requirements (3 probing questions about what was learned and what gaps remain — at least one counterfactual, at least one referencing specific tally data).

**Step 4 — Emit the signed `journal-body-anchor` coordination-log record:**

```bash
node -e '
const path = require("path");
const { buildAnchorRecord } = require("./.claude/hooks/lib/journal-body-anchor.js");
const { appendStamped } = require("./.claude/hooks/lib/coc-append.js");
const identity = JSON.parse(process.env.IDENTITY_JSON);
const journalPath = process.env.JOURNAL_PATH;          // absolute path from Step 3
const relPath = path.relative(process.cwd(), journalPath);
const slotRecordRef = process.env.SLOT_RECORD_REF;     // from Step 2 helper return
const partial = buildAnchorRecord({ journalPath, relPath, slotRecordRef, identity });
const r = appendStamped(process.cwd(), ".claude/learning/coordination-log.jsonl", partial, { identity });
process.stdout.write(JSON.stringify(r));
' < /dev/null
```

The `appendStamped()` helper stamps `verified_id`+`person_id`+`seq`+`prev_hash`+`ts`+`sig` and refuses to write rather than truncate per `knowledge-convergence.md` MUST-6. A `{ ok: false }` result MUST be surfaced + STOP — do NOT retry by hand-writing.

**Why this matters:** at fold time, `foldAnchorPredicate` re-hashes the journal body and compares against `sha256_of_content_bytes` in the signed anchor. Tamper post-write fails verification AND names the anchor's SIGNER per `knowledge-convergence.md` MUST NOT clause "Treat a body-anchor finding as accusing the journal's frontmatter author when the anchor predicate names a DIFFERENT signer." The pass receipt's cryptographic integrity is what distinguishes /certify from theater.

## Question bank schema

`specs/_certification.yaml` (consumer repo's curated bank). The orchestrator validates this schema at probe start; missing required fields → STOP with the offending question id.

```yaml
version: 1 # schema version (currently 1)
bank_version: "<repo>-2026-05-25" # operator-visible bank version (free text)
sections:
  - id: <slug> # e.g. "co-foundations", "trust-posture", "framework-first"
    title: <human-readable name>
    cites_spec: <path:line-range> # e.g. "rules/artifact-flow.md:1-40"
    questions:
      - id: <slug>-q1 # unique across the whole bank
        prompt: <one or two sentences>
        kind: multiple_choice | short_answer
        cites_spec_section: <path:line-range>
        options: # multiple_choice only
          - A: <option text>
          - B: <option text>
          - C: <option text>
        expected: A # multiple_choice: the correct letter; short_answer: canonical answer prose
        grading_rubric: # short_answer ONLY — 3–5 acceptance criteria
          - <must mention X>
          - <must distinguish Y from Z>
          - <must NOT claim W>
```

Ordering convention: easy questions first, hard last. The bank's curator owns ordering; the orchestrator does NOT re-sort.

## Failure modes

- **Empty bank** (`questions: []` after expansion): STOP, surface "bank is empty — seed it from `.claude/templates/specs/_certification.yaml` before running /certify."
- **Schema invalid** (missing `expected:`, missing `grading_rubric:` on a `short_answer`, unknown `kind:`): STOP, name the offending question id.
- **Operator abandons mid-gate**: write `journal/NNNN-DEFER-certify-<display_id>-incomplete.md`; operator stays `L2_SUPERVISED`. Re-running `/certify` restarts from question 1 — the gate is full-bank; partial-bank carry-forward is intentionally NOT supported (the bank is the unit of certification, not individual questions).
- **Bank's cited spec section missing on disk**: warn in the brief receipt; the question is still asked (the operator is being tested on the rule's content as the bank's curator captured it; the missing spec is a separate fix-the-bank task).

## Next steps after certify

Pass → `/whoami --register` (if unrostered) → `/onboard` (re-read team state with verified identity) → `/claim <path>` (start work).

Until pass, the operator stays `L2_SUPERVISED` via `posture.json` (no certify-side write needed — `multi-operator-coordination.md` §1 already enforces L2 default for unrostered operators).

## Composition with other commands

- **`/onboard`** answers "who am I + what's the team state" (read-only). `/certify` adds the knowledge-gate. Run `/onboard` first.
- **`/whoami --register`** is the roster-write. `/certify` does NOT register; the pass journal entry is the prerequisite the next session points at when reviewing the roster-PR.
- **`/codify`** authors rules; `/certify` tests knowledge of rules. When a `/codify` lands a load-bearing rule, the consumer repo's bank curator should add a question covering it; without that, the bank goes stale relative to the live rule corpus.

## Origin

2026-05-25 co-owner-directed COC tooling. Receipt: `journal/0158-DECISION-certify-onboarding-mechanism-2026-05-25.md`. Skill body ~140 lines per `rules/cc-artifacts.md` Rule 2 (progressive disclosure — SKILL.md answers 80% of routine questions without sub-file reads).
