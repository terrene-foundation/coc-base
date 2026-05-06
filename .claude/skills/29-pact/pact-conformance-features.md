# PACT Conformance Features (N1-N6)

PACT specification Normative Requirements N1-N6 add pre-retrieval filtering, envelope caching, plan re-entry, tiered audit, monitoring observations, and cross-SDK conformance. All six are implemented in `pact.governance.engine.GovernanceEngine`.

## N1 -- KnowledgeFilter (Pre-Retrieval Gate)

A pre-retrieval lifecycle gate that evaluates BEFORE the 5-step access enforcement algorithm. Fail-closed: filter exceptions return DENY.

```python
from pact.governance.knowledge import KnowledgeFilter, FilterDecision, KnowledgeQuery
from pact.governance.engine import GovernanceEngine

class MyFilter:
    def filter_before_retrieval(
        self, role_address: str, query: KnowledgeQuery, envelope_snapshot
    ) -> FilterDecision:
        # Inspect clearances, narrow scope, or deny entirely
        if "secret" in query.classifications:
            return FilterDecision(allowed=False, reason="Insufficient clearance")
        return FilterDecision(allowed=True, reason="OK")

engine = GovernanceEngine(
    org=compiled_org,
    knowledge_filter=MyFilter(),
)

# check_access() now runs the filter first
decision = engine.check_access(role_address, knowledge_item, posture)
```

## N2 -- Effective Envelope Cache

Bounded OrderedDict keyed by `(role_address, task_id)` with prefix-based cascade invalidation on mutations. Optional TTL.

```python
engine = GovernanceEngine(
    org=compiled_org,
    envelope_cache_ttl_seconds=300.0,  # optional TTL
)

# Cache is invalidated automatically on:
#   grant_clearance, revoke_clearance, transition_clearance
#   approve_bridge, reject_bridge
#   set_role_envelope, set_task_envelope
# Prefix invalidation: mutating role 'D1-R1' evicts all descendants starting with 'D1-R1-'
```

Invariants:

- Max 10,000 entries (LRU eviction via OrderedDict.popitem(last=False))
- TTL checked on read, not background-evicted
- Cascade is prefix-based to handle inheritance

## N3 -- Plan Re-Entry Guarantee

Suspends a plan on budget/temporal/posture/envelope triggers, blocks `verify_action()` calls with that plan_id until resume conditions are met.

```python
from pact.governance.suspension import SuspensionTrigger

suspension = engine.suspend_plan(
    role_address="D1-R1-D2-R2",
    plan_id="plan-001",
    trigger=SuspensionTrigger.BUDGET,
    snapshot={"last_action": "deploy", "spent_usd": 950.0},
)

# verify_action() with ctx={"plan_id": "plan-001"} returns BLOCKED
verdict = engine.verify_action(role_address, "deploy", {"plan_id": "plan-001"})
assert verdict.level == "blocked"

# Update conditions as they become satisfied
engine.update_resume_condition(
    plan_id="plan-001",
    condition_type="budget_replenished",
    satisfied=True,
)

# Resume when all conditions met
resume_verdict = engine.resume_plan("plan-001")
assert resume_verdict.level == "auto_approved"
```

Triggers: `BUDGET`, `TEMPORAL`, `POSTURE`, `ENVELOPE`. Each has a default resume condition from `resume_condition_for_trigger()`.

## N4 -- Audit Durability Tiers

`TieredAuditDispatcher` routes audit anchors to different persistence tiers based on `VerificationLevel`. Gradient-aligned: more critical verdicts get more durable storage.

```python
from pact.governance.audit import TieredAuditDispatcher

dispatcher = TieredAuditDispatcher(
    auto_approved_sink=memory_sink,
    flagged_sink=sqlite_sink,
    held_sink=sqlite_sink,
    blocked_sink=replicated_sink,  # Highest durability for BLOCKED
)

engine = GovernanceEngine(
    org=compiled_org,
    audit_dispatcher=dispatcher,
)
# _emit_audit() now routes through the dispatcher based on verification_level
# Falls back to legacy _emit_audit_direct() if the dispatcher fails
```

## N5 -- ObservationSink (Monitoring)

Structured monitoring events distinct from EATP audit chain. Emits on `verify_action` verdict, clearance changes, bridge events, and envelope changes.

```python
from pact.governance.observation import ObservationSink, Observation

class MetricsSink:
    def emit(self, obs: Observation) -> None:
        metrics.counter(
            f"pact.{obs.event_type}.{obs.level}",
            tags={"role": obs.role_address},
        ).inc()

engine = GovernanceEngine(
    org=compiled_org,
    observation_sink=MetricsSink(),
)
```

Event types: `verdict`, `clearance_change`, `bridge_event`, `envelope_change`.
Levels: `info`, `warn`, `critical`.
Non-blocking: exceptions in `emit()` are logged but never disrupt governance decisions.

## N6 -- Cross-Implementation Conformance

Test vectors in `tests/trust/pact/conformance/vectors/` provide byte-identical serialization references that Python and Rust SDKs both validate against.

```python
# tests/trust/pact/conformance/test_n6_conformance.py
def test_verdict_serialization_matches_vector():
    vec = _load_vector("governance_verdict")
    verdict = GovernanceVerdict(**vec["input"], timestamp=datetime.fromisoformat(...))
    canonical = json.dumps(verdict.to_dict(), sort_keys=True)
    assert canonical == vec["expected_canonical_json"]
```

8 vectors cover: `constraint_envelope`, `governance_verdict`, `role_clearance`, `access_decision`, `filter_decision` (N1), `plan_suspension` (N3), `audit_anchor` (N4), `observation` (N5).

Wire format stability tests verify enum values haven't drifted:

- `AgentPosture`: `pseudo, supervised, tool, delegating, autonomous`
- `VerificationLevel`: `AUTO_APPROVED, FLAGGED, HELD, BLOCKED`
- `SuspensionTrigger`: `budget, temporal, posture, envelope`

## Integration Order

When configuring GovernanceEngine with all features:

```python
engine = GovernanceEngine(
    org=compiled_org,
    # Existing params ...
    knowledge_filter=filter,              # N1
    envelope_cache_ttl_seconds=300.0,     # N2
    audit_dispatcher=dispatcher,          # N4
    observation_sink=sink,                # N5
)
# N3 suspensions are runtime operations, not init params
# N6 conformance is a test-time validation, not runtime
```

## Related Files

- `src/kailash/trust/pact/engine.py` -- GovernanceEngine with all N1-N5 wiring
- `src/kailash/trust/pact/knowledge.py` -- FilterDecision, KnowledgeFilter protocol, KnowledgeQuery
- `src/kailash/trust/pact/suspension.py` -- PlanSuspension, SuspensionTrigger, ResumeCondition
- `src/kailash/trust/pact/observation.py` -- Observation, ObservationSink protocol
- `src/kailash/trust/pact/audit.py` -- TieredAuditDispatcher
- `tests/trust/pact/conformance/` -- Cross-SDK test vectors and tests
