# Skill: Trust-Plane Store Backend Implementation

## When to Use This Skill

When adding a new `TrustPlaneStore` backend (e.g., PostgreSQL, DynamoDB, or any other storage engine).

## Prerequisites

- `TrustPlaneStore` protocol: `kailash/trust/plane/store/__init__.py`
- Conformance test suite: `tests/trust/plane/store/test_store_conformance.py`
- Existing reference implementations:
  - SQLite: `kailash/trust/plane/store/sqlite.py` (698 LOC, default backend)
  - Filesystem: `kailash/trust/plane/store/filesystem.py` (305 LOC)
  - PostgreSQL: `kailash/trust/plane/store/postgres.py` (production backend)
- Python 3.11+

## Store Security Contract (Mandatory Checklist)

Every backend MUST satisfy ALL six requirements. A missing requirement is a security defect.

- [ ] **1. ATOMIC_WRITES**: Every record write is all-or-nothing. A crash during write MUST NOT produce partial or corrupted records.
  - SQLite: SQL transactions
  - Filesystem: `atomic_write()` (temp file + fsync + `os.replace()`)
  - PostgreSQL: SQL transactions with `COMMIT`/`ROLLBACK`

- [ ] **2. INPUT_VALIDATION**: Every method accepting a record ID or query parameter MUST call `validate_id()` before using it in a path or query. Malformed IDs MUST raise `ValueError`.

  ```python
  from kailash.trust.plane._locking import validate_id
  validate_id(record_id)  # Regex: ^[a-zA-Z0-9_-]+$
  ```

- [ ] **3. BOUNDED_RESULTS**: Every `list_*()` method MUST accept a `limit` parameter and MUST NOT return more than `limit` records. Default limit MUST be <= 1000. Clamp negative values: `limit = max(0, limit)`.

- [ ] **4. PERMISSION_ISOLATION**: The backend MUST ensure the calling process only accesses records for the current project. Cross-project visibility is forbidden.
  - SQLite: scoped to a single `.db` file
  - Filesystem: scoped to a directory
  - PostgreSQL: `WHERE project_id = ?` or Row-Level Security

- [ ] **5. CONCURRENT_SAFETY**: The backend MUST handle concurrent reads and writes without data loss or corruption.
  - SQLite: WAL mode + `BEGIN IMMEDIATE`
  - Filesystem: `filelock`
  - PostgreSQL: MVCC

- [ ] **6. NO_SILENT_FAILURES**: Every method MUST raise a specific, named exception (subclass of `TrustPlaneStoreError`) on failure. Methods MUST NOT return `None` or `False` to signal errors.

## Step-by-Step Implementation Guide

### Step 1: Create the backend module

```
kailash/trust/plane/store/<backend_name>.py
```

Required header:

```python
# Copyright 2026 Terrene Foundation
# SPDX-License-Identifier: Apache-2.0

"""<Backend>-backed TrustPlaneStore implementation."""

from __future__ import annotations

import json
import logging
from kailash.trust.plane._locking import validate_id
from kailash.trust.plane.delegation import Delegate, DelegateStatus, ReviewResolution
from kailash.trust.plane.holds import HoldRecord
from kailash.trust.plane.models import DecisionRecord, MilestoneRecord, ProjectManifest

logger = logging.getLogger(__name__)

__all__ = ["<BackendName>TrustPlaneStore"]
```

### Step 2: Implement all protocol methods

The `TrustPlaneStore` protocol requires these method groups:

| Group      | Methods                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| Lifecycle  | `initialize()`, `close()`                                                     |
| Decisions  | `store_decision()`, `get_decision()`, `list_decisions()`                      |
| Milestones | `store_milestone()`, `get_milestone()`, `list_milestones()`                   |
| Holds      | `store_hold()`, `get_hold()`, `list_holds()`, `update_hold()`                 |
| Delegates  | `store_delegate()`, `get_delegate()`, `list_delegates()`, `update_delegate()` |
| Reviews    | `store_review()`, `list_reviews()`                                            |
| Manifest   | `store_manifest()`, `get_manifest()`                                          |
| Anchors    | `store_anchor()`, `get_anchor()`, `list_anchors()`                            |
| WAL        | `store_wal()`, `get_wal()`, `delete_wal()`                                    |

### Step 3: Apply `validate_id()` to every ID parameter

Every method that receives an ID from outside MUST validate it:

```python
def store_decision(self, record: DecisionRecord) -> None:
    validate_id(record.decision_id)  # MUST be first line
    # ... then persist

def store_review(self, review: ReviewResolution) -> None:
    validate_id(review.hold_id)      # BOTH IDs validated
    validate_id(review.delegate_id)
    # ... then persist
```

### Step 4: Implement atomic writes

All writes must be wrapped in the backend's atomic mechanism:

```python
# SQLite
conn.execute("INSERT OR REPLACE INTO ...", (...,))
conn.commit()

# PostgreSQL
with conn.cursor() as cur:
    cur.execute("INSERT INTO ... ON CONFLICT (...) DO UPDATE ...", (...,))
conn.commit()
```

### Step 5: Implement bounded queries with positive limit clamping

```python
def list_decisions(self, limit: int = 1000) -> list[DecisionRecord]:
    limit = max(0, limit)  # Prevent LIMIT -1 bypass
    # ... query with LIMIT
```

### Step 6: Set file/database permissions

```python
# For file-based backends (SQLite, filesystem):
import os
try:
    os.chmod(self._db_path, 0o600)
except OSError:
    logger.debug("Could not set 0o600 (non-POSIX?)")
```

