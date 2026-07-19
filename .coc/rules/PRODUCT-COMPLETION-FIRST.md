---
id: "PRODUCT-COMPLETION-FIRST"
paths: [".claude/commands/**", ".claude/rules/**"]
---

# Product-Completion-First — Triage Gate Findings By CATEGORY, Not Severity

Red-team runs in every phase / wave / session and stays — it is good practice. But grinding
_every_ surfaced finding to convergence spends most of the budget on the lowest-value increments,
so weeks pass with no complete, visible product to show. The fix is not to weaken red-team (every
reviewer still RUNS every round — the errored/empty-reviewer evidence gate is unchanged). The fix
is to triage the **disposition of findings** by CATEGORY: findings that block completion are fixed
now; polish that does not block completion is documented, tracked, and revisited at the right
juncture (product-visible, or on demand).

**Severity (CRIT/HIGH/MED/LOW) is a ranking + reporting attribute ONLY — it NEVER gates
fix-vs-defer.** A LOW-severity bug still blocks completion and is fixed now; a MED-severity polish
item with no forward-impact is deferred. The gate is the category, not the severity.

This is mature-agile practice adapted for autonomous COC codegen: labor is ~10× cheaper and
parallel (`rules/autonomous-execution.md`), so the scarce resource this protects is
**convergence-attention + context-budget**, never labor. The honest reason to defer an increment is
"it would overflow this wave's convergence-attention budget," NEVER "we don't have time"
(`rules/time-pressure-discipline.md` — procedure drops stay BLOCKED). Depth (the full classifier
walkthrough, the `/sweep` report contract, worked examples) lives in `.claude/skills/sweep/`.

## The three categories (positive-allowlist definitions per `cc-artifacts.md` Rule 10)

| Category                    | Definition                                                                                                                                                                                                                                                        | Disposition                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BUG**                     | Prevents successful testing/closure of an in-scope item — a failing test/build/type check, a shipped path that is wrong/insecure/lossy, a contract/API break, a gate-integrity or self-ref-enforcement defect, an unmet success-criterion on a _shipped_ feature. | **FIX NOW — severity-independent.** Converges to 2 clean rounds.                                                                                                 |
| **INVEST-NOW ISSUE**        | Does not itself block testing/closure of the current item, BUT has material impact on later stages such that fixing now is the correct investment (deferring compounds cost — foundational / architectural / shared-substrate that later work builds on).         | **FIX NOW**, AND the **judgment bucket** → classify WITH an impact rationale and SURFACE at the gate (`/sweep`) for co-owner direction. Never silently deferred. |
| **INCREMENTAL IMPROVEMENT** | "Could do" quality — polish, prose/naming, defense-in-depth _beyond an already-working guard_, tail-quality _off_ shipped paths, redundant coverage, refactor-for-elegance. No forward-impact; does not block testing/closure.                                    | **DEFER** to the deferred-quality tracking list with a value-anchor. Does NOT reset the redteam clean-round counter.                                             |

## MUST Rules

### 1. Every Gate-Surfaced Finding Is Classified Into Exactly ONE Category; Severity Never Gates

