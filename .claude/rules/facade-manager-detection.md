---
priority: 10
scope: path-scoped
paths:
  - "packages/**"
  - "src/**"
  - "**/tests/**"
---

# Facade Manager Detection Rules


<!-- slot:neutral-body -->

Closely related to `rules/orphan-detection.md`, this rule targets the specific code shape that becomes orphaned most often: classes named `*Manager`, `*Executor`, `*Store`, `*Registry`, `*Engine`, or `*Service` that are exposed via a property accessor on the framework's top-level class.

The naming pattern signals "this is a long-lived object that owns state, manages a subsystem, or persists data." When such a class lands without a Tier 2 test that imports it AND a production call site that invokes it, the chance it never runs in production is very high — the same failure pattern Phase 5.11 surfaced for `TrustAwareQueryExecutor`.

## MUST Rules

### 1. Every Manager-Shape Class Has a Tier 2 Test

Any class matching `*Manager` / `*Executor` / `*Store` / `*Registry` / `*Engine` / `*Service` exposed as a property on the framework's top-level class (e.g. `db.trust_executor`, `app.audit_store`) MUST have at least one Tier 2 test that:

1. Imports the class through the framework facade (`db.trust_executor`, not `from dataflow.trust import TrustAwareQueryExecutor`).
2. Constructs a real DataFlow / Nexus / Kaizen instance against real infrastructure.
3. Triggers a code path that ends up calling at least one method on the manager.
4. Asserts the externally-observable effect (a row in the audit table, a redacted field in the read result, a record in the metrics counter).

```python
# DO — Tier 2 test imports through the facade and asserts an external effect
@pytest.mark.integration
async def test_trust_executor_audits_query(test_suite):
    db = DataFlow(test_suite.config.url, enable_trust=True)
    set_agent_id("agent-42")
    await db.express.list("Document")

    # External assertion: an audit row exists
    audit_rows = await db.express.list("AuditEntry", filter={"agent_id": "agent-42"})
    assert len(audit_rows) >= 1
    assert audit_rows[0].operation == "list"

# DO NOT — Tier 1 test against the class in isolation
def test_trust_executor_records_audit():
    executor = TrustAwareQueryExecutor(MagicMock(), MagicMock())
    executor.record_query_success(...)
    executor.audit_store.append.assert_called_once()
# ↑ proves the executor calls its dependency, NOT that the framework calls the executor
```

**Why:** Manager-shape classes are stateful — the test must observe the state change through the same surface a user would. Mocks of the dependencies prove the unit, not the wiring.

### 2. Manager Test File Naming Convention

The Tier 2 test file MUST be named `test_<lowercase_manager_name>_wiring.py` so the absence of the file is grep-able. The file MUST import the framework facade, not the manager class directly.

```
tests/integration/
  test_trust_executor_wiring.py    # exercises db.trust_executor end-to-end
  test_audit_store_wiring.py       # exercises db.audit_store end-to-end
  test_classification_policy_wiring.py
```

**Why:** Predictable naming lets `/redteam` automatically detect missing wiring tests by checking for the expected file name.

### 3. Manager Constructor Receives the Framework Instance

A manager MUST take the parent framework instance (`dataflow_instance`, `app`, etc.) in its `__init__` rather than constructing one itself or pulling from a global. This makes the dependency on the framework explicit and prevents the manager from running with a stale or duplicated framework state.

```python
# DO — explicit framework dependency
class TrustAwareQueryExecutor:
    def __init__(self, dataflow_instance: DataFlow):
        self._df = dataflow_instance

# DO NOT — global lookup
class TrustAwareQueryExecutor:
    def __init__(self):
        self._df = get_current_dataflow()  # global

# DO NOT — self-construction
class TrustAwareQueryExecutor:
    def __init__(self, db_url: str):
        self._df = DataFlow(db_url)  # creates a parallel framework instance
```

**Why:** A manager that builds its own framework instance creates a parallel connection pool, parallel cache, parallel audit store — the user's operations on `db` and the manager's audit on the parallel `db` are tracking different state.

## MUST NOT

- Expose a manager-shape class as a public attribute without a wiring test in the same PR

**Why:** The PR review is the structural gate that catches missing wiring before the symbol becomes part of the public API; once shipped, the symbol cannot be silently removed.

- Use Tier 1 unit tests as the sole coverage for a manager-shape class

**Why:** Tier 1 mocks the framework's call into the manager. The exact failure mode this rule prevents is "the framework never calls the manager in production" — Tier 1 cannot detect that.

- Construct managers with global state lookups or self-constructed framework instances

**Why:** Implicit dependencies hide the wiring contract from reviewers and let the manager run against state that isn't the user's actual `db`.

## Relationship to Other Rules

- `rules/orphan-detection.md` — broader rule covering all facade-style attributes; this rule is the specific manager-shape pattern.
- `rules/testing.md` § "Tier 2 (Integration): Real infrastructure recommended" — Tier 2 contract.
- `rules/zero-tolerance.md` Rule 2 — config flags with no consumer are stubs; manager classes with no consumer are the same failure mode at a different scale.

<!-- /slot:neutral-body -->
