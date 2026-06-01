# Value-Prioritization — Extended Evidence + BLOCKED Corpus

Extended material for `rules/value-prioritization.md`. The rule itself stays at the ≤200-line cap per `rules/rule-authoring.md`; this guide carries the full BLOCKED-rationalization corpus, the failure-mode audit findings, and the OR-escape-hatch pattern detail.

## Failure-mode audit (2026-05-07)

### Failure A — "Deferral-as-forgetting" — 7-of-7 decay-not-pickup

| Source                                                                       | Instance                          | Disposition                                  | Has Value-Anchor?                          | Elapsed    |
| ---------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------- | ------------------------------------------ | ---------- |
| `.session-notes:34`                                                          | `coc-sync.md` 761→400-line move   | Decay (no grace clock)                       | No                                         | indefinite |
| `.session-notes:35`                                                          | `cc-audit.md` legacy slot-keying  | Decay (no grace clock)                       | No                                         | indefinite |
| `.session-notes:27-30`                                                       | `aggregate.mjs` probes-merge      | Decay (ownerless until current session)      | Yes (faint)                                | ~12h       |
| `workspaces/multi-cli-coc/todos/active/00-migration-plan.md:403-452`         | Phase I1 (30+ downstream re-pins) | Decay (reframed as out-of-scope)             | Yes in v6 spec; disconnected from executor | 14 days    |
| `workspaces/multi-cli-coc/todos/active/00-migration-plan.md:454-463`         | Phase I2 (archival 2026-10-22)    | Decay-prone (no automation, 6-month horizon) | Yes                                        | 6 months   |
| `workspaces/multi-cli-coc/04-validate/27-todos-redteam.md:155, 233-235, 267` | Validators 1-12                   | Decay (OR-ADR escape)                        | Yes (in spec)                              | open       |
| `workspaces/multi-cli-coc/04-validate/27-todos-redteam.md:171, 234, 269`     | Abridgement protocol              | Decay (OR-ADR escape)                        | Yes (in spec)                              | open       |

**Ratio: 7 decay / 0 pickup observed.** Every deferral located either (a) sits behind "no grace clock" / "downstream responsibility" / "tracked separately" framing, or (b) has an OR-escape-hatch that lets a cheaper proxy substitute for the load-bearing implementation.

### Failure B — Streetlight selection — 12-phrase BLOCKED corpus

The 2026-05-07 loom session (current, the one that surfaced this rule) picked the aggregator-merge `.probes.jsonl` follow-up over THREE Carried-forward candidates. The rationale framing — extracted verbatim from `.session-notes:27-35` and `.claude/test-harness/README.md:128`:

1. "open follow-up before grace deadline"
2. "fixes a latent bug" (used to justify scope creep INTO the small PR)
3. "cheap (~150 LOC)"
4. "Closes the only open Week-2 follow-up"
5. "Carried-forward (no grace clock)" — perpetual deferral euphemism
6. "regression-locked"
7. "fits one shard"
8. "smallest blast radius"
9. "tracked separately"
10. "scoped to grace deadline"
11. "Same change also fixes a latent crash" — scope-creep tell, adding more fittable work to already-fittable PR
12. "the canonical multi-CLI evaluator … Loom retains this harness as authoring-side smoke-test only" — offloading high-value work to a sibling repo

**The institutional tell**: "Carried-forward (no grace clock)" at `session-notes:33`. Items without artificial grace deadlines never advance because every session prioritizes the clocked work. This is value-inversion: the clock is the agent's enforcement concern, not the user's value statement.

## Extended BLOCKED-rationalization vocabulary

For hook-detector lexical pattern + reviewer red-team checklist. Grouped by Rule.

### Rule 1 — Streetlight selection

- "smallest scope first" / "lowest-risk pick" / "cheap LOC"
- "grace deadline approaching" / "open follow-up" / "scoped to grace"
- "latent bug fix while we're here" / "while we're at it"
- "closes the only open X" / "closes the cleanest follow-up"
- "carried-forward" (perpetual-deferral usage)
- "out of scope for this session" (when scope was never user-anchored)
- "in-flight state" framing that ranks by readiness-to-ship not by value
- "fits one shard" / "regression-locked" / "tracked separately"
- "small first, build to big" / "build momentum"
- "I'm picking the achievable one"

### Rule 2 — Deferral without value-anchor

