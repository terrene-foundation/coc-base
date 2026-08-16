---
name: pact-governed-agents
description: "PactGovernedAgent, @governed_tool decorator, middleware, and anti-self-modification defense"
---

# PACT Governed Agents

PACT wraps agent execution with governance enforcement. Agents receive a frozen `GovernanceContext` (read-only), NOT the `GovernanceEngine`. Tool access is DEFAULT-DENY.

## PactGovernedAgent

```python
from pact.governance.agent import PactGovernedAgent, GovernanceBlockedError, GovernanceHeldError
from pact.governance.config import TrustPostureLevel

agent = PactGovernedAgent(
    engine=engine,
    role_address="D1-R1-T1-R1",
    posture=TrustPostureLevel.SUPERVISED,
)

# Agent gets a frozen context -- cannot modify constraints
ctx = agent.context                        # GovernanceContext (frozen=True)
ctx.allowed_actions                        # frozenset({"read", "write"})
ctx.posture                                # TrustPostureLevel.SUPERVISED
ctx.effective_clearance_level              # ConfidentialityLevel.RESTRICTED
# ctx.posture = TrustPostureLevel.AUTONOMOUS  -> FrozenInstanceError
```

### Tool Registration (Default-Deny)

Tools must be explicitly registered. Unregistered tools are blocked.

```python
# Register tools with governance metadata
agent.register_tool("read", cost=0.0)
agent.register_tool("write", cost=10.0)
agent.register_tool("analyze", cost=25.0, resource="reports")
```

### Tool Execution

Governance verification happens BEFORE the tool function runs. If blocked or held, the tool function is NEVER called.

```python
def read_data():
    return {"data": [1, 2, 3]}

# Execute through governance
result = agent.execute_tool("read", _tool_fn=read_data)
# Governance checks: registered? -> envelope ok? -> financial ok? -> execute

# Unregistered tool -> GovernanceBlockedError
try:
    agent.execute_tool("deploy", _tool_fn=lambda: None)
except GovernanceBlockedError as e:
    print(e.verdict.reason)  # "Tool 'deploy' is not governance-registered"

# Over financial limit -> GovernanceBlockedError or GovernanceHeldError
try:
    agent.execute_tool("write", _tool_fn=lambda: None)
except GovernanceHeldError as e:
    print(e.verdict.reason)  # "... exceeds approval threshold ... held for human approval"
```

### Verdict Flow

| Verdict Level   | Agent Behavior                                   |
| --------------- | ------------------------------------------------ |
| `auto_approved` | Tool executes silently                           |
| `flagged`       | Warning logged, tool executes                    |
| `held`          | `GovernanceHeldError` raised, tool NOT called    |
| `blocked`       | `GovernanceBlockedError` raised, tool NOT called |

## GovernanceContext (Frozen)

The anti-self-modification defense: agents get an immutable snapshot of their governance state.

```python
from pact.governance.context import GovernanceContext

# Created by engine.get_context() -- NOT by agents
ctx = engine.get_context(
    role_address="D1-R1-T1-R1",
    posture=TrustPostureLevel.SUPERVISED,
)

# Read-only fields
ctx.role_address              # "D1-R1-T1-R1"
ctx.posture                   # TrustPostureLevel.SUPERVISED
ctx.effective_envelope        # ConstraintEnvelopeConfig | None
ctx.clearance                 # RoleClearance | None
ctx.effective_clearance_level # ConfidentialityLevel | None
ctx.allowed_actions           # frozenset({"read", "write"})
ctx.compartments              # frozenset({"project-x"})
ctx.org_id                    # "acme-corp"
ctx.created_at                # datetime

# Serialization
d = ctx.to_dict()
ctx2 = GovernanceContext.from_dict(d)
```

## @governed_tool Decorator

Marks functions with governance metadata for auto-registration.

```python
from pact.governance.decorators import governed_tool

@governed_tool("write_report", cost=50.0)
def write_report(content: str) -> str:
    return f"Report: {content}"

@governed_tool("read_data", cost=0.0, resource="customer-db")
def read_data(query: str) -> list:
    return [{"id": 1}]

# Metadata is attached to the function
write_report._governed           # True
write_report._governance_action  # "write_report"
write_report._governance_cost    # 50.0

# The function remains directly callable
result = write_report("Q4 Summary")

# For governance enforcement, use PactGovernedAgent.execute_tool()
agent.register_tool("write_report", cost=50.0)
agent.execute_tool("write_report", _tool_fn=lambda: write_report("Q4 Summary"))
```

## PactGovernanceMiddleware

Low-level building block that returns verdicts (does NOT raise exceptions). Use this for integration with custom agent frameworks.

```python
from pact.governance.middleware import PactGovernanceMiddleware

middleware = PactGovernanceMiddleware(
    engine=engine,
    role_address="D1-R1-T1-R1",
)

# Returns GovernanceVerdict -- caller decides how to handle
verdict = middleware.pre_execute(
    action_name="deploy",
    context={"cost": 500.0},
)

if verdict.level == "blocked":
    # Framework-specific blocking logic
    raise RuntimeError(verdict.reason)
elif verdict.level == "held":
    # Queue for human approval
    approval_queue.submit(verdict)
elif verdict.level == "flagged":
    logger.warning("Flagged: %s", verdict.reason)
# auto_approved -> proceed
```

### PactGovernedAgent vs PactGovernanceMiddleware

| Feature           | PactGovernedAgent                      | PactGovernanceMiddleware |
| ----------------- | -------------------------------------- | ------------------------ |
| Raises exceptions | Yes (GovernanceBlockedError/HeldError) | No (returns verdict)     |
| Tool registration | Built-in default-deny                  | Caller manages           |
| Frozen context    | Exposed via `.context`                 | Not exposed              |
| Use case          | Direct agent wrapping                  | Framework integration    |

## Cross-References

- `pact-governance-engine.md` -- engine.get_context(), engine.verify_action()
- `pact-envelopes.md` -- effective envelope in context
- `pact-kaizen-integration.md` -- wrapping Kaizen agents
- Source: `pact/governance/agent.py`
- Source: `pact/governance/decorators.py`
- Source: `pact/governance/middleware.py`
- Source: `pact/governance/context.py`
