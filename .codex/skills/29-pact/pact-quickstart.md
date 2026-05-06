---
name: pact-quickstart
description: "Getting started with PACT governance -- install, org definition, verify actions"
---

# PACT Quickstart

PACT (Positional Accountability and Constraint Topology) is a governance framework for AI agents. It enforces constraint envelopes, knowledge clearance, and D/T/R addressing.

## Install

```bash
pip install kailash-pact
```

## Minimal Example

```python
from pact.governance.config import (
    ConstraintEnvelopeConfig,
    FinancialConstraintConfig,
    OperationalConstraintConfig,
    OrgDefinition,
    AgentConfig,
    TeamConfig,
    WorkspaceConfig,
    TrustPostureLevel,
)
from pact.governance.engine import GovernanceEngine

# 1. Define constraint envelope
analyst_envelope = ConstraintEnvelopeConfig(
    id="analyst-envelope",
    description="Analyst operating boundary",
    financial=FinancialConstraintConfig(
        max_spend_usd=100.0,
        requires_approval_above_usd=50.0,
    ),
    operational=OperationalConstraintConfig(
        allowed_actions=["read", "write", "analyze"],
        blocked_actions=["deploy", "delete"],
    ),
)

# 2. Define organization
org = OrgDefinition(
    org_id="acme-corp",
    name="Acme Corp",
    agents=[
        AgentConfig(
            id="analyst-1",
            name="Data Analyst",
            role="analyst",
            constraint_envelope="analyst-envelope",
        ),
    ],
    teams=[
        TeamConfig(
            id="data-team",
            name="Data Team",
            workspace="data-ws",
            agents=["analyst-1"],
        ),
    ],
    envelopes=[analyst_envelope],
    workspaces=[
        WorkspaceConfig(id="data-ws", path="/workspaces/data"),
    ],
)

# 3. Create GovernanceEngine
engine = GovernanceEngine(org)

# 4. Verify an action
verdict = engine.verify_action(
    role_address="D1-R1",
    action="read",
    context={"cost": 10.0},
)

print(verdict.level)    # "auto_approved"
print(verdict.allowed)  # True
print(verdict.reason)   # "Action 'read' is within all constraint dimensions"

# 5. Action exceeding approval threshold -> HELD
verdict = engine.verify_action(
    role_address="D1-R1",
    action="write",
    context={"cost": 75.0},
)
print(verdict.level)  # "held"

# 6. Blocked action -> BLOCKED
verdict = engine.verify_action(
    role_address="D1-R1",
    action="deploy",
)
print(verdict.level)  # "blocked"
```

## GovernanceVerdict

Every `verify_action()` call returns a `GovernanceVerdict`:

| Field              | Type   | Description                                                |
| ------------------ | ------ | ---------------------------------------------------------- |
| `level`            | `str`  | `"auto_approved"`, `"flagged"`, `"held"`, `"blocked"`      |
| `allowed`          | `bool` | `True` for auto_approved/flagged, `False` for held/blocked |
| `reason`           | `str`  | Human-readable explanation                                 |
| `role_address`     | `str`  | The D/T/R address evaluated                                |
| `action`           | `str`  | The action evaluated                                       |
| `envelope_version` | `str`  | SHA-256 hash for TOCTOU detection                          |

## SQLite Backend

```python
engine = GovernanceEngine(
    org,
    store_backend="sqlite",
    store_url="/tmp/pact-governance.db",
)
```

## Cross-References

- `pact-governance-engine.md` -- full engine API
- `pact-envelopes.md` -- envelope model
- Source: `pact/governance/engine.py`
- Source: `pact/governance/config.py`
