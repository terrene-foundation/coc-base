# Completion Criterion — Evidence Base, Refutations, and Measured Gaps

Depth companion to `rules/completion-criterion.md`. Every `MUST-N` anchor in that rule resolves here.

**Read this before proposing any change to a convergence criterion, a redteam round count, an adaptive-review scheme, or a "done" definition anywhere in the corpus.** It exists so the 2026-08-02 research is never re-derived. Four independent investigations ran — three research lanes plus a downstream proposal reviewed by two more reviewers — and they converged. § "Searched for and NOT found" records the dead ends explicitly so nobody re-walks them.

## 1. The mechanism, stated once

A verification loop whose stopping rule is "review until no findings" **cannot terminate**. Not because the code is bad and not because the reviewer is noisy: a generative reviewer pointed at an unbounded surface keeps producing genuinely real findings, because each round samples a different slice and there is always another slice.

What used to bound review was **human cost** — reviewers tire, bill hours, lose interest. Review self-limited without anyone designing a bound, so the absence-of-findings criterion was never load-bearing; the budget was, invisibly. Agent review has near-zero marginal cost and never tires. Remove the natural bound without installing a designed one and the loop runs forever on real findings.

The same mechanism explains surface-explosion: if done is the absence of findings, **every capability added moves done further away**, because it enlarges the surface the absence must hold over.

## 2. The triggering observation, and why it is diagnostic

An adversarial review loop ran to roughly **fifty rounds** without converging. The obvious hypothesis — that low-value polish findings were resetting the counter — was **tested and falsified**: of seven headline findings, **zero** were incremental. All were real defects or real gaps in enforcement-bearing guards, with genuine bugs still surfacing at rounds 8, 10 and 11.

That is the load-bearing fact. **"Only real findings count" filters nothing when every finding is real.** A classifier that removes noise removes nothing here. Nothing inside the loop looked like waste from the inside, which is what makes it dangerous rather than merely wasteful.

Reported symptom across repositories: *"projects are never done."* Nothing about the mechanism is repo-specific.

## 3. Every obvious fix, and what refutes it

| Proposed fix | Refuted by |
| --- | --- |
| **Cap the rounds** | *Looping Is Not Reliability* (arXiv:2607.24604): correctness **82.0% → 67.3%** rev 1→2; **16.0% of trajectories produce a correct patch then LOSE it** by rev 3. Iteration is not monotone, so a count cannot encode correctness. (The paper also reports a flat condition — the load-bearing claim is **non-monotonicity**, not "more rounds are bad".) This is why `completion-criterion.md` MUST-4 makes the cap a **circuit breaker** and mandates last-known-good preservation. |
| **Filter harder on severity** | Falsified in the field (§2) — zero of seven findings were incremental. Independently, `product-completion-first.md` MUST-1 **BLOCKS severity-as-gate** outright; the corpus gates on CATEGORY with fail-closed ambiguity resolution. |
| **Trust the critic** | arXiv:2407.04549 — iterative self-refinement drives the model evaluator away from human judgement in-context. Huang et al. (ICLR 2024) — intrinsic self-correction without an external signal degrades output. |
| **Iterate longer** | Reflexion's gains are real (~12 steps, AlfWorld) but only against an **external** oracle — and even then, oracle-grounded reflection scored **55.15 vs 55.76 baseline** at moderate complexity (arXiv:2506.12928). External signal is **necessary, not sufficient**. |
| **Reduce review because modern models self-critique** | The capability that would justify it — reliably **locating** one's own errors — is the one that has NOT improved. Models correct others' errors effectively and fail on their own. Tyen et al.: models repair an error once its location is given but cannot find the location themselves. See §5. |

Corroborating scale: *When Agents Do Not Stop* (arXiv:2607.01641) — **68 confirmed unbounded-loop failures across 47 of 6,549 real agent repos**, a measured production failure class. *The Verification Horizon* (arXiv:2606.26300) — Rice + Goodhart make any proxy, including "the reviewer found nothing", subject to inevitable failure.

## 4. The corpus survey — nothing in loom could have stopped it

