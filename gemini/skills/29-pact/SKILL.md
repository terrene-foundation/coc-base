---
name: 29-pact
description: "PACT governance — D/T/R, envelopes, clearance, governed agents, verification gradient."
---

# PACT Governance Skills

Quick reference for PACT organizational governance patterns.

## When to Use

Use PACT when asking about governance, D/T/R, operating envelope, knowledge clearance, verification gradient, `GovernanceEngine`, `PactGovernedAgent`, access enforcement, organizational governance, PACT, governed agent, clearance, bridges, KSP, monotonic tightening, MCP governance, `McpGovernanceEnforcer`, `McpGovernanceMiddleware`, `McpAuditTrail`, `McpToolPolicy`, MCP tool policy, default-deny MCP, or governed MCP tools.

## Install

```bash
pip install kailash-pact          # Governance framework
pip install kailash>=2.0.0        # Core SDK with trust subsystem
pip install kailash-kaizen>=2.0.0 # For governed Kaizen agents
```

## Skill Files

| Skill                                                     | Use When                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [pact-quickstart](pact-quickstart.md)                     | Getting started, first GovernanceEngine                                                               |
| [pact-governance-engine](pact-governance-engine.md)       | Engine API, verify_action, compute_envelope                                                           |
| [pact-dtr-addressing](pact-dtr-addressing.md)             | D/T/R grammar, Address parsing                                                                        |
| [pact-envelopes](pact-envelopes.md)                       | Three-layer model, monotonic tightening                                                               |
| [pact-access-enforcement](pact-access-enforcement.md)     | 5-step algorithm, clearance, bridges, KSPs                                                            |
| [pact-governed-agents](pact-governed-agents.md)           | PactGovernedAgent, @governed_tool                                                                     |
| [pact-kaizen-integration](pact-kaizen-integration.md)     | Wrapping Kaizen agents with governance                                                                |
| [pact-mcp-governance](pact-mcp-governance.md)             | MCP tool governance: enforce, audit, middleware                                                       |
| [pact-enforcement-modes](pact-enforcement-modes.md)       | ENFORCE/SHADOW/DISABLED modes, HELD verdict handling, envelope adapter                                |
| [pact-conformance-features](pact-conformance-features.md) | N1-N6: KnowledgeFilter, EnvelopeCache, PlanSuspension, AuditTiers, ObservationSink, cross-SDK vectors |

## Key Types

```python
from pact.governance import GovernanceEngine, GovernanceVerdict
from kailash.trust.pact.config import (
    ConstraintEnvelopeConfig, OrgDefinition,
    TrustPostureLevel, VerificationLevel,
    ConfidentialityLevel,
)
from kailash.trust.pact.agent import PactGovernedAgent
from kailash.trust.pact.audit import AuditChain

# MCP governance
from pact.mcp import (
    McpGovernanceEnforcer, McpGovernanceMiddleware, McpAuditTrail,
    McpToolPolicy, McpGovernanceConfig, McpActionContext,
)
```

## TrustPostureLevel (Decision 007)

Five canonical posture levels with autonomy gradient:

| Canonical  | Autonomy | Ceiling      | Old Name (alias)   |
| ---------- | -------- | ------------ | ------------------ |
| PSEUDO     | 1        | PUBLIC       | PSEUDO_AGENT       |
| TOOL       | 2        | RESTRICTED   | _(new, no old)_    |
| SUPERVISED | 3        | CONFIDENTIAL | SHARED_PLANNING    |
| DELEGATING | 4        | SECRET       | CONTINUOUS_INSIGHT |
| AUTONOMOUS | 5        | TOP_SECRET   | DELEGATED          |

Old names work as enum aliases (`TrustPostureLevel.PSEUDO_AGENT` resolves to `PSEUDO`). String deserialization of old values is handled by `_missing_()`.

## Rules

See `.claude/rules/pact-governance.md` for security invariants.
