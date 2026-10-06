# `burn-down-reporting.md` — extended reference

Depth for `.claude/rules/burn-down-reporting.md`. Not baseline-emitted; `cc`-tier, so it reaches
every USE template and BUILD repo alongside the rule. The rule body carries every MUST, MUST NOT,
BLOCKED-rationalization entry, DO/DO-NOT block and `**Why:**` line, plus all eight canonical
Trust-Posture Wiring field labels with their normative statements. Everything below — motivating
narrative, per-BLOCKED rationale, the Detection-mechanism measured narrative, the Wiring reasoning,
the cross-reference map and the Origin narrative — lives here, where it is not injected into any
path-scoped profile.

The sibling `burndown-integrity.md` extract is a DIFFERENT rule: that one governs a figure's
PROVENANCE (a generated block from a declared source manifest); this one governs WHETHER a close-out
reports cleared/remains/delta at all.

## Why activity is not a burn-down

At the close of a session or a wave the agent naturally reports ACTIVITY: what it did, what it merged, what it learned. Activity is unbounded and self-flattering — a session that merged 14 PRs and left 63 issues open reads as a triumph, and the reader cannot tell whether the outstanding surface SHRANK, held, or GREW. The number that answers that question is never volunteered, because producing it means counting what remains, which is the least pleasant measurement available.

The rule's own framing sentence, extracted from the same paragraph: it "makes it compulsory at every
session close and every wave close, and fixes where it lives so it does not collide with the
deliberately verification-free `.session-notes` surface."

## MUST-2 depth

The rule body states the four BLOCKED sources and the prior-close carve-out. Each leans on a
different authority, and the differences matter when adjudicating a borderline figure:

- **A count reconstructed across a context boundary** — `verify-claims-before-write.md` MUST-2
  presumes exactly that source false.
- **A count recalled from memory within one session** is BLOCKED on this rule's own authority:
  MUST-2 there names context-boundary reconstructions and truncated output, not plain same-session
  recall.
- **A count copied forward from a prior session's notes** is BLOCKED for a different and weaker
  reason: a fresh read of a durable file is not presumed-false _about the file_, it is simply STALE
  about the world — the notes record what was true when written, and the burn-down's whole subject
  is what is true now.
- **The prior-close baseline carve-out.** A baseline MAY come from a PRIOR close because a
  historical residual is not re-derivable by any command run now, and MUST-1's whole purpose is a
  trajectory readable ACROSS `/clear` boundaries. The carve-out is conditioned — measured,
  instrument-named, SHA/timestamp-pinned in a DURABLE receipt (a journal entry or commit body), and
  CITED by the report — precisely because those conditions are what distinguish a historical
  measurement from a recollection wearing its grammar. A baseline taken from `.session-notes` or
  from memory stays BLOCKED.

## MUST-3 depth

**Scope — this prohibits the BURN-DOWN, not every number, and the exempt counts sit ON the fenced
surface.** The clause fences the three-quantity burn-down (MUST-1) off `.session-notes` ONLY.
`commands/wrapup.md` § Wave tracker REQUIRES a memory-sourced POINTER line carrying counts
(`wave X/N, K agents in flight, M PRs merged`) **in the `.session-notes` Wave-tracker section
itself** — one of that file's four always-present sections — while wave DETAIL lives in the
gitignored `.wave-tracker.d/<display_id>.md`. Those pointer counts are mandated, are pointer-scale
not burn-down-scale, and are explicitly OUT of this clause's scope **even though they sit on the
fenced surface**; dropping them because "MUST-3 forbids counts here" is BLOCKED and breaks a
mandated section.

The permitted burn-down surfaces — session-close / wave-close report, wave-close commit or journal
entry, `/sweep` decision report — are permitted because they are "surfaces where measurement is
permitted and expected."

The `commands/wrapup.md` § Hard rules the fence rests on are "No quantitative claims", the
4-tool-call cap, and the memory-only sourcing constraint.

## Wiring depth

**Severity — the verbatim gate-review confirm-scope.** `halt-and-report` at gate-review: "reviewer
at `/redteam` + cc-architect at `/codify` confirm the session's and each wave's close carried a
three-quantity burn-down whose every figure names an in-session instrument, and that no counted
burn-down was written into `.session-notes`". `advisory` at the hook layer per
`hook-output-discipline.md` MUST-2 — whether a close-out report constitutes a burn-down is a
semantic judgment over prose, with no structural tool-call-time signal, so a lexical detector MUST
NOT carry `block`.

