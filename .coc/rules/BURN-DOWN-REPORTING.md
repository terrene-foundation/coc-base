---
id: "BURN-DOWN-REPORTING"
paths: ["**/workspaces/**", "**/.session-notes*", "**/.session-notes.d/**", "**/.wave-tracker*", "**/.wave-tracker.d/**", "**/todos/**", "journal/**"]
---

# Burn-Down Reporting — A Number Against A Number, Every Session And Every Wave

At the close of a session or a wave the agent naturally reports ACTIVITY: what it did, what it merged, what it learned. Activity is unbounded and self-flattering — a session that merged 14 PRs and left 63 issues open reads as a triumph, and the reader cannot tell whether the outstanding surface SHRANK, held, or GREW. The number that answers that question is never volunteered, because producing it means counting what remains, which is the least pleasant measurement available.

A **burn-down** is three quantities against one baseline: what was CLEARED, what REMAINS, and the DELTA. It is a measurement, not a narrative. This rule makes it compulsory at every session close and every wave close, and fixes where it lives so it does not collide with the deliberately verification-free `.session-notes` surface.

## MUST Rules

### 1. Every Session Close And Every Wave Close Reports Cleared / Remains / Delta

At the end of EVERY session AND at the close of EVERY wave (the `wave-loop.md` MUST-2 inter-wave gate, and the terminal wave alike), the agent MUST report a burn-down carrying all THREE quantities against a stated baseline:

1. **CLEARED** — issues closed, PRs merged, branches landed, items closed, **with counts**.
2. **REMAINS** — the FULL residual surface, counted on the SAME axes as the baseline (not only the axes that improved).
3. **DELTA** — the change against the baseline total, per axis: `63 → 49 issues · 35 → 0 local commits · 2 → 1 PRs`.

Reporting only what was done, or reporting CLEARED without REMAINS, or reporting both without the explicit per-axis delta, is BLOCKED. An axis that did NOT move is still reported (`63 → 63`); silently dropping a flat or worsening axis is the failure mode this clause blocks.

```markdown
# DO — three quantities, same axes, explicit delta

Burn-down (baseline: session start @ `0c5b3daa`)
| axis | start | now | delta |
| open issues | 63 | 49 | **−14** |
| open PRs | 2 | 1 | **−1** |
| local-only commits | 35 | 0 | **−35** |
| unresolved design disputes | 1 | 1 | **0** (FENCE, still open) |

# DO NOT — activity narrative with no residual and no delta

"Strong session: merged 14 PRs, closed the base-red suites, landed the wave plan."
(the reader cannot tell whether the outstanding surface shrank, held, or grew)
```

**BLOCKED rationalizations:**

- "We merged 14 PRs" as the report (that is ACTIVITY, not burn-down)
- "The remaining work is in the ledger / the issue tracker, the reader can look"
- "The residual didn't change much, so the delta isn't interesting"
- "Counting what remains is expensive at the end of a long session"
- "The wave was small, a burn-down is ceremony for one lane"
- "I'll report the burn-down at the end of the sprint instead of per wave"
- "The axes that moved are the informative ones" (a flat or worsening axis is the informative one)

**Why:** Without the residual and the delta, a report of activity is unfalsifiable as progress — a session can merge fourteen PRs while the outstanding surface grows, and nothing in the narrative reveals it. The three-quantity shape is what makes the sprint's trajectory readable across `/clear` boundaries, and reporting the flat axes is what stops the burn-down degenerating into a highlight reel.

### 2. Every Burn-Down Count Is MEASURED In-Session And Names Its Instrument

