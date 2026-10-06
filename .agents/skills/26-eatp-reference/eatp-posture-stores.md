# EATP SDK — Posture Persistence Reference

SQLite-backed persistence for agent posture state, the PostureStore protocol, PostureEvidence, PostureEvaluationResult, and the PostureStateMachine with store integration.

**Source**: `kailash/trust/posture_store.py`, `kailash/trust/postures.py`

## PostureStore Protocol

The `PostureStore` protocol (`kailash.trust.postures.PostureStore`) defines the 4-method contract for posture persistence backends. It is `@runtime_checkable`, so `isinstance()` checks work at runtime.

```python
from kailash.trust.postures import PostureStore, TrustPosture, TransitionResult

class PostureStore(Protocol):
    def get_posture(self, agent_id: str) -> TrustPosture:
        """Return current posture. Raises KeyError if agent not registered."""
        ...

    def set_posture(self, agent_id: str, posture: TrustPosture) -> None:
        """Persist the posture for agent_id."""
        ...

    def get_history(self, agent_id: str, limit: int = 100) -> List[TransitionResult]:
        """Return the most recent limit transition results."""
        ...

    def record_transition(self, result: TransitionResult) -> None:
        """Persist a transition result."""
        ...
```

**Important**: `get_posture()` must raise `KeyError` for unregistered agents. The `PostureStateMachine` interprets `KeyError` as "use the default posture."

## SQLitePostureStore

Thread-safe SQLite persistence for agent postures and transition history.

### Setup

```python
from kailash.trust.posture_store import SQLitePostureStore
from kailash.trust.postures import TrustPosture

# Option 1: Context manager (recommended)
with SQLitePostureStore("/tmp/eatp/postures.db") as store:
    store.set_posture("agent-001", TrustPosture.SUPERVISED)
    posture = store.get_posture("agent-001")
    history = store.get_history("agent-001", limit=50)

# Option 2: Manual lifecycle
store = SQLitePostureStore("/tmp/eatp/postures.db")
# ... use store ...
store.close()
```

The constructor performs full initialization: creates parent directories, sets 0o600 permissions, creates tables, and runs schema migrations.

### Database Schema

Two tables:

- `postures`: `(agent_id TEXT PK, posture TEXT NOT NULL, updated_at TEXT NOT NULL)`
- `transitions`: `(id INTEGER PK, agent_id TEXT, from_posture TEXT, to_posture TEXT, success INTEGER, timestamp TEXT, metadata TEXT, transition_type TEXT)`

### Schema Migration Support

The `transition_type` column was added in RT-06 to preserve `EMERGENCY_DOWNGRADE` transitions. On construction, `SQLitePostureStore` automatically migrates databases created before RT-06:

```python
# _migrate_transitions_table checks PRAGMA table_info and adds the column if missing
# This is safe to call repeatedly — it checks for column existence first
```

Without the stored `transition_type`, emergency downgrades would be inferred as plain `DOWNGRADE` when read back from the database. The migration preserves the distinction.

### Security Properties

| Property            | Implementation                                               |
| ------------------- | ------------------------------------------------------------ |
| Path validation     | Rejects `..`, null bytes, symlinks via `_validate_db_path()` |
| File permissions    | Created with `os.open(O_CREAT, 0o600)`, then `os.chmod()`    |
| Agent ID validation | `^[a-zA-Z0-9_-]+$` via `validate_agent_id()`                 |
| SQL injection       | All queries use `?` parameterized placeholders               |
| Concurrency         | WAL mode, `threading.local()` per-thread connections         |
| Result set bounds   | History queries capped at 10,000 rows                        |

### API Reference

#### get_posture(agent_id) -> TrustPosture

Returns the current posture for an agent. Returns `TrustPosture.SUPERVISED` if the agent has no stored posture (CARE spec default).

```python
posture = store.get_posture("agent-001")
# Returns TrustPosture.SUPERVISED if agent-001 is unknown
```

#### set_posture(agent_id, posture) -> None

Upsert the current posture for an agent.

```python
store.set_posture("agent-001", TrustPosture.SHARED_PLANNING)
```

#### record_transition(result) -> None

Persist a `TransitionResult`. The `agent_id` is extracted from `result.metadata["agent_id"]`. Stores `reason` and `blocked_by` inside the metadata JSON for full round-trip fidelity. The `transition_type` is stored in a dedicated column to preserve `EMERGENCY_DOWNGRADE`.

