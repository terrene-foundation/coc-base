---
name: co-reference
description: "CARE/EATP/CO/COC reference — governance, trust protocols, Dual Plane, Mirror Thesis."
allowed-tools:
  - Read
  - Glob
  - Grep
---

# Framework Family Reference

The Terrene Foundation's governance and methodology stack:

```
CARE (Philosophy: What is the human for?)
  ├── EATP (Protocol: How do we keep the human accountable?)
  └── CO (Methodology: How does the human structure AI's work?)
       ├── COC (Codegen) — production
       ├── COR (Research) — production
       ├── COG (Governance) — production
       ├── COE (Education) — analysis
       ├── COComp (Compliance) — sketch
       └── COL (Learners) — development
```

## Quick Reference

| Framework | What It Is                  | Core Contribution                                                                                    |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| **CARE**  | Governance philosophy       | Dual Plane Model, Mirror Thesis, 6 human competencies, 8 principles                                  |
| **EATP**  | Trust verification protocol | 5 elements (genesis→delegation→constraint→attestation→audit), verification gradient, trust postures  |
| **CO**    | Domain-agnostic methodology | 8 first principles, 5-layer architecture, 6-phase workflow                                           |
| **COC**   | CO for codegen              | 3 fault lines (amnesia, convention drift, security blindness), value inversion, autonomous execution |

## How They Connect

| CARE Concept       | EATP Operationalization                  | CO Manifestation                         | COC Implementation               |
| ------------------ | ---------------------------------------- | ---------------------------------------- | -------------------------------- |
| Trust Plane        | Genesis + Delegation Records             | Layer 2 (Context) + Layer 3 (Guardrails) | Rules + CLAUDE.md                |
| Execution Plane    | Constraint Envelopes                     | Layer 1 (Intent agents)                  | Agents + Skills                  |
| Human-on-the-Loop  | Trust Postures + Verification Gradient   | Layer 4 (Instructions)                   | 7-phase workflow + quality gates |
| Evolutionary Trust | Audit Anchors                            | Layer 5 (Learning)                       | Observe-digest-codify pipeline   |
| Accountability     | Traceability (necessary, not sufficient) | Human approval gates                     | Evidence-based completion        |

## Spec Reference (load on demand)

- **[care-spec.md](care-spec.md)** — Dual Plane Model, Mirror Thesis, 6 competencies, 8 principles
- **[eatp-spec.md](eatp-spec.md)** — 5 elements, verification gradient, trust postures, cascade revocation
- **[co-spec.md](co-spec.md)** — 8 first principles, 5-layer architecture, 6-phase workflow
- **[coc-spec.md](coc-spec.md)** — 3 fault lines, value inversion, 5-layer codegen implementation

## Cross-Cutting Reference

- **[governance-layer-thesis.md](governance-layer-thesis.md)** — How CARE/EATP/CO/COC relate to execution tools (Claude Code CLI)
- **[behavioral-guidelines.md](behavioral-guidelines.md)** — How to respond when discussing these frameworks

## Implementation Reference

| Framework | Implementation Skill                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| EATP      | [26-eatp-reference/](../26-eatp-reference/SKILL.md) — TrustPlane SDK, BudgetTracker, PostureStore, security patterns |
| PACT      | [29-pact/](../29-pact/SKILL.md) — GovernanceEngine, D/T/R addressing, envelopes, clearance                           |
| COC       | [28-coc-reference/](../28-coc-reference/SKILL.md) — Template implementation details                                  |

## Central Insight

**Trust is human. Execution is shared. The system reveals what only humans can provide.**

Raw model capability is becoming a commodity. Institutional knowledge — the context, guardrails, and methodology surrounding the model — is the differentiator.
