# EATP SDK — Budget Tracking Reference

Thread-safe, fail-closed budget accounting with integer microdollars, two-phase reserve/record semantics, threshold callbacks, and crash-safe SQLite persistence.

**Source**: `kailash/trust/constraints/budget_tracker.py`, `kailash/trust/constraints/budget_store.py`

## Core Concepts

### Integer Microdollars

All budget arithmetic uses integer microdollars to avoid floating-point precision issues:

- 1 USD = 1,000,000 microdollars
- `$1.50` = `1_500_000` microdollars
- Threshold comparisons use `committed * 100 >= allocated * threshold_pct` (pure integer arithmetic)

```python
from kailash.trust.constraints.budget_tracker import usd_to_microdollars, microdollars_to_usd

budget = usd_to_microdollars(100.0)   # 100_000_000
display = microdollars_to_usd(budget)  # 100.0

# usd_to_microdollars rejects NaN/Inf (raises BudgetTrackerError)
```

### Two-Phase Reserve/Record Lifecycle

Every spend follows a reserve-then-record pattern:

```python
from kailash.trust.constraints.budget_tracker import BudgetTracker, usd_to_microdollars

tracker = BudgetTracker(allocated_microdollars=usd_to_microdollars(100.0))

estimated_cost = usd_to_microdollars(5.0)

# Phase 1: Reserve (fail-closed — returns False if insufficient)
if tracker.reserve(estimated_cost):
    # Phase 2: Do the work ...
    actual_cost = usd_to_microdollars(4.75)  # Actual may differ from estimate

    # Phase 3: Record (releases reservation, commits actual)
    tracker.record(
        reserved_microdollars=estimated_cost,
        actual_microdollars=actual_cost,
    )
```

**Safe direction**: Between the two atomic operations in `record()` (reserved subtracted before committed added), `remaining()` briefly over-reports. This may briefly allow a reservation that would have been denied, but never denies one that should be allowed.

### Saturating Arithmetic

- `_reserved` is decreased by `reserved_microdollars` but never below 0
- `_committed` can exceed `_allocated` to track real overspend (no upper saturation on committed)
- `remaining_microdollars()` returns `max(0, allocated - committed - reserved)`

## BudgetTracker API

### Constructor

```python
tracker = BudgetTracker(
    allocated_microdollars=usd_to_microdollars(100.0),
    store=None,        # Optional BudgetStore for persistence
    tracker_id=None,   # Required when store is provided
)
```

- `allocated_microdollars` must be a non-negative integer
- When `store` is provided, `tracker_id` is required
- On construction with a store, existing committed state is auto-restored (reservations are lost — safe direction)

### reserve(microdollars) -> bool

Atomically attempt to reserve budget. Thread-safe. Returns `False` (fail-closed) if:

- `microdollars` is negative or not an integer
- Insufficient remaining budget
- Any unexpected exception occurs

Zero-amount reservation always returns `True`.

### record(reserved_microdollars, actual_microdollars) -> None

Finalize a reservation: release the reserved amount and commit the actual cost.

- Both arguments must be non-negative integers (raises `BudgetTrackerError` otherwise)
- After updating committed, threshold callbacks are collected inside the lock
- Callbacks and store save happen outside the lock (deadlock prevention)

### remaining_microdollars() -> int

Non-negative remaining budget. Thread-safe (acquires lock).

### check(estimated_microdollars) -> BudgetCheckResult

Non-mutating check: would the estimated spend fit? Does NOT modify internal state.

```python
result = tracker.check(usd_to_microdollars(10.0))
if result.allowed:
    print(f"Remaining: ${microdollars_to_usd(result.remaining_microdollars):.2f}")
```

Returns `BudgetCheckResult` with: `allowed`, `remaining_microdollars`, `allocated_microdollars`, `committed_microdollars`, `reserved_microdollars`.

### snapshot() -> BudgetSnapshot

Capture a serializable snapshot of persistent state (`allocated` and `committed` only). In-flight reservations are intentionally excluded.

### from_snapshot(snapshot) -> BudgetTracker (classmethod)

Restore a BudgetTracker from a serialized snapshot with zero reservations.

```python
snap = tracker.snapshot()
data = snap.to_dict()  # {"allocated": 100000000, "committed": 4750000}

# Later: restore
restored = BudgetTracker.from_snapshot(BudgetSnapshot.from_dict(data))
```

## Threshold Callbacks

### on_threshold(callback)

Register a callback for budget utilization thresholds:

| Threshold      | Fires When                     |
| -------------- | ------------------------------ |
| `threshold_80` | committed >= 80% of allocated  |
| `threshold_95` | committed >= 95% of allocated  |
| `exhausted`    | committed >= 100% of allocated |

Each threshold fires at most once per BudgetTracker lifetime. If a callback raises, it is logged and remaining callbacks still execute (fail-safe).

```python
def alert_budget(event: BudgetEvent):
    print(f"Budget alert: {event.event_type}, "
          f"remaining: ${microdollars_to_usd(event.remaining_microdollars):.2f}")

tracker.on_threshold(alert_budget)
```

### on_record(callback)

Register a callback fired after every `record()` call. Unlike `on_threshold()`, this fires on every record, not just at specific thresholds. Useful for custom utilization checks at arbitrary percentages (e.g., posture-budget integration).

```python
def check_custom_threshold():
    snap = tracker.snapshot()
    if snap.committed > snap.allocated * 60 // 100:
        print("Custom 60% threshold reached")

tracker.on_record(check_custom_threshold)
```

## BudgetEvent