Every finding a review/redteam/sweep gate surfaces MUST be classified into exactly one of BUG /
INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT per the positive-allowlist table above, BEFORE any
fix-vs-defer disposition. The finding's SEVERITY (CRIT/HIGH/MED/LOW) is a ranking/reporting
attribute and MUST NOT be used to decide fix-vs-defer. Using severity as the fix-vs-defer gate —
"it's only LOW, defer it" OR "it's HIGH, so it blocks" — is BLOCKED. **Classification is
fail-closed:** any finding whose category is ambiguous resolves toward IMMEDIATE
(bug/invest-now), NEVER toward silent defer — mirroring `rules/self-referential-codify.md`'s
"edge cases resolve in favor of the gate firing." (The paired name-the-success-criterion
mitigation — an INCREMENTAL label MUST name the criterion it checked against, and "no criterion
covers this path" → ESCALATE — is MUST-3.)

```markdown
# DO — category gates; severity ranks

Finding: a LOW-severity null-deref on a shipped auth path.
Category: BUG (shipped path is wrong) → FIX NOW, even at LOW severity.

# DO NOT — severity gates

Finding: LOW-severity null-deref on a shipped auth path.
"LOW severity, no CRIT/HIGH → defer to next cycle." (a LOW bug still blocks completion)
```

**BLOCKED rationalizations:** "it's only LOW/MED, defer it" / "no CRIT or HIGH, so the round is clean" / "high severity means it must block; low means it can wait" / "severity IS the priority signal, that's what it's for".

**Why:** Severity measures blast-radius-if-triggered, not whether the item blocks a complete, visible product; using it as the fix-vs-defer gate defers real bugs (a LOW bug is still a bug) and grinds harmless polish (a MED refactor still burns a full convergence round). The category — does it block testing/closure? does it have forward-impact? — is the axis that maps to completion.

### 2. Bug + Invest-Now Are Immediate; Incremental Defers Via The Generalized-1b Conditions; Silent Defer Is BLOCKED

BUG and INVEST-NOW findings MUST be fixed in-cycle to convergence (INVEST-NOW judgment calls are
additionally SURFACED at the gate with impact + implications + symmetric pros/cons per
`rules/recommendation-quality.md` MUST-1/2/3 for co-owner direction — never silently self-decided).
An INCREMENTAL finding MAY route to the deferred-quality tracking list ONLY under the
generalized `rules/zero-tolerance.md` Rule-1b conditions: (i) a blocking-safety note (which
shipped/success path it does NOT touch), (ii) a value-anchor citing a user-anchored source
(`rules/value-prioritization.md` MUST-2), (iii) full-fix acceptance criteria, (iv) a revisit
trigger (`after-milestone:<name>` | `on-demand`). Deferring without all four is silent deferral and
is BLOCKED. The `value-prioritization.md` MUST-4 OR-escape-hatch ("implement X OR file an issue OR
document as known-limitation") is BLOCKED here too — commit to ONE disposition.

```markdown
# DO — incremental defers with the four conditions; bug/invest-now fixed now

INCREMENTAL: extra defense-in-depth on an already-guarded path.
Defer → deferred-quality list: (i) does not touch the shipped validation path;
(ii) value-anchor: "polish per brief §UX-quality"; (iii) acceptance: add the second
guard + test; (iv) revisit: after-milestone:walking-skeleton.

# DO NOT — silent defer, OR bug relabelled incremental, OR the OR-escape

"Deferring the failing-test fix as incremental." (a failing test is a BUG — BLOCKED)
"Defer the polish (tracked separately)." (no value-anchor / no revisit trigger — BLOCKED)
"Implement the fix OR add a smoke-test asserting current behavior." (OR-escape — BLOCKED)
```

**BLOCKED rationalizations:** "it's incremental, tracked separately" (without the four conditions) / "a build failure is incremental this cycle" / "defer the invest-now issue silently, note it later" / "Carried-forward (no grace clock)" / "Phase-N / v-next scope" / "implement OR document as a known limitation".

**Why:** Silent deferral is deferral-as-forgetting — the item leaves the queue and its value-rationale evaporates across the next `/clear` (`value-prioritization.md` Origin: 7-of-7 deferred items decayed rather than picked up). The four generalized-1b conditions are what make an incremental defer a tracked hold on the same work, not an abandonment; relabelling a bug/invest-now "incremental" ships the exact defect the category gate exists to catch.

### 3. A Warm Same-Class Bug/Invest-Now Gap Is Fixed Now — The Category Verdict Gates The Lane

When a gate surfaces a latent same-class gap that fits the remaining shard budget
(`rules/autonomous-execution.md` Rule 4), the category verdict — NOT convenience — gates the lane: a
BUG or INVEST-NOW same-class gap MUST be fixed in the same session (filing a follow-up issue instead
is BLOCKED per Rule 4); an INCREMENTAL same-class gap MAY route to the deferred-quality list with a
value-anchor. Relabelling a warm same-class BUG/INVEST-NOW gap "incremental" to defer it is BLOCKED.
When an INCREMENTAL classification cannot name the success-criterion it checked against ("no
criterion covers this path"), the disposition is ESCALATE (surface it), NOT auto-defer.

```markdown
# DO — category verdict gates the warm-gap lane

Reviewer flags 40 sibling call-sites, same null-bind class as the in-flight fix, ~300 LOC.
Category: BUG (sibling paths are wrong) → fix now, same session (Rule 4).

# DO NOT — defer a warm bug as "incremental"

"The 40 siblings are incremental hardening — file a follow-up issue." (same-class BUG,
warm context, fits budget → BLOCKED; the category, not convenience, gates the lane)
```

**BLOCKED rationalizations:** "it's incremental so I'll defer it" (when the category is bug/invest-now) / "a follow-up issue captures the siblings" / "the warm gap is polish" (when it is the same bug class) / "no success-criterion covers it, so it's incremental by default" (absent-criterion → escalate, not auto-defer).

**Why:** Same-class gaps cost least to fix while context is warm (`autonomous-execution.md` Rule 4: a follow-up issue forces the next session to reload everything, 2–5× the marginal cost); letting "it's incremental" defer a warm same-class bug is that rule's failure mode wearing this rule's vocabulary. The absent-criterion escalation closes the under-specified-brief hole — silence about coverage is a question for the human, not a license to defer.

### 4. `/sweep` Surfaces The Triage + Completion Status + Decision Points Actively — Never Silently Decided

The judgment-bucket items (INVEST-NOW vs defer) and the deferred-quality backlog MUST be surfaced
ACTIVELY and EXPLICITLY at `/sweep` as a management decision report (`.claude/skills/sweep/` § report
contract): completion status, ETA-to-complete in autonomous cycles, the prioritized immediate queue,
the deferred-quality backlog grouped by revisit trigger, the INVEST-NOW-vs-defer decision points
(each with implications + symmetric pros/cons), and a recommended next-step for ratification. The
agent MUST NOT silently self-decide a judgment-bucket item OR let a deferred item sit past its
revisit trigger unsurfaced.

```markdown
# DO — /sweep surfaces the decision points for direction

Decision point (INVEST-NOW vs defer): the shared cache-key refactor.
Recommend INVEST-NOW — later billing + audit waves build on this key shape; deferring
compounds. Pro: unblocks two waves. Con: ~1 cycle now vs ~3 if deferred. Ratify? (y/n)

# DO NOT — silently decide the judgment bucket

[agent quietly defers the cache-key refactor as incremental; never surfaced at /sweep]
```

**BLOCKED rationalizations:** "the invest-now call is obvious, no need to surface" / "the deferred item can wait silently until someone asks" / "/sweep is just a status list, not a decision gate" / "I decided the judgment bucket to keep momentum".

**Why:** The judgment bucket is exactly where a mis-classification ships a real defect under a converged banner (the category boundary's honest risk); the human ratifying the deferred set at `/sweep` is the structural check that catches it. An unsurfaced deferred item is a rotted item (`value-prioritization.md` MUST-3 "still wanted?" gate) — the `/sweep` revisit is the anti-forgetting teeth without which the deferred-quality list is net-negative.

## Skip-Class Carve-Out — A Declared Fork Dual-Surface Skip Is Not An Uncategorized Coverage Gap

An explicit "N inherited-canon-CLEAN artifacts skipped (reviewed upstream)" line from the fork dual-surface redteam seat (`commands/redteam.md` § Step 0.5 + `skills/30-claude-code-patterns/dual-surface-redteam.md`) is NOT a surfaced finding requiring category classification (MUST-1) and MUST NOT be flagged at `/sweep` or a product-completion pass as an unaddressed coverage gap. A CLEAN artifact is byte-identical to the last-accepted canon blob canon already reviewed to convergence — it carries NO fork-side delta to find, so its review is DELEGATED upstream by construction, not deferred as incremental. The carve-out is bounded to the DECLARED CLEAN class only: the skip is reported explicitly with its count (never silent), it never covers a Seat-L / Seat-D surface (both still converge to the BUG + INVEST-NOW gate), and it never licenses relabelling a real fork-side BUG/INVEST-NOW finding as "inherited-canon, skip". An UNDECLARED skip, or a "skip" of anything other than byte-identical-to-canon inherited artifacts, is a finding that MUST be classified per MUST-1.

**Why:** A declared delegated-upstream skip is accounted-for by construction (canon's own convergence + the explicit count), so treating it as an uncategorized coverage hole would grind the convergence-attention budget on a surface with zero fork-side risk — the exact mis-allocation this rule's category gate exists to prevent, one layer up. Bounding the carve-out to the byte-identical CLEAN class keeps it from becoming the "skip it, it's inherited" relabel that would let a real fork-side defect ship under the skip banner.

## MUST NOT

- Use severity (CRIT/HIGH/MED/LOW) as the fix-vs-defer gate for any surfaced finding.

**Why:** Severity ranks blast-radius, not completion-impact; gating on it defers real bugs and grinds harmless polish — the originating failure mode this rule blocks.

- Defer a finding classified BUG or INVEST-NOW as "incremental".

**Why:** Relabelling a completion-blocking finding as polish ships the defect under a converged banner — the exact risk the category gate exists to catch.

- Route an INCREMENTAL finding to the deferred-quality list without the four generalized-1b conditions (blocking-safety note + value-anchor + acceptance criteria + revisit trigger).

**Why:** A defer without the four conditions is silent deferral-as-forgetting; the conditions are what make it a tracked hold, not an abandonment.

- Ship the deferred-quality label/list without the `/sweep` revisit teeth in the same cycle.

**Why:** A label that makes deferral easier, with no revisit gate, is net-negative — deferred items rot (`value-prioritization.md` Origin, 7-of-7 decay). The list and the teeth ship paired.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` + the `/redteam` + `/sweep` gates confirm every surfaced finding was category-classified, that no BUG/INVEST-NOW was deferred as incremental, and that the judgment bucket was surfaced not silently decided); `advisory` at the hook layer (whether a finding is a bug vs an incremental is judgment-bearing per `hook-output-discipline.md` MUST-2 — a lexical detector cannot carry `block`).
- **Grace period:** 7 days from rule landing (2026-07-11 → 2026-07-18).
- **Cumulative posture impact:** same-class violations (deferring a genuine BUG/INVEST-NOW as "incremental", OR a silent incremental defer missing the four conditions, OR silently self-deciding a judgment-bucket item) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window fires the emergency trigger `blocking_triage_bypass` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — a dedicated key because mis-triaging a completion-blocking finding as deferrable polish is a distinct, high-consequence failure class (a real defect ships under a converged banner) warranting an instant drop, not only cumulative accrual.
- **Receipt requirement:** SessionStart soft-gate `[ack: product-completion-first]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` + the `/redteam`/`/sweep` gates inspect any session that surfaced findings and confirm (a) each finding carries a category label, (b) no finding whose evidence shows a failing test/build/type-check/insecure-or-lossy shipped path was routed to the deferred-quality list, (c) every incremental defer carries the four generalized-1b conditions, (d) the judgment bucket was surfaced at `/sweep`, not silently decided. The eval-harness suite `.claude/test-harness/tests/product-completion-first.test.mjs` structurally asserts the classifier + convergence-scoping + fail-closed properties. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory detector flagging a defer whose finding text matches a BUG signal (`failing test` / `build error` / `type error` / `insecure` / `lossy` / `contract break` / `gate-integrity` / `self-ref-enforcement defect` — the full BUG-definition signal set); audit fixtures land with it at `.claude/audit-fixtures/product-completion-first/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (severity-as-gate) + MUST-2 (silent/mis-categorized defer) + MUST-3 (warm same-class bug/invest-now deferred as incremental) + MUST-4 (judgment bucket silently decided).
- **Origin:** See § Origin.

## Origin

2026-07-11 — co-owner-directed origination (`rules/artifact-flow.md` § Co-Owner-Directed Origination
/ O1 lane), receipt-first `journal/0467`. Verbatim directive: red-team stays in every phase/wave, but
the harness must stop grinding ~80% of the budget on <10%-value increments that do not block a
complete, visible product — "small increments that do not block the sprints to completion should be
documented and tracked separately, and revisited as required or after the full product is done and
visible." Corrected in-session to the CATEGORY gate (bug/invest-now = immediate regardless of
severity; incremental = defer) with severity decoupled from fix-vs-defer, and `/sweep` rebuilt as a
management decision report. Ratified dispositions D1–D4 (`journal/0467`): D1 lean anchor rule (authored
`priority:10 path-scoped` under the measured saturated-baseline constraint — codex 11.89% / gemini
12.35% headroom within the 15% proximity band, matching the `knowledge-cascade-routing.md` precedent),
D2 invest-now surfaced-for-direction, D3 GH `deferred-quality` label surface, D4 numeric
autonomous-cycle ETA. Companion consumers: `redteam.md` § Category-Based Finding Triage + Convergence
Criterion 3, `wave-loop.md` G1/MUST-3, `zero-tolerance.md` Rule 1d, `autonomous-execution.md` Rule 4,
`self-referential-codify.md` two-tier gate.