```python
from kailash.trust.postures import TransitionResult, PostureTransition, TrustPosture
from datetime import datetime, timezone

result = TransitionResult(
    success=True,
    from_posture=TrustPosture.SUPERVISED,
    to_posture=TrustPosture.SHARED_PLANNING,
    transition_type=PostureTransition.UPGRADE,
    reason="Agent demonstrated reliability",
    metadata={"agent_id": "agent-001", "requester_id": "admin-001"},
)
store.record_transition(result)
```

#### get_history(agent_id, limit=100) -> List[TransitionResult]

Returns transitions in reverse chronological order (newest first). Limit is capped at 10,000.

```python
history = store.get_history("agent-001", limit=50)
for tr in history:
    print(f"{tr.from_posture.value} -> {tr.to_posture.value} "
          f"({tr.transition_type.value}, success={tr.success})")
```

#### close() -> None

Close the calling thread's database connection. After calling `close()`, further operations raise `RuntimeError`.

## PostureStateMachine with Store Integration

The `PostureStateMachine` accepts an optional `store` parameter to delegate persistence:

```python
from kailash.trust.postures import PostureStateMachine, TrustPosture
from kailash.trust.posture_store import SQLitePostureStore

store = SQLitePostureStore("/tmp/eatp/postures.db")

machine = PostureStateMachine(
    default_posture=TrustPosture.SUPERVISED,  # CARE spec default (RT-17)
    store=store,
)

# get_posture reads from store; falls back to default on KeyError
posture = machine.get_posture("agent-001")

# set_posture writes to both store and in-memory cache
machine.set_posture("agent-001", TrustPosture.SHARED_PLANNING)

# transition() persists results via store.record_transition()
from kailash.trust.postures import PostureTransitionRequest
result = machine.transition(PostureTransitionRequest(
    agent_id="agent-001",
    from_posture=TrustPosture.SHARED_PLANNING,
    to_posture=TrustPosture.CONTINUOUS_INSIGHT,
    reason="High success rate over 72 hours",
    requester_id="admin-001",
))
```

When no store is configured (`store=None`), state is kept in memory with bounded history (max 10,000 entries, oldest 10% trimmed at capacity).

### Default Posture: SUPERVISED

Per CARE spec compliance (RT-17), the `PostureStateMachine` defaults to `TrustPosture.SUPERVISED` (autonomy_level=2). This means tool agents start in supervised mode where the agent proposes actions and a human approves. Callers may pass any other posture to override.

## PostureEvidence

Structured evidence supporting posture transition evaluations.

```python
from kailash.trust.postures import PostureEvidence
from datetime import datetime, timezone

evidence = PostureEvidence(
    observation_count=500,
    success_rate=0.97,                       # Bounded [0.0, 1.0], must be finite
    time_at_current_posture_hours=72.5,      # Non-negative, must be finite
    anomaly_count=2,                         # Non-negative
    source="monitoring-system-v3",
    timestamp=datetime.now(timezone.utc),
    metadata={"region": "us-east-1", "cluster": "prod-a"},
)

# Serialize
data = evidence.to_dict()

# Deserialize
restored = PostureEvidence.from_dict(data)
```

### Validation Rules (enforced in `__post_init__`)

| Field                           | Constraint                      |
| ------------------------------- | ------------------------------- |
| `success_rate`                  | `math.isfinite()`, `[0.0, 1.0]` |
| `time_at_current_posture_hours` | `math.isfinite()`, `>= 0`       |
| `observation_count`             | `>= 0`                          |
| `anomaly_count`                 | `>= 0`                          |

NaN and Inf are rejected for both float fields. This prevents constraint bypass via NaN comparisons (same pattern as BudgetTracker).

## PostureEvaluationResult

Structured result of a posture evaluation.

```python
from kailash.trust.postures import PostureEvaluationResult, TrustPosture

eval_result = PostureEvaluationResult(
    decision="approved",           # Must be "approved", "denied", or "deferred"
    rationale="Success rate exceeds 95% threshold over 72 hours",
    suggested_posture=TrustPosture.CONTINUOUS_INSIGHT,
    evidence_summary={
        "success_rate": 0.97,
        "observation_count": 500,
        "anomaly_count": 2,
    },
    evaluator_id="posture-evaluator-v2",
)

# Serialize / deserialize
data = eval_result.to_dict()
restored = PostureEvaluationResult.from_dict(data)
```

`decision` is validated in `__post_init__` against the set `{"approved", "denied", "deferred"}`.

## TrustPosture Enum

Five graduated trust postures with ordering support:

| Posture              | Autonomy Level | Value                  |
| -------------------- | -------------- | ---------------------- |
| `PSEUDO_AGENT`       | 1              | `"pseudo_agent"`       |
| `SUPERVISED`         | 2              | `"supervised"`         |
| `SHARED_PLANNING`    | 3              | `"shared_planning"`    |
| `CONTINUOUS_INSIGHT` | 4              | `"continuous_insight"` |
| `DELEGATED`          | 5              | `"delegated"`          |

Supports comparison operators: `TrustPosture.SUPERVISED < TrustPosture.DELEGATED` evaluates to `True`.

Helper methods:

- `can_upgrade_to(target)` — `target.autonomy_level > self.autonomy_level`
- `can_downgrade_to(target)` — `target.autonomy_level < self.autonomy_level`

## PostureTransition Enum

```python
class PostureTransition(str, Enum):
    UPGRADE = "upgrade"
    DOWNGRADE = "downgrade"
    MAINTAIN = "maintain"
    EMERGENCY_DOWNGRADE = "emergency_downgrade"
```

`EMERGENCY_DOWNGRADE` bypasses all guards and goes directly to `PSEUDO_AGENT`. It is preserved through SQLite round-trips via the `transition_type` column.

## Emergency Downgrade

```python
result = machine.emergency_downgrade(
    agent_id="agent-001",
    reason="Anomalous behavior detected",
    requester_id="security-monitor",
)
# Always succeeds, bypasses all guards
# Sets posture to PSEUDO_AGENT immediately
# Records with transition_type=EMERGENCY_DOWNGRADE
```

## TransitionGuard

Guards validate posture transitions. The default guard requires `requester_id` for upgrades:

```python
from kailash.trust.postures import TransitionGuard, PostureTransition

# Custom guard example
guard = TransitionGuard(
    name="min_observations",
    check_fn=lambda req: req.metadata.get("observation_count", 0) >= 100,
    applies_to=[PostureTransition.UPGRADE],
    reason_on_failure="Insufficient observations for upgrade (minimum: 100)",
)
machine.add_guard(guard)
```

Guards can be listed (`machine.list_guards()`) and removed by name (`machine.remove_guard("name")`).

## Complete Example: Persistent Posture Management

```python
from kailash.trust.posture_store import SQLitePostureStore
from kailash.trust.postures import (
    PostureStateMachine,
    PostureTransitionRequest,
    PostureEvidence,
    PostureEvaluationResult,
    TransitionGuard,
    PostureTransition,
    TrustPosture,
)

# Setup persistent store
with SQLitePostureStore("/tmp/eatp/postures.db") as store:
    # Create state machine with store
    machine = PostureStateMachine(
        default_posture=TrustPosture.SUPERVISED,
        store=store,
    )

    # Collect evidence
    evidence = PostureEvidence(
        observation_count=500,
        success_rate=0.97,
        time_at_current_posture_hours=72.5,
        anomaly_count=2,
        source="monitoring-v3",
    )

    # Evaluate (application logic)
    evaluation = PostureEvaluationResult(
        decision="approved",
        rationale="High success rate over extended observation period",
        suggested_posture=TrustPosture.SHARED_PLANNING,
        evidence_summary=evidence.to_dict(),
        evaluator_id="posture-evaluator",
    )

    # Execute transition
    if evaluation.decision == "approved" and evaluation.suggested_posture:
        current = machine.get_posture("agent-001")
        result = machine.transition(PostureTransitionRequest(
            agent_id="agent-001",
            from_posture=current,
            to_posture=evaluation.suggested_posture,
            reason=evaluation.rationale,
            requester_id="posture-evaluator",
            metadata={"evidence": evidence.to_dict()},
        ))
        print(f"Transition {'succeeded' if result.success else 'blocked'}: "
              f"{result.from_posture.value} -> {result.to_posture.value}")

    # Check history
    history = store.get_history("agent-001", limit=10)
    for tr in history:
        print(f"  {tr.timestamp}: {tr.from_posture.value} -> {tr.to_posture.value} "
              f"({tr.transition_type.value})")
```

## Cross-References

- **Skill**: `co-reference` — Full EATP framework knowledge
- **Budget tracking**: `eatp-budget-tracking.md` — Related persistence pattern for budgets
- **Security patterns**: `eatp-security-patterns.md` — Lock ordering, integer arithmetic, symlink rejection
- **Source**: `kailash/trust/posture_store.py`, `kailash/trust/postures.py`
