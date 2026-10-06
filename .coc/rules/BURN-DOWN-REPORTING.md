---
id: "BURN-DOWN-REPORTING"
paths: ["**/workspaces/**", "**/.session-notes*", "**/.session-notes.d/**", "**/.wave-tracker*", "**/.wave-tracker.d/**", "**/todos/**", "journal/**"]
---

# Burn-Down Reporting — A Number Against A Number, Every Session And Every Wave

Depth companion — cited below as **the extract** — is `.claude/guides/rule-extracts/burn-down-reporting.md`: § Why activity is not a burn-down, per-BLOCKED rationale, Wiring reasoning, cross-refs, Origin.

A **burn-down** is three quantities against one baseline: what was CLEARED, what REMAINS, and the DELTA. It is a measurement, not a narrative. This rule makes it compulsory at every session close and every wave close, and fixes where it lives (MUST-3).

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

Every number in a burn-down MUST be produced by a command run in the SAME session as the report, and the report MUST name the instrument that produced it. A count reconstructed across a context boundary is BLOCKED. A count recalled from memory within one session is BLOCKED on this rule's own authority. A count copied forward from a prior session's notes is BLOCKED. The baseline the delta is measured against MUST likewise be a measured number with its own named instrument and a pinned SHA or timestamp. **A baseline MAY come from a PRIOR close** — but ONLY if that figure was itself measured, instrument-named, and SHA/timestamp-pinned in a DURABLE receipt (a journal entry or commit body), and the report CITES that receipt. A baseline taken from `.session-notes` or from memory stays BLOCKED. Per-source authority + the carve-out's rationale: extract § MUST-2 depth.

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

The burn-down belongs in the agent's session-close / wave-close REPORT to the human, the wave-close commit or journal entry, or the `/sweep` decision report. It MUST be produced BEFORE `/wrapup` runs. It MUST NOT be written into `.session-notes` / `.session-notes.d/<id>.md`: that file is a verification-FORBIDDEN pointer surface (`commands/wrapup.md` § Hard rules), and a measured burn-down cannot be produced there without breaking its contract.

**Scope — this prohibits the BURN-DOWN, not every number.** The clause fences the three-quantity burn-down (MUST-1) off `.session-notes` ONLY. `commands/wrapup.md` § Wave tracker REQUIRES a memory-sourced POINTER line carrying counts (`wave X/N, K agents in flight, M PRs merged`) **in the `.session-notes` Wave-tracker section itself**. Those pointer counts are mandated, are pointer-scale not burn-down-scale, and are explicitly OUT of this clause's scope **even though they sit on the fenced surface**; dropping them because "MUST-3 forbids counts here" is BLOCKED and breaks a mandated section. Full fenced-surface detail: extract § MUST-3 depth.

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

