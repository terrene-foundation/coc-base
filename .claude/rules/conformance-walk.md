---
priority: 10
scope: path-scoped
# DO NOT PUT A `#` COMMENT INSIDE THE `paths:` BLOCK BELOW. This trap-guard lives here because
# here is where the trap is; the provenance and measurements for this glob set live in § Origin
# and its paired depth file, which the abridger strips.
# The frontmatter-paths parser in the floor-only-assertion hook library captures this block with
# `/(^|\n)paths:\s*\n((?:\s*-\s*.*\n?)+)/`, so a `#` line TERMINATES the capture — and the
# damage depends on WHERE. MEASURED 2026-09-19:
#   comment FIRST in the block -> 0 globs parsed; degrades to the hand-listed fallback and
#                                 reports `derived: false`, which is at least visible.
#   comment ANYWHERE LATER     -> TRUNCATED to exactly the items ABOVE it, and still reports
#                                 `derived: TRUE`. THE DANGEROUS ONE: a caller reads the scope as
#                                 authoritative while every glob below the comment is gone, and
#                                 no flag moves. (The truncated count is position-dependent, not
#                                 a fixed 1 — it is however many items precede the comment.)
#   comment ABOVE the key, or none -> all items parsed. Safe.
paths:
  - "**/tools/conformance/**"
  - "**/e2e/**"
  - "**/eval-harness/**"
  - "**/04-validate/**"
  - "**/*conformance*"
  - "**/suites/**"
  - "scripts/ci/**"
  - ".github/workflows/**"
  - ".claude/bin/check-*.mjs"
  - ".claude/hooks/**"
  - ".claude/test-harness/**"
  - ".claude/audit-fixtures/**"
---

# Conformance Walk — Freeze The Expectation, Judge Source / Delivered / Live State, Report Coverage Honestly

A breadth check, a type-check, and a merge gate all answer "does it compile / render / return 200 / not crash". None answers the question a testable surface actually poses: **does each actionable unit DO what it is FOR — in the artifact the user actually installs?** The Conformance Walk (CW) closes that gap with ONE surface-agnostic core (`cw_core`) + a registry of per-surface adapters grouped into THREE oracle families on ONE delivery axis — **source → shipped artifact → live behavior**: **SOURCE** conformance (SCM = Source Conformance Matrix — the symbol exists + holds its contract IN SOURCE, judged without running), **DELIVERED** conformance (DCM/FCM — the capability is reachable + non-stub in the SHIPPED ARTIFACT: wheel × binding × resolved feature set), and **LIVE** conformance (API / CLI / MCP / FE — a real invocation matches the frozen post-state). ONE discipline across all three: enumerate every unit, attach a FROZEN expectation, judge observed state against it with a DETERMINISTIC oracle, report coverage HONESTLY (separate from pass-rate), and RATCHET so a new unit without an expectation fails the gate.

**The delivery gap is the thesis.** The dominant failure is not "source lacks the feature" and not "the running service misbehaves" — it is _source HAS the feature, tests PASS against source, yet the published artifact the user installs does NOT contain it_ (a capability gated off the default cargo feature set compiles out of the wheel; a binding wrapper is never generated). DELIVERED is the middle node nobody instruments, and one capability record spans symbol (SCM) → delivered-node (DCM) → endpoint/tool/route (LIVE): a red delivered-node lights the WHOLE capability.

The methodology, `cw_core` + its JSON-schema interop boundary, the normative adapter-registry interface, the three-family adapter table, the phase-action triggers, and the CW-vs-`/redteam` role split live in `.claude/skills/conformance-walk/SKILL.md`. This rule carries the four MUST clauses; each surface supplies its own adapter per the skill's per-consumer adapter obligation.

## MUST Rules

### 1. Every Actionable Unit Carries A Frozen Expectation Asserted Against Live/Static Observed State

Every actionable UNIT on a touched testable surface (a public symbol, a route + its interactive elements, an endpoint, a CLI subcommand/flag, an MCP tool) MUST carry a FROZEN expectation — the observable contract or transition it should hold — asserted against the LIVE or STATIC observed state. The expectation MUST be frozen BEFORE the observation (freeze-then-judge). "Compiled / rendered / 200 / didn't crash" is the FLOOR, never the expectation; a different-than-expected effect is NOT a pass.

