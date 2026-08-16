# EATP SDK — Security Patterns Reference

Security patterns learned from red team validation of the EATP SDK. These patterns apply to BudgetTracker, PostureStore, constraint evaluation, and all EATP persistence layers.

**Source**: Red team findings C1, C3, M1, H1, H2 from tool-agent-support workspace validation

## Pattern 1: Callbacks Fire OUTSIDE the Lock (C1 — Deadlock Prevention)

**Problem**: Threshold callbacks that fire inside the lock cause deadlock when they call back into the tracker (e.g., `remaining_microdollars()`, `check()`, `snapshot()`).

**Solution**: Collect events inside the lock, fire callbacks after releasing.

```python
def record(self, reserved_microdollars, actual_microdollars):
    events_to_fire: List[BudgetEvent] = []

    with self._lock:
        # Update state
        self._reserved = max(0, self._reserved - reserved_microdollars)
        self._committed += actual_microdollars

        # Collect events INSIDE lock (consistent state read)
        events_to_fire = self._collect_threshold_events()

    # Fire callbacks OUTSIDE lock (safe for re-entrant calls)
    for event in events_to_fire:
        for cb in self._threshold_callbacks:
            try:
                cb(event)
            except Exception:
                logger.exception("Threshold callback raised -- ignoring")
```

**Rule**: Any callback registered via `on_threshold()` or `on_record()` MUST be invoked outside the lock. The callback may call any public method on the tracker without deadlock.

## Pattern 2: Snapshot Capture INSIDE the Lock (C3 — Race Prevention)

**Problem**: If the snapshot for persistence is captured after releasing the lock, a concurrent `record()` call can modify state between the lock release and the snapshot capture. The saved snapshot then reflects a state that never existed atomically.

**Solution**: Capture the snapshot while still holding the lock, save it after releasing.

```python
def record(self, reserved_microdollars, actual_microdollars):
    snapshot_to_save: Optional[BudgetSnapshot] = None

    with self._lock:
        # Update state ...
        self._committed += actual_microdollars

        # Capture snapshot INSIDE lock (consistent state)
        if self._store is not None:
            snapshot_to_save = BudgetSnapshot(
                allocated=self._allocated,
                committed=self._committed,
            )

    # Save OUTSIDE lock (I/O should not hold the lock)
    if snapshot_to_save is not None and self._tracker_id is not None:
        try:
            self._store.save_snapshot(self._tracker_id, snapshot_to_save)
        except Exception:
            logger.exception("Failed to save snapshot -- state is in memory only")
```

**Rule**: Any state that will be persisted MUST be captured as a snapshot inside the lock. The actual I/O (SQLite write, file write) happens outside the lock to avoid holding it during slow operations.

## Pattern 3: Integer Arithmetic for Threshold Comparisons (M1 — Float Precision)

**Problem**: Floating-point arithmetic introduces precision errors in threshold checks. `committed / allocated >= 0.80` can fail to trigger at exactly 80% due to representation error.

**Solution**: Use pure integer arithmetic. Multiply by 100 instead of dividing.

```python
# CORRECT: Integer arithmetic
committed_x100 = self._committed * 100
if committed_x100 >= self._allocated * 80:
    # 80% threshold crossed

# WRONG: Float arithmetic
if self._committed / self._allocated >= 0.80:  # Precision error!
    # May not trigger at exactly 80%
```

**Rule**: All threshold comparisons in budget tracking MUST use integer multiplication, never floating-point division. Float is acceptable only for human-readable log messages (display purposes).

## Pattern 4: Input Validation Before Lock Acquisition (H2 — Invalid Input Rejection)

**Problem**: If invalid inputs (negative integers, NaN, non-integer types) reach the arithmetic inside the lock, they can corrupt internal state irreversibly. NaN in particular poisons accumulators: once `committed += NaN`, the committed value is permanently NaN and all future budget checks pass.

**Solution**: Validate inputs before acquiring the lock. Reject invalid inputs immediately.

```python
def record(self, reserved_microdollars, actual_microdollars):
    # Validate BEFORE acquiring the lock
    if not isinstance(reserved_microdollars, int) or reserved_microdollars < 0:
        raise BudgetTrackerError(
            f"reserved_microdollars must be a non-negative integer, "
            f"got {reserved_microdollars!r}",
            details={"reserved_microdollars": str(reserved_microdollars)},
        )
    if not isinstance(actual_microdollars, int) or actual_microdollars < 0:
        raise BudgetTrackerError(
            f"actual_microdollars must be a non-negative integer, "
            f"got {actual_microdollars!r}",
            details={"actual_microdollars": str(actual_microdollars)},
        )

    with self._lock:
        # State is safe to modify — inputs are validated
        ...
```

