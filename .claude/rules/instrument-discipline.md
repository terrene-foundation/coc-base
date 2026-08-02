---
priority: 0
scope: baseline
cli_delivery: baseline
---

# Instrument Discipline — A Check That Cannot Discriminate Is Not Evidence

Before any check, probe, fixture, or test result is cited as evidence, ONE test governs it:

> **Would this instrument produce a DIFFERENT result if the proposition were false?**

If not, it is not evidence — whatever it printed. Instrument table, worked cases, BLOCKED corpus: `.claude/guides/rule-extracts/instrument-discipline.md`.

## MUST Rules

### 1. Name The Falsifying Result Before Citing Any Check As Evidence

State what the instrument would have printed had the proposition been FALSE. No nameable falsifying result ⇒ BLOCKED as evidence: re-instrument, or report the question UNANSWERED. Having run, exited 0, or printed a plausible value does not satisfy this.

```bash
# DO — can return the other answer, and that is stated
gh pr checks "$N" --json name,state -q '.[]|select(.state!="SUCCESS")'   # non-empty ⇒ NOT green
# DO NOT — output constant across the hypothesis
git status --porcelain      # empty on "nothing done" AND on "all committed"
```

**BLOCKED rationalizations:** "the command ran clean" / "it exited 0" / "the number looked right" / "that's how we always check it" / "it's a sanity check, not proof".

**Why:** A result consistent with both branches of the hypothesis carries zero information, so acting on it is acting on a guess wearing the grammar of a measurement.

### 2. A Passing Test Is An Instrument — And A Non-Reddening Mutation Is Two Hypotheses

**(a)** A green test, fixture, suite, or probe reports on the behavior it NAMES and MUST clear MUST-1 first; citing a green without having established the run would RED in that behavior's absence is BLOCKED. **(b)** A mutation that does NOT red the test leaves TWO live hypotheses — vacuous test, OR inert mutation — so recording "proven vacuous" on it is BLOCKED; show the mutation reached the code under test, or the result stands UNRESOLVED.

```bash
# DO — establish the red, and prove the mutation executes, before reading either green
git stash && pytest -k revocation   # or cargo nextest run -E 'test(revocation)'
<mutate>; <assert mutated line runs>; <run test>          # then the result is readable
# DO NOT — cite a green alone, or read a non-reddening mutation as a verdict
pytest -q   # "412 pass"; <mutate>; still green → "vacuous"  ← also an INERT mutation
```

**BLOCKED rationalizations:** "the suite is green" / "CI passed" / "the test is named for that behavior" / "it would have failed if it were broken" / "I changed the code and nothing failed" / "the mutation was obviously reachable" / "the test must be vacuous then".

**Why:** A test asserting nothing about its named behavior passes identically whether that behavior is present or absent; an unvalidated mutation then becomes a second non-discriminating instrument, issuing false vacuity verdicts against working tests.

## MUST NOT

- Report a question ANSWERED, or treat a lexical match (grep, keyword scan, string presence) as a verdict on a semantic property, when no result the instrument could have produced would have falsified the proposition

**Why:** A token's presence is consistent with assertion, negation, and quotation alike; a confident wrong answer ends the search that would have found the right instrument.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm each check cited as evidence carries a named falsifying result, and that no green test or non-reddening mutation was read as a verdict without its discrimination shown); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether an instrument discriminates is judgment-bearing over the check's semantics, with no structural tool-call-time signal.
- **Grace period:** 7 days from rule landing (2026-07-29 → 2026-08-05).
- **Cumulative posture impact:** same-class violations (a non-discriminating check cited as evidence; a green suite cited as verification without an established red; a non-reddening mutation recorded as a vacuity verdict) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: whether an instrument discriminates is a judgment-bearing property of the check's semantics, resolvable only at the review layer, so it does not warrant an instant-drop key; and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. The universal `regression_within_grace` trigger already covers it. Same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, and `issue-triage-routing.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: instrument-discipline]` IFF `posture.json::pending_verification` includes the `instrument-discipline` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any session citing a check, probe, fixture, or test result as evidence and confirm (a) the falsifying result was named, (b) a green cited as verification had its red established, (c) any mutation read as a vacuity verdict was shown to reach the code under test. Phase 2 deferred — no hook detector (a regex detector would itself instance this class); audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/instrument-discipline/` per `cc-artifacts.md` Rule 9. **Probes: STAGED, and NOTHING EXECUTES THEM.** `coc-artifact-eval-coverage.md` MUST-1's prose-artifact probe mandate is **NOT satisfied**, and the Phase-1 gate-review above is this rule's **ONLY ACTIVE coverage** — for every audience, loom included. A bipolar suite (all three clauses, both polarities) and its graduation deadline (`expires: 2026-08-12`) are declared at loom in `eval-manifest.json::_deferred_probes` (`.claude/test-harness/probes/instrument-discipline.probes.jsonl` — named explicitly because `coc-artifact-eval-coverage.md` MUST-4 requires the Detection block to name the probe FILE, and the R13 prose cut dropped it). The integrity check HARD-FAILS past that date and runs on every PR matching the workflow's FOUR-entry `paths:` filter (`.claude/**`, `tests/integration/multi-operator/**`, the workflow file itself, `variants/**`) and targeting `main` — it carries no `push:`/`schedule:`/`workflow_dispatch:` trigger, so a PR touching only `journal/` or `workspaces/` does NOT surface it** — but it is **evidence-producing, NOT merge-preventing**: per `coc-artifact-eval-coverage.md` § Wiring, the branch-protection payload at loom carries NO `required_status_checks` key at all (verified with `has()`, not the object-construction form that yields `null` for a missing key) and `.enforce_admins.enabled` is `false`, so a human may merge over the red. That declaration time-bounds the GRADUATION OBLIGATION; it does not create coverage, and it does not block. **The mechanics of why — the registration blockers, the `/test-harness-probe` input glob, the check-(k) non-collision — live in that manifest entry and are deliberately NOT restated here** (`specs-authority.md` Rule 9): they were restated once, the two copies drifted, and the drift is recorded in the manifest's own text. Consumer note: `.claude/test-harness/**` is never-synced to USE and downstream, and on the BUILD lane only `test-harness/lib/**` ships (`sync-tier-aware.mjs::BUILD_ONLY_ALWAYS_INCLUDE`) — so no audience receives the suite, `eval-manifest.json`, or the `results/` glob; `commands/test-harness-probe.md` is `use_exclude`d (absent at USE-template and downstream) but SHIPS to BUILD on the CC lane.
- **Violation scope:** MUST-1 (unnamed falsifying result) + MUST-2(a) (green cited without an established red) + MUST-2(b) (non-reddening mutation read as a vacuity verdict). Every `violations.jsonl` row names the instrument and the proposition it was cited for.
- **Origin:** See § Origin.

Origin: 2026-07-29 — O1 co-owner-directed origination; receipt-first `journal/0569`. Baseline because no loaded rule carries this obligation: `evidence-first-claims.md` governs claim GRAMMAR, this governs instrument SELECTION. A reachability argument for this scope is BLOCKED and NOT made (`93e47705` refuted it). Depth: `journal/0569` + `.claude/guides/rule-extracts/instrument-discipline.md`.