```text
# DO — freeze the delivered-capability contract, then judge the SHIPPED artifact against it
Unit: capability `auth::SessionProvider::refresh_async`. Frozen expectation: reachable +
non-stub in the SHIPPED wheel under the resolved feature set. Observed: source HAS it and
unit tests PASS, but the wheel built with default features compiled it out → FAIL
(the floor "source compiles / unit tests green" passed; the expectation "the capability is
delivered in the artifact the user installs" did not — the delivery gap).

# DO NOT — assert the floor and call it a pass
Unit: `auth::SessionProvider::refresh_async`. Assertion: "the symbol exists in the source
tree" (grep-resolves) → PASS. (source presence ≠ artifact presence — the wheel the user
installs can omit it entirely and this still reads green)
```

**Why:** The floor ("it didn't crash") is satisfied by a surface that does the WRONG thing; only a frozen expectation asserted against the observed effect distinguishes "works" from "runs". Freezing BEFORE observing is what stops the expectation from being back-fitted to whatever the code happened to do.

### 2. The Deterministic Oracle Is Load-Bearing; Any LLM/Agent Semantic Judgment Is Advisory-Only

The DETERMINISTIC oracle — the one that yields the same verdict on every run with no model in the loop — is the load-bearing CI verdict and MAY hard-fail the gate. Any LLM / agent / semantic judgment MUST be ADVISORY-only: it produces a pre-computed worklist or a capture-then-human-freeze slot, and it MUST NOT hard-fail the gate. Wiring a non-reproducible semantic verdict as a blocking CI gate is BLOCKED.

```text
# DO — deterministic verdict blocks; semantic judgment is an advisory worklist item
Deterministic: "endpoint fired + schema matched + read-back present" → hard PASS/FAIL (CI).
Semantic: "is this error copy user-appropriate?" → advisory worklist row for /redteam.

# DO NOT — a model verdict gates the merge
"LLM judged the response 'looks correct' → mark PASS, block merge on the LLM verdict."
(non-reproducible; a re-run flips the gate, and a flaky judge blocks a good merge)
```

**Why:** A CI gate must be reproducible — a model-in-the-loop verdict flips between runs and turns the gate into noise operators learn to override. Splitting deterministic (load-bearing) from semantic (advisory) keeps the gate trustworthy while still surfacing the judgment questions to the human, pre-computed.

### 3. Coverage Is Reported Separately From Pass-Rate, Over A Machine-Derived Denominator

Coverage (is every enumerated unit measured?) MUST be reported SEPARATELY from pass-rate (how many measured units passed). The denominator MUST be machine-derived — enumerated from source or runtime, never hand-listed — and a verdict counts toward coverage only if it carries ≥1 real assertion (no-vacuous-eval guard). Fabricating 100% by dropping non-pass rows, hand-listing the denominator, or counting an assertion-free verdict as coverage is BLOCKED.

```text
# DO — two separate numbers over a machine-derived denominator
Denominator = 214 routes enumerated from the router AST. Coverage: 214/214 measured
(100%). Pass-rate: 190/214 pass, 24 fail. The 24 fails are the fix-list; coverage is honest.

# DO NOT — collapse coverage into pass-rate, or hand-list the denominator
"We test 190 routes and they all pass → 100%." (the 24 unmeasured routes vanished from
the denominator; "100%" is fabricated by omission)
```

**Why:** Collapsing coverage into pass-rate lets a surface hit "100%" by never measuring the units that would fail — the denominator silently shrinks to the passing set. A machine-derived denominator + separate coverage number makes "nothing unmeasured" a checkable claim, and the no-vacuous guard closes the `assert(true)` hole.

### 4. The Verdict Taxonomy Is Discrete: Pass | Fail | Blocked | Retest | Skipped | Not-Run