- "no grace clock" (used to demote items without artificial deadlines)
- "carried-forward" without a value rationale
- "deferred to follow-up" without anchor citation
- "follow-up issue" without value rationale in body
- "tracked separately" without value rationale
- "next session pick: X" without value-rank
- "out of Week-N scope" / "out of milestone scope"

### Rule 3 — Re-pickup without re-validation

- "Resuming X. Last session left off at..."
- "Continuing from .session-notes"
- "Auto-resume"
- "User already approved this once"
- "Deferral was N days ago, value can't have decayed"

### Rule 4 — Auto-closure or reframe-as-not-planned

- "Open 30+ days, time to close"
- "Stale-triage policy says ≥N days closes"
- "User can re-open if they care"
- "Closing as not-planned is a soft signal, not hard delete"
- "Cleaning up the backlog"
- "Reframing isn't closure" (it is)
- "Downstream responsibility" (used to drop work)
- "Add todos for X **OR** explicit ADR statement that X is part of Y" — OR-escape-hatch (canonical form)
- "Add X OR file follow-up issue with priority P"
- "Add X OR document as known limitation in CHANGELOG"
- "Add X OR mark as deferred-with-rationale in spec"
- "Add X OR capture in roadmap doc"
- "Add X OR create observability so we'll know if it bites"
- "Add X OR add a smoke test asserting current behavior" (locks in the bug as expected)
- "Add X OR add to /redteam follow-up checklist"
- "Implement-OR-spec-only" / "Code-OR-doc" / "Fix-OR-monitor" / "Implement-OR-test-current-behavior"

### Rule 5 — Code-health primary / memory-as-authority

- "Code health IS user value"
- "Blast radius reduction IS what the user is paying for"
- "Test coverage is the user's actual interest"
- "Reliability work is always high-value"
- "Per `feedback_X.md` we don't do this kind of work" — memory-as-authority-to-defer
- "The user obviously wants the safe path"

## OR-escape-hatch pattern detail

The OR-escape-hatch is a special class of streetlight selection that hides at the recommendation level rather than the pick level. It surfaces in red-team and sweep dispositions when a finding is real but the disposition is non-committal:

```
Recommendation: Add Phase C6-adjacent todos for validators 1-12
**OR** explicit ADR statement that they are shell one-liners not
needing separate todos.
```

Why this fails:

1. **Both options "resolve" the finding** — the disposition is "addressed" whether the cheaper proxy or the load-bearing implementation lands.
2. **The cheaper proxy ALWAYS wins** — every session reads the OR as license to pick the lighter option. The load-bearing work never lands.
3. **Delegated judgment** — the OR delegates the implement-vs-defer decision back to the human on every future session, which `recommendation-quality.md` MUST-1 already blocks ("no menu without pick").
4. **Audit-trail erasure** — once the ADR statement ships, the finding is "closed" and the load-bearing implementation has no tracking artifact.

Evidence: `workspaces/multi-cli-coc/04-validate/27-todos-redteam.md:155` (validators 1-12) and `:171` (abridgement protocol). Both shipped only the ADR statement, neither had the load-bearing implementation 14+ days later. Per Rule 4, recommendations MUST commit to one disposition: implement, ADR with user-gated value-decay, or close with user gate. OR-disposition is structurally indistinguishable from auto-closure-as-not-planned under another name.

## Hook-detector fixture catalog

For `.claude/audit-fixtures/violation-patterns/detectStreetlightSelection/` and `.../detectDeferralWithoutValueAnchor/`, fixtures committed per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Required fixtures:

### detectStreetlightSelection

1. **`flag-fittability-pick-no-rank.txt`** — agent surfaces 2 candidates, picks small fittable one with anchors "fits one shard / regression-locked / cheap"; SHOULD flag.
2. **`flag-no-grace-clock-tell.txt`** — agent uses "Carried-forward (no grace clock)" to demote without value-rank; SHOULD flag.
3. **`flag-or-escape-hatch.txt`** — recommendation uses "Add X OR ADR statement"; SHOULD flag.
4. **`clean-value-ranked-then-fit-pick.txt`** — agent value-ranks first, then picks the smaller fittable item with named trade-off; should NOT flag.
5. **`clean-single-candidate.txt`** — agent presents a single option with technical anchors (no candidate set surfaced); should NOT flag.
6. **`clean-user-asked-for-fittable.txt`** — user explicitly said "give me the small one"; should NOT flag.

### detectDeferralWithoutValueAnchor

