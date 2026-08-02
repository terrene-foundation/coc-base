# Schema & Data Migration — Extended Examples and Evidence

Companion reference for `.claude/rules/schema-migration.md`. The rule body holds the load-bearing MUST / MUST NOT clauses, their `**Why:**` lines, their BLOCKED-rationalization corpora, and the Rule-8 Trust Posture Wiring. This file holds the FULL worked DO/DO-NOT code per clause, the cross-language `force_downgrade` signatures, the evidence chains, and the per-rule origin narratives.

Authoring a migration from scratch? Start at `skills/02-dataflow/migration-scaffold.md` (copy-pasteable scaffold). This file is the rule's evidence companion, not a scaffold.

## Rule 1 — All Schema Changes Through Numbered Migrations: Full Code

```python
# DO — DataFlow @db.model drives auto-migration; the schema lives in code
@db.model
class User:
    id: int = field(primary_key=True)
    email: str

# DO — explicit numbered migration when not using auto-migrate
# migrations/0042_add_user_email_index.py

# DO NOT — DDL string in application code
await conn.execute("ALTER TABLE users ADD COLUMN email TEXT")
```

### Why — Extended

DDL outside the migration framework runs once on whichever environment the agent happens to touch and never on the others. The schemas drift, the next deploy fails on the un-migrated environment, and the failure looks like a code bug because the migration was never recorded.

**Scope of "application code":** services, controllers, handlers, models, and rake/management tasks. DDL is permitted in (a) numbered migration files, (b) the SDK's own dialect helper layer (BUILD repos only — downstream USE projects have no dialect helper layer), and (c) test fixtures that create and tear down test schemas.

## Rule 1a — Inline-DDL Grep: Full Sweep and Evidence

```bash
# DO — /redteam includes the grep audit explicitly
grep -RInE 'CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|SCHEMA)|ALTER\s+(TABLE|INDEX)|DROP\s+(TABLE|SCHEMA|INDEX)' \
    --include='*.py' --include='*.rs' --include='*.rb' \
    -- packages/ src/ \
    | grep -vE '/(migrations|tests/fixtures|dialect)/'
# Exit 0 with no matches = clean. Any match = Rule 1 violation.

# DO NOT — rely on the rule statement alone, without a mechanical sweep
# (rule says "DDL outside migrations is BLOCKED" but no /redteam grep enforces it,
#  so violations land silently and ship to production)
```

### Why — Extended

A rule that says "X is BLOCKED" with no mechanical sweep ships violations indefinitely. The grep is O(seconds) and catches the failure mode the rule was written to prevent. Three-way schema drift (spec ↔ migration ↔ inline DDL in application code) is invisible at code-review level because the reviewer cannot hold all three artifacts in attention at once; the grep surfaces every inline-DDL site in one pass and the migration cross-check follows from there.

**Evidence:** a registry's `_create_registry_tables()` shipped `CREATE TABLE IF NOT EXISTS _kml_model_versions` for ~3 months while migration 0002 owned the same table with a different column-set; the `IF NOT EXISTS` no-op masked the divergence until a user hit a missing-column query path.

Origin: kailash-ml 1.5.x followup #699 (2026-04-29) — three-way schema-drift discovery (spec ↔ migration ↔ inline DDL) mandating a migration.

## Rule 2 — Data Fixes Are Migrations: Full Code

```python
# DO — backfill as a numbered migration
# migrations/0043_backfill_user_signup_source.py
def upgrade(conn):
    conn.execute("UPDATE users SET signup_source = 'organic' WHERE signup_source IS NULL")

def downgrade(conn):
    conn.execute("UPDATE users SET signup_source = NULL WHERE signup_source = 'organic'")

# DO NOT — hotfix SQL in a notebook, ticket comment, or one-off script
# psql> UPDATE users SET signup_source = 'organic' WHERE signup_source IS NULL;
```

A hotfix run by hand has no record, no rollback, and no audit trail. The next environment never gets the same fix, and six months later the team cannot reconstruct why production rows differ from staging.

## Rule 3 — Reversible Path: Full Code

```python
# DO
def upgrade(conn):
    conn.execute("ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'free'")

def downgrade(conn):
    conn.execute("ALTER TABLE users DROP COLUMN tier")

# DO NOT — silent irreversibility
def upgrade(conn):
    conn.execute("DROP TABLE archived_events")  # data gone, no path back, no warning
def downgrade(conn):
    pass  # placeholder
```

Migrations are deployed, and deployed code rolls back. Without `downgrade()`, a failed deploy cannot return to a known-good schema and the system is stuck mid-migration with neither old nor new code able to run.

## Rule 7 — Destructive Downgrades Require `force_downgrade=True`: Cross-Language Signatures

The orchestrator-layer signature is `MigrationManager.apply_downgrade(migration, dataflow, *, force_downgrade: bool = False)` (Python) and the equivalent `MigrationManager::rollback(version, dataflow, force_downgrade: bool)` (Rust). Either MUST return `DowngradeRefusedError` (Python) / `DataFlowError::DowngradeRefused` (Rust) when `force_downgrade` is false AND the stored `down_sql` contains destructive DDL.