**Regression-within-grace — why no dedicated key.** Whether a close-out report is a burn-down is a
review-layer semantic judgment that does not warrant an instant-drop key, and minting one would drag
`trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit;
the universal trigger already covers it. The same no-dedicated-key disposition
`orchestration-launch-ledger.md`, `knowledge-cascade-routing.md`, and `security.md`
§ Enforcement-Surface Parity took.

## Detection depth

**The Phase-1 sweep, verbatim.** Reviewer at `/redteam` + cc-architect at `/codify` inspect any
session that closed a wave or the session itself and confirm "(a) the close-out report carries
CLEARED + REMAINS + DELTA on the same axes as its stated baseline, including axes that did not move,
(b) every figure names an in-session instrument and the baseline is pinned to a SHA/timestamp,
(c) `.session-notes` carries no counted burn-down."

**The reachability residual, recorded rather than papered over.** These two gate-review surfaces are
the ONLY detectors — `commands/wrapup.md` carries NO burn-down self-check, so nothing fires at
close-out itself. A one-line memory-only recall bullet there was authored and then WITHDRAWN:
`wrapup.md` sits at a ratified 168-body-line cap (`journal/0543`) and the bullet made it 169, and
`cc-artifacts.md` Rule 3(c)'s named-rationale escape — the sanctioned mechanism for exactly this —
was deliberately NOT invoked: raising a ratified ceiling in the same change that needs the extra line
is self-serving, so the reference was dropped instead. That is a judgment call, not a rule-compelled
outcome, and it is recorded as one.

The honest consequence is that a session which never touches a `paths:` surface can close without
this rule ever loading. The mitigation is the `paths:` set, which now includes
`**/.session-notes.d/**` and `**/.wave-tracker*` — `/wrapup` writes the first and `wave-loop.md` G2
writes the second, so any session reaching a real close-out fires the rule. A session that edits only
`src/` and closes does NOT.

**Fixture + probe coverage, and the MUST-4 citation tension.** Fixtures at
`.claude/audit-fixtures/burn-down-reporting/` are **bipolar per PROBED PAIR (MUST-1, MUST-2,
meta-compliance), NOT per MUST: MUST-3 ships NO fixture pair and NO probe row, and is covered by
gate-review only.** That is deliberate — `coc-artifact-eval-coverage.md` MUST-1's per-type mandate
for `type: rule` is a set of PROPERTIES (efficacy + no-false-positive + meta-compliance), all three of
which ship bipolarly, not a pair per clause; MUST-3 is nonetheless this rule's most novel clause, so
the omission is recorded here rather than left to be inferred from the fixture listing.

The probe suite's SIX rows sit in THREE pairs: MUST-1 efficacy + no-false-positive; MUST-2 efficacy +
no-false-positive; meta-compliance compliant + violation.

Fixtures are named per `coc-artifact-eval-coverage.md` MUST-4, which REQUIRES the Detection block to
cite the fixtures directory. Note the standing tension that mandate creates with judge hygiene: the
probe prompt instructs the judge to read this rule as a governing document, so naming the directory
there hands a tool-enabled judge a path from which the pole of its own candidate could be read
(`artifact-probe-adapter.mjs` renders no candidate identity precisely to prevent that). The tension is
architectural and shared by every probed rule, not specific to this one; do NOT resolve it by dropping
the citation, which MUST-4 blocks.

**The deferred Phase-2 detector, as designed.** An advisory `Stop` detector flagging a close-out
report carrying merge/close counts with no adjacent residual figure; audit fixtures for it land WITH
the detector per `cc-artifacts.md` Rule 9.

## Distinct From / Cross-References

- **Distinct from** `wave-loop.md` MUST-5 (wave-boundary claims cite durable receipts) — that governs whether a convergence CLAIM is evidenced; this governs whether the close-out reports the residual SURFACE at all. A wave can cite perfect receipts and still never say what remains.
- **Distinct from** `product-completion-first.md` MUST-4 (`/sweep` surfaces the triage + decision points) — that governs the DISPOSITION of findings; this governs the COUNT of the surface. `/sweep` is one of the permitted burn-down surfaces (MUST-3), not a substitute for the obligation.
- **Composes with** `value-prioritization.md` MUST-2 (deferred items carry value-anchors) — the ledger says WHY an item still matters; the burn-down says HOW MANY are left.
- **Binds** `verify-claims-before-write.md` MUST-2 (context-boundary reconstructions presumed false) and `instrument-discipline.md` MUST-1 (name the falsifying result) at the burn-down-figure surface; MUST-2 here is those two applied to counts.
- **Bounded by** `commands/wrapup.md` § Hard rules — MUST-3 exists precisely to keep this rule from breaking the wrapup surface's memory-only contract.

## Origin — full narrative

2026-08-02 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination), verbatim in-session directive: _"there are w0 to w8 in this sprint, parallelize at max velocity safely and always report the burndown and remaining surface at the end of every wave/session."_ Recorded as the W0-d lane of (loom-internal reference) § STANDING DIRECTIVE, which states the obligation but is a NON-CASCADING notes surface — per `knowledge-cascade-routing.md` MUST-1 a behavioural directive applying to every agent in every repo belongs in a COC artifact, so W0-d exists to route it there. Triggering observation: session 5 closed reporting fourteen merged PRs (activity) while sixty-three issues, two PRs, and thirty-five invisible local-only commits remained (residual), and no delta was ever stated.

Authored `priority: 10` + `scope: path-scoped` + `cli_delivery: skill-channel` under the measured saturated-baseline constraint — the same disposition `orchestration-launch-ledger.md` and `command-skill-parity.md` took for identical saturation (`knowledge-cascade-routing.md` shares the priority/scope choice but declares no `cli_delivery:` key, so it is precedent for the scoping only), path-scoped to the workspace / session-notes / todos / journal surfaces where session-and-wave close-out work lives.
