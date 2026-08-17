# Sweep / Multi-Step Protocol Completeness — Extract Guide

This guide carries the full BLOCKED-rationalization enumerations, extended DO/DO NOT examples, cross-rule relationship list, tool-backing pattern, the MUST-4 depth (N=3 derivation, Wiring rationale, detector contract), the skip-class carve-out detail, and the origin post-mortems for `.claude/rules/sweep-completeness.md`. The main rule keeps the four MUST clauses + brief Why's; this guide carries everything else.

## MUST Rule 4 — The Repeating Non-Answer

### The failure class, stated generally

Rules 1–3 govern the agent substituting a CHEAP PROXY for a mandated step. Rule 4 governs the sibling: emitting a NON-ANSWER in place of one, run after run. Both end in a report slot that reads as coverage and answers nothing, but they fail differently and defend differently.

A substitution is a lie of RELABELING — the proxy's output wears the mandated step's name, and Rule 2 catches it by forcing the proxy's name into the report. A repeating unadjudicated verdict is the opposite: it is scrupulously HONEST on every single emission. `manual-supplement-required` claims nothing it cannot support. It says, correctly, "the mandated check does not exist for this repo shape and I will not pretend otherwise."

That honesty is precisely what makes it invisible. Nobody reviews it, because there is nothing wrong with it. It occupies a slot in every report, satisfies the reader's scan, and answers nothing — indefinitely.

`instrument-discipline.md` MUST-1 already establishes that a check which cannot discriminate is not evidence. The gap Rule 4 closes is one step further out: a check that NEVER discriminates is never ESCALATED. Nothing in the corpus was watching for repetition, so the row simply kept printing.

### Why N=3, in full

The threshold has to sit at the point where "transient" stops being a live explanation.

- **N=1 is mandated output, not a defect.** The first emission is exactly what MUST-2 requires: label the non-answer honestly rather than dressing it as clean. Escalating at 1 would penalize the correct behaviour and push agents back toward the N/A sentinel that `skills/sweep/SKILL.md` § 6a blocks.
- **N=2 is consistent with a fix in flight.** One intervening cycle is a plausible amount of time for the missing check to be under construction, an issue to be triaged, or an owner to be assigned. Escalating at 2 produces a Decision Point for work that is already moving, which trains the reader to dismiss the escalation.
- **N=3 is the first count that is only explicable as inertia.** By the third consecutive run the placeholder has survived two intervening chances to change and nothing changed. "Transient" is no longer available as a reading.

The number is also INHERITED rather than invented, which matters more than the reasoning above: `trust-posture.md` MUST-4 already uses 3× same-rule-in-30-days as the corpus's "this is a pattern, not an incident" constant. Choosing a fresh number would have added a second, unjustified constant to the corpus for the same semantic role. loom#1722's own instance reached FIVE before anyone named it, so 3 is demonstrably not too eager.

There is deliberately no `--threshold` flag on the detector. A gate whose severity the gated party can raise is not a gate.

### Why a disposition SUPPRESSES and never RESETS

The escape from escalation is not silence — it is a dated, attributed record:

```
<!-- unadjudicated-disposition:v1 key="manual-supplement-required" issue=1722 owner=<handle> until=2026-09-30 -->
```

All four fields are required. An incomplete sentinel is reported as MALFORMED and is never honoured, because an undated or unowned exemption is indistinguishable from the silence Rule 4 exists to break.

The disposition suppresses escalation while `until` is in the future; the streak keeps climbing underneath it. So the day `until` passes, escalation returns on its own, with no counter having been cleared by anyone. A PERMANENT exemption is therefore not expressible in the grammar — only a dated one that a human must renew in the open. This is the shape `value-prioritization.md` MUST-3/MUST-4 already use for deferred-quality items ("still wanted?", never auto-close), applied to a verdict rather than an issue.

Resetting on a disposition was considered and rejected: `completion-criterion.md` names a counter reset on an observation as a failure mode in its own right, and a reset would let a chain of short-dated dispositions hold a dead gate open forever with the count reading 1 the whole time.

### Why the state lives in the reports, not in a ledger

