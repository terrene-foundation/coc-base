---
name: co-spec
description: "CO specification: eight first principles, five-layer architecture, six-phase workflow, domain application template."
---

# CO Specification

**CO** = Cognitive Orchestration. Domain-agnostic base methodology for structuring human-AI collaboration.

**Key distinction**: CO is the base methodology. COC, COR, COG, etc. are domain applications. The "C" at the end of COC already means "for Codegen" — do not say "COC for Codegen."

## What Makes CO a Methodology

- **Principles** (why): Eight domain-agnostic first principles
- **Architecture** (what): Five-layer model
- **Processes** (how): Six-phase workflow with evidence-based completion
- **Roles** (who): Human-on-the-Loop practitioner + domain-specialized agents
- **Artifacts** (deliverables): Context documents, rule files, enforcement mechanisms, learning logs
- **Quality Criteria** (done?): Measurable standards
- **Adoption Path** (how to get there): Phased organizational guidance

## Eight First Principles

1. **Institutional Knowledge Thesis** — AI capability is commodity; institutional knowledge is the differentiator
2. **Brilliant New Hire Principle** — AI without context = most capable hire with zero onboarding
3. **Three Failure Modes** — Amnesia, Convention Drift, Safety Blindness
4. **Human-on-the-Loop Position** — Human defines/maintains context, not in/out of execution chain
5. **Deterministic Enforcement** — Critical rules enforced outside AI context, not probabilistically
6. **Bainbridge's Irony** — More automation requires deeper human understanding
7. **Knowledge Compounds** — Institutional knowledge accumulates across sessions, subject to human approval
8. **Authentic Voice and Responsible Co-Authorship** — Output reflects genuine human intellectual direction

## Five-Layer Architecture

```
Layer 5: LEARNING      — Observe, digest, codify knowledge across sessions
Layer 4: INSTRUCTIONS  — Structured workflows with approval gates
Layer 3: GUARDRAILS    — Deterministic enforcement outside AI context
Layer 2: CONTEXT       — Organization's institutional knowledge, machine-readable
Layer 1: INTENT        — Route to domain-specialized agents
```

Each layer encodes a different aspect of human judgment: L1 organizational structure, L2 institutional knowledge, L3 risk tolerance, L4 process maturity, L5 everything above compounding.

## Six-Phase Workflow Model

| Phase | Command    | Purpose                                         |
| ----- | ---------- | ----------------------------------------------- |
| 01    | `/analyze` | Research and understand the problem space       |
| 02    | `/plan`    | Structure the work; **human approves**          |
| 03    | `/execute` | Do the work one task at a time                  |
| 04    | `/review`  | Adversarial critique; produces finalized output |
| 05    | `/learn`   | Extract knowledge; upgrade CO artifacts         |
| 06    | `/deliver` | Package and hand off                            |

Phase 05 is unique — output goes OUTSIDE the workspace, back into .claude/ artifacts. This is Principle 7 (Knowledge Compounds) made concrete. Proposals require human approval.

Domains rename commands to fit vocabulary but preserve the 6-phase structure.

## Domain Applications

| Application       | Short Name | Status      |
| ----------------- | ---------- | ----------- |
| CO for Codegen    | COC        | Production  |
| CO for Research   | COR        | Production  |
| CO for Governance | COG        | Production  |
| CO for Education  | COE        | Analysis    |
| CO for Compliance | COComp     | Sketch      |
| CO for Learners   | COL        | Development |
| COL for Finance   | COL-F      | Production  |

## Honest Limitations

- Does not help with truly novel domains where no institutional knowledge exists yet
- Does not solve the alignment problem
- Three failure modes are current AI limitations, not permanent boundaries
- Effectiveness depends on the quality of institutional knowledge the human provides
