---
name: pact-mcp-governance
description: "PACT MCP governance -- enforce constraint envelopes on MCP tool invocations with default-deny, verification gradient, audit trail, and monotonic tightening"
---

# PACT MCP Governance

MCP has zero built-in governance: any connected agent can call any tool with any arguments. PACT for MCP adds deterministic enforcement as a middleware layer.

## Install

```bash
pip install kailash-pact
```

## Quick Start

```python
from pact.mcp import (
    McpGovernanceConfig,
    McpGovernanceEnforcer,
    McpGovernanceMiddleware,
    McpToolPolicy,
    McpActionContext,
)

# 1. Define per-tool policies
config = McpGovernanceConfig(
    tool_policies={
        "web_search": McpToolPolicy(
            tool_name="web_search",
            max_cost=1.0,
            rate_limit=10,
        ),
        "code_execute": McpToolPolicy(
            tool_name="code_execute",
            max_cost=5.0,
            allowed_args=frozenset({"language", "code"}),
            denied_args=frozenset({"sudo", "rm_rf"}),
        ),
    },
    # default_policy=DefaultPolicy.DENY  (default -- unregistered tools blocked)
)

# 2. Create enforcer
enforcer = McpGovernanceEnforcer(config)

# 3. Direct check (no middleware)
ctx = McpActionContext(
    tool_name="web_search",
    args={"query": "test"},
    agent_id="agent-1",
    cost_estimate=0.5,
)
decision = enforcer.check_tool_call(ctx)
# decision.level: "auto_approved" | "flagged" | "held" | "blocked"
# decision.allowed: True if auto_approved or flagged
```

## Middleware Pattern (async)

```python
async def my_mcp_handler(tool_name: str, args: dict) -> Any:
    """Your actual MCP tool handler."""
    ...

middleware = McpGovernanceMiddleware(enforcer, handler=my_mcp_handler)

result = await middleware.invoke(
    "web_search",
    {"query": "test"},
    agent_id="agent-1",
    cost_estimate=0.5,
)
if result.executed:
    print(result.tool_result)
else:
    print(f"Blocked: {result.decision.reason}")
```

## Key Components

### McpGovernanceEnforcer

Core enforcement engine. Evaluates tool calls through a 5-step verification gradient:

1. **Tool registration** -- default-deny for unregistered tools
2. **NaN/Inf defense** -- `math.isfinite()` on all numeric fields
3. **Argument constraints** -- `denied_args` (blocklist) and `allowed_args` (allowlist)
4. **Cost constraints** -- `max_cost` per tool policy; flagged at 80% of limit
5. **Rate limits** -- per-agent, per-tool, per-minute with bounded tracking

All error paths return BLOCKED (fail-closed).

### McpGovernanceMiddleware

Async wrapper that intercepts tool calls, runs governance checks, and only forwards to the handler if allowed. Returns `McpInvocationResult` with both the decision and the tool result.

### McpAuditTrail

Bounded (`deque(maxlen=10_000)`), append-only, thread-safe audit log. Query by agent, tool, or decision level:

```python
trail = enforcer.audit_trail
blocked = trail.get_by_decision("blocked")
agent_history = trail.get_by_agent("agent-1")
tool_history = trail.get_by_tool("web_search")
all_entries = trail.to_list()
```

### Runtime Tool Registration (Monotonic Tightening)

Tools can be registered at runtime, but only with equal or more restrictive policies:

```python
# Tighten at runtime -- OK
enforcer.register_tool(McpToolPolicy(
    tool_name="web_search",
    max_cost=0.5,  # was 1.0 -- tighter
    rate_limit=5,  # was 10 -- tighter
))

# Widen at runtime -- raises ValueError
enforcer.register_tool(McpToolPolicy(
    tool_name="web_search",
    max_cost=10.0,  # was 1.0 -- WIDER, monotonic tightening violation
))
```

## Key Types

```python
from pact.mcp import (
    # Configuration
    McpToolPolicy,         # Per-tool policy (frozen dataclass)
    McpGovernanceConfig,   # Config with default_policy + tool_policies
    McpActionContext,      # Context for a single tool call evaluation
    DefaultPolicy,         # DENY or ALLOW for unregistered tools
    # Enforcement
    McpGovernanceEnforcer, # Core enforcement engine
    GovernanceDecision,    # Result of a governance check (frozen)
    # Middleware
    McpGovernanceMiddleware, # Async wrapper for MCP tool calls
    McpInvocationResult,   # Decision + tool result combined
    # Audit
    McpAuditTrail,         # Bounded, queryable audit log
    McpAuditEntry,         # Single audit record (frozen)
)
```

## Security Invariants

Per `.claude/rules/pact-governance.md`:

1. **Default-deny** -- unregistered tools are BLOCKED (Rule 5)
2. **NaN/Inf defense** -- `math.isfinite()` on all numeric fields (Rule 6)
3. **Thread-safe** -- all shared state access acquires `self._lock` (Rule 8)
4. **Fail-closed** -- all error paths return BLOCKED (Rule 4)
5. **Bounded collections** -- audit trail uses `deque(maxlen=10_000)` (Rule 7)
6. **Frozen types** -- `McpToolPolicy`, `McpGovernanceConfig`, `McpActionContext`, `GovernanceDecision`, `McpAuditEntry` are all `frozen=True`
7. **Monotonic tightening** -- runtime `register_tool()` can only narrow policies (Rule 2)
8. **Immutable dicts** -- args, metadata, tool_policies use `MappingProxyType` post-construction