Every number in a burn-down MUST be produced by a command run in the SAME session as the report, and the report MUST name the instrument that produced it. A count reconstructed across a context boundary is BLOCKED — `verify-claims-before-write.md` MUST-2 presumes exactly that source false. A count recalled from memory within one session is BLOCKED on this rule's own authority: MUST-2 there names context-boundary reconstructions and truncated output, not plain same-session recall. A count copied forward from a prior session's notes is BLOCKED for a different and weaker reason: a fresh read of a durable file is not presumed-false _about the file_, it is simply STALE about the world — the notes record what was true when written, and the burn-down's whole subject is what is true now. The baseline the delta is measured against MUST likewise be a measured number with its own named instrument and a pinned SHA or timestamp. **A baseline MAY come from a PRIOR close** — a historical residual is not re-derivable by any command run now, and MUST-1's whole purpose is a trajectory readable ACROSS `/clear` boundaries — but ONLY if that figure was itself measured, instrument-named, and SHA/timestamp-pinned in a DURABLE receipt (a journal entry or commit body), and the report CITES that receipt. A baseline taken from `.session-notes` or from memory stays BLOCKED.

Where the instrument cannot discriminate — a count that would read the same whether the proposition were true or false — the burn-down MUST say so rather than print the number (`instrument-discipline.md` MUST-1).

```bash
# DO — measured, instrument named, baseline pinned
gh issue list --state open --limit 200 --json number | node -e '…length'   # 49 open @ 2026-08-02
git ls-remote --exit-code --heads origin "$b"                              # local-only: 0 of 10 branches

# DO NOT — recalled, or counted with a non-discriminating instrument
"about 50 issues left"                       # memory; presumed false
git status --porcelain | wc -l               # empty on "nothing done" AND on "all committed"
```

**BLOCKED rationalizations:**

- "The number was measured earlier this session, it hasn't moved"
- "The prior session's notes carry the count"
- "An approximate count communicates the trend just as well"
- "`/wrapup` will verify it" (`/wrapup` is verification-FORBIDDEN — see MUST-3)
- "The command exited 0, so the count is good" (exit 0 is not discrimination)

**Why:** A burn-down's entire value is that it is a measurement; an unmeasured count is a narrative wearing the grammar of a number, and it is the one form of narrative the reader has no way to challenge. Naming the instrument makes each figure independently re-derivable by the next session, which is what lets the NEXT burn-down use it as a baseline.

### 3. The Burn-Down Is A REPORT Surface, Not A `.session-notes` Section

The burn-down belongs in the agent's session-close / wave-close REPORT to the human, the wave-close commit or journal entry, or the `/sweep` decision report — surfaces where measurement is permitted and expected. It MUST be produced BEFORE `/wrapup` runs. It MUST NOT be written into `.session-notes` / `.session-notes.d/<id>.md`: that file is a verification-FORBIDDEN pointer surface (`commands/wrapup.md` § Hard rules — "No quantitative claims", 4-tool-call cap, memory-only), and a measured burn-down cannot be produced there without breaking its contract.

**Scope — this prohibits the BURN-DOWN, not every number, and the exempt counts sit ON the fenced surface.** The clause fences the three-quantity burn-down (MUST-1) off `.session-notes` ONLY. `commands/wrapup.md` § Wave tracker REQUIRES a memory-sourced POINTER line carrying counts (`wave X/N, K agents in flight, M PRs merged`) **in the `.session-notes` Wave-tracker section itself** — one of that file's four always-present sections — while wave DETAIL lives in the gitignored `.wave-tracker.d/<display_id>.md`. Those pointer counts are mandated, are pointer-scale not burn-down-scale, and are explicitly OUT of this clause's scope **even though they sit on the fenced surface**; dropping them because "MUST-3 forbids counts here" is BLOCKED and breaks a mandated section.

```markdown
# DO — the mandated pointer counts stay IN the notes; only the burn-down is fenced

.session-notes.d/<id>.md § Wave tracker:
→ `.wave-tracker.d/<id>.md` — wave 3/9, 4 agents in flight, 2 PRs merged ← mandated, unaffected

# DO NOT — read MUST-3 as a ban on the mandated pointer counts

"MUST-3 forbids counts in the notes, so I am omitting the Wave tracker's K and M."
```

