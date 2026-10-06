# Adversarial Coverage — Extended Examples and Evidence

Companion to `.claude/rules/adversarial-coverage.md`. Extracted spans retain their original wording and historical context; the rule remains the governing contract.

## Rule 1 — full worked example

```markdown
# DO — derive, then report cells
"Coverage: 7 roles × 6 phases = 42 cells. 31 attacked, 9 excluded with reason, 2 OPEN."

# DO NOT — enumerate a roster and call convergence
"Deployed 8 agents. All report no remaining gaps. Converged."
```

## Rule 2 — full worked example

```markdown
# DO
"Not converged: yield is 2 and falling, but 3 cells are unattacked. Coverage governs."

# DO NOT
"Two consecutive rounds found nothing. Converged."
```

## Rule 3 — full worked example

```markdown
# DO
"`unavailable` exempts an indicator from band-breach. A deployment declares it, dodges the floor,
ships a clean board pack. Escape cost: 0. Compliance cost: an instrument. → route it: the state must
appear as a counted obligation and forfeit the matching conformance claim."

# DO NOT
"`unavailable` is a state for honestly reporting an uninstalled instrument." (true, and not the check)
```

## Rule 4 — full worked example

```markdown
# DO
"blocked_actions is absent from all 60 fields of constraint-envelope.schema.json (parsed, not grepped)."

# DO NOT
"blocked_actions is a wire field, so renaming it is breaking."
```

## Rule 5 — full worked example

```markdown
# DO — separate agent, refutation framing, no authorship cue
"Here is clause N14-D-01. Find the deployment configuration that satisfies it while defeating its
stated purpose."

# DO NOT
"Review the clause you just drafted and check whether it is correct."
```

## Rule 6 — full worked example

```markdown
# DO
"Searched: VerificationBundle, verification bundle, evidence package, export package, bundle,
manifest, package. Found eatp/06 §VerificationBundle — ratified, schema'd, Level-3 required."

# DO NOT
"Searched `manifest` and `export package`: 0 hits. Proceeding to define an Evidence Package."
```

## Originating failure mode

## The failure these rules fix

> **An attack round inherits the blind spot of its question.**

Fifteen rounds of correctness review did not surface a harm the corpus had **already written down in its
own limitations section** — because every round asked *"is this right?"* and none asked *"who receives
this?"*. The rounds were not careless; they found 23 defects. **Re-running a correct question harder
converges. It does not broaden.**

This is the documented failure mode of single-attacker red teaming: *"the common practice of training a
single attacker model **restricts coverage** across all potential attack styles and risk categories"*
and *"**removing coverage creates category blind spots**"* (QDRT, arXiv:2506.07121).

---

## 5. Evidence base

| Claim | Source |
|---|---|
| Intrinsic self-correction degrades reasoning without external feedback | Huang et al., *LLMs Cannot Self-Correct Reasoning Yet*, ICLR 2024 — arXiv:2310.01798 |
| Net −2.1% accuracy; **69.6%** of regressions are false problem identification | follow-up replication, arXiv:2510.12171 |
| External/tool feedback is what makes critique work | CRITIC, arXiv:2305.11738 |
| Decoupled critics beat self-critique; weak-to-strong critique generalisation | arXiv:2502.03492 |
| Self-critique has high false-positive rates and misses nearly all true negatives | RealCritic, arXiv:2501.14492 |
| Single attacker restricts coverage; multiple specialised attackers; *"removing coverage creates category blind spots"* | QDRT, arXiv:2506.07121 |
| Narrow attacks over-report success and under-report **category coverage** | arXiv:2512.20677 |
| Reasoning models exploit specification loopholes ~**2×** more (37.1% vs 17.5%) | arXiv:2605.02269 |
| Specification gaming = satisfying the literal spec while violating intent | survey, *Specification Gaming in AI* |
| Current-generation Claude models show high **evaluation awareness** | arXiv:2605.23055 |
| CoT does not reliably reflect true decision causes; faithfulness degrades under optimisation pressure | CoT-monitorability literature, arXiv:2603.05706 |
| Frontier practice: structured scenario sets, deduplication, transferability, **external** validation | Anthropic Frontier Red Team; METR external evaluation |

## Origin — full adoption and budget record

## Origin

2026-08-22 — adopted at loom from an upstream ecosystem proposal (loom#1904), co-owner-directed
(`artifact-flow.md` § Co-Owner-Directed Origination). The artifacts were built and validated against a
live 29-round run in the originating ecosystem BEFORE being offered here, and that test is the argument
for adoption: rounds 9–25 under an enumerated-axis method converged five times and were five times
wrong; round 26 under the derived surface found four never-attacked cells and every one produced a real
defect; round 29 reached all three convergence conditions. Two of round 26's findings were harms the
corpus had recorded in its own review findings and never actioned.

**Adopted with ZERO de-scoping** — every MUST, MUST NOT, DO/DO-NOT block, `**Why:**` line, the R×P
derivation and the §5 evidence base are verbatim from the offer. Changed for loom only: `priority:` +
`scope:` frontmatter (`rule-authoring.md` MUST-7, absent upstream); `/challenge` removed from `paths:`
and Scope (no such command here); the `subagent-delegation-verification.md` cross-reference re-pointed
to `agents.md` § Agent-Result-Delivery (the upstream target does not exist at loom and would have been a
dangling reference per `cc-artifacts.md` MUST NOT); the originating ecosystem's internal workspace path
and journal numbers scrubbed to the generic principle (`knowledge-cascade-routing.md` MUST-3 — this rule
cascades to every consumer, so another ecosystem's internal paths must not ride along); and this Wiring
block added.

**Budget: MEASURED, not assumed.** The rule charges ZERO bytes against all eight injection profiles —
its `paths:` name two exact command files and two workspace subtrees that no profile probe matches.
Verified with a firing control: widening `paths:` to `**/*.md` moved `loom-command-edit` 492608 →
505724 B (over budget) and breached `root-doc`'s +5% ceiling; restoring the real paths returned exactly
to baseline. So `rule-authoring.md` Rule 10's proximity-band gate does not fire.