For `reserve()`, invalid input returns `False` (fail-closed) rather than raising, matching the two-phase lifecycle convention.

**Rule**: Every public method that modifies state MUST validate inputs before acquiring any lock. The validation MUST check both type (`isinstance(x, int)`) and range (`x >= 0`).

## Pattern 5: math.isfinite() on All Numeric Fields (NaN/Inf Prevention)

**Problem**: `NaN` bypasses all numeric comparisons (`NaN > X` is always `False`, `NaN < X` is always `False`). If NaN enters a constraint field, all constraint checks pass silently. `Inf` has similar bypass properties.

**Solution**: Validate with `math.isfinite()` in `__post_init__` and `from_dict()`.

```python
import math

@dataclass
class PostureEvidence:
    success_rate: float
    time_at_current_posture_hours: float

    def __post_init__(self):
        if not math.isfinite(self.success_rate):
            raise ValueError(f"success_rate must be finite, got {self.success_rate}")
        if not (0.0 <= self.success_rate <= 1.0):
            raise ValueError(f"success_rate must be in [0.0, 1.0]")
        if not math.isfinite(self.time_at_current_posture_hours):
            raise ValueError(f"time must be finite")
        if self.time_at_current_posture_hours < 0:
            raise ValueError(f"time must be non-negative")
```

**Rule**: Every dataclass with numeric constraint fields MUST validate `math.isfinite()` in `__post_init__`. This applies to: `PostureEvidence`, constraint envelopes (`FinancialConstraints`, `TemporalConstraints`), and conversion functions (`usd_to_microdollars`).

## Pattern 6: Symlink Rejection on Database Paths

**Problem**: An attacker who can create symlinks can redirect database paths to arbitrary files (e.g., `/etc/passwd`), causing reads from or writes to unintended locations.

**Solution**: Check for symlinks before opening.

```python
import os

def _validate_db_path(db_path: str) -> None:
    if "\x00" in db_path:
        raise ValueError("db_path contains null byte")

    parts = db_path.replace("\\", "/").split("/")
    if ".." in parts:
        raise ValueError("db_path contains path traversal '..'")

    if os.path.islink(db_path):
        raise ValueError("db_path is a symlink -- refusing to follow")
```

**Rule**: All database path validation MUST reject symlinks (`os.path.islink()`), null bytes, and `..` path traversal components. This applies to both `SQLiteBudgetStore` and `SQLitePostureStore`.

## Pattern 7: 0o600 File Permissions on Database Files

**Problem**: SQLite database files created with default permissions may be world-readable on shared systems, exposing trust records, budget data, and posture history.

**Solution**: Create with restricted permissions, then enforce with `os.chmod()`.

```python
import os
import stat

# Create new file with restricted permissions
if not os.path.exists(db_path):
    fd = os.open(
        db_path,
        os.O_CREAT | os.O_WRONLY,
        stat.S_IRUSR | stat.S_IWUSR,  # 0o600
    )
    os.close(fd)

# Enforce even on existing files (may have been created with different umask)
if hasattr(os, "chmod"):
    os.chmod(db_path, stat.S_IRUSR | stat.S_IWUSR)
```

**Rule**: All EATP database files (`.db`, `-wal`, `-shm`) MUST have 0o600 permissions on POSIX systems. Set permissions both at creation time and on existing files.

## Pattern 8: Parameterized SQL for All Queries

**Problem**: String interpolation into SQL enables injection attacks, even when IDs appear validated.

**Solution**: Use `?` placeholders for all values. Validate identifiers separately.

```python
# CORRECT: Parameterized
cursor = conn.execute(
    "SELECT allocated, committed FROM budget_snapshots WHERE tracker_id = ?",
    (tracker_id,),
)

# CORRECT: Upsert with parameterized values
conn.execute(
    "INSERT INTO budget_snapshots (tracker_id, allocated, committed, updated_at) "
    "VALUES (?, ?, ?, ?) "
    "ON CONFLICT(tracker_id) DO UPDATE SET "
    "allocated = excluded.allocated, committed = excluded.committed, "
    "updated_at = excluded.updated_at",
    (tracker_id, snapshot.allocated, snapshot.committed, now),
)

# WRONG: String interpolation
conn.execute(f"SELECT * FROM snapshots WHERE tracker_id = '{tracker_id}'")
```

**Rule**: Defense in depth. Even when IDs are validated against `^[a-zA-Z0-9_-]+$`, always use parameterized queries. The validation prevents injection, but parameterization provides a second layer.

## Pattern 9: Tracker/Agent ID Validation

**Problem**: Unconstrained IDs can contain path traversal characters (`../`), SQL injection characters, or null bytes.

**Solution**: Validate against a strict regex before any use.