```python
# DO — Python: keyword-only flag on the downgrade API
def apply_downgrade(
    self,
    migration: Migration,
    dataflow: DataFlow,
    *,
    force_downgrade: bool = False,
) -> None:
    if not force_downgrade and _contains_destructive_ddl(migration.down_sql):
        raise DowngradeRefusedError(
            f"apply_downgrade({migration.version!r}) refused — down_sql contains "
            f"destructive DDL; pass force_downgrade=True to acknowledge data loss "
            f"is irreversible"
        )
    for stmt in migration.down_sql:
        dataflow.execute_raw(stmt)

# DO NOT — Python: run destructive down_sql by default
def apply_downgrade(self, migration: Migration, dataflow: DataFlow) -> None:
    for stmt in migration.down_sql:
        dataflow.execute_raw(stmt)  # DROP TABLE just ran
```

```rust
// DO — Rust: explicit confirmation on the rollback API
pub async fn rollback(
    &self,
    version: &str,
    dataflow: &DataFlow,
    force_downgrade: bool,
) -> Result<(), DataFlowError> {
    let down_sql = self.load_down_sql(version, dataflow).await?;
    if !force_downgrade && contains_destructive_ddl(&down_sql) {
        return Err(DataFlowError::DowngradeRefused(format!(
            "rollback({version:?}) refused — down_sql contains destructive DDL; \
             pass force_downgrade=true to acknowledge data loss is irreversible"
        )));
    }
    for stmt in &down_sql { dataflow.execute_raw(stmt).await?; }
    Ok(())
}

// DO NOT — Rust: run destructive down_sql by default
pub async fn rollback(&self, version: &str, dataflow: &DataFlow) -> Result<(), DataFlowError> {
    let down_sql = self.load_down_sql(version, dataflow).await?;
    for stmt in &down_sql { dataflow.execute_raw(stmt).await?; }  // DROP TABLE just ran
    Ok(())
}
```

### Why — Extended

Dropped data is unrecoverable and the downgrade surface is strictly wider than the individual DROP primitive — a single `rollback("0042")` call can execute dozens of destructive statements in one transaction before the operator notices. The primitive-layer `force_drop` flag (mandated by `dataflow-identifier-safety.md` MUST Rule 4) does nothing for an orchestrator that replays persisted `down_sql` strings, because the orchestrator is the caller and the flag was already checked against a literal API at upgrade-generation time. Requiring the flag at every layer that can touch destructive DDL is the only structural defense against "I meant to roll back the schema, not destroy the data" incidents.

Test suites requiring rollback MUST pass `force_downgrade=True` explicitly — the test's intent is exactly what the flag is for.

**Layering:** the identifier helper guards the DDL-primitive layer (`force_drop`); this rule guards the migration-orchestrator layer above it (`force_downgrade`). Both layers MUST gate independently; the flag does NOT flow through.

Origin: 2026-04-19 codify cycle — destructive migration paths landed without downgrade-surface confirmation flags despite the primitive-layer `force_drop` guard existing in `dataflow-identifier-safety.md` since 2026-04-12.

## Rule 8 — New `@db.model` Field On An Existing Table: Full Paired-Artifact Example

```python
# DO — new field on an existing @db.model lands all three paired artifacts, same PR
@db.model
class ApprovalRecord:
    id: int = field(primary_key=True)
    approver_id: str          # ← NEW field on an existing table
# + migrations/0044_add_approvalrecord_approver_id.py:
#     "ALTER TABLE approval_records ADD COLUMN IF NOT EXISTS approver_id TEXT"
# + regenerated field-classification metadata (approver_id classified)
# + manifest field-count bumped (N → N+1)

# DO NOT — add the field to the model only, rely on create_tables()
@db.model
class ApprovalRecord:
    id: int = field(primary_key=True)
    approver_id: str          # model has it; create_tables() no-ops on the existing table
# tests pass (fresh test schema HAS the column); production reads/writes approver_id against a
# table that never got the column → runtime error on every already-migrated database
```

### Why — Extended

`create_tables()`'s `CREATE TABLE IF NOT EXISTS` semantics make a model-only field addition CI-invisible — the fresh-created test schema always has the new column, so every test passes, while every already-migrated database (production, staging, any long-lived DB) never receives it and errors at first read/write of the field. The `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration is the only artifact that reaches existing tables; the field-classification regen keeps the new field inside the tenant/security-classification contract instead of silently unclassified; the manifest-count bump keeps the pinned field-set assertion honest. All three are one atomic change — splitting them ships a half-migrated schema.

### Origin — Full Narrative

`kailash-coc-rs` USE-template proposal — schema-migration approver-identity lesson (2026-07-21). A new `approver_id`-class field added to an existing `@db.model` table was CI-invisible: `create_tables()` (`CREATE TABLE IF NOT EXISTS`) no-ops on the already-existing table, so the fresh-created test schema carried the column and CI passed while already-migrated databases never received it; the paired `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration, the field-classification regeneration, and the manifest-count bump were all omitted. Landed at loom via `/sync-from-use` Gate-1 classification.