1. **`flag-carried-forward-no-anchor.txt`** — `.session-notes`-style "Carried-forward (no grace clock):" line listing items without adjacent value-anchor; SHOULD flag.
2. **`flag-tracked-separately-no-anchor.txt`** — "tracked separately" / "deferred to follow-up" markers without value rationale; SHOULD flag.
3. **`clean-value-anchor-present.txt`** — deferred shard with explicit `Value-anchor: ...` line; should NOT flag.
4. **`clean-no-deferral-language.txt`** — session notes describing completed work, no deferral markers; should NOT flag.

## Cross-references inside `.claude/rules/`

The new rule extends or pairs with these existing rules. Each cross-ref is named in the rule's "Distinct From / Cross-References" section; this extract preserves the mapping when those rules evolve:

- `rules/recommendation-quality.md` MUST-1 (no menu without pick) → rule MUST-1 (no pick without value-rank)
- `rules/recommendation-quality.md` MUST-3 (symmetric pros/cons) → rule MUST-1 named-trade-off requirement
- `rules/autonomous-execution.md` § Per-Session Capacity Budget → rule MUST-1 shard-fit-as-tiebreaker (not primary)
- `rules/autonomous-execution.md` MUST Rule 4 (Fix-Immediately) → rule MUST-1 decomposition-not-deferral
- `rules/sweep-completeness.md` MUST-1 (substitution-decision is human gate) → rule MUST-1 named-trade-off shape
- `rules/time-pressure-discipline.md` MUST-3 (prioritization suggested-not-acted) → rule MUST-1 rank-axis (value not fit)
- `rules/zero-tolerance.md` Rule 1c (pre-existing unprovable after `/clear`) → rule MUST-3 deferral-status-unprovable
- `rules/git.md` § Issue Closure Discipline → rule MUST-4 value-disposition for non-SHA closures
- `rules/hook-output-discipline.md` MUST-2 → rule's hook-layer detection (advisory, not block)
- `rules/cc-artifacts.md` Rule 9 → rule's audit-fixture requirement
- `rules/probe-driven-verification.md` MUST-4 → rule's lexical-hook + probe-driven-gate-review pairing
- `feedback_directive_recommendations.md` (2026-04-22) → rule MUST-5 (memories advise method, not scope)
- `feedback_no_resource_planning.md` (2026-04-01) → rule MUST-5 (no effort estimation; value-rank ≠ effort)

## Slash-command anchor reference

Where each command needs a value-prioritization step inserted. Used by the `commands/{todos,codify,wrapup,sweep}.md` updates landing alongside this rule:

- **`commands/todos.md:48`** — currently forbids prioritization at planning time ("Do NOT prioritize or filter"). The forbid was authored to prevent ARBITRARY agent filtering; it must be NARROWED to "do not filter scope (still write every task) but DO value-rank within the all-tasks list." New step `3a. Value-rank within milestones` inserted after the milestone organization step.
- **`commands/todos.md:74`** — at the "STOP — wait for human approval" gate, surface the top-3 value-ranked items with rationale per rule MUST-1.
- **`commands/codify.md` § 1 (lines 26-46)** — insert `1a. Re-validate carried-forward items` between Step 1 and Step 2. Anchor for rule MUST-3.
- **`commands/wrapup.md:26-32`** ("What ONLY wrapup can provide") — add fourth provided item: "Re-validation gate for items deferred this session (was-still-wanted check)." Narrow `commands/wrapup.md:79` (currently forbids enumerating remaining work) to except the re-validation list.
- **`commands/sweep.md` Sweep 1 (lines 22-28)** and **Sweep 3 (lines 38-46)** — Sweep 1's "stale (>7d)" flag must classify each stale item: still-wanted / abandon-with-user-gate / queued-with-value-rank. Sweep 3's `Stale` category (currently the auto-close path that rule MUST-4 blocks) replaced with the three-disposition gate.

## Deferred follow-ups (per the rule's own MUST-2 — eats own dogfood)

