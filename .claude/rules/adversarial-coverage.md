---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/redteam.md"
  - ".claude/commands/vet.md"
  - "**/04-validate/**"
  - "**/04-vet/**"
---

# Adversarial Coverage Rules — proving the attack surface closed

Full worked examples, research evidence and origin: `.claude/guides/rule-extracts/adversarial-coverage.md` (**the companion**). The roles, phases, convergence gates and wiring remain here.

## Scope

These rules govern ALL adversarial review in this repository: `/redteam`, `/vet`, and any
agent asked to attack, critique, or validate an artefact. They exist because a 17-round validation
(a 17-round validation series in the originating ecosystem) converged **five times** and was **five times wrong**,
each time because the round had run out of answers to a question, not out of questions.

Origin: adopted at loom 2026-08-22 from an upstream ecosystem proposal (loom#1904); the
originating discovery receipts stay in that ecosystem's journal and are deliberately not
cited by path here (`knowledge-cascade-routing.md` MUST-3 — the cascading copy carries the
generic principle, the specific provenance stays in the local receipt). Evidence base: §5.

---

The originating failure mode and its research quotations are preserved in the companion § “Originating failure mode”.

## MUST Rules

### 1. Coverage is derived, never enumerated

An adversarial review MUST derive its attack surface from the **structure of the artefact under
review**, and MUST NOT use a hand-listed set of checks, agents, or "perspectives".

**A hand-listed roster is a preference; a derivation is a proof obligation.** The derivation for a
normative artefact (a specification, rule, policy, or contract) is fixed and is given in §3.

**DO:** report “7 roles × 6 phases = 42 cells; 31 attacked, 9 excluded with reason, 2 OPEN.” **DO NOT:** infer convergence from “8 agents, no findings.”

**Why:** a roster converges when its members run out of findings, which is a fact about the roster. A derivation converges when every cell is discharged, which is a fact about the artefact.

### 2. Convergence requires BOTH falling yield AND closed coverage

A review MUST NOT be declared converged on falling finding-count alone. Convergence requires:

1. **Coverage closed** — every derived cell attacked or explicitly excluded with a stated reason; and
2. **Yield falling** — the two most recent rounds produced no finding that would break, leak, alarm
   falsely, or be unreachable; and
3. **Questions stable** — no new cell was added in the last two rounds.

**DO:** report “Not converged: yield is falling but 3 cells remain unattacked.” **DO NOT:** declare convergence from two empty rounds alone.

**Why:** a falling count under an **expanding** question set is not convergence — it is the old questions being exhausted while new ones are still producing. In the origin case every newly opened axis found a defect on its first pass, four times running.

### 3. Every normative clause gets the incentive check

For **every** clause that offers an alternative, an exemption, a default, or a state meaning
*"not done"*, the review MUST compute **which branch a payoff-maximising deployment takes**, and MUST
record the answer.

> **If the escape is cheaper than compliance, the clause contains a preference, not a requirement.**

The fix is always the same shape: **route, don't excuse** — make the escape a *declared, counted*
departure so choosing it is visible and costed.

**DO:** compute that `unavailable` buys an exemption for zero escape cost, then make it a counted obligation forfeiting the conformance claim. **DO NOT:** merely describe the state as honest reporting.

**Why:** in the origin case this pattern recurred **five times in eight rounds** — `k = 1`, an `undeclared` default, `unavailable`, *"or disclose"*, *"costs the claim"* — each written to be honest about a limitation and each immediately the cheapest way around the rule. And the exposure is rising, not falling: reasoning-focused models show **roughly twice** the propensity to exploit specification loopholes as their predecessors (37.1% vs 17.5%, arXiv:2605.02269).

### 4. A finding is warranted by evidence, never by reasoning

Every finding MUST cite the artefact that establishes it — a `file:line`, a command and its output, a
parsed field list. A finding warranted only by an argument is a **hypothesis** and MUST be labelled
one.

**DO:** cite the parsed schema showing `blocked_actions` absent from all 60 fields. **DO NOT:** infer breakage from a field name without reading its contract.

**Why:** model chain-of-thought *"does not always reflect the true causes of model decisions"* and faithfulness *"degrades under optimization pressure"*. The reasoning that produces a finding is not evidence for it. In the origin case, **16 of the defects** were capabilities asserted absent that existed under another name — every one survived reasoning and died to one command.

### 5. The attacker MUST NOT be the author, and MUST NOT be told it is reviewing its own work

Adversarial review MUST be role-separated: a distinct agent, given the artefact **without** the framing
that it produced it, and instructed to **refute** rather than to assess.

**DO:** ask a separate attacker to find a compliant deployment that defeats clause N14-D-01’s purpose, without an authorship cue. **DO NOT:** ask the author to review its own clause.

**Why:** intrinsic self-correction **degrades** accuracy without external feedback — a measured net **−2.1%**, with **69.6%** of the damage from *false problem identification*, the model critiquing a correct answer into a wrong one (arXiv:2310.01798 and follow-ups). *"Decoupled critic LLMs significantly outperform both self-critique methods and approaches using stronger critic models"*, and a **weaker** critic can guide a stronger author (weak-to-strong critique generalisation). Separately, current-generation Claude models show **high evaluation-awareness** (arXiv:2605.23055) — a model told it is reviewing its own output can perform the review rather than conduct it.

### 6. Absence claims and design decisions both require a functional search

An **absence claim** (*"the corpus has no X"*) and a **design decision** (*"we will add X"*) are the
same assertion — that no existing decision governs. Both MUST be supported by a functional search:
*what would this be called if it already existed?* — with the search terms **recorded**.

**DO:** record searches across “VerificationBundle”, “verification bundle”, “evidence package”, “export package”, “bundle”, “manifest” and “package” before adding a mechanism. **DO NOT:** treat two unmatched names as proof of absence.

**Why:** the origin case recorded **sixteen** instances of a capability existing under another name, and the rule as first written covered only absence claims — so a clause that *invented* a mechanism beside a ratified one passed review twice.

---

## MUST NOT Rules

### 1. No convergence claim without a coverage table

MUST NOT report "converged", "no remaining gaps", or "all agents found nothing" without publishing the
derived coverage table and the disposition of every cell.

### 2. No naming a risk in place of checking it

MUST NOT close a review with a clause flagged as *"most likely to be wrong, should be attacked"* and
unattacked. **In the origin case a correct, specific, named prediction failed to prevent the error four
consecutive times**, while a one-command check resolved it every time. **A flag is not a mitigation.**

---

## 3. The derivation — the attack surface of a normative artefact

**This is complete by construction, not by enumeration.** A normative clause cannot be stated without
all seven roles; an artefact it governs cannot exist outside the six phases. Coverage is the product.

### Roles — derived from the structure of `SUBJECT MUST PREDICATE`

| # | Role | The question it asks | Defect class |
|---|---|---|---|
| R1 | **Subject** — who must comply | Can it be done at all, with what it is given? | implementability |
| R2 | **Predicate** — what must hold | Is it right, and does it say what it means? | correctness |
| R3 | **Verifier** — who determines compliance | Can a third party tell, from the artefact alone? | verifiability |
| R4 | **Recipient** — who receives the artefact | What does this reveal to the party holding it? | disclosure |
| R5 | **Record-subject** — who the artefact is *about* | What does this do to the party it describes? | subject harm |
| R6 | **Co-context** — the other clauses in force | Does it hold when only half of them land? | composition |
| R7 | **Complying agent's payoff** | Which branch does a payoff-maximiser take? | incentive |

> **R4 and R5 are distinct and the distinction is load-bearing.** A resolution record *goes to* a
> customer and is *about* an employee. Attacking only R4 finds what the customer learns; only R5 finds
> what it does to the person named.

### Phases — the states an artefact governed by a clause can occupy

| # | Phase | The question it asks |
|---|---|---|
| P1 | **draft / amend** | Is the clause itself sound? |
| P2 | **bind** | What happens when it takes force on a real implementation? |
| P3 | **emit** | What is frozen at production time and can never be revisited? |
| P4 | **retain** | What survives, for how long, and what is destroyed? |
| P5 | **disclose** | What crosses a boundary, to whom? |
| P6 | **supersede** | What happens to artefacts produced under the prior version? |

### Coverage obligation

**Every (Rᵢ, Pⱼ) cell is attacked or excluded with a stated reason.** Cells excluded as
*not-applicable* MUST say why in one line. A review reports:

```
Coverage: 42 cells — 31 attacked, 9 n/a (reason given), 2 OPEN
Convergence: BLOCKED — 2 cells open (R3×P5, R5×P6)
```

**`R×P` is the axis space. It is closed when the table has no OPEN cell — and that is a proof, not an
argument.**

---

## 4. Attacker specialisation

Attackers MUST be **role-conditioned**: one attacker per role, each given only its role's question, and
each blind to the others' findings until aggregation.

**Why:** *"the common practice of training a single attacker model restricts coverage across all potential attack styles and risk categories"*; QDRT's remedy is **multiple specialised attackers** with behaviour-conditioned prompting, and its ablation shows *"removing coverage creates category blind spots"* (arXiv:2506.07121). A single generalist attacker asked for "any problems" reproduces the origin failure by construction — it will ask its own most-available question.

---

## 5. Evidence base

The complete claim/source table is preserved in the companion § “5. Evidence base”.

## Cross-references

- `rules/sweep-completeness.md` — fixing one instance obliges sweeping its siblings
- `rules/verify-resource-existence.md` — the cited line must be opened
- `rules/agents.md` § "A Dispatched Agent's Result Is Not Received Until It Is DELIVERED" — a delegated
  finding is unverified until it is genuinely delivered and its citation opened
- the loom adoption receipt (`/govern` DECISION entry) — origin findings + verbatim directive

## Trust Posture Wiring

Canonical-8-field per `trust-posture.md` MUST-8 — this rule lands AT/AFTER the MUST-8 SHA, so it
ships compliant on first land rather than grandfathered.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm a convergence claim published a derived coverage table, that no cell was closed on falling yield alone, and that every clause offering an alternative carried the MUST-3 incentive computation); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether an attack surface was DERIVED or ENUMERATED is a judgment over the review's own reasoning, with no tool-call-time signal, and a lexical detector for it would instance the class MUST-1 blocks.
- **Grace period:** 7 days from rule landing (2026-08-22 → 2026-08-29).
- **Cumulative posture impact:** same-class violations (a convergence claim with no coverage table; a review converged on yield alone; an enumerated roster used in place of a derivation; a clause with an escape hatch shipped without its incentive computation; a finding warranted by reasoning and not labelled a hypothesis; an attacker told it is reviewing its own work) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: derived-vs-enumerated coverage is a review-layer semantic judgment that does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `instrument-discipline.md` and `completion-criterion.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: adversarial-coverage]` IFF `posture.json::pending_verification` includes the `adversarial-coverage` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any session declaring convergence and confirm (a) a derived `R×P` coverage table was published with every cell attacked or excluded-with-reason, (b) all three convergence conditions held, not yield alone, (c) each escape-hatch clause carried its payoff computation, (d) attackers were role-separated and given no authorship cue. The upstream offer also carries a marker-extractability gate (every clause marker parses, no duplicate IDs, no dangling references). It is **DELIBERATELY NOT ADOPTED in this pass and its path is deliberately NOT NAMED here** — naming a scanner loom does not ship makes it a LIVE binding that must resolve, which reds `detection-binding-check::dangling-scanner-binding` (MEASURED on this landing: naming it produced exactly that offender). Adopting it is a separate decision — it is Python in a node-gated corpus and would need its own registration and fixtures. **Phase 2 is RETIRED, not deferred**, per `hook-output-discipline.md` MUST-5(b): whether a surface was derived rather than enumerated is not observable from any argv token, AST node, or git-object fact at tool-call time, so no hook detector will ever be built and no `phase2-deferrals.json` row is owed. Gate-review IS the enforcement layer here, permanently. Scanner: none (`scanner: null` — derived-vs-enumerated is semantic, with no structural signal). **Fixtures: `.claude/audit-fixtures/adversarial-coverage/`** — six candidates in three bipolar pairs, each with a `.expected` answer-key sidecar that is never shown to a judge. **Probes: REGISTERED — `.claude/test-harness/probes/adversarial-coverage.probes.json`**, 6 rows in 3 bipolar `pair_id` pairs (derived-coverage covering MUST-1/2 + the two MUST NOTs; warrant-and-incentive covering MUST-3/4/5/6; meta-compliance), each carrying BOTH a violation and a compliant pole. Registered in `eval-manifest.json` as a probe-only entry and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. The suite was AUTHORED rather than deferred because both deferral exits are closed: naming an unwritten path reds `xref-integrity` as a dangling reference (MEASURED on this landing), and a `probe_authorship_deferrals` row needs an `accepted_by` that `completion-criterion.md` MUST-6 forbids the proposing party from granting itself. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes the dispatcher and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they run when an orchestrator dispatches `/test-harness-probe` at gate-review.
- **Violation scope:** MUST-1 (enumerated roster in place of a derivation) + MUST-2 (convergence on yield alone) + MUST-3 (escape-hatch clause with no incentive computation) + MUST-4 (finding warranted by reasoning, unlabelled) + MUST-5 (author reviewing own work / authorship cue given) + MUST-6 (absence claim or design decision with no recorded functional search) + both MUST NOT clauses. Every `violations.jsonl` row names the review and the clause that fired.
- **Origin:** See § Origin below.

## Origin

2026-08-22 — adopted from the upstream ecosystem proposal loom#1904. Full adoption, validation and budget record: companion § “Origin — full adoption and budget record”.

**Adopted with ZERO de-scoping** — every MUST, MUST NOT, DO/DO-NOT block, `**Why:**` line, the R×P derivation and the §5 evidence base are verbatim from the offer. Changed for loom only: `priority:` + `scope:` frontmatter (`rule-authoring.md` MUST-7, absent upstream); `/challenge` removed from `paths:` and Scope (no such command here); the `subagent-delegation-verification.md` cross-reference re-pointed to `agents.md` § Agent-Result-Delivery (the upstream target does not exist at loom and would have been a dangling reference per `cc-artifacts.md` MUST NOT); the originating ecosystem's internal workspace path and journal numbers scrubbed to the generic principle (`knowledge-cascade-routing.md` MUST-3 — this rule cascades to every consumer, so another ecosystem's internal paths must not ride along); and this Wiring block added.