Every unit's verdict MUST be one of the discrete set `Pass | Fail | Blocked | Retest | Skipped | Not-Run`. `Blocked` (un-walkable — a precondition/dependency was down) is NOT `Pass` and NOT `Fail`; `Retest` (non-deterministic, needs a re-run) is NOT `Fail`; `Skipped` (deliberately out of the denominator — consciously out of scope) is distinct from `Not-Run` (in the denominator, never reached this run) which is a coverage gap, NOT a `Pass`. Collapsing `Blocked` / `Not-Run` into `Pass`, or a coverage gap into silence, is BLOCKED.

```text
# DO — a down dependency is Blocked, a never-reached unit is Not-Run
Auth service down → the 12 units behind it are Blocked (not Fail, not Pass).
Runner never reached route /admin/audit → Not-Run (a coverage gap to close, not a pass).

# DO NOT — coerce non-pass verdicts to Pass to hit a green board
"The dependency was down so those 12 units just pass by default." (Blocked→Pass hides
that they were never actually judged)
```

**Why:** A binary pass/fail forces every un-judged unit into one bucket, and "green" absorbs Blocked and Not-Run silently — the exact way a coverage gap masquerades as success. The discrete taxonomy keeps "we couldn't judge this" and "we never got to this" visible and distinct from "this passed".

## MUST NOT