```markdown
# DO — burn-down in the session-close report / wave-close journal entry, measured, BEFORE /wrapup

[session report] Burn-down: 63 → 49 issues (…instruments…) → then run /wrapup

# DO NOT — a counted burn-down inside .session-notes

.session-notes.d/esperie.md: "49 issues remaining, 14 merged this session"
(quantitative claim on a memory-only surface; either the number is unverified
or the 4-tool-call cap was broken to verify it)
```

**BLOCKED rationalizations:**

- "The notes are where the next session looks, so the burn-down belongs there"
- "I'll verify the counts and then write them into the notes" (that breaks the `/wrapup` tool-call cap)
- "A count in the notes is fine if it was measured earlier"
- "`.session-notes` already carries an outstanding ledger, so a count fits"

**Why:** `.session-notes` is deliberately memory-only and verification-free so a wrapup cannot cascade into a verification pass; a measured burn-down written there is either an unverified number (defeating MUST-2) or a broken wrapup contract. Separating the surfaces keeps both intact — the ledger points at the residual, the burn-down counts it.

## MUST NOT

- Report a session or wave close with activity only — no residual, no delta

**Why:** The originating failure mode: activity is unbounded and self-flattering, and it hides whether the outstanding surface shrank, held, or grew.

- Print a burn-down number that was recalled, carried forward, or produced by an instrument that cannot discriminate

**Why:** An unmeasured count is a narrative in the grammar of a measurement, and the reader has no way to challenge it.

- Write a counted burn-down into `.session-notes`

