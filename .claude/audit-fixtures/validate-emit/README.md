# Audit Fixtures — validate-emit

Structural probes (per `rules/probe-driven-verification.md` MUST-3 — exit-code,
count-of-elements, equality checks on pure-function outputs) for the F30
validator at `.claude/bin/validate-emit.mjs`.

These fixtures are NOT semantic; they verify the validator's mechanical
behavior — one fixture per scope-restriction predicate per `rules/cc-artifacts.md`
Rule 9, covering each of the 7 first-cycle checks plus the parsing helpers.

Note: checks 5 (`mirror-exclusion`) and 6 (`paths-annotation-consistency`) are
predicate-tested via their shared pure-function helpers (`parseEmitExclusions`
in fixture #10, `matchesGlob` in fixture #3); the check-level wrappers are thin
glue around those helpers + the standard live-tree I/O the other check fixtures
already exercise.

## Run

```bash
node .claude/audit-fixtures/validate-emit/run.mjs
```

Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.

## Fixture catalog

| #   | Predicate                                   | What it pins                                                                                                                                        |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | parseFrontmatter — leading `---` block      | extracts fields; correctly handles unterminated frontmatter                                                                                         |
| 2   | parseToolList — comma + array forms         | `"Read, Edit"` and `["Read","Edit"]` both → `["Read","Edit"]`                                                                                       |
| 3   | matchesGlob — exact + `/**` prefix          | `skills/foo` matches `skills/foo/**`; doesn't match unrelated paths                                                                                 |
| 4   | check 1 — command frontmatter               | H1-only command flagged; `---`-leading command passes; exempt list honored                                                                          |
| 5   | check 2 — command line cap                  | body > 150 (after stripping frontmatter) flagged; ≤150 passes                                                                                       |
| 6   | check 3 — read-only specialist tools        | agent declaring Edit/Write flagged; Read/Bash/Grep clean                                                                                            |
| 7   | check 4 — tool canonicality                 | `LS` flagged as non-canonical; canonical set clean                                                                                                  |
| 8   | check 7 — audit-fixture coverage            | detector with no fixture dir → fixture-needed; flag+clean fixture → pass                                                                            |
| 9   | parseReadonlySpecialists — agents.md parse  | extracts backtick-quoted names from "Read-only specialists (...)" sentence                                                                          |
| 10  | parseEmitExclusions — manifest sub-block    | parses `cli_emit_exclusions: codex/gemini` list under top-level YAML key                                                                            |
| 11  | classifyFixtures — flag vs clean naming     | `flag-X.txt` counts as flag; `clean-X.txt` counts as clean                                                                                          |
| 12  | check 6 multi-rule-per-row (R1 #1 lock)     | `matchAll` iterates EVERY rule on a Rules-Index row, not just the first                                                                             |
| 13  | classifyFixtures strict prefix (R1 #2 lock) | `clean-flag-X.txt` ambiguous name does NOT count as flag (strict `^flag-`)                                                                          |
| 14  | check 1 unterminated frontmatter (R1 #4)    | `---` open without close fails check 1 (parseFrontmatter would consume body)                                                                        |
| 15  | check 13 — validateGeminiCommandToml        | clean TOML → no errors; premature `'''` close in body → flagged (#408 AC#7)                                                                         |
| 16  | check 13 — extractRulesIndexCitations       | extracts EVERY `.claude/rules/<f>.md` row citation; empty index → `[]`                                                                              |
| 17  | check 14 — canonicalPolicies                | order-insensitive policies-table compare; detects a dropped gate (DF-AC6-2)                                                                         |
| 18  | check 15 — parseVariantsBlock               | `variants:` → non-null overlay VALUES (arm 1) + `null` cells (arm 4); variant_only path NOT swept in                                                |
| 19  | check 15 — parseVariantOnlyAll              | `variant_only:` → flat path set across langs (the 2nd union lane); next top-level block not swept in                                                |
| 20  | check 15 — classifyVariantFile              | one CLEAN per allowlist arm (overlay/variant_only/convention-rule+ternary+wrapper/null-ack/README+.example) + ORPHAN + unknown-axis-not-mis-flagged |
| 21  | check 15 — checkVariantOrphan e2e           | git-tracked enumeration over a synthetic tree: planted orphan → FAIL, declared → PASS, untracked operator-local companion → invisible               |

Note: check 13 (`consumer-efficacy`, #408 AC#7) is predicate-tested here via its
exported pure helpers (fixtures 15–16); the check-level wrapper + fault-injection
over synthetic emit trees (malformed TOML / unterminated frontmatter / missing
description / empty skill dir / dangling citation / lane-asymmetric + empty
index) is the Tier-2 regression
`test-harness/tests/consumer-efficacy-contract.test.mjs` (incl. the LIVE-corpus
clean-pass).

Check 14 (`codex-policies-fresh`, DF-AC6-2) is predicate-tested via
`canonicalPolicies` (fixture 17); the check-level wrapper + the stale-policies
FAIL teeth + the CC-only SKIP are the Tier-2 regression
`test-harness/tests/codex-policies-fresh.test.mjs` (incl. the LIVE-repo
committed==fresh regression-lock).

## Why structural probes

The validator's own output is structured (`{pass, fail, fixture-needed, skip}`
per artifact). The fixtures here exercise the predicates that produce those
statuses, not the validator's prose. Per `rules/probe-driven-verification.md`
MUST-3, this is the correct shape for a no-LLM CI verification path.
