---
name: eatp-spec
description: "EATP specification: five elements, verification gradient, trust postures, cascade revocation, traceability distinction."
---

# EATP Specification

**EATP** = Enterprise Agent Trust Protocol. Operationalizes CARE's governance philosophy as a concrete, verifiable protocol.

**Core insight**: Trust establishment (human judgment, once) is separate from trust verification (machine speed, continuously).

## The Five Elements (Trust Lineage Chain)

1. **Genesis Record** — Organizational root of trust. A human executive cryptographically commits accountability. No AI creates its own genesis record.

2. **Delegation Record** — Authority transfer with constraint tightening. Delegations can only reduce authority, never expand it. A manager with $50K authority can delegate $10K to an agent, not $75K.

3. **Constraint Envelope** — Multi-dimensional operating boundaries:
   - **Financial**: Transaction limits, spending caps, cumulative budgets
   - **Operational**: Permitted/blocked actions
   - **Temporal**: Operating hours, blackout periods, time-bounded auth
   - **Data Access**: Read/write permissions, PII handling, data classification
   - **Communication**: Permitted channels, approved recipients, tone guidelines

4. **Capability Attestation** — Signed declaration of authorized capabilities. Prevents capability drift. Makes authorized scope explicit and verifiable.

5. **Audit Anchor** — Tamper-evident execution record. Each anchor hashes the previous; modifying any record invalidates the chain forward. Production should use Merkle trees or external checkpointing.

## Verification Gradient

| Result | Meaning | Action |
|---|---|---|
| **Auto-approved** | Within all constraints | Execute and log |
| **Flagged** | Near constraint boundary | Execute and highlight for review |
| **Held** | Soft limit exceeded | Queue for human approval |
| **Blocked** | Hard limit violated | Reject with explanation |

## Five Trust Postures

| Posture | Autonomy | Human Role |
|---|---|---|
| **Pseudo-Agent** | None | Human in-the-loop; agent is interface only |
| **Supervised** | Low | Agent proposes, human approves |
| **Shared Planning** | Medium | Human and agent co-plan |
| **Continuous Insight** | High | Agent executes, human monitors |
| **Delegated** | Full | Remote monitoring |

Postures upgrade through demonstrated performance. They downgrade instantly if conditions change.

## EATP Operations

- **ESTABLISH** — Create agent identity and initial trust
- **DELEGATE** — Transfer authority with constraints
- **VERIFY** — Validate trust chain and permissions
- **AUDIT** — Record and trace all trust operations

## Cascade Revocation

Trust revocation at any level automatically revokes all downstream delegations. Mitigations for propagation latency: short-lived credentials (5-minute validity), push-based revocation, action idempotency.

## The Traceability Distinction (Critical)

**EATP provides traceability, not accountability.**
- **Traceability**: Trace any AI action back to human authority. EATP delivers this.
- **Accountability**: Humans understand, evaluate, and bear consequences. No protocol can deliver this.
- Traceability is necessary for accountability but not sufficient.

## Prior Art

Control plane/data plane separation (SDN), PDP/PEP (XACML), OAuth 2.0 scopes, SPIFFE/SPIRE, PKI certificate chains. EATP adds: verification that actions are within human-established trust boundaries, with unbroken chains to human authority.

## Honest Limitations

- **Constraint gaming**: Agents might achieve prohibited outcomes through individually permitted actions
- **Compromised genesis authority**: Root compromise propagates through entire chain
- **Correct but unwise constraints**: Verifies constraints are respected, not that they were wisely set
- **Implementation vulnerabilities**: Security depends on correct implementation
- **Social engineering**: Humans can be deceived into creating inappropriate delegations

## SDK Implementation

For EATP SDK implementation details (TrustPlane, BudgetTracker, PostureStore, security patterns), see [26-eatp-reference/](../26-eatp-reference/SKILL.md).
