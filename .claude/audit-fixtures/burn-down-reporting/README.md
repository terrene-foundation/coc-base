# burn-down-reporting audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/coc-artifact-eval-coverage.md` MUST-1: a bipolar
fixture set (fires + clean) per probed predicate. These fixtures back the LLM-judge probe
suite at `.claude/test-harness/probes/burn-down-reporting.probes.json`, registered in
`.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null` — this rule
ships no structural scanner of its own; its efficacy IS the probe, per MUST-1's per-type
table for `type: rule`).

**Detection layer.** `burn-down-reporting.md` claims **NO hook layer** and no scanner. Whether
a close-out report constitutes a burn-down is a semantic judgment over prose with no
structural tool-call-time signal, so the load-bearing detector is the REVIEW layer (reviewer
at `/redteam`, cc-architect at `/codify`) — and those two are the ONLY detectors. `/wrapup`
carries no burn-down self-check; see the rule's Detection block for why one was authored and
withdrawn, and what the residual is. Each `.expected` is
therefore the **reviewer's expected disposition** (`FLAG <clause> — <reason>` /
`CLEAN — <reason>` / `COMPLIANT` / `NON-COMPLIANT`), NOT a live hook JSON return. A reader
MUST NOT infer any hook fires on these.

## The pairs

| pair              | violation pole                         | compliant pole                         |
| ----------------- | -------------------------------------- | -------------------------------------- |
| `MUST-1-firing`   | `flag-activity-only-close`             | `clean-three-quantity-burn-down`       |
| `MUST-2-firing`   | `flag-recalled-burn-down-figures`      | `clean-three-quantity-burn-down`       |
| `meta-compliance` | `meta-violation-burn-down-clause-rule` | `meta-compliant-burn-down-clause-rule` |

`clean-three-quantity-burn-down` serves as the compliant pole for BOTH firing pairs, under
two different `rule_ref`s: for MUST-1 it asks "does the clause over-fire on a report that
DOES carry the three quantities", for MUST-2 "does it over-fire on a report whose figures ARE
measured". Same fixture, two distinct over-firing questions; the rows are independent and
each is scored against its own pole.

## Origin-incident conditions (enumerated per `rule-authoring.md` MUST-9)

MUST-9 requires each fixture to reproduce the originating incident's conditions, not an
idealized version in which the agent has already been told what to look for. The originating
incident is loom session 5 (2026-08-02). Conditions were enumerated FIRST; each is carried by
`flag-activity-only-close`:

| #   | Condition                                                         | Carried                                                                         |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | A genuinely productive session with a large, honest activity list | 14 PRs, each named by number, none inflated                                     |
| 2   | The residual exists and is large                                  | 63 issues, 2 PRs, 35 local-only commits — all real at the incident              |
| 3   | The residual is never counted, only gestured at                   | "still work in the backlog", "several branches … still local"                   |
| 4   | No baseline is stated, so no delta is derivable                   | no SHA, no timestamp, no start column                                           |
| 5   | The report is SELF-CRITICAL, so it reads rigorous                 | volunteers a `main`-red merge, two PR-body over-claims, two instrument failures |
| 6   | The residual's sources ARE pointed at                             | `.session-notes` forest ledger + `todos/active/` named explicitly               |
| 7   | The highest-value number is the one most compressed               | 35 invisible commits appear as the word "several"                               |

Condition 5 is the one an idealized fixture drops. A report that reads sloppy is easy to
flag; the incident's report read _more_ disciplined than most compliant ones, because rigor
about ERRORS is not rigor about RESIDUAL and the two are easy to conflate. Condition 6 is the
second: pointing at where the residual lives is correct behaviour for the notes surface
(MUST-3) and is exactly what does not discharge MUST-1 — a fixture without it lets a judge
pass on "the report ignored the backlog entirely", which the incident did not do.

## Sweep exclusions + known-synthetic content (read before filing a finding against this dir)

Three things in here look like defects to a corpus-wide sweep and are deliberate:

1. **The two `meta-*-burn-down-clause-rule.md` files are SYNTHETIC candidate rules, not real
   rules.** They carry valid rule frontmatter (`priority: 10`, `scope: path-scoped`, `paths:`)
   because a meta-compliance judge must see a realistic artifact. They are NOT registered in
   `sync-manifest.yaml` and MUST NOT be — they are fixture inputs. Same accepted class as the
   rule-shaped fixtures under `.claude/audit-fixtures/scan-synced-disclosure/**/.claude/rules/*.md`.
2. **Both meta fixtures cite `.claude/audit-fixtures/residual-axis-stability/` and
   `.claude/test-harness/probes/residual-axis-stability.probes.json`, which DO NOT EXIST.** That
   is intentional: a synthetic candidate rule needs a Detection block naming its own fixtures and
   probes (`coc-artifact-eval-coverage.md` MUST-4) for the judge to grade, and inventing a real
   directory to satisfy an xref sweep would ship two more unregistered artifacts. An
   xref-integrity sweep over `.claude/**/*.md` will flag these two paths — **that is a known
   false positive against this directory, not a `cc-artifacts.md` dangling-cross-reference
   violation.** Exclude the fixture tree, or accept the two hits with this note as the receipt.
3. **The prose in the `.txt` candidates is a realistic session report** and therefore contains
   PR numbers, SHAs, and file paths. These are loom's own coordinates and carry no cross-tenant
   correlation; the one operator identifier that appeared here was genericized to `<operator>`.
   The illustrative instrument list in `clean-three-quantity-burn-down.txt` includes
   `run-harness-suites.mjs`, which EXECUTES and may write under `.claude/test-harness/results/`.
   That is fixture prose only — the rule mandates that instruments be NAMED, never which
   instrument to use, and picks no executing instrument for any consumer.

## Answer-key separation

The `.expected` sidecars are answer keys and are NEVER handed to a judge — only the
`.txt` / `.md` candidate is. The candidates carry no HTML comments and none of the
answer-key markers `.claude/test-harness/tests/probe-suite-integrity.test.mjs` enumerates;
that separation is enforced mechanically there, not by convention here.