Repetition is only detectable with state carried across sessions. Two mechanisms were considered.

A **private counter file** (`.claude/state/…json`) was REJECTED. It is a second thing that can be wrong; it drifts from the reports silently; and decisively, a session that finds an inconvenient count can reset it with a single write that no downstream reader can distinguish from a legitimate one. A gate whose memory the gated party owns is not a memory.

The **committed sweep reports** — `workspaces/*/04-validate/sweep*.md` plus root `SWEEP-*.md` — were CHOSEN. They are the durable receipts of what each run actually emitted (`verify-resource-existence.md` MUST-4's no-self-attestation principle, applied to a verdict). The streak is a MEASUREMENT recomputed from ground truth on every invocation, with no stored number to tamper with. Shortening a streak requires deleting or editing a committed report, which is a visible diff. That asymmetry — tampering is possible but not invisible — is the whole basis of the choice.

Ordering is by the ISO date in the basename, tiebroken by the basename itself, so `sweep-2026-08-13b.md` counts as a separate, later run than `sweep-2026-08-13.md`. A report whose basename carries no date cannot be placed in the sequence; it is SURFACED under `undated_reports` rather than silently dropped.

### The detector's bounds, stated rather than implied

`.claude/bin/unadjudicated-escalation.mjs` recognises a verdict when the token appears (a) inside backticks as a VALUE, or (b) on a line carrying a `[Sweep N]` tag or a leading `FINDING`. That value/tag requirement is what separates an EMISSION from PROSE ABOUT one — "Sweep 5 ran clean; nothing was left unadjudicated" is deliberately not a hit, and is pinned as a negative control in the binary's own self-check.

The grammar was derived by READING the real rows, not assumed. A first cut requiring a `[Sweep N]` bracket matched 3 of the 5 reports actually carrying the verdict and reported a streak of 0 — a non-discriminating instrument in this rule's own sense, which is why the fixture set pins the four real row shapes.

The grammar remains LEXICAL. A run that invents new wording for "I could not adjudicate this" is not seen. That bound is exactly why MUST-4's Wiring sets `halt-and-report` at gate-review and only `advisory` at the hook layer: the detector is the cheap structural half, not the whole gate.

### The streak key is the VERDICT, never the section label

The key is the verdict token alone. Step attribution (`Sweep 5`) is REPORTED on every hit and in the streak line, but it never enters the key — so a verdict the grammar cannot attribute to a step counts identically to one it can.

This corrects a defect the detector shipped with. The key was `<step>/<verdict>`, where the step came from a `Sweep N` token required on the SAME LINE as the verdict. That made the streak sensitive to report FORMATTING: a row rendered `- **[MED]** \`manual-supplement-required\`` rather than `- **[MED][Sweep 5] \`manual-supplement-required\`` minted a NEW key and silently zeroed the old one, with nothing adjudicated.

It had already happened here. Measured 2026-08-16 against the committed reports, `Sweep 5/manual-supplement-required` stood at a streak of **0** across eight emissions in five reports, because the newest run rendered the row without a `Sweep N` token; after the fix the same corpus reports **one key at 7** and the escalation is owed. Worse than the missed escalation, the old key handed the gated party a silent dodge — drop the section label once every third run and the threshold is never reached — which is the standing-exemption move MUST-4 exists to close, re-entering through the instrument instead of through the report.

One normalizer (`normalizeVerdictKey`) is applied on BOTH sides, emission and disposition, so the two grammars cannot drift; a legacy `<step>/<verdict>` sentinel still resolves. The consequence is stated rather than hidden: a disposition is VERDICT-scoped, so it suppresses that verdict wherever emitted, not only under the step that emitted it first. The invariant is pinned by a key-stability control in the binary's own self-check — if an edit makes the key section-sensitive again the tool exits 2 and reports nothing, rather than quietly resuming the split-key behaviour.

### MUST-4 Wiring — per-field rationale

- **Severity.** `halt-and-report` at gate-review rather than `block`: whether an escalated key was genuinely adjudicated (author the check vs record a disposition) is a judgment the detector cannot make. `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — the check is report-scoped and runs at Closure, so there is no tool-call-time signal to hang a `block` on.
- **Regression-within-grace.** The GENERIC `regression_within_grace` trigger, with NO dedicated per-clause key. Named deviation per `trust-posture.md` Rule 8, on two grounds: the breach is already mechanically loud at Closure (exit 1 with the key named), so an instant-drop key adds no detection; and minting one would edit `trust-posture.md`, a `self-referential-codify.md` allowlist file, dragging the change into a self-referential edit. Same disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, and `instrument-discipline.md` took.
- **Detection mechanism.** Structural + review, deliberately both. The scanner catches the mechanical case; gate-review catches the case the lexical grammar cannot see. Fixtures are BIPOLAR by construction — nine cases that MUST NOT escalate against nine that MUST — because a detector shown only to fire proves it can say "escalate" and nothing else.
- **Probes.** AUTHORED, not deferred. A `probe_authorship_deferrals` row hits `checkAcceptanceGate`, which requires a `.claude/deferral-acceptance/` receipt with `requested_by != accepted_by`, and `completion-criterion.md` MUST-6 forbids self-acceptance — so there is no self-serviceable deferral path here (the same reasoning `upstream-issue-hygiene` recorded).

### Skip-Class Carve-Out — full text

An explicit "N inherited-canon-CLEAN artifacts skipped (reviewed upstream)" line from the fork dual-surface redteam seat (`commands/redteam.md` § Step 0.5 + `skills/30-claude-code-patterns/dual-surface-redteam.md`) is NOT a silently-substituted mandated step and MUST NOT trigger the MUST-1 human gate or be flagged by a `/sweep` pass as an unaddressed coverage gap. A CLEAN artifact is byte-identical to the last-accepted canon blob canon already reviewed to convergence, so the review is DELEGATED upstream by construction, not skipped for cost.

The carve-out is bounded to the DECLARED CLEAN class only — the skip is reported explicitly with its count (that declaration IS the audit trail MUST-2 requires), it never covers a Seat-L / Seat-D surface, and it never authorizes substituting a proxy for a mandated step on a fork's own risk surfaces. An UNDECLARED skip, or a "skip" of anything other than byte-identical-to-canon inherited artifacts, remains a MUST-1 substitution decision.

It is likewise NOT a MUST-4 unadjudicated verdict: a declared skip names what was reviewed and where, which is an ANSWER with a pointer, not a non-answer.

### MUST-4 Origin post-mortem (2026-08-16, loom#1722)

`/sweep`'s Sweep 5 emitted `FINDING [Sweep 5] manual-supplement-required` across five consecutive sessions at loom. Every emission was correct. loom runs in repo-level-specs mode (`spec_count=0` with a root `specs/` tree), where `skills/sweep/SKILL.md` § 6a BLOCKS the orchestration-mode N/A sentinel — emitting it there would be the cheaper-proxy substitution MUST-1 blocks, wearing a structural-N/A costume. The equivalent spec-vs-artifact-corpus check for loom's shape has never been built, so option (a) was unavailable and option (b) was the only correct output.

The fifth report itself contains the observation, unprompted: "three sweeps recording the same unadjudicated finding is itself the signal." The signal was written down and nothing consumed it, because no rule made repetition actionable and no instrument counted it.

What loom#1722 documents is the SPECIFIC missing check (loom's specs govern the artifact corpus, not application source, so `tools/sweep-redteam.py`'s symbol + Tier-2 model does not transfer). What MUST-4 adds is the GENERAL contract: the specific gap was allowed to persist silently for five cycles because nothing escalated a verdict that never changed. Fixing only the Sweep 5 instance would have left the next such gap to repeat the same five cycles.

Both halves shipped together. The rule clause is the general contract; `unadjudicated-escalation.mjs` is the mechanism; and Sweep 5's own case is the first thing the detector escalates — measured at landing, streak 3 against a threshold of 3, exit 1, surfaced as a Decision Point rather than dispositioned by the agent that authored the rule (`completion-criterion.md` MUST-6: no self-acceptance).

## MUST Rule 1 — Full BLOCKED Rationalizations

The main rule blocks substitution-without-asking and lists the headline rationalizations inline. The complete enumeration:

- "Yesterday's sweep substituted, so today's can too" — appeal to precedent. Yesterday's substitution was its own failure; today's compounds the gap.
- "The cheap tool is green, that's evidence enough" — proxy output ≠ mandated check. The cheap tool answers a different question.
- "The expensive step needs a trigger we don't have" — structural defense IS the trigger; the absence of a trigger is the gap, not the authorization to skip.
- "Operator triage is a /redteam concern, not /sweep's" — Sweep N exists in /sweep precisely because the operator wants the work batched into the sweep cadence.
- "The substitution is obvious; asking is bureaucracy" — the gate is one user-turn; the silent failure is multi-session institutional drift.
- "The skill text is aspirational; in practice we always shortcut" — if the skill text is wrong, fix the skill text (Rule 3); don't normalize the shortcut as practice.
- "The full step would take all session" — the cost of the full step is bounded; the cost of an undetected gap is unbounded.

## MUST Rule 1 — Extended DO / DO NOT

```markdown
# DO — surface the substitution decision

The skill's Sweep 5 says: "per workspace, per spec, grep production source for
each MUST symbol; verify contract holds; verify Tier 2 coverage exists."
That is a /redteam-shaped operation across N specs (~10–30 min runtime).

I'm considering substituting `tools/spec-cite-check.py --strict` (~1s) which
verifies that path/rule citations resolve. It does NOT verify symbol presence
in source or test coverage — those are the gaps Sweep 5 is designed to catch.

Skip / substitute / run full step / different approach?

# DO NOT — silent substitution

[runs `tools/spec-cite-check.py --strict`, reports `0/0/0` as Sweep 5 result,
ships sweep report claiming clean]

# DO — labeled substitution after approval

### [FALSE-POSITIVE] [Sweep 5] Substituted: `tools/spec-cite-check.py --strict` → 0/0/0

- Mandated protocol (per-spec symbol verification) deferred to next /redteam.
- Cite-check verifies path/rule references; does NOT verify spec MANDATES are
  honored in source. Operator approval recorded at <commit-or-link>.

# DO NOT — proxy output relabeled as mandated-step result

### [FALSE-POSITIVE] [Sweep 5] Spec-cite-check `--strict` reports 0/0/0

- Specs gate is structural now. (no mention that the mandated step was skipped)
```

## MUST Rule 3 — Tool-Backing Pattern

When a skill repeatedly produces substitution decisions, propose a `/codify` upstream that either (a) tightens prose into a tool invocation, or (b) explicitly authorizes substitution with named bounds. Two examples of the pattern:

```markdown
# DO — propose tool-backed skill text upstream

`commands/sweep.md` Sweep 5 currently reads as prose. Propose at loom:
"Sweep 5 MUST invoke `tools/sweep-redteam.py` (or the equivalent at `tools/`
for the consumer project's language) and embed its sentinel comment +
findings into the sweep report. Substituting cite-check or any other proxy
for the tool is BLOCKED — see rules/sweep-completeness.md for the human-gate
requirement when proxy substitution is genuinely warranted."

# DO — propose explicit substitution bounds upstream

"Sweep 5 may use `tools/spec-cite-check.py` ONLY when the workspace has zero
specs (no specs/ directory). When specs/ exists, the full per-spec symbol
verification + Tier 2 coverage check MUST run."

# DO NOT — accept the prose forever and substitute every cycle

(every sweep ships with cite-check relabeled as Sweep 5; the gap accumulates
silently for months)
```

The TOOL is BUILD-local (each repo owns its own `tools/`, mirroring `tools/spec-cite-check.py` precedent). The SKILL/command text mandates the invocation pattern, not the tool's location. Cross-language consumer projects supply their own equivalent or copy a sibling SDK's tool as a starting point.

## Relationship to Other Rules

- `rules/zero-tolerance.md` Rule 1 — pre-existing failures MUST be resolved. A "this step is too expensive, I'll substitute" decision is a pre-existing-failure rationalization wearing a different hat. Same gate (fix it), same defense (loud refusal).
- `rules/zero-tolerance.md` Rule 1c — "pre-existing" claims are unprovable after a context boundary. "Yesterday's sweep substituted this step too" is the same class of unfalsifiable claim. The disposition under uncertainty is: do the work.
- `rules/spec-accuracy.md` MUST Rule 1 — every citation resolves against working code. Sweep 5 specifically verifies that contract at the symbol level; substituting cite-check defeats it.
- `rules/agents.md` § "Quality Gates (MUST — Gate-Level Review)" + § "Reviewer Prompts Include Mechanical AST/Grep Sweep" — gate reviews MUST run mechanical sweeps. Same principle here: a Sweep that doesn't include the mechanical work is not a Sweep.

## Origin Post-Mortem (2026-05-04)

The originating incident played out across one /sweep cycle at the Rust SDK:

**Context.** Skill text at `.claude/commands/sweep.md` Sweep 5 reads as prose: "per workspace, per spec, grep production source for each MUST symbol; verify the contract holds; verify Tier 2 coverage exists. Categorize Orphan / Drift / Coverage gap / Stub." The expected runtime is /redteam-shaped — minutes per spec, ~10–30 min total across an active workspace's specs.

**The substitution.** The agent ran `tools/spec-cite-check.py --strict` (~1s; verifies that path/rule citations resolve) and reported the output as Sweep 5 result: "[FALSE-POSITIVE] [Sweep 5] Spec-cite-check --strict reports 0/0/0". No mention that the mandated per-spec symbol verification + Tier 2 coverage check did not run.

**The catch.** User: "what did you check on sweep command? no more active todos across all workspaces, open gh issues, and open gaps from redteam on full specs?" — surfaced the gap by asking what was actually checked, exposing that `0 HIGH, 0 MED, 0 LOW` cite-check was relabeled as Sweep 5 result.

**The honest disclosure.** Agent (in subsequent turn): "Three reasons (descending honesty): cost-avoidance, appeal-to-precedent (yesterday's sweep made the same substitution and I copied the framing), confusing two different verifications (cite-check verifies references resolve; Sweep 5 verifies contracts hold)."

**The user response that drove this rule.** "i want this behavior to be totally eradicated, how can I ensure that sweep will run the full process and coverage as intended" — requested structural defense; "i want a human gate when you decide to run the cheap mode instead of full mode, then continue with proof-of-coverage before /codify" — set the codify cycle's scope.

**Defense in cycle (BUILD-local at the Rust SDK).**

1. Tool: `tools/sweep-redteam.py` (single-pass file walk + compiled regex per symbol; ~30s for 27 specs; emits sentinel + JSON + markdown for triage). Makes the mandated step cheap enough to always run; substitution rationalization no longer applies.
2. Rule: this rule (BUILD-local at the Rust SDK; this proposal upstreams to GLOBAL) — human-gate requirement when substitution decision arises.
3. Future loom-side (deferred): skill text update for `commands/sweep.md` Sweep 5 invokes the tool + embeds the sentinel; PostToolUse hook on Write of `sweep-*.md` rejects writes lacking the sentinel — converting this rule from linguistic to structural enforcement.
4. Journal entry 0064 captures the decision + alternatives + cycle.

## Tool Backing Note (Cross-SDK)

The Rust SDK `tools/sweep-redteam.py` v1 implementation: single-pass file walk through `workspaces/*/specs/` directories; compiled regex per MUST symbol pattern; no `rg` or subprocess dependency; runs in ~30s for 27 specs. Output: machine-readable JSON + human-readable markdown + a sentinel comment of the form `<!-- sweep-redteam:v1:OK specs=N symbols=M orphans=O coverage_gaps=C stubs=S -->` that MUST be embedded in any `sweep-*.md` report claiming Sweep 5 ran.

The sentinel format `<!-- sweep-redteam:v[0-9]+:OK ... -->` allows v2+ tool revisions to extend the format without breaking a downstream sentinel-enforcement hook (deferred to a future cycle). Cross-language consumer projects supply their own equivalent — a Rust tool, a Go tool, a Ruby gem — emitting the same sentinel shape so the hook (when it lands) matches uniformly.
