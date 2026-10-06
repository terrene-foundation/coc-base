# cross-cli-artifact-hygiene Audit Fixtures

Fixtures for `tools/lint-workspaces.js` per `rules/cross-cli-artifact-hygiene.md`.

Per `rules/cc-artifacts.md` MUST §9 (Audit Tools Ship With Committed Test Fixtures), every mechanical audit tool ships with test fixtures exercising every scope-restriction predicate.

## Layout

| Fixture                        | Type | Expected lint behavior                                                                      |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------- |
| `flag-agent-syntax.md`         | flag | Multiple findings: agent-subagent-type, agent-object-subagent-type, agent-run-in-background |
| `flag-claude-md-authority.md`  | flag | Multiple findings: cli-baseline-claude-md, cli-baseline-agents-md, cli-baseline-path        |
| `flag-tool-name.md`            | flag | Multiple findings: tool-noun-read, tool-noun-bash, tool-noun-edit, hook-event-session-start |
| `clean-neutral-delegation.md`  | null | Zero findings — delegation, baseline, hook, tool refs all neutral                           |
| `clean-historical-citation.md` | null | Zero findings — `(historical)` qualifier skips the line                                     |

## Run

    node tools/lint-workspaces.js .claude/audit-fixtures/cross-cli-artifact-hygiene/

Expected: the 3 `flag-*.md` LINT fixtures produce findings; every other `.md` in this
directory produces zero. Combined exit code: 1. The lint enumerates `*.md` ONLY, so the
`.txt` probe candidates below are invisible to it by construction.

## Two tiers live in this directory — do not read one as the other

| Tier           | Files                                                      | Consumer                                     |
| -------------- | ---------------------------------------------------------- | -------------------------------------------- |
| **STRUCTURAL** | the 5 `.md` fixtures in the Layout table above              | `tools/lint-workspaces.js` (pattern labels)   |
| **SEMANTIC**   | the 12 `.txt` transcripts + the 2 `meta-*-rule.md` poles     | `.claude/test-harness/probes/cross-cli-artifact-hygiene.probes.json` (LLM judge) |

The `.expected` sidecars are NOT one format. A STRUCTURAL sidecar states the lint's expected
finding set (`FLAG: … PATTERNS: …`); a SEMANTIC sidecar is a judge ANSWER KEY, never shown to a
judge. They are not interchangeable.

The probe candidates are session TRANSCRIPTS, not artifact snapshots, and that is deliberate.
The rule's obligations are about artifact CONTENT, so a snapshot looks like the natural
candidate — but the transcript quotes the artifact body verbatim inside the agent's own tool
call, so the content stays fully legible while the transcript additionally supplies the two
things a snapshot cannot: mechanical facts shared across a bipolar pair, and the authorial
context that separates a PRESCRIPTIVE mention from a qualified HISTORICAL one, which is where
four of the five MUST clauses actually turn. The 5 lint fixtures were NOT reused as probe
candidates: their sidecars are lint-output expectations, and each announces its own verdict in
its H1 (`(BLOCKED)` / `(CLEAN)`), which would make the probe an open-book exam.

MUST-5 and the `## MUST NOT` bullet have NO lint pattern at all, so both poles of each pair
print `0 findings` and exit 0. A judge is the only instrument that separates them, and a
reader who treats the clean lint as coverage for those two clauses has read an instrument that
never looked.

## Severity

Advisory. Per the rule's Trust Posture Wiring, lint output surfaces leakage to the user; the user adjudicates rewrite vs qualify-as-historical. New leaks introduced after rule-land are `regression_within_grace` per `trust-posture.md` MUST Rule 4.

## Allowlist

Lines containing `(historical)`, `(historical citation)`, or `<!-- cli-portable-exception -->` are skipped. This implements MUST 5 (qualified-historical mentions are acceptable).
