---
id: "INSTRUMENT-DISCIPLINE"
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

### 3. Show The Instrument Fires HERE, And Read The Hits

Naming the falsifying result (MUST-1) does not show THIS tool can emit it. **(a)** Fire the instrument at a known-answer case first; never-shown-to-fire-here is BLOCKED as evidence, however sound its logic. **(b)** Read the matches, not the tally — including what a count COUNTS.

```bash
# DO — the control fires against a case already known to hold the pattern
git grep -c 'process\.exit(0)' -- path/known-to-have-it.js  # prints 8 ⇒ matcher works HERE
git grep -n 'severity: "block"' -- .claude/rules/           # then READ each hit in context
# DO NOT — cite an empty result from an instrument never shown to fire, or report the tally
grep -rn 'process\.exit([12])' .claude/hooks/  # silently no-matches under this repo's ugrep
node --test tests/integration/*.test.js        # "tests 14" counts FILES; inner harness ran 350
```

**BLOCKED rationalizations:** "it returned empty, so there are none" / "grep is grep" / "that flag is POSIX" / "it works on my other machine" / "the tally is the finding" / "I read a sample and they all looked fine" / "the count went down, so the fix landed" / "`ls` and `head` both agree, so the path is right" / "a control for a one-line check is ceremony".

**Why:** A sound check can be physically unable to emit its falsifying result here — an unimplemented regex dialect, a shell that will not word-split, a case-insensitive filesystem — so its silence is indistinguishable from a true negative, and survives review that checks only the reasoning; no control catches an over-match, which only reading the hits reveals.

### 4. An Instrument Is Scoped To The Question It Was BUILT For

Soundness for question A carries NO information about question B. Reading a check built for A to answer a DIFFERENT question B re-triggers MUST-1 for B: name what it would print were B FALSE; unnameable ⇒ B is UNANSWERED. **A field's semantics are fixed by its PRODUCER, not by the reader's question.**

```bash
# DO — the second question gets its OWN falsifying result named against THIS instrument
# a simulator built to PARTITION N PRs into merge-order groups, now asked "will they conflict?"
# ⇒ it never opens a diff, so no output of it could show a conflict: UNANSWERED, re-instrument
git merge-tree "$(git merge-base A B)" A B | grep -c '^<<<<<<<'   # >0 ⇒ they DO conflict
# DO NOT — read the sound-for-A instrument as though it had answered B
# "the simulator returned 4 clean groups, so the PRs don't conflict"  ← it never looked
gh run view "$ID" --json jobs -q '.jobs[].labels'   # records what the job REQUESTED, not the host
```

**BLOCKED rationalizations:** "the script already ran, no need for another" / "it's the same data" / "the field is right there in the output" / "it was correct the last time I used it" / "the tool is well-tested" / "I'm only reading one more field off it" / "the output is plausible for both questions" / "the producer and I mean the same thing by that name" / "it discriminates, I already checked" / "it's one question, not two — the check covers the whole claim" / "I'm verifying the change as a whole, so there is no second question to name".

**Why:** Discrimination belongs to the PROPOSITION, not the tool — so a value plausible for B survives a self-review that only ever asked about A.

## MUST NOT

- Report a question ANSWERED, or treat a lexical match (grep, keyword scan, string presence) as a verdict on a semantic property, when no result the instrument could have produced would have falsified the proposition