Twenty completion-bearing surfaces were read. **No clause is capable of terminating the loop.** The reason is structural, not an oversight in any one rule:

1. **Every terminal condition is the absence of findings** (`commands/redteam.md` Convergence Criterion 3). An absence cannot be finished, only waited for.
2. **`product-completion-first.md` is a pass-through in this case by design.** Its BUG row is a positive allowlist of what counts and its disposition reads "converges to 2 clean rounds" — the classifier **feeds** the loop rather than bounding it. It was built to stop incrementals resetting the counter; when every finding is a real BUG it removes nothing.
3. **Three clauses ratchet the surface UPWARD per round** — `zero-tolerance.md` Rule 1 (found ⇒ owned, this run), `autonomous-execution.md` MUST-4 (warm same-class gaps fixed now), `coc-artifact-eval-coverage.md` MUST-2 (every finding becomes a permanent named case). Each round can legitimately **create** the work the next round finds.
4. **Both ambiguity resolvers point inward** — `product-completion-first.md` MUST-1 (ambiguous → IMMEDIATE) and MUST-3 (no covering criterion → ESCALATE). Correct individually; jointly they mean uncertainty always adds work.
5. **Every clause that could gate the loop is asymmetric** — `sweep-completeness.md` MUST-1, `redteam.md`'s stop-early violation, `wave-loop.md` MUST-6 all fire on doing LESS. Nothing fires on doing more.
6. **`redteam.md` penalises stopping with no symmetric penalty for continuing.**

Measured absence: `grep -rniE "before (any )?verification|acceptance list|stated up.?front|exit criteria|definition of done"` over `.claude/rules/*.md` + `.claude/commands/*.md` → **zero matches** (positive control `"acceptance criteria"`, same command form, same corpus → 12 lines). `commands/todos.md` — the plan-authoring gate — contains **zero** occurrences of `success criteri` or `acceptance`.

**The corpus mandates that findings be checked AGAINST criteria it never mandates anyone write down first.** That is the gap `completion-criterion.md` MUST-1 closes.

The one clause on the right axis is `wave-loop.md` MUST-1 bound B — it explicitly bounds *verification attention*. But it bounds the **surface**, not the **iterations over it**: a 3-invariant wave can still run 50 rounds.

## 5. Why an external critic is NOT redundant with internal deliberation

The strongest temptation is to read the overthinking literature as licence to cut external review. **That is a category error and it must not be repeated.**

The overthinking results are real but measure **internal chain-of-thought length within a single generation** — Anthropic's *Inverse Scaling in Test-Time Compute* (four task families where longer reasoning lowers accuracy; five distinct failure modes; Claude models increasingly distracted by irrelevant information); Chen et al. ICML 2025 (*Do NOT Think That Much for 2+3=?*). Survey consensus is an inverse-U on reasoning length.

**They do not measure external review rounds in a fresh context.** Different variable. No paper measures the second. Anyone claiming the hypothesis is confirmed *or* refuted by the overthinking papers is over-reading them.

What rescues external review is exactly what a governance redteam controls:

- **Heterogeneity.** Heter-MAD (agents from different models) improved *every* tested MAD framework, up to +5.8%. Homogeneous debate is what fails — no MAD method beat plain CoT in >20% of 36 configurations.
- **Context separation.** Separate-session review consistently outperforms same-session self-correction, attributed to removing anchoring on the generation context. Models correct others' errors effectively and fail on their own.
- **Collaborative framing.** Competitive/zero-sum MAD degenerates; collaborative MAD outperformed all baselines across every setting.

Hence `completion-criterion.md` MUST-5's **disjoint-context** clause: a fresh-session reviewer with no shared history counts as an external signal, because what makes an internal critic redundant is shared context and a shared failure distribution — not shared silicon. It is a throughput tier, **not an oracle**: critics hallucinate too.

**Self-critique is weakest where it matters most.** Self-verification loops performed *worse than guessing up front*; gains appeared only with an external **sound** verifier. Adding a generic critique directive dropped Self-Refine **76.0% on TruthfulQA** via over-correction. Averaged across iterations, a single self-verification call breaks more correct responses than it fixes.