.session-notes.d/<operator>.md: "49 issues remaining, 14 merged this session"
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

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify`, sweep per § Detection mechanism below); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — a lexical detector MUST NOT carry `block`. Reasoning + the verbatim confirm-scope: extract § Wiring depth.
- **Grace period:** 7 days from rule landing (2026-08-02 → 2026-08-09).
- **Cumulative posture impact:** same-class violations (a session or wave closed on an activity-only report; a burn-down figure recalled rather than measured; a counted burn-down written into `.session-notes`) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation from the canonical key-per-clause shape, recorded per `trust-posture.md` Rule 8. Reasoning + sibling precedents: extract § Wiring depth.
- **Receipt requirement:** SessionStart soft-gate `[ack: burn-down-reporting]` IFF `posture.json::pending_verification` includes the `burn-down-reporting` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` inspect any session that closed a wave or the session itself and confirm MUST-1, MUST-2 and MUST-3 hold of its close-out report. Fixtures: `.claude/audit-fixtures/burn-down-reporting/` — **bipolar per PROBED PAIR (MUST-1, MUST-2, meta-compliance), NOT per MUST; MUST-3 is gate-review-covered only.** Probes: `.claude/test-harness/probes/burn-down-reporting.probes.json` — a bipolar SIX-row suite in THREE pairs, registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`), dispatched at gate-review via `/test-harness-probe`, deliberately NOT in CI (the loom↔csq boundary keeps CI LLM-free). **Detector ARMED (2026-09-18)** — `.claude/hooks/residual-figure-guard.js` (pure predicates in `.claude/hooks/lib/residual-figure.js`) is REGISTERED in `.claude/settings.json` at the `Stop` event it was authored for, so it loads and fires at close-out. It fires when a close-out reply prints cleared counts and names no residual — identity `burn-down-reporting/close-out-without-residual`, severity `advisory`, capped there because every half of the check is a lexical read of the agent's own prose and `hook-output-discipline.md` MUST-2 forbids `block` on a lexical signal. The Phase-1 GATE-REVIEW sweep above therefore remains the enforcement layer of record, and the reachability residual named there is NARROWED by this hook rather than closed — a session that closes without loading this rule still reaches `Stop`, but MUST-2's measured-figure clause and MUST-3's `.session-notes` prohibition stay gate-review-covered. MUST-2's measured-figure clause and MUST-3's `.session-notes` prohibition stay gate-review-covered. Fixtures ship WITH it per `cc-artifacts.md` Rule 9: `.claude/audit-fixtures/burn-down-reporting/residual-*.txt` driven by `residual-run.mjs`, bipolar on every scope predicate. Depth ((a)/(b)/(c) sweep verbatim, residual record, pair composition, coverage rationale + MUST-4 citation tension, detector design): extract § Detection depth. Detection-mechanism depth — the arming records, the five-surface registration measurements with their firing controls, the withdrawn revisions and the declared blind spots — lives in `skills/32-trust-posture/invoker-class-rollout-provenance.md`.
- **Invoker class:** `runtime` AND `agent-mid-procedure` — BOTH, so this block does NOT discharge the role-blind question, and is not meant to. `runtime` is backed by `.claude/hooks/residual-figure-guard.js`, registered at `Stop` in `.claude/settings.json` (MEASURED 1, against the `integration-hygiene` control returning 1 in all five surfaces), which fires MUST-1's close-out check at tool-call time with no command typed — at CC ONLY, and at NO Codex or Gemini audience. MUST-2's measured-figure clause and MUST-3's `.session-notes` prohibition have NO self-firing invoker at all: they bottom out in reviewer at `/redteam` + cc-architect at `/codify`, and `.claude/sync-manifest.yaml:5665-5679` scopes both commands to `[build, use-consumer]`, so at the `platform` role they are REACHABLE-BUT-UNINVOKABLE and that finding correctly stands.
- **Violation scope:** MUST-1 (activity-only close; a dropped flat/worsening axis) + MUST-2 (unmeasured or non-discriminating figure) + MUST-3 (counted burn-down on the `.session-notes` surface). Every `violations.jsonl` row names the close-out surface and the missing quantity.
- **Origin:** See § Origin.

## Distinct From / Cross-References

The full Distinct-From / Composes-With / Binds / Bounded-By map is extract § Distinct From / Cross-References, covering `wave-loop.md` MUST-5, `product-completion-first.md` MUST-4, `value-prioritization.md` MUST-2, `verify-claims-before-write.md` MUST-2, `instrument-discipline.md` MUST-1 and `commands/wrapup.md` § Hard rules.

## Origin

2026-08-02 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination); the verbatim in-session directive is the W0-d lane of (loom-internal reference) § STANDING DIRECTIVE. Quote, triggering observation, routing rationale and the saturated-baseline authoring decision: extract § Origin — full narrative.

**Extraction record — 2026-08-19 structural cleanup, ZERO de-scoping.** Every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and the failure-mode statement of every `**Why:**` line stayed here verbatim; the Wiring keeps all eight canonical field labels with their normative statements. Depth moved verbatim to the extract, § headings cited at each site. **`rule-authoring.md` Rule 10 / Rule 11 do NOT fire** — Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is `scope: path-scoped`, so this is STRUCTURAL CLEANUP, not a Rule-10 paired extraction and therefore not Rule-11 recurrence input (`journal/0148` disposition).