**Why:** A token's presence is consistent with assertion, negation, and quotation alike; a confident wrong answer ends the search that would have found the right instrument.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm each check cited as evidence carries a named falsifying result, that no green test or non-reddening mutation was read as a verdict without its discrimination shown, and that any instrument cited was shown to fire HERE with its hits read rather than its tally); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether an instrument discriminates is judgment-bearing over the check's semantics, with no structural tool-call-time signal.
- **Grace period:** 7 days from rule landing (2026-07-29 → 2026-08-05).
- **Cumulative posture impact:** same-class violations (a non-discriminating check cited as evidence; a green suite cited as verification without an established red; a non-reddening mutation recorded as a vacuity verdict; an instrument never shown to fire here cited as evidence; a tally reported in place of the hits) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: whether an instrument discriminates is a judgment-bearing property of the check's semantics, resolvable only at the review layer, so it does not warrant an instant-drop key; and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. The universal `regression_within_grace` trigger already covers it. Same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, and `issue-triage-routing.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: instrument-discipline]` IFF `posture.json::pending_verification` includes the `instrument-discipline` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any session citing a check, probe, fixture, or test result as evidence and confirm (a) the falsifying result was named, (b) a green cited as verification had its red established, (c) any mutation read as a vacuity verdict was shown to reach the code under test, (d) the instrument was fired at a known-answer case so it is shown to discriminate HERE, and (e) the hits were read rather than a tally reported in their place. Phase 2 is RETIRED, not pending (2026-08-14): no hook detector will EVER be built, because a regex detector would itself instance this class — so no structural fixtures are owed either. Gate-review IS the enforcement layer here, permanently. **Probes: REGISTERED — `.claude/test-harness/probes/instrument-discipline.probes.json`**, 14 rows in 7 bipolar `pair_id` pairs covering ALL SIX sub-clauses (MUST-1, MUST-2(a), MUST-2(b), MUST-3(a), MUST-3(b), and — via the clause-scoped block below — MUST-4) plus a meta-compliance pair, with candidates + answer-key sidecars at **`.claude/audit-fixtures/instrument-discipline/`** (SEMANTIC tier only — not the deferred Phase-2 structural set). Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES`, which enforces the bipolar-pole, answer-key-separation and meta-pole surface-equalization floor. This satisfies `coc-artifact-eval-coverage.md` MUST-1's prose-artifact mandate (efficacy + no-false-positive + meta-compliance) and DISCHARGES the former `_deferred_probes` declaration and its `expires: 2026-08-12` hard-fail, both removed in the same change. **What registration buys, MEASURED and not assumed: DISPATCHABILITY, never automatic execution.** `/test-harness-probe --artifacts` (Mode B) reads the registered suites from `eval-manifest.json`, NOT the Mode-A `results/{compliance,safety}-*.jsonl` glob, so `coc-probe-dispatch.mjs plan` renders every one of this suite's judge prompts (measured at THIS suite's landing: plan `dispatch_count` 24 → 36, with 12 rows under `suite: instrument-discipline` where there were 0; both figures are that landing's measurement and are NOT current — re-measure rather than citing them, as the MUST-4 block below does). But NO workflow invokes the dispatcher — a `grep -rn 'coc-probe-dispatch\|test-harness-probe\|--artifacts' .github/workflows/` (against a control shown to fire on the same tree) returns exactly one hit, and it is a COMMENT, not a `run:` step — and the loom↔csq boundary keeps CI LLM-free. The suite therefore executes ONLY when an orchestrator dispatches it at gate-review, and a green CI run is NEVER evidence the probes passed. The prior claim that `/test-harness-probe` "never reaches this file at all" described Mode A alone and is superseded. What CI DOES gate is REGISTRATION and hygiene — `coc-manifest-integrity.mjs` (check (b) `artifact_id` rows, check (e) orphan probe files) and `probe-suite-integrity.test.mjs` — on EVERY PR targeting `main` — the `pull_request` arm carries NO `paths:` filter (loom#1567 removed it so a required context always reports), and the FOUR-entry filter (`.claude/**`, `tests/integration/multi-operator/**`, the workflow file itself, `variants/**`) sits on the `push:` arm ALONE, so a PR touching only `journal/` or `workspaces/` still instantiates the workflow but SKIPS the expensive structural job on a job-level `if:`. The `on:` block ALSO carries `merge_group`, `push`, `workflow_dispatch`, and — since 2026-08-14 — a WEEKLY `schedule:` (`cron: "17 6 * * 1"`). Three of those four corrections are to PRE-EXISTING errors, not to breakage introduced by the calendar arm: the superseded text claimed a `paths:`-filtered PR arm and no `push:`/`workflow_dispatch:` trigger, and all three were already false on `main`; only the `no schedule:` clause was falsified by the calendar change — and whether it is merge-preventing is a claim about MUTABLE repo settings, so **re-measure it rather than citing this line** — with `has()`, never the object-construction form, which yields `null` for a missing key and so cannot tell ABSENT from PRESENT-AND-NULL (a non-discriminating instrument in this rule's own sense). Measured 2026-08-08: `contexts: ["Required checks"]`, `enforce_admins` `true` — it IS merge-preventing now; the prior text here said the opposite, which held only until loom #65 step 1 landed. Consumer note: `.claude/test-harness/**` is never-synced to USE and downstream, and on the BUILD lane only `test-harness/lib/**` ships (`sync-tier-aware.mjs::BUILD_ONLY_ALWAYS_INCLUDE`) — so no audience receives the suite, `eval-manifest.json`, or the `results/` glob; `commands/test-harness-probe.md` is `use_exclude`d (absent at USE-template and downstream) but SHIPS to BUILD on the CC lane.
- **Violation scope:** MUST-1 (unnamed falsifying result) + MUST-2(a) (green cited without an established red) + MUST-2(b) (non-reddening mutation read as a vacuity verdict) + MUST-3(a) (instrument never shown to fire here) + MUST-3(b) (tally reported in place of the hits). MUST-4 carries its OWN clause-scoped block below. Every `violations.jsonl` row names the instrument and the proposition it was cited for.
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-4 (instrument scope)