## 6. The discriminator is ORACLE PRESENCE, never model capability

Best-supported finding in the set. Verifier-based scaling asymptotically dominates verifier-free (*Scaling Test-Time Compute Without Verification or RL is Suboptimal*); the whole self-improvement premise is fragile under **imperfect** verifiers (Stroebl et al.).

**The inversion that matters for a governance corpus:** a change with real tests that can genuinely fail has a sound verifier and needs less LLM adversarial review. A change with **no** executable oracle — prose rules, specs, config, documentation, governance artifacts — has no sound verifier at all, so adversarial review is the only verification channel available.

**Artifact changes need MORE review than code changes, not less.** This is the opposite of the natural instinct, and it is why `completion-criterion.md` MUST-5 floors the no-oracle branch at the full budget.

**Model self-reported confidence is the worst-supported candidate signal and is REJECTED.** Verbalized confidence is pervasively overconfident, clustering 80–100%, persisting through self-consistency and CoT. A 2026 mechanistic study found a stable middle-to-late-layer circuit writing confidence inflation at the final token position that responds to the committed answer **largely independently of that answer's correctness** — the model partly reports *that it answered*, not *how likely it is to be right*. Efficacy is genuinely contested, but nobody argues it is good enough to gate a security review on.

## 7. Security surfaces: the direction is UP, not down

Not a signal for reducing review. Security vulnerability counts **increase across later refinement iterations** even as functional correctness improves; practitioner guidance from that line caps consecutive LLM-only iterations at 3 and resets the chain after each human review. LLM reviewers systematically miss race conditions, timing attacks, and complex authorization logic **regardless of prompting** — SAST cross-referencing recovered 47% of baseline misses. Adversarial framing alone is not sufficient either: *Refute-or-Promote* reports 80+ agents including dedicated adversarial reviewers **unanimously endorsing a padding oracle that did not exist**.