- Assert the floor (compiled / rendered / 200 / no-crash) as the expectation. **Why:** the floor is satisfied by a surface doing the wrong thing; the frozen expectation is the only signal that separates works from runs.
- Wire a non-reproducible LLM/agent verdict as a blocking CI gate. **Why:** a model-in-the-loop gate flips between runs and becomes override-noise; deterministic verdicts gate, semantic ones advise.
- Report a single "100%" that conflates coverage and pass-rate, or hand-list the denominator. **Why:** the denominator silently shrinks to the passing set — fabricated 100% by omission.
- Ship a new unit with no frozen expectation, or let a coverage regression pass the gate. **Why:** freeze-then-judge requires the expectation to precede the unit; without the ratchet, coverage decays every merge.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every touched testable surface's units carry frozen expectations, coverage is reported separately from pass-rate over a machine-derived denominator, and the verdict taxonomy is the discrete set); `advisory` at the hook layer (whether an expectation is frozen-vs-floor and whether a denominator is machine-derived are judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal; a lexical tripwire on `assert(true)` / status-only assertions MAY pair as advisory but MUST NOT carry `block`).
- **Grace period:** 7 days from rule landing (2026-07-16 → 2026-07-23).
- **Cumulative posture impact:** same-class violations (a unit shipped without a frozen expectation, a semantic verdict wired as a blocking gate, coverage conflated with pass-rate, or a non-discrete verdict) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a freeze-then-judge / coverage-honesty property is review-layer-plus-advisory-hook and does not warrant an instant-drop key; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: conformance-walk]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session touching a testable surface and confirm (a) each new unit carries a frozen expectation asserted against observed state, (b) the deterministic oracle is the gate and any semantic verdict is advisory, (c) coverage is reported separately from pass-rate over a machine-derived denominator with the no-vacuous guard, (d) verdicts are from the discrete taxonomy. **Probes: REGISTERED** — `.claude/test-harness/probes/conformance-walk.probes.json` (12 rows, 6 bipolar pairs; fixtures `.claude/audit-fixtures/conformance-walk/`; probe-only, pinned in `probe-suite-integrity.test.mjs`). Registration buys DISPATCHABILITY, never execution — a green CI run is NEVER evidence these probes passed. **Structural detector: ARMED AT LOOM, FENCED FROM CONSUMERS — a co-owner-approved STAGED rollout (2026-09-13).** `.claude/hooks/floor-only-assertion-guard.js` (pure predicates in `.claude/hooks/lib/floor-only-assertion.js`) IS registered in `.claude/settings.json` at `PostToolUse`, matcher `Edit|Write` — the event and matcher its own `@hook-event` header declares, where the written content AND its final path are both settled, MEASURED on this tree against a known-absent control — so AT LOOM it fires. **ARMED is not PROVEN EFFECTIVE:** no armed guard has been OBSERVED firing in a live session; registration and distribution state are all that is measured. **It reaches NO consumer:** the hook file is deliberately fenced `loom_only` in `sync-manifest.yaml` with its required twin in `validate-emit.mjs::LOOM_ONLY_TIER_CARVEOUTS`, so it does not ship — a consumer receives this RULE and not this DETECTOR, enforcement at those targets is GATE-REVIEW at the consumer's end (the Phase-1 sweep above), and the gap is DECLARED in the detector-distribution baseline registry (`detector-distribution-baseline.json`, under the test-harness tree) rather than left silent. **Staged because firing volume is measured on loom's corpus and nowhere else, and a consumer's corpus is a different population.** PROMOTION is deleting this guard's `loom_only:` entry TOGETHER WITH its `LOOM_ONLY_TIER_CARVEOUTS` twin — removing either alone is a defect. Where it does not run, its SILENCE is the absence of an instrument, never a clean verdict (`instrument-discipline.md` MUST-3(a)). It emits `conformance-walk/floor-only-assertion` (a case whose ONLY assertion is the floor — `status < 500`, `assert(true)`, a lone `toBeDefined()`) and `conformance-walk/hand-listed-denominator` (a coverage denominator typed as an integer literal instead of derived from what the run enumerated — the same derived-not-typed contract `instrument-discipline.md` MUST-6(c) states). Severity `advisory`, capped by argument not by default: both verdicts are lexical judgments over code — whether a floor assertion is the ONLY one in its case rests on a case boundary the module INFERS, and whether an integer literal is a coverage denominator is read off an identifier NAME — so `hook-output-discipline.md` MUST-2 forbids `block`, exactly as § Severity above set in advance. Its in-scope path set is DERIVED from this rule's own frontmatter `paths:` plus `zero-tolerance.md` Rule 6's test-file convention, degrading to a declared hand-listed fallback where the corpus is absent. Bipolar fixtures + the fail-open and scope arms: `.claude/audit-fixtures/conformance-walk/floor-*`, driven by `.claude/audit-fixtures/conformance-walk/run.mjs`; the `floor-` prefix namespaces them apart from this rule's probe candidates in the same directory, per `cc-artifacts.md` Rule 9.
- **Invoker class:** `runtime` AND `agent-mid-procedure` — BOTH, so this block does NOT discharge on either alone. Added 2026-09-19 (`journal/0618`): this file's `/codify`-touched edit ends its MUST-8 grandfather for the canonical-field set, and the field was missing. `runtime` is backed by `.claude/hooks/floor-only-assertion-guard.js`, MEASURED registered at `PostToolUse` matcher `Edit|Write` in `.claude/settings.json` — 1 occurrence there and ZERO across the four Codex/Gemini surfaces (`.claude/codex-templates/hooks.json`, `.claude/gemini-templates/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`), each measured against an `integration-hygiene` control returning 1 on all five, so the zeros are readable true negatives and not a dead grep. That runtime arm reaches only the LEXICAL half of MUST-1 and MUST-3 (a floor-only case, a typed coverage denominator) and is silent on MUST-2 and MUST-4 entirely; it is also fenced `loom_only`, so at every consumer the runtime arm is ABSENT and its silence there is the absence of an instrument. `agent-mid-procedure` is reviewer at `/implement` + cc-architect at `/codify`, and at the `platform` role those are REACHABLE-BUT-UNINVOKABLE — the same verdict `issue-triage-routing.md` records for the identical pair. **An earlier revision of this field claimed the opposite ("REACHABLE AND INVOKABLE at `platform`") and it is WITHDRAWN as false.** Its instrument was sound for a DIFFERENT question: neither `agents/quality/reviewer.md` nor `agents/cc-architect.md` carries a `surface_roles` entry, which is true and means the AGENTS are not role-restricted — but what makes the gate-review moment reachable is whether the HOSTING PROCEDURE surfaces, and `commands/implement.md` and `commands/codify.md` are both `[build, use-consumer]`. Reading an agent-restriction check as a procedure-reachability answer is `instrument-discipline.md` MUST-4. The repo's dedicated instrument says so directly: `check-invoker-audience.mjs` reports `/codify platform=NO` and `/implement platform=NO` at this repo's `platform` role. The gate-review arms that ARE invokable here are `/govern` and `/cc-audit`, neither of which carries a `surface_roles` entry, and `/govern` is the lane this rule's own edits travel through.
- **Violation scope:** MUST-1 (frozen expectation vs floor) + MUST-2 (deterministic-load-bearing / semantic-advisory split) + MUST-3 (coverage-separate-from-pass-rate + machine-derived denominator + no-vacuous) + MUST-4 (discrete verdict taxonomy).
- **Origin:** See § Origin.

