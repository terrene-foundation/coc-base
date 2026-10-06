---
name: pact-kaizen-integration
description: "Cross-package integration -- GovernanceEnvelopeAdapter, AuditChain, GradientEngine, YAML orgs"
---

# PACT-Kaizen Integration

PACT governance integrates with Kaizen agent teams through adapters, audit chains, and YAML-based organization definitions.

## Wrapping a Kaizen Agent

```python
from pact.governance.engine import GovernanceEngine
from pact.governance.agent import PactGovernedAgent, GovernanceBlockedError
from pact.governance.config import TrustPostureLevel

# 1. Build governance engine from org definition
engine = GovernanceEngine(org_definition)

# 2. Wrap each Kaizen agent with governance
governed_agent = PactGovernedAgent(
    engine=engine,
    role_address="D1-R1-T1-R1",     # Agent's position in org
    posture=TrustPostureLevel.SUPERVISED,
)

# 3. Register the agent's tools
governed_agent.register_tool("analyze", cost=5.0)
governed_agent.register_tool("summarize", cost=2.0)
governed_agent.register_tool("deploy", cost=100.0)

# 4. Execute tools through governance
try:
    result = governed_agent.execute_tool(
        "analyze",
        _tool_fn=lambda: kaizen_agent.run_tool("analyze", data),
    )
except GovernanceBlockedError as e:
    print(f"Blocked: {e.verdict.reason}")
```

## GovernanceEnvelopeAdapter

Bridges PACT governance envelopes to trust-layer `ConstraintEnvelope` for backward compatibility with Kaizen's `ExecutionRuntime` and `GradientEngine`.

```python
from pact.governance.envelope_adapter import GovernanceEnvelopeAdapter, EnvelopeAdapterError

adapter = GovernanceEnvelopeAdapter(engine=engine)

# Convert governance envelope to trust-layer ConstraintEnvelope
try:
    trust_envelope = adapter.to_constraint_envelope(
        role_address="D1-R1-T1-R1",
        task_id="sprint-42",  # optional
    )
    # trust_envelope is a kailash.trust.plane.models.ConstraintEnvelope
    # Usable with ExecutionRuntime and GradientEngine
except EnvelopeAdapterError as e:
    # Fail-closed: no fallback to legacy envelopes
    print(f"Conversion failed: {e}")
```

**Field mapping:**

| PACT (governance)                       | Trust-layer                      |
| --------------------------------------- | -------------------------------- |
| `financial.max_spend_usd`               | `financial.max_cost_per_session` |
| `financial.requires_approval_above_usd` | `financial.max_cost_per_action`  |
| `operational.allowed_actions`           | `operational.allowed_actions`    |
| `data_access.read_paths`                | `data_access.read_paths`         |
| `communication.allowed_channels`        | `communication.allowed_channels` |

## AuditChain

Thread-safe tamper-evident chain of audit anchors for governance decisions.

```python
from pact.governance.audit import AuditChain, AuditAnchor, PactAuditAction
from pact.governance.config import VerificationLevel

# Create audit chain
chain = AuditChain(chain_id="acme-governance")

# Append anchors (thread-safe, auto-sealed with SHA-256 hash chain)
anchor = chain.append(
    agent_id="analyst-1",
    action="read_financial_data",
    verification_level=VerificationLevel.AUTO_APPROVED,
    envelope_id="env-analyst",
    result="allowed",
    metadata={"cost": 10.0, "resource": "q4-report"},
)

anchor.anchor_id        # "acme-governance-0"
anchor.sequence         # 0
anchor.content_hash     # SHA-256 hex digest
anchor.previous_hash    # None (genesis) or previous anchor's hash
anchor.is_sealed        # True
anchor.verify_integrity()  # True

# Query the chain
chain.length                                    # int
chain.latest                                    # AuditAnchor
chain.filter_by_agent("analyst-1")              # [AuditAnchor, ...]
chain.filter_by_level(VerificationLevel.BLOCKED)  # [AuditAnchor, ...]

# Verify entire chain integrity
is_valid, errors = chain.verify_chain_integrity()
# (True, []) or (False, ["Anchor 3: content hash mismatch (tampered?)"])

# Serialize/deserialize
data = chain.to_dict()
restored = AuditChain.from_dict(data)
```

**Bounded collection:** Chain has `max_anchors=10_000` by default. When capacity is reached, the oldest 10% is evicted.

### Integrating with GovernanceEngine

