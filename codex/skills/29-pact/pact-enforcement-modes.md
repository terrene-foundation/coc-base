---
description: PACT enforcement modes (ENFORCE/SHADOW/DISABLED) and envelope-to-execution adapter
---

# PACT Enforcement Modes

PactEngine supports 3 enforcement modes for governance rollout safety.

## Quick Start

```python
from pact.engine import PactEngine
from pact.enforcement import EnforcementMode

# Production — verdicts are binding (default)
engine = PactEngine(org="org.yaml", enforcement_mode=EnforcementMode.ENFORCE)

# Staging — log verdicts but never block (calibrate envelopes)
engine = PactEngine(org="org.yaml", enforcement_mode=EnforcementMode.SHADOW)

# Emergency — skip governance entirely (requires env var guard)
# export PACT_ALLOW_DISABLED_MODE=true
engine = PactEngine(org="org.yaml", enforcement_mode=EnforcementMode.DISABLED)
```

## Mode Behavior

| Mode     | verify_action | Blocks | Logs          | Audit                     |
| -------- | ------------- | ------ | ------------- | ------------------------- |
| ENFORCE  | Runs          | Yes    | On block      | verdict                   |
| SHADOW   | Runs          | Never  | Always (INFO) | verdict + shadow=True     |
| DISABLED | Skipped       | Never  | Warning       | governance_disabled event |

## HELD Verdict Handling

```python
async def my_approval_handler(verdict, role, action, context) -> bool:
    # Custom logic — e.g., persist hold, await human decision
    return True  # Proceed, or False to block

engine = PactEngine(org="org.yaml", on_held=my_approval_handler)
```

Without `on_held`: raises `GovernanceHeldError` (distinct from PactError).

## Envelope Adapter

`_adapt_envelope(role_address)` maps all 5 PACT constraint dimensions:

| Dimension     | Supervisor Param                      | Default (no envelope) |
| ------------- | ------------------------------------- | --------------------- |
| Financial     | budget_usd                            | 0.0                   |
| Operational   | tools, max_depth                      | [], 0                 |
| Data Access   | data_clearance                        | "none"                |
| Temporal      | timeout_seconds                       | 60                    |
| Communication | allowed_channels, notification_policy | (none)                |

All numeric fields validated with `math.isfinite()`. NaN/Inf → maximally restrictive defaults.