Dataclass emitted when a threshold is crossed:

```python
@dataclass
class BudgetEvent:
    event_type: str              # "threshold_80", "threshold_95", or "exhausted"
    remaining_microdollars: int
    allocated_microdollars: int
    timestamp: datetime          # UTC
```

Full `to_dict()` / `from_dict()` round-trip serialization. Validates `event_type` against allowed set in `__post_init__`.

## SQLiteBudgetStore

Crash-safe SQLite persistence for budget snapshots and transaction logs.

### Setup

```python
from kailash.trust.constraints.budget_store import SQLiteBudgetStore
from kailash.trust.constraints.budget_tracker import BudgetTracker, usd_to_microdollars

store = SQLiteBudgetStore("/tmp/eatp/budget.db")
store.initialize()  # Creates tables, indexes, sets 0o600 permissions

tracker = BudgetTracker(
    allocated_microdollars=usd_to_microdollars(100.0),
    store=store,
    tracker_id="agent-001",
)
# If "agent-001" already has saved state, committed is auto-restored
```

### Database Schema

Two tables:

- `budget_snapshots`: `(tracker_id TEXT PK, allocated INT, committed INT, updated_at TEXT)`
- `budget_transactions`: `(id INTEGER PK, tracker_id TEXT, event_type TEXT, amount INT, timestamp TEXT)`

Index: `idx_budget_tx_tracker ON budget_transactions (tracker_id, id)`

### Security Properties

| Property          | Implementation                                       |
| ----------------- | ---------------------------------------------------- |
| Path validation   | Rejects `..`, null bytes, symlinks                   |
| File permissions  | 0o600 on POSIX (owner read/write only)               |
| SQL injection     | All queries use `?` parameterized placeholders       |
| Tracker ID        | Validated `^[a-zA-Z0-9_-]+$`                         |
| Concurrency       | WAL mode, `threading.local()` per-thread connections |
| Result set bounds | Transaction log capped at 10,000 entries per query   |

### BudgetStore Protocol

Any persistence backend must implement these 3 methods:

```python
class BudgetStore:
    def get_snapshot(self, tracker_id: str) -> Optional[BudgetSnapshot]:
        """Load a previously saved snapshot, or None if not found."""
        ...

    def save_snapshot(self, tracker_id: str, snapshot: BudgetSnapshot) -> None:
        """Persist a budget snapshot (upsert)."""
        ...

    def get_transaction_log(self, tracker_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Return the most recent transaction log entries."""
        ...
```

### Additional Helper: log_transaction

```python
store.log_transaction(
    tracker_id="agent-001",
    event_type="record",
    amount=usd_to_microdollars(4.75),
)
```

### Lifecycle

```python
store = SQLiteBudgetStore("/tmp/eatp/budget.db")
store.initialize()  # Must call before any operation

# ... use store ...

store.close()  # Closes ALL per-thread connections and resets state
```

## Thread Safety Invariants

1. All mutable state (`_reserved`, `_committed`, `_fired_thresholds`, `_transaction_log`) is protected by `self._lock`
2. Callbacks fire OUTSIDE the lock (C1 fix) — prevents deadlock when callbacks call `remaining_microdollars()`, `check()`, or `snapshot()`
3. Snapshot for persistence is captured INSIDE the lock (C3 fix) — prevents race where the save sees state from a concurrent `record()` call
4. Input validation on `record()` happens BEFORE acquiring the lock (H2 fix) — invalid inputs never corrupt internal state
5. Transaction log uses `deque(maxlen=10_000)` — bounded collection per EATP rules

## Exception Hierarchy

```
TrustError
  └── BudgetTrackerError  — Raised by BudgetTracker and BudgetSnapshot
  └── BudgetStoreError    — Raised by SQLiteBudgetStore
```

Both include `.details: Dict[str, Any]` for structured error context.

## Complete Example

```python
from kailash.trust.constraints.budget_tracker import (
    BudgetTracker,
    BudgetEvent,
    usd_to_microdollars,
    microdollars_to_usd,
)
from kailash.trust.constraints.budget_store import SQLiteBudgetStore

# Setup persistence
store = SQLiteBudgetStore("/tmp/eatp/budget.db")
store.initialize()

# Create tracker with $50 budget
tracker = BudgetTracker(
    allocated_microdollars=usd_to_microdollars(50.0),
    store=store,
    tracker_id="research-agent",
)

# Register threshold alert
def on_threshold(event: BudgetEvent):
    pct = (1 - event.remaining_microdollars / event.allocated_microdollars) * 100
    print(f"ALERT: {event.event_type} — {pct:.0f}% used")

tracker.on_threshold(on_threshold)

# Simulate work
for i in range(10):
    cost = usd_to_microdollars(4.50)
    if tracker.reserve(cost):
        # Do work...
        actual = usd_to_microdollars(4.25)
        tracker.record(reserved_microdollars=cost, actual_microdollars=actual)
        remaining = microdollars_to_usd(tracker.remaining_microdollars())
        print(f"Step {i+1}: spent $4.25, remaining ${remaining:.2f}")
    else:
        print(f"Step {i+1}: DENIED — insufficient budget")
        break

# Cleanup
store.close()
```

## Cross-References

- **Skill**: `co-reference` — Full EATP framework knowledge
- **Security patterns**: `eatp-security-patterns.md` — Lock ordering, integer arithmetic, symlink rejection
- **Posture stores**: `eatp-posture-stores.md` — Related persistence pattern for postures
- **Source**: `kailash/trust/constraints/budget_tracker.py`, `kailash/trust/constraints/budget_store.py`