```python
chain = AuditChain(chain_id="acme-governance")

engine = GovernanceEngine(
    org_definition,
    audit_chain=chain,   # All decisions are automatically recorded
)

# Every verify_action(), grant_clearance(), set_role_envelope(), etc.
# emits an anchor to the chain
verdict = engine.verify_action("D1-R1-T1-R1", "deploy", {"cost": 500.0})

# SQLite backend also has its own audit log with integrity verification
engine = GovernanceEngine(
    org_definition,
    store_backend="sqlite",
    store_url="/tmp/pact.db",
)
is_valid, error_msg = engine.verify_audit_integrity()
```

## GradientEngine

Evaluates actions against constraint dimensions independently from the main engine. Useful for pre-flight checks or custom evaluation.

```python
from pact.governance.gradient import GradientEngine, EvaluationResult
from pact.governance.config import (
    VerificationGradientConfig,
    GradientRuleConfig,
    VerificationLevel,
)

# Configure gradient rules (first match wins)
gradient = VerificationGradientConfig(
    rules=[
        GradientRuleConfig(
            pattern="deploy*",
            level=VerificationLevel.HELD,
            reason="Deployments require human approval",
        ),
        GradientRuleConfig(
            pattern="read*",
            level=VerificationLevel.AUTO_APPROVED,
            reason="Read operations are pre-approved",
        ),
    ],
    default_level=VerificationLevel.HELD,
)

# Create engine with envelope and gradient
gradient_engine = GradientEngine(config=envelope, gradient=gradient)

# Evaluate an action
result = gradient_engine.evaluate(
    action="deploy_to_prod",
    context={"cost_usd": 500.0, "channel": "internal"},
)

result.level           # VerificationLevel.HELD (matched "deploy*")
result.all_satisfied   # True/False (all dimensions passed?)
result.matched_rule    # "deploy*"
result.action          # "deploy_to_prod"

# Per-dimension results
for dim in result.dimensions:
    print(f"{dim.dimension.value}: {'PASS' if dim.satisfied else 'FAIL'} -- {dim.reason}")
```

## YAML Organization Definition

Load org definitions from YAML for Kaizen agent team configuration.

```python
from pact.governance.yaml_loader import load_org_yaml, LoadedOrg

loaded: LoadedOrg = load_org_yaml("org-config.yaml")
loaded.org_definition   # OrgDefinition
loaded.envelopes        # list[EnvelopeSpec]
loaded.clearances       # list[ClearanceSpec]
loaded.bridges          # list[BridgeSpec]
loaded.ksps             # list[KspSpec]
```

Example YAML:

```yaml
org:
  org_id: acme-ai-division
  name: "Acme AI Division"
  departments:
    - department_id: engineering
      name: Engineering
      teams: [ml-team, infra-team]
  teams:
    - id: ml-team
      name: ML Team
      workspace: ml-workspace
      team_lead: ml-lead
      agents: [ml-lead, ml-analyst]
  agents:
    - id: ml-lead
      name: ML Team Lead
      role: team_lead
      constraint_envelope: lead-envelope
    - id: ml-analyst
      name: ML Analyst
      role: analyst
      constraint_envelope: analyst-envelope
  envelopes:
    - id: lead-envelope
      financial:
        max_spend_usd: 1000.0
      operational:
        allowed_actions: [read, write, analyze, deploy, approve]
    - id: analyst-envelope
      financial:
        max_spend_usd: 100.0
      operational:
        allowed_actions: [read, write, analyze]
  workspaces:
    - id: ml-workspace
      path: /workspaces/ml
```

## PactAuditAction Types

10 governance action types recorded in audit anchors:

| Action               | When Emitted                                 |
| -------------------- | -------------------------------------------- |
| `envelope_created`   | `set_role_envelope()`, `set_task_envelope()` |
| `envelope_modified`  | Envelope update                              |
| `clearance_granted`  | `grant_clearance()`                          |
| `clearance_revoked`  | `revoke_clearance()`                         |
| `barrier_enforced`   | Access denied                                |
| `ksp_created`        | `create_ksp()`                               |
| `ksp_revoked`        | KSP deactivation                             |
| `bridge_established` | `create_bridge()`                            |
| `bridge_revoked`     | Bridge deactivation                          |
| `address_computed`   | Address compilation                          |

## Cross-References

- `pact-governance-engine.md` -- GovernanceEngine API
- `pact-governed-agents.md` -- PactGovernedAgent wrapping pattern
- `pact-envelopes.md` -- envelope model consumed by adapter
- Source: `pact/governance/envelope_adapter.py`
- Source: `pact/governance/audit.py`
- Source: `pact/governance/gradient.py`
- Source: `pact/governance/yaml_loader.py`