**Why:** That surface is memory-only and verification-forbidden by contract; a count there is either unverified or was produced by breaking the wrapup tool-call cap.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` confirm the session's and each wave's close carried a three-quantity burn-down whose every figure names an in-session instrument, and that no counted burn-down was written into `.session-notes`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a close-out report constitutes a burn-down is a semantic judgment over prose, with no structural tool-call-time signal, so a lexical detector MUST NOT carry `block`.
- **Grace period:** 7 days from rule landing (2026-08-02 → 2026-08-09).
- **Cumulative posture impact:** same-class violations (a session or wave closed on an activity-only report; a burn-down figure recalled rather than measured; a counted burn-down written into `.session-notes`) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (whether a close-out report is a burn-down is a review-layer semantic judgment that does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `orchestration-launch-ledger.md`, `knowledge-cascade-routing.md`, and `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: burn-down-reporting]` IFF `posture.json::pending_verification` includes the `burn-down-reporting` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` inspect any session that closed a wave or the session itself and confirm (a) the close-out report carries CLEARED + REMAINS + DELTA on the same axes as its stated baseline, including axes that did not move, (b) every figure names an in-session instrument and the baseline is pinned to a SHA/timestamp, (c) `.session-notes` carries no counted burn-down. **Reachability residual, recorded rather than papered over:** these two gate-review surfaces are the ONLY detectors — `commands/wrapup.md` carries NO burn-down self-check, so nothing fires at close-out itself. A one-line memory-only recall bullet there was authored and then WITHDRAWN: `wrapup.md` sits at a ratified 168-body-line cap (`journal/0543`) and the bullet made it 169, and `cc-artifacts.md` Rule 3(c)'s named-rationale escape — the sanctioned mechanism for exactly this — was deliberately NOT invoked: raising a ratified ceiling in the same change that needs the extra line is self-serving, so the reference was dropped instead. That is a judgment call, not a rule-compelled outcome, and it is recorded as one. The honest consequence is that a session which never touches a `paths:` surface can close without this rule ever loading. The mitigation is the `paths:` set, which now includes `**/.session-notes.d/**` and `**/.wave-tracker*` — `/wrapup` writes the first and `wave-loop.md` G2 writes the second, so any session reaching a real close-out fires the rule. A session that edits only `src/` and closes does NOT. Scanner: none (semantic, not a structural signal). Fixtures: `.claude/audit-fixtures/burn-down-reporting/` — **bipolar per PROBED PAIR (MUST-1, MUST-2, meta-compliance), NOT per MUST: MUST-3 ships NO fixture pair and NO probe row, and is covered by gate-review only.** That is deliberate — `coc-artifact-eval-coverage.md` MUST-1's per-type mandate for `type: rule` is a set of PROPERTIES (efficacy + no-false-positive + meta-compliance), all three of which ship bipolarly, not a pair per clause; MUST-3 is nonetheless this rule's most novel clause, so the omission is recorded here rather than left to be inferred from the fixture listing. Fixtures are named per `coc-artifact-eval-coverage.md` MUST-4, which REQUIRES the Detection block to cite the fixtures directory. Note the standing tension that mandate creates with judge hygiene: the probe prompt instructs the judge to read this rule as a governing document, so naming the directory here hands a tool-enabled judge a path from which the pole of its own candidate could be read (`artifact-probe-adapter.mjs` renders no candidate identity precisely to prevent that). The tension is architectural and shared by every probed rule, not specific to this one; do NOT resolve it by dropping the citation, which MUST-4 blocks. Probes: `.claude/test-harness/probes/burn-down-reporting.probes.json` — a bipolar suite of SIX rows in THREE pairs (MUST-1 efficacy + no-false-positive; MUST-2 efficacy + no-false-positive; meta-compliance compliant + violation), registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`) and dispatched at gate-review via `/test-harness-probe`; it is deliberately NOT in CI (the loom↔csq boundary keeps CI LLM-free). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `Stop` detector flagging a close-out report carrying merge/close counts with no adjacent residual figure; audit fixtures for it land WITH the detector per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (activity-only close; a dropped flat/worsening axis) + MUST-2 (unmeasured or non-discriminating figure) + MUST-3 (counted burn-down on the `.session-notes` surface). Every `violations.jsonl` row names the close-out surface and the missing quantity.
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Distinct from** `wave-loop.md` MUST-5 (wave-boundary claims cite durable receipts) — that governs whether a convergence CLAIM is evidenced; this governs whether the close-out reports the residual SURFACE at all. A wave can cite perfect receipts and still never say what remains.
- **Distinct from** `product-completion-first.md` MUST-4 (`/sweep` surfaces the triage + decision points) — that governs the DISPOSITION of findings; this governs the COUNT of the surface. `/sweep` is one of the permitted burn-down surfaces (MUST-3), not a substitute for the obligation.
- **Composes with** `value-prioritization.md` MUST-2 (deferred items carry value-anchors) — the ledger says WHY an item still matters; the burn-down says HOW MANY are left.
- **Binds** `verify-claims-before-write.md` MUST-2 (context-boundary reconstructions presumed false) and `instrument-discipline.md` MUST-1 (name the falsifying result) at the burn-down-figure surface; MUST-2 here is those two applied to counts.
- **Bounded by** `commands/wrapup.md` § Hard rules — MUST-3 exists precisely to keep this rule from breaking the wrapup surface's memory-only contract.

## Origin

2026-08-02 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination), verbatim in-session directive: _"there are w0 to w8 in this sprint, parallelize at max velocity safely and always report the burndown and remaining surface at the end of every wave/session."_ Recorded as the W0-d lane of (loom-internal reference) § STANDING DIRECTIVE, which states the obligation but is a NON-CASCADING notes surface — per `knowledge-cascade-routing.md` MUST-1 a behavioural directive applying to every agent in every repo belongs in a COC artifact, so W0-d exists to route it there. Triggering observation: session 5 closed reporting fourteen merged PRs (activity) while sixty-three issues, two PRs, and thirty-five invisible local-only commits remained (residual), and no delta was ever stated.

Authored `priority: 10` + `scope: path-scoped` + `cli_delivery: skill-channel` under the measured saturated-baseline constraint — the same disposition `orchestration-launch-ledger.md` and `command-skill-parity.md` took for identical saturation (`knowledge-cascade-routing.md` shares the priority/scope choice but declares no `cli_delivery:` key, so it is precedent for the scoping only), path-scoped to the workspace / session-notes / todos / journal surfaces where session-and-wave close-out work lives.