### Step 7: Register the backend

1. Add to `store/__init__.py`:

```python
from kailash.trust.plane.store.<backend> import <BackendName>TrustPlaneStore  # noqa: E402, F401
```

2. Add to `__init__.py` `__all__`

3. Add to `config.py` backend choices

4. Add to `cli.py` `--store` option

### Step 8: Run the conformance test suite

Add your backend to the parametrized fixture in `test_store_conformance.py`:

```python
@pytest.fixture(params=["filesystem", "sqlite", "<backend_name>"])
def store(request, tmp_path):
    if request.param == "<backend_name>":
        store = <BackendName>TrustPlaneStore(...)
        store.initialize()
        yield store
        store.close()
```

Run: `pytest tests/trust/plane/store/test_store_conformance.py -v`

All tests MUST pass. The conformance suite tests all six contract requirements.

## Common Pitfalls

### Pitfall 1: Forgetting `validate_id()` on query parameters

```python
# WRONG: path traversal in filesystem, SQL injection risk
path = store_dir / f"{user_input}.json"

# RIGHT: validate first
validate_id(user_input)
path = store_dir / f"{user_input}.json"
```

R13 caught this exact bug in `store_review()` where `hold_id` and `delegate_id` were not validated.

### Pitfall 2: Using `open()` instead of `atomic_write()`

```python
# WRONG: partial write on crash = corrupted record
with open(path, 'w') as f:
    json.dump(record, f)

# RIGHT: crash-safe atomic write
atomic_write(path, record.to_dict())
```

### Pitfall 3: Missing `LIMIT` clause on list queries

```python
# WRONG: unbounded query → OOM on large datasets
cursor = conn.execute("SELECT data FROM decisions")

# RIGHT: always bound
cursor = conn.execute("SELECT data FROM decisions LIMIT ?", (limit,))
```

### Pitfall 4: Negative limit bypass

```python
# WRONG: SQLite LIMIT -1 returns ALL rows
cursor = conn.execute("SELECT ... LIMIT ?", (limit,))  # limit=-1 → no limit

# RIGHT: clamp to non-negative
limit = max(0, limit)
cursor = conn.execute("SELECT ... LIMIT ?", (limit,))
```

### Pitfall 5: SQL string interpolation

```python
# WRONG: SQL injection
conn.execute(f"SELECT * FROM decisions WHERE id = '{decision_id}'")

# RIGHT: parameterized query
conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,))
```

### Pitfall 6: Platform-specific file permissions

```python
# WRONG: assumes POSIX
os.chmod(path, 0o600)  # Crashes on Windows

# RIGHT: handle gracefully
try:
    os.chmod(path, 0o600)
except OSError:
    logger.debug("Could not set permissions (non-POSIX?)")
```

## R14 Findings: PostgreSQL Backend Patterns

These patterns were discovered during R14 red teaming of the PostgreSQL backend (2026-03-15).

### Pitfall 7: Missing PoolTimeout handling

```python
# WRONG: PoolTimeout is not OperationalError — falls through exception handlers
from psycopg_pool import PoolTimeout
# PoolTimeout is not caught by `except psycopg.OperationalError`

# RIGHT: catch PoolTimeout explicitly in _safe_connection()
try:
    conn = self._pool.getconn()
except PoolTimeout as exc:
    raise StoreConnectionError(f"Connection pool timeout: {exc}") from exc
except psycopg.OperationalError as exc:
    raise StoreConnectionError(...) from exc
```

### Pitfall 8: Double-wrapping store exceptions

```python
# WRONG: wraps an already-wrapped StoreConnectionError again
try:
    self._do_query()
except Exception as exc:
    raise StoreQueryError(...) from exc  # Double-wrap if inner raised StoreQueryError

# RIGHT: re-raise existing store errors as-is
try:
    self._do_query()
except (StoreConnectionError, StoreQueryError):
    raise  # Already wrapped — don't re-wrap
except psycopg.Error as exc:
    raise StoreQueryError(...) from exc
```

### Pitfall 9: Connection string leaking passwords in errors

```python
# WRONG: password visible in error message
raise StoreConnectionError(f"Cannot connect to {self._conninfo}")

# RIGHT: sanitize connection info
def _sanitize_conninfo(conninfo: str) -> str:
    """Strip password from connection string for safe logging."""
    return re.sub(r'password=[^\s]+', 'password=***', conninfo)

raise StoreConnectionError(f"Cannot connect to {self._sanitize_conninfo(self._conninfo)}")
```

### Pattern: Exception wrapping for database backends

All database backends MUST follow this exception wrapping pattern:

```python
from kailash.trust.plane.exceptions import StoreConnectionError, StoreQueryError

@contextmanager
def _safe_connection(self):
    """Context manager that wraps provider exceptions."""
    try:
        conn = self._get_connection()
        yield conn
    except (StoreConnectionError, StoreQueryError):
        raise  # Already wrapped
    except PoolTimeout as exc:
        raise StoreConnectionError(
            f"Pool timeout: {self._sanitize_conninfo(self._conninfo)}"
        ) from exc
    except psycopg.OperationalError as exc:
        raise StoreConnectionError(
            f"Connection error: {self._sanitize_conninfo(self._conninfo)}"
        ) from exc
    except psycopg.Error as exc:
        raise StoreQueryError(f"Query error: {exc}") from exc
```

## See Also

- R13 store backend red team findings (informed this skill's error handling patterns)
- R14 validation findings (PostgreSQL PoolTimeout, exception wrapping)
- TODO-24: PostgreSQL backend — first real application of this codified pattern