```python
import re

_TRACKER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

def _validate_tracker_id(tracker_id: str) -> None:
    if not isinstance(tracker_id, str) or not tracker_id:
        raise BudgetStoreError("tracker_id must be a non-empty string")
    if "\x00" in tracker_id:
        raise BudgetStoreError("tracker_id contains null byte")
    if not _TRACKER_ID_RE.match(tracker_id):
        raise BudgetStoreError(f"Invalid tracker_id: must match [a-zA-Z0-9_-]+")
```

**Rule**: All externally-sourced IDs (tracker IDs, agent IDs) MUST be validated before use in SQL queries, file paths, or any other context. The regex `^[a-zA-Z0-9_-]+$` is the canonical EATP pattern.

## Pattern 10: Bounded Collections (deque with maxlen)

**Problem**: Unbounded collections (lists, dicts) in long-running processes grow without limit, eventually causing memory exhaustion.

**Solution**: Use `deque(maxlen=N)` or manual trim with oldest-10% eviction.

```python
from collections import deque

# BudgetTracker transaction log
_MAX_TRANSACTION_LOG = 10_000
self._transaction_log: deque = deque(maxlen=_MAX_TRANSACTION_LOG)

# PostureStateMachine transition history
self._max_history_size = 10_000
if len(self._transition_history) > self._max_history_size:
    trim_count = self._max_history_size // 10
    self._transition_history = self._transition_history[trim_count:]
```

**Rule**: All in-memory collections that grow with usage MUST have a bounded maximum size. Default bound: 10,000 entries. When at capacity, evict the oldest 10%.

## Pattern 11: WAL Mode for Concurrent Reads

**Problem**: SQLite default journal mode (`DELETE`) blocks readers during writes.

**Solution**: Enable WAL (Write-Ahead Logging) mode on connection creation.

```python
conn = sqlite3.connect(db_path)
conn.execute("PRAGMA journal_mode=WAL")
```

Combined with `threading.local()` per-thread connections, this allows concurrent readers without blocking writers.

**Rule**: All EATP SQLite databases MUST use WAL journal mode. Each thread gets its own connection via `threading.local()`.

## Pattern 12: Fail-Closed on Errors

**Problem**: Silently swallowing errors in security-critical paths can allow unauthorized actions.

**Solution**: Default to deny (fail-closed) on any unexpected condition.

```python
def reserve(self, microdollars: int) -> bool:
    # Fail-closed on invalid input
    if not isinstance(microdollars, int) or microdollars < 0:
        return False

    try:
        with self._lock:
            # ... reservation logic ...
            return True
    except Exception:
        # Fail-closed: any unexpected error -> deny
        logger.exception("Unexpected error in reserve() -- fail-closed")
        return False
```

**Rule**: In the EATP trust model, unknown or error states MUST deny, never silently permit. `reserve()` returns `False` on error. Constraint evaluation defaults to `BLOCKED` on error.

## Summary Table

| ID  | Pattern                      | Prevents                                       |
| --- | ---------------------------- | ---------------------------------------------- |
| C1  | Callbacks outside lock       | Deadlock on re-entrant tracker calls           |
| C3  | Snapshot inside lock         | Race condition on concurrent record() calls    |
| M1  | Integer threshold arithmetic | Float precision errors at boundary values      |
| H1  | on_record() callbacks        | Monkey-patching for custom threshold checks    |
| H2  | Input validation before lock | NaN/negative corruption of internal state      |
| --  | math.isfinite() validation   | NaN/Inf bypass of numeric constraints          |
| --  | Symlink rejection            | Arbitrary file read/write via symlink redirect |
| --  | 0o600 permissions            | World-readable trust/budget databases          |
| --  | Parameterized SQL            | SQL injection (defense-in-depth)               |
| --  | ID validation regex          | Path traversal, injection via IDs              |
| --  | Bounded collections          | Memory exhaustion in long-running processes    |
| --  | WAL mode + threading.local() | Reader blocking during writes                  |
| --  | Fail-closed on errors        | Silent permit on unexpected conditions         |

## Cross-References

- **Budget tracking**: `eatp-budget-tracking.md` — BudgetTracker API where these patterns are applied
- **Posture stores**: `eatp-posture-stores.md` — PostureStore where these patterns are applied
- **Trust-plane security rules**: `.claude/rules/trust-plane-security.md` — Trust-plane-specific MUST/MUST-NOT rules
- **EATP rules**: `.claude/rules/eatp.md` — SDK conventions (dataclasses, error hierarchy, cryptography)
- **Source**: `kailash/trust/constraints/budget_tracker.py`, `kailash/trust/constraints/budget_store.py`, `kailash/trust/posture_store.py`