This independently corroborates `agents.md` § "Correctness-Review-Clean Is Not Security-Clean" (kailash-py #1842-S3: a CLEAN correctness verdict co-occurred with a CRITICAL revocation bypass the same-round security reviewer caught).

## 8. Where the yield actually comes from

**Technique diversity, not repetition.** Testing averages ~30% defect-removal efficiency per individual test step; most individual test forms remove below 35% of defects present. Design reviews and code inspections average ~85%; static analysis frequently >65%. High DRE **cannot be achieved by testing alone** — exceeding 95% requires the combination.

Rounds 3 through 50 of the same adversarial reviewer are **not** 48 draws at the same rate; they are 48 draws against the residue that lens already filtered. The residual after convergence consists of **blind spots shared by generator and critic**, which more rounds of the same model cannot reach. Hence MUST-4's instrument-rotation mandate.

Fagan: 4–5 reviewers optimal with diminishing returns beyond; Porter et al. found **reviewer expertise mattered much more than process** — selection dominates count.

**Measured knees**, for calibration: parallel aggregated passes plateau at **n≈5–10**; sequential fix loops become refinement-resistant by **iteration 3–4**, with P(further improvement) < 10% by iteration 10; LLM repair loops peak at **~2 rounds** then decline. Fifty rounds is roughly an order of magnitude past every number in the 2025–2026 literature.

**Confound worth knowing:** above ~500 lines of diff, returns drop sharply as context overflow forces surface pattern-matching. A flat yield curve may be **chunking failure, not a detection ceiling** — which aligns with `autonomous-execution.md`'s existing ≤500 LOC shard budget.

## 9. What mature disciplines actually do

**No mature discipline uses absence-of-findings.** Pentest, financial audit, ALARP and medical-device validation all bound scope up front, set a threshold up front, and have a **named human accept the residual**. NIST SP 800-115 states plainly that it *"does not present a comprehensive... assessment program"* and that *"no individual technique provides a comprehensive picture... when executed alone."*

The named practices `completion-criterion.md` MUST-1 draws on: **Release Criteria** (Rothman — SMART, consensus-agreed before the fact), **Definition of Done** (Scrum — universal, per-increment, ≤7–10 items), **entry/exit criteria** (ISO/IEC/IEEE 29119 — risk-directed effort, Part 1 informative and Parts 2/3/4 normative), **quality gate / bug bar** (Microsoft SDL — *"never relax it once it's been set"*), and **charter** (Session-Based Test Management — chartered, time-boxed, reviewable, debriefed).

Bolton's stopping heuristics legitimise both halves: **#1 "Time's Up!"** is a named respectable stop, **#4 "Mission Accomplished"** is a pre-stated acceptance list, and **#10 "No More Interesting Questions"** — *no question's answer is worth its cost* — is the criterion the 50-round loop was missing. **#9 "The Customary Conclusion"** is on that list as a heuristic to be WARY of: a fixed round count is a customary stop, not a measured one.

Bach's Good Enough Quality, clause 4, is the missing stopping rule almost verbatim: *"In the present situation, and all things considered, further improvement would be more harmful than helpful."* Note his bar is **"no CRITICAL problems"**, not "no known defects".

**Vocabulary discipline — use pentest, not audit.** Audit materiality works because misstatements share one unit against one total tied to one stakeholder decision. **Findings share no denominator.** There is no threshold below which a finding "does not matter"; there is only a named person deciding, on the record, to carry it. An accepted finding is **a bet — logged, owned, revisitable** — never a claim of harmlessness.

## 10. Why the criterion must not be self-authored

An agent that writes its own acceptance criterion and then verifies against it has moved the self-judgment one step earlier, not removed it. The criterion is gamed **at declaration time**, and every downstream check then passes honestly — which is why a Detection scheme that only checks the list's *timing* and *shape* cannot discriminate a deliberately narrow list from an honest one.

Spec-driven development and property-based testing both make the role split structural, the latter explicitly to prevent the *"cycle of self-deception."* Hence MUST-1's ratification requirement and Detection check (e), which requires the reviewer to **independently derive** an acceptance surface from the spec/brief and report every item absent from the authored list.

## 11. Imminence is a third axis

Severity asks *how bad if triggered*. Category asks *does this block completion*. **Imminence** asks *is this happening to a user right now*.

A finding that is live in production AND actively exploitable, actively losing data, or actively serving a wrong answer must be surfaced immediately and in parallel — and **still must not gate completion**, which is what keeps the scope-creep vector closed. Imminence routes to an incident lane, not onto the acceptance list. Without this axis, a completion criterion either ignores live incidents or reopens the unbounded loop to admit them.

## 12. Searched for and NOT found — do not re-walk these

Reported as **not found**, not as **does not exist**:

- **No study measures the yield of the Nth adversarial review round in a governance/prose-artifact setting.** Every diminishing-returns number in §8 is code review or debugging loops. The transfer to rule/spec review is unmeasured.
- **No study tests whether external adversarial review degrades output quality for frontier reasoning models.** The core hypothesis has not been tested by anyone.
- **No false-negative-rate comparison for adversarial vs standard security review.** 2026 security-review work is overwhelmingly focused on false positives (10–50% FP rates), because that determines usability; false negatives are acknowledged and addressed by ensembles, not measured.
- **No canonical "capability probe for effort calibration" pattern.** Harness-probe literature does tier detection and harness comparison; nothing uses a probe result to set a verification budget. Using one would be a novel application, not a cited one.
- **No classical (pre-LLM) source bounds review by ROUND COUNT** with an empirical basis. Bounding by reviewer count (4–5), time (SBTM), or rate exists. By repeated passes — not found.
- **No formally named antipattern** for "DoD expressed as absence of findings."
- **No canonical author formalises "zero KNOWN defects"** as a named criterion. Bach's is "no critical problems" — adjacent, not the same.

**Verification caveats on specific numbers, carried forward honestly:** several source PDFs returned content streams the fetchers could not decode, so a small number of headline figures rest on search-index summaries rather than a read of the source table. Where a figure is load-bearing for a decision, re-read the source before relying on it. Metrics across the security-review literature are not directly comparable (F1 vs accuracy vs detection rate vs FP rate); one systematic review calls direct comparison inconclusive.

## 13. Provenance

2026-08-02, co-owner-directed. Four independent investigations converged: a corpus-completion-surface audit (§4), a practice-and-standards review (§9), an overthinking/adaptive-calibration review (§5–§7), and a downstream proposal (loom#1528) itself adversarially reviewed by two further reviewers who converged on the **imminence** and **authorship** gaps and corrected several citation over-claims.

Two premises did not survive and are recorded so they are not re-proposed: **(a)** scoping the acceptance list to *user-visible* behaviour — the highest-consequence defect classes (security, data-integrity, tenant-isolation) are the least visible; and **(b)** calibrating review depth on *model capability* — the least-supported axis available, refuted in §5–§6.

A third near-miss is recorded because it is the most instructive: the first draft imported an external best practice (**"gate on a severity bar"**) over a ratified local rule (`product-completion-first.md` MUST-1, which BLOCKS severity-as-gate and fixes CATEGORY as the gate). It produced a rule that read authoritative — it cited real industry practice — while contradicting the corpus it shipped into. **Check the corpus before importing the literature.**

---

# Worked DO/DO-NOT blocks and BLOCKED corpora (extracted from the rule)

Extracted at authoring time under measured injection-budget pressure — the `workspace-note`
profile sat at 218736 B against a 216904 B budget BEFORE the rule existed, so an un-extracted
39 KB rule exceeded the +5% ceiling by 30 KB. Nothing here was cut for being wrong; it was cut
for being depth. Every `MUST-N` below is the rule's clause of the same number.

## MUST-1 — the acceptance list

```markdown
# DO — stated up front, two layers, category-gated, ratified by a distinct party

## Acceptance (this deliverable) — authored by the product owner at /todos, unchanged since
1. Revocation denies a revoked token within one refresh interval.
2. Tenant A cannot read tenant B's ledger rows under any documented call path.

## Definition of done (universal)
Tests pass · no stubs · CHANGELOG entry · zero open `BUG` / `INVEST-NOW` findings

# DO NOT — no list, or a list derived at review time

"Run /redteam and fix what it finds."
(the acceptance surface IS the findings, so it grows with every round and can never be reached)

# DO NOT — self-authored by the agent that will satisfy it

"The criteria for this wave are, as best I can reconstruct them from what review surfaced: ..."
```

**BLOCKED rationalizations:** "The spec is the acceptance list" (a spec describes the system; an acceptance list states what THIS deliverable must satisfy) · "We'll know it when we see it" · "Writing criteria up front is waterfall" · "The findings will tell us what the criteria should have been" · "Only user-visible behaviour belongs on the list" (**the most dangerous form** — security, data-integrity and tenant-isolation defects are invisible until catastrophic, which is exactly why they must be ON it) · "The list would just be everything anyway" · "I wrote the list, and I know the deliverable best" (that is the conflict, not a qualification).

## MUST-2 — converge vs budget, and imminence

```markdown
# DO — split, then converge on one side and budget the other

BUG / INVEST-NOW / on-list: 2 findings → converge (iterate to clean; no cap applies)
INCREMENTAL + off-list: 9 findings → backlog w/ the four MUST-2 defer conditions; 1 round
                                    budgeted; not gating
LIVE + actively exploitable: 1 finding → notify NOW, in parallel, incident lane; still not gating

# DO NOT — one convergence criterion over everything

"11 findings, none trivial. Round 12." (round 50 is this sentence, 38 more times)
```

**BLOCKED rationalizations:** "Every finding here is real, so every finding must gate" (real ≠ `BUG`/`INVEST-NOW` ≠ on-list; the 50-round loop had zero trivial findings) · "Budgeting findings means shipping known defects" (it means shipping *triaged* ones, which is what every shipped system has done) · "The category call is subjective, so gate on everything" (it is fail-closed, not subjective: ambiguity resolves INTO the gating half) · "One more round is cheap" · "The live-incident finding can wait for the round to close" (imminence does not wait).

## MUST-3 — the counter

```markdown
# DO — counter tracks the ARTIFACT's state, and the surface includes consumers

Round 5 finds an on-list defect in shared validate_scope() → fix lands → counter resets for
validate_scope AND all 40 call sites (their evidence was earned against the OLD behaviour).
Deliverable counter = MINIMUM over surfaces, so it is 0, not "4 clean of 5".

# DO NOT — counter tracks the REVIEWER's output, or resets only the diff

Round 5 finds anything → counter → 0 → begin again
(a better reviewer now makes completion strictly less reachable)
"One-file diff, so one surface resets" (40 call sites keep stale evidence)
```

**BLOCKED rationalizations:** "A new finding means the earlier clean rounds were wrong" (it means they did not cover that surface) · "Resetting globally is the conservative choice" (it is the non-terminating choice) · "Partial resets are hard to track" (the surface is the diff plus its consumers) · "The diff is one file, so one surface resets".

## MUST-4 — circuit breaker, rotation, last-known-good

```markdown
# DO — effort budget, risk-allocated, rotating instrument, cap as a breaker

Budget: 3 rounds. R1 adversarial security lens · R2 mechanical AST/grep sweep ·
R3 fresh-context correctness reviewer.
Stop on budget exhaustion OR marginal BUDGETED-HALF yield ≈ 0 — stated with its falsifying
result: "round 3 surfaced 0 new INCREMENTAL where rounds 1-2 surfaced 6 and 2."
At the cap with open gating-half findings → ESCALATE, naming them. Never "converged".
Last-known-good pinned at the round-4 tree, which passed its gating checks.

# DO NOT — N rounds of the same lens, or a cap-stop called done

Round 6 of the same reviewer prompt (the residue is that lens's blind spot)
"Round 5 of 5, so this is convergence."
```

**BLOCKED rationalizations:** "The reviewer found something last round, so it is still productive" · "Rotating instruments is more setup than just re-running" · "Two clean rounds is the standard" (a customary stop, not a measured one) · "A cap risks shipping a defect the next round would have caught" (the cap is a BREAKER — hitting it is escalation, not a ship decision) · "We are at round 4, so we are nearly done" (a round count encodes effort, never correctness) · "The latest revision supersedes the earlier one" (16% of trajectories lose a correct patch by rev 3).

## MUST-5 — oracle presence

```markdown
# DO — condition on the oracle, with soundness established

Tested engine change; red established for the changed property (stash-and-run shows RED)
  → oracle sound FOR THAT PROPERTY → 1 rotated adversarial round (floor)
Baseline rule / spec / config edit → no oracle exists → full budget, rotating lenses
Revocation path → trust-bearing → full uncapped loop regardless of oracle

# DO NOT — condition on the model, its confidence, or a suite-level green

"This model self-critiques well, so one round is enough."
"The harness is green, so the oracle is sound."
"I'm confident in this change, so skip the security lens."
```

**BLOCKED rationalizations:** "Modern reasoning models self-critique, so external review is redundant" (the capability that would justify this — locating one's OWN errors — has not improved) · "The model reported high confidence" (verbalized confidence responds to having answered, not to being right) · "It's only a doc/rule change" (it has no oracle at all — an argument for MORE review) · "The tests pass, so it's verified" (only if they could have failed for this property) · "This surface is probably not security-relevant" (ambiguity resolves TO trust-bearing).

## MUST-6 — residual acceptance

```markdown
# DO — a bet, owned by a standing role, with both triggers

Residual R-3 · accepted by: platform-engineer (standing role) · category INCREMENTAL
safety: no shipped path reaches it · value-anchor: <link> · full-fix criteria: <list>
revisit: on next auth-surface change  OR  2026-11-01, whichever first

# DO NOT — self-accepted, or accepted by absence

"Logged as residual; no reviewer available this cycle." (not accepted → not done)
"Low impact, closing." (a claim of harmlessness, with no name against it)
```

**BLOCKED rationalizations:** "The agent triaged it, that is the acceptance" · "No human was available, so I filed it as residual" · "It is low severity, it does not need a signature" (route ceremony by category, but SOME name is required for anything gating-eligible) · "The revisit trigger is implicit in the backlog" (7 of 7 deferred items decayed) · "A calendar date is arbitrary" (an event trigger that never fires is a permanent park).