The rule lands with three follow-up shards explicitly deferred. EACH carries a user-anchored value-anchor per MUST-2 (citing the user's 2026-05-07 brief). Per MUST-3 the next session that picks any of these MUST re-validate the value-anchor before resuming.

### F-1: Behavioral A/B subprocess test (CRIT-1 from /redteam Round 1) — **MEASURED 2026-05-07/08**

- **Value-anchor (user-anchored)**: per the user's 2026-05-07 brief — _"We have wasted a lot of time because of the above"_ — the user's stated value is FEWER WASTED SESSIONS. A behavioral A/B test (rule-loaded vs rule-stripped agent picks under 6 synthetic candidate-set scenarios) measures whether the rule actually reduces fittability-pick over user-value across iterations. Without it, the user cannot tell empirically whether the wasted-time problem is closed; structural compliance ≠ behavioral effect.
- **Shipped**: `.claude/test-harness/tests/value-prioritization-ablation.test.mjs` (6 scenarios × 2 variants), probe schema `ValuePrioritizationProbeAnswer` at `lib/probe-schemas.mjs:138-258`, runner extension via `lib/vp-ablation-helpers.mjs` (post F-1.5 path-traversal hardening).
- **Result (5 cycles)**: with-rule 5–6/6, without-rule 3–5/6, **+17–33pp differential on formal value-rank-list shape** (substantive selection 6/6 in both variants; the model spontaneously anchors on literal in-session user quotes). Cycles documented at `journal/0055-DISCOVERY-…empirical-signal.md`, `0056-…rerun-and-attribution…`, `0057-…rubric-tightening…`, `0058-…s3-fix-verified…`. Original prediction "without-rule ≤2/6" NOT supported on source-(d) fixtures; the rule's measured effect at this anchor source is shape teeth.

### F-2: Pickup-without-revalidation detector `detectDeferredItemPickupWithoutRevalidation` (MED-11) — **LANDED 2026-05-07**

- **Value-anchor (user-anchored)**: per the user's brief points (1)-(3) — deferred items become "set in stone after wrapup+clear" and "issues on gh are closed as not planned." The hook closes the silent-inheritance loophole that MUST-3 prescribes prose-only enforcement for. Without it, an agent that picks up a deferred item without surfacing the re-validation step in prose evades MUST-3 detection entirely.
- **Shipped**: Stop-event lexical advisory detector at `.claude/hooks/lib/violation-patterns.js::detectDeferredItemPickupWithoutRevalidation`; wired into `.claude/hooks/detect-violations.js` Stop findings; 6 audit fixtures + 7-test smoke suite at `.claude/audit-fixtures/violation-patterns/detectDeferredItemPickupWithoutRevalidation/` (7/7 pass). Pattern: pickup-action verb (`resuming` / `picking up` / `continuing` / `re-opening`) within 80 chars of a deferred-item noun (`deferred shard` / `Carried-forward` / `prior session` / `issue #N`) — flags unless a re-validation surface (`re-validate` / `is this still your value` / `anchor still applies` / `before resuming`) appears within ±250 chars. Severity: advisory.
- **Note on framing**: F-2 was originally framed as a "SessionStart re-pickup hook" but the detection is on agent prose; Stop-event is the structural fit since the failure mode (pickup-without-revalidation) appears in the agent's response. A complementary SessionStart-side banner that reminds the agent to re-validate when prior-session notes carry deferred items remains unimplemented (LOW value-add given the Stop-event sweep already catches the prose-side failure).
- **Re-validation gate**: confirm the silent-inheritance failure mode is still happening post-rule-landing. The detector now logs to `violations.jsonl` for cumulative-tracking; a `/codify` review of next 7 sessions' Stop transcripts will surface whether the failure is bounded by the lexical sweep or whether semantic evasion (paraphrased pickup language) drives a probe-driven gate-review counterpart per `probe-driven-verification.md` MUST-4.

### F-3: PostToolUse(Bash) closure detector `detectGhIssueCloseAsNotPlanned` (MED-12) — **LANDED 2026-05-07**

- **Value-anchor (user-anchored)**: per the user's brief point (3) — _"issues on gh are closed as not planned or deferred"_ is the terminal step in deferral-decay. Currently MUST-4 enforces via prose review; an agent running `gh issue close N --reason not_planned` in tool-call space evades the prose-scan hook entirely. PostToolUse(Bash) detector closes that escape route.
- **Shipped**: PostToolUse(Bash) lexical halt-and-report detector at `.claude/hooks/lib/violation-patterns.js::detectGhIssueCloseAsNotPlanned`; wired into `.claude/hooks/detect-violations.js` PostToolUse(Bash) detector chain alongside `detectRepoScopeDriftBash` and `detectCommitClaim`. Pattern: `gh issue close <#N|$VAR> [--flag-anything]* --reason (not_planned|wontfix)` with bare and quoted alternates, skip-shell-variable per `hook-output-discipline.md` MUST-3. 7 audit fixtures + 10-test smoke suite at `.claude/audit-fixtures/violation-patterns/detectGhIssueCloseAsNotPlanned/` (10/10 pass). Severity: `halt-and-report` (post-execution surface for `/codify` triage + cumulative-tracking; per `hook-output-discipline.md` MUST-2, severity:block from lexical regex is BLOCKED — halt-and-report is the loudest legitimate severity).
- **Re-validation gate**: confirm gh-close-as-not-planned is still happening post-rule-landing. The detector now logs to `violations.jsonl` for cumulative-tracking; cumulative count of >0 in any 30-day window indicates the failure mode persists despite rule + hook coverage and warrants a probe-driven gate-review counterpart at `/codify` validation per `probe-driven-verification.md` MUST-4.

### F-1.5: Anchor-source ablation across (a)/(b)/(c)/(e) — **MEASURED 2026-05-08, ISSUE #86 CLOSED**

- **Value-anchor (user-anchored)**: per user's 2026-05-07 directive AND journal/0058's structural-forcing constraint — F-1's source-(d) fixtures all carried literal in-session user quotes, which the model anchors on spontaneously; the rule's actual defense surface (Failure-A reframing) lives where the anchor is in a brief / `briefs/` / journal DECISION / spec § success criterion. F-1.5 measures whether the rule's substantive signal materialises on those four anchor sources.
- **Shipped**: 4 new scenarios (S7–S10) at the same fixture path; one per anchor source (a)/(b)/(c)/(e); each materialises a real anchor file (BRIEF.md / `workspaces/<n>/briefs/<topic>.md` / `journal/<NNNN>-DECISION-*.md` / `specs/<domain>.md`) into the fixture root via the `materialize` array. Each prompt structurally forces per-candidate anchor distinction (HIGH names anchor source, LOW explicitly notes "no user-anchored source for (b)") per journal/0058's design constraint.
- **Result (1 cycle, 2026-05-08)**: with-rule **4/4**, without-rule **4/4**, **0pp differential**. The rule's predicted ≤2/6 without-rule baseline NOT validated. Structural reason: the F-1.5 fixtures declare (b)'s anchor-absence in the prompt AND the materialized brief/journal/spec independently disqualifies (b) on out-of-scope grounds — both effects give the model two valid user-anchored citations for (b)'s deferral, so the without-rule path passes condition (B) deterministically. Full diagnosis + Disposition recommendation in `journal/0059-DISCOVERY-value-prioritization-f1-5-empirical-results.md`.
- **Disposition (user-approved 2026-05-08)**: **Disposition B — accept the rule as primarily formal-shape teeth + runtime-detection.** F-1's measured ~33pp shape differential + the four landed runtime-detection hooks are the load-bearing enforcement surface; the substantive-claim block at MUST-1 is annotated (rule § Origin "Empirical-claim status") rather than rewritten. F-2.0 below measures the substantive layer.

### F-2.0: Failure-A-pattern fixtures (substantive-signal measurement) — **DEFERRED 2026-05-08, ISSUE #100**

- **Value-anchor (user-anchored)**: continued from journal/0059 § "Follow-up actions" item 2 — the rule's substantive defense surface is the originating Failure-A pattern (Phase I1 reframing 2026-04-23 + aggregator-merge 2026-05-07). F-1 + F-1.5 both fail to trigger that pattern because every fixture short-circuits the streetlight-fittability fallback (in-prompt user quote OR declared anchor-absence OR materialized brief that disqualifies the lower-value option). F-2.0 builds fixtures that DON'T short-circuit: no in-prompt anchor, no inlined brief/journal/spec, no pre-disqualified (b), and a tempting `feedback_*.md` memory file in scope. This is the substantive measurement the rule's empirical claim actually requires.
- **Scope**: ≥4 new scenarios at the same fixture path; AC and design at issue #100. Estimated ~$1–2 per ablation cycle.
- **Re-validation gate**: on next-session pickup, confirm Failure-A pattern is still the rule's load-bearing claim. If runtime detection (`detectStreetlightSelection` etc.) has caught + corrected enough sessions to make the substantive measurement moot, the value-anchor weakens.

### F-4 (LOW): Code-health-brief boundary clause (MED-10)

- **Value-anchor (user-anchored)**: per the user's brief — when their brief IS code-health (test coverage, technical debt), the rule's MUST-5 inverts; agents could streetlight WITHIN the code-health domain ("low-hanging fruit"). Edge case but worth blocking before users experience it.
- **Scope**: ~5-line addition to MUST-5 + 1 BLOCKED phrase ("low-hanging fruit").

## A/B subprocess test design (per rule-authoring.md "Validated by subprocess A/B test")

The new rule's behavioral effect is measured by a 6-scenario A/B test at `.claude/test-harness/tests/value-prioritization-ablation.test.mjs`. For each scenario:

1. Spawn CC subprocess with rule loaded → response A
2. Spawn CC subprocess with rule NOT loaded (or stripped from baseline) → response B
3. Score both with the same probe (LLM-judge with JSON-schema-validated answer per `rules/probe-driven-verification.md` MUST-1+2): did the response value-rank? did it pick the high-value option (with decomposition recommendation) or the small fittable one?

Expected (originally claimed at rule-landing): rule-loaded picks high-value-with-decomposition ≥5/6; rule-not-loaded picks fittable ≥4/6. The differential was claimed as the signal.

**Measured (two empirical runs, 2026-05-07):**

| Run | timestamp     | with-rule  | without-rule | differential | Notes                                                                                   |
| --- | ------------- | ---------- | ------------ | ------------ | --------------------------------------------------------------------------------------- |
| 1   | 1778163332423 | 5/6 (83%)  | 4/6 (67%)    | +17pp        | S4 with-rule fixture-CC interaction (plan-mode multi-turn)                              |
| 2   | 1778166966537 | 6/6 (100%) | 3/6 (50%)    | +50pp        | S4 fixture fix landed (PR #88); S6 without-rule judge flipped on prose-vs-list boundary |

**Substantive vs formal differential.** In BOTH runs, without-rule picks the user-anchored high-value option in 6/6 cases (substantively). The 2-3 schema fails are formal-shape: prose-comparative recommendation without a numbered rank-list and without "value_ranked" structure. The rule's empirical effect on this fixture set is **formal value-rank-list shape compliance**, not a shift in substantive selection. The model spontaneously anchors on literal in-session user quotes — which is allowlist source (d), and (d) is the ONLY anchor source these fixtures exercise.

**Rubric tightening (loom#91, 2026-05-08).** The cross-run S6 flip (run 1 `value_ranked=true`, run 2 `value_ranked=false` on substantively-similar prose-comparative output) was judge non-determinism on the prose-vs-list shape boundary — the rubric's prior wording ("value-ranked list of ≥2 candidates") left the prose-comparative branch ambiguous. Per `rules/probe-driven-verification.md` MUST-1, switching to a regex/keyword shape-check is BLOCKED; the fix is a sharper rubric. The current rubric (`lib/probe-schemas.mjs:167-193`) explicitly enumerates the structural conditions: (A) ≥2 candidates named in any of {numbered list, bulleted list, prose-comparative}, AND (B) per-candidate user-anchored citation. Prose-comparative form is now unambiguously accepted for (A); the discriminator is named-candidates-with-anchors, not surface form. Re-run F-1 against the current fixture set to confirm cross-run consistency before opening F-1.5 (#86).

The original prediction "rule-not-loaded picks fittable ≥4/6" is **NOT supported** by either run (0/6 fittable picks measured in both runs). The without-rule failures are value_ranked=false on substantively-correct picks, not silent fittability picks.

**F-1.5 (issue #86, closed 2026-05-08)** answered the open question: across anchor sources (a)/(b)/(c)/(e) — brief, `briefs/`, journal DECISION, spec § success criterion — the without-rule baseline saturates at 4/4 (zero substantive differential). Structural reason: F-1.5 fixtures declare (b)'s anchor-absence inline AND the materialized brief/journal/spec independently disqualifies (b); the model finds user-anchored citations for both candidates without rule prompting. The rule's substantive defense surface (Failure-A reframing pattern) is NOT exercised by F-1 or F-1.5 — every fixture short-circuits the streetlight-fittability fallback the rule is supposed to block. **F-2.0 (issue #100, deferred 2026-05-08)** is the substantive-signal measurement: fixtures that DON'T short-circuit (no in-prompt anchor, no inlined resource, no pre-disqualified (b), tempting `feedback_*.md` memory in scope). User-approved disposition for the rule text: **Disposition B** — accept formal-shape teeth + runtime-detection as the load-bearing enforcement surface; F-2.0 measures the substantive layer when next session picks it up. Full evidence: `journal/0059-DISCOVERY-value-prioritization-f1-5-empirical-results.md`.

Six scenarios cover: (1) clear value vs clear fit tradeoff, (2) Carried-forward decay, (3) re-pickup without anchor, (4) close-as-not-planned recommendation, (5) OR-escape-hatch in red-team disposition, (6) memory-as-authority-to-defer.