## Origin

**2026-09-19 — the rule did not load when loom authored its OWN gates (`journal/0618`, MOVE 1).**
Frontmatter `paths:` reached a consumer's conformance trees and nothing at loom, so the rule
mandating freeze-then-judge was structurally absent at the moment a gate was written — the
reachability class `issue-triage-routing.md` and `agents.md`'s worktree clause were each authored
to close. Six root-anchored globs were added for loom's own enforcement surface; the consumer
globs were KEPT, because the three that match zero files HERE are the ones that reach a consumer's
trees. **The premise was MEASURED against Claude Code's own loader, not argued from convention** — all
six inject on their own trigger path, though the WITHHOLDING pole was established for ONE glob and
the other five are controlled positives, so "all six" is one controlled instance plus five
uncontrolled positives generalized across the single FORM under test: an inference, not a per-row
measurement. The prior in-corpus S20 measurement covered only leading-`**/` and was never evidence
about this form. **Editing that
glob set is UNMEASURED by `check-rule-injection-budget.mjs`** — the rule fires in 0 of its 8
PROFILES before and after, so its silence is the absence of an instrument, never a green, and the
rule is charged WHOLE to every session touching one of the six paths: measure an addition with the
tool's own `matchingGlobs`. A session PROFILE for this surface is the mechanical fix and is NOT
BOOKED — no issue, no deferral row, no acceptor — which the depth records as a gap rather than a
plan. This
frontmatter is ALSO `hooks/lib/floor-only-assertion.js`'s scope authority, so one edit has two
effects. Probe method, the per-glob results and exactly which pole each one has, the leading-`/` refusal, the byte
accounting and the enqueued work: `skills/conformance-walk/loom-self-application.md`.

2026-07-16 — loom origination (#1146), generalizing two independently-converged instances of one meta-pattern: the Symbol Conformance Matrix (SCM — renamed the Source Conformance Matrix under CW-SDL, the SOURCE-family reference adapter; a static-symbol/BE verification method in a BUILD SDK repo) and the Transition-Oracle Walk (TOW, #1137, a route/interaction/FE eval-harness in a downstream consumer). The four MUST clauses are the surface-agnostic core; each surface supplies its own adapter per `skills/conformance-walk/SKILL.md`. #1137 is re-scoped as CW's route/interaction (FE) adapter, not closed. Co-owner-directed origination per `rules/artifact-flow.md` § Co-Owner-Directed Origination; receipt-first DECISION `journal/0518`. Core-extraction evidence (six shared elements, file:line-grounded from both instances) in the design study; the specific instance provenance stays in the local receipt per `knowledge-cascade-routing.md` MUST-3.

**CW-SDL generalization (2026-07-21, loom #1218).** The flat BE/FE model above generalized to the current **CW-SDL** shape (Conformance Walk — Source / Delivered / Live): ONE surface-agnostic core (`cw_core`) + three oracle families on the delivery axis, with **DELIVERED** (DCM/FCM) the first-class MIDDLE family the flat model lacked and the delivery-gap thesis its motivation. The four MUST clauses GENERALIZE unchanged in intent across all three families. Evidence: the **kailash-rs reference implementation** — `cw_core` (surface-agnostic core + a `record.schema.json` v1.0.0 / Draft-2020-12 JSON-schema interop boundary) and the DELIVERED adapter's five lenses (landed as the FCM gate, kailash-rs #1918); referenced conceptually per `rules/spec-accuracy.md` (the impl lives in another repo — no loom-local file:line citation). Ground-truth research (cited by path): `(loom-internal reference){10-conformance-walk-core-design.md, 14-dcm-build-on-and-loom-cw-design.md, 15-codegen-conformance-best-practices.md}`.