Applies to the **MUST-4** clause ONLY (added 2026-08-11, `/sync-from-use` Gate-1 placement of a downstream-relayed upflow entry). Per `trust-posture.md` MUST-8 grandfather cutoff it lands AT/AFTER the MUST-8 SHA and ships canonical-8-field-compliant; the MUST-1..3 Wiring block above stays on its own wiring until itself `/codify`-touched (the clause-scoped precedent set by `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm that an instrument re-read for a second question carried a falsifying result named for THAT question); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether two readings of one instrument are the same question is judgment-bearing over the check's semantics, with no structural tool-call-time signal.
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (an instrument sound for one question cited as evidence for a second without its own named falsifying result; a producer-defined field read under the reader's meaning) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8, on the SAME reasoning the MUST-1..3 block records: question-scope is a review-layer semantic judgment that does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. MUST-4 does not reuse the MUST-1..3 block's disposition; this is its own record.
- **Receipt requirement:** SessionStart soft-gate `[ack: instrument-discipline]` IFF `posture.json::pending_verification` includes the `instrument-discipline` rule_id (shared rule_id; one ack covers MUST-1..4).
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any session that cites one instrument for two distinct propositions and confirm a falsifying result was named for the SECOND. Scanner: none — `eval-manifest.json::instrument-discipline` stays `scanner: null` (question-scope is semantic, with no structural signal), so no structural fixture set is claimed for this clause. **Probes: REGISTERED, and the paths below resolve** — `.claude/test-harness/probes/instrument-discipline.probes.json` gains one bipolar `pair_id` pair (`MUST-4-firing`): an efficacy (`RuleEfficacyAnswer`, violation pole) + no-false-positive (`NoFalsePositiveAnswer`, compliant pole) row, with candidates + answer-key sidecars at `.claude/audit-fixtures/instrument-discipline/`. This satisfies `coc-artifact-eval-coverage.md` MUST-1's prose-artifact mandate for the clause; the suite's existing meta-compliance pair covers the modified artifact. Dispatchability re-measured on THIS change, not inherited, two-pole on one tree: `coc-probe-dispatch.mjs plan` reports `dispatch_count` 52 → 54 with `suite: instrument-discipline` rising 12 → 14 and `refusal_count` 0 on both poles (2026-08-12). Execution semantics are unchanged from the MUST-1..3 block: no workflow invokes the dispatcher, so a green CI run is NEVER evidence these probes passed. Phase 2 is RETIRED for MUST-4 too (2026-08-14): no hook detector will EVER be built, because a regex detector would itself instance this rule's class — so no structural fixtures are owed. Gate-review IS the enforcement layer, permanently.
- **Violation scope:** MUST-4 ONLY (an instrument re-used for a second question without a falsifying result named for that question, including a producer-defined field read under the reader's meaning). Every `violations.jsonl` row names the instrument, the proposition it was cited for, and the question it was originally built for.
- **Origin:** See § Origin.

Origin: 2026-07-29 — O1 co-owner-directed origination; receipt-first `journal/0569`. Baseline because no loaded rule carries this obligation: `evidence-first-claims.md` governs claim GRAMMAR, this governs instrument SELECTION. A reachability argument for this scope is BLOCKED and NOT made (`93e47705` refuted it). Depth: `journal/0569` + `.claude/guides/rule-extracts/instrument-discipline.md`.

**MUST-4** — 2026-08-11, landed via `/sync-from-use` Gate-1 placement of a DOWNSTREAM-relayed upflow entry; hop-level provenance only, GLOBAL on both axes. A paired entry claiming the same slot was evaluated in the same pass and deliberately ordered AFTER this one; it measured 612 B and is DEFERRED, not landed — this file has no MUST-5, and any future placement of that entry takes the slot. Extension-vs-standalone reasoning, the originating incident class, and the scrub record: extract § "MUST-4 — depth".
