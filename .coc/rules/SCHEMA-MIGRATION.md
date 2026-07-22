---
id: "SCHEMA-MIGRATION"
paths: ["**/migrations/**", "**/db/**", "**/*.sql", "**/models.py", "**/schema.py", "**/dataflow/**", "**/*.py", "**/*.rb"]
---

# Schema & Data Migration Rules

The schema is the contract between code and data. Every change to that contract MUST go through a numbered, reviewable, reversible migration. Direct DDL and ad-hoc data fixes are how schemas drift from code, and how production silently breaks.

## MUST Rules

### 1. All Schema Changes Through Numbered Migrations

`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, and any other DDL MUST live in a numbered migration file managed by the project's migration framework (DataFlow auto-migrate, Alembic, ActiveRecord, sqlx, etc.). DDL string literals in **application code** are BLOCKED outside of migration files.

**Scope clarification:** "Application code" means services, controllers, handlers, models, and rake/management tasks. DDL is permitted in: (a) numbered migration files, (b) the SDK's own dialect helper layer (BUILD repos only — downstream USE projects do not have a dialect helper layer), and (c) test fixtures that create and tear down test schemas.

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

**Why:** DDL outside the migration framework runs once on whichever environment the agent happens to touch and never on the others. The schemas drift, the next deploy fails on the un-migrated environment, and the failure looks like a code bug because the migration was never recorded.

#### 1a. /redteam MUST Grep For Inline DDL Outside Migrations

`/redteam` mechanical sweep MUST scan every package source tree for DDL string literals (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `ALTER INDEX`, `CREATE SCHEMA`, `DROP SCHEMA`) appearing OUTSIDE the migration framework's directories (`migrations/`, `src/**/migrations/**`, dialect helper layers in BUILD repos, test fixtures). Any hit is a Rule 1 violation and BLOCKS the redteam round until resolved.

```bash
# DO — /redteam includes the grep audit explicitly
grep -RInE 'CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|SCHEMA)|ALTER\s+(TABLE|INDEX)|DROP\s+(TABLE|SCHEMA|INDEX)' \
    --include='*.py' --include='*.rs' --include='*.rb' \
    -- packages/ src/ \
    | grep -vE '/(migrations|tests/fixtures|dialect)/'
# Exit 0 with no matches = clean. Any match = Rule 1 violation.

# DO NOT — rely on the rule statement alone, without a mechanical sweep
# (rule says "DDL outside migrations is BLOCKED" but no /redteam grep enforces it,
# so violations land silently and ship to production)
```

**BLOCKED rationalizations:**

- "The migration framework auto-detects schema drift, the grep is redundant"
- "We'd notice if someone added inline DDL in code review"
- "The pre-commit hook covers it" (only if the hook runs the same grep — if not, BLOCKED)
- "False positives on `CREATE TABLE` in docstrings make the grep noisy" (filter docstrings via `--include` patterns; do NOT silence the audit)
- "The dialect helper layer has DDL by design" (whitelisted via the path-exclusion clause; everything else stays in scope)
- "We'll add the grep next cycle once the false-positive baseline is captured"

**Why:** A rule that says "X is BLOCKED" with no mechanical sweep ships violations indefinitely. The grep is O(seconds) and catches the failure mode the rule was written to prevent. Three-way schema drift (spec ↔ migration ↔ inline DDL in application code) is invisible at code-review level because the reviewer cannot hold all three artifacts in attention at once; the grep surfaces every inline-DDL site in one pass and the migration cross-check follows from there. Evidence: a registry's `_create_registry_tables()` shipped `CREATE TABLE IF NOT EXISTS _kml_model_versions` for ~3 months while migration 0002 owned the same table with a different column-set; the IF NOT EXISTS no-op masked the divergence until a user hit a missing-column query path.

Origin: kailash-ml 1.5.x followup #699 (2026-04-29) — three-way schema-drift discovery (spec ↔ migration ↔ inline DDL) mandating a migration.

### 2. Data Fixes Are Migrations, Not One-Off SQL

If runtime data needs to be corrected (backfills, reclassifications, deduplication), the fix MUST be a numbered migration with the same review and rollback discipline as schema changes. Ad-hoc `INSERT` / `UPDATE` / `DELETE` statements run against production are BLOCKED.

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

**Why:** A hotfix run by hand has no record, no rollback, and no audit trail. The next environment never gets the same fix, and six months later the team cannot reconstruct why production rows differ from staging.

### 3. Every Migration Has a Reversible Path

`upgrade()` MUST have a corresponding `downgrade()` that returns the schema to its prior state. Migrations marked irreversible (e.g., destructive column drops with no preserved data) MUST be flagged in code and require explicit human acknowledgement before running.

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

**Why:** Migrations are deployed, and deployed code rolls back. Without `downgrade()`, a failed deploy cannot return to a known-good schema and the system is stuck mid-migration with neither old nor new code able to run.

### 4. Migration Files Are Append-Only

Once a migration file is committed to a shared branch, it MUST NOT be edited. Mistakes are corrected by adding a new migration that reverses or supersedes the prior one.

**Why:** Editing a committed migration file means environments that already ran it have a different schema than environments that run the edited version, and the framework's "this migration ran" tracking lies. The drift is undetectable until something breaks.

### 5. Test the Migration on Real Schema, Not :memory:

Migration tests MUST run against a copy of the production schema dialect (PostgreSQL → PostgreSQL test instance, MySQL → MySQL test instance). `sqlite:///:memory:` is acceptable for unit tests but NOT for migration validation.

**Why:** PostgreSQL and SQLite accept different DDL — `BLOB` vs `BYTEA`, `AUTOINCREMENT` vs `SERIAL`, `IF NOT EXISTS` quirks. A migration that passes against SQLite can syntax-error against production PostgreSQL on first deploy.

### 6. Production Schema Sync Is a Deploy Gate

`/deploy` MUST verify the production migration head matches the code's expected migration head before publishing the new bundle. If they diverge, deploy STOPS until the migrations are reconciled. This check MUST be declared as a gate in `deploy/deployment-config.md` (see `deploy-hygiene.md` § "Pre-deploy gates run before every deploy").

**Why:** Code that assumes a column exists, deployed against a database where the column does not exist yet, throws on first request. The deploy command returns 0; the application is broken; users see errors. Same failure class as `deploy-hygiene.md` § "Verify deploy state before stacking more production commits".

### 7. Destructive Downgrades Require `force_downgrade=True`

Every migration path that runs destructive DDL or irreversible data transforms — `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `TRUNCATE`, rollback of an upgrade whose `down_sql` deletes data, or any downgrade that cannot round-trip the original row values — MUST require an explicit `force_downgrade=True` flag on the calling API. The default MUST be to refuse with a typed error. This is the migration-orchestrator-layer sibling of `dataflow-identifier-safety.md` MUST Rule 4 (DROP Statements Require Explicit Confirmation): the identifier helper guards the DDL-primitive layer (`force_drop`); this rule guards the migration-orchestrator layer above it (`force_downgrade`).

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

**BLOCKED rationalizations:**

- "The table is empty, the downgrade is harmless"
- "This is the dev environment, there's nothing to lose"
- "CI only runs this path, production never sees it"
- "We'll add the flag later once the API stabilizes"
- "The developer just ran the upgrade seconds ago, they obviously want to undo it"
- "The tests need to roll back, requiring a flag breaks the test suite"
- "The down_sql was generated by the framework, it's trusted"
- "`force_drop` on the primitive layer is enough, the orchestrator doesn't need its own flag"

**Why:** Dropped data is unrecoverable and the downgrade surface is strictly wider than the individual DROP primitive — a single `rollback("0042")` call can execute dozens of destructive statements in one transaction before the operator notices. The primitive-layer `force_drop` flag (mandated by `dataflow-identifier-safety.md` MUST Rule 4) does nothing for an orchestrator that replays persisted `down_sql` strings, because the orchestrator is the caller and the flag was already checked against a literal API at upgrade-generation time. Requiring the flag at every layer that can touch destructive DDL is the only structural defense against "I meant to roll back the schema, not destroy the data" incidents. Test suites requiring rollback MUST pass `force_downgrade=True` explicitly — the test's intent is exactly what the flag is for.

Origin: 2026-04-19 codify cycle — destructive migration paths landed without downgrade-surface confirmation flags despite the primitive-layer `force_drop` guard existing in `dataflow-identifier-safety.md` since 2026-04-12.

## MUST NOT

- **No "I'll write the migration later" data fixes.** If you change runtime data, you write the migration in the same commit. Period.

**Why:** "Later" means a different session, a different agent, and a high probability of "later" never arriving — the production environment stays patched-by-hand and the staging environment doesn't match.

- **No raw SQL in application code as a workaround for missing schema.** If the schema doesn't have the column you need, add a migration. Do not coerce the data with a runtime SQL hack.

**Why:** Runtime SQL hacks calcify into "the way it works" and the missing schema column never gets added. Two years later, every read of that table has a CASE WHEN around the missing column.

- **No `DROP` of a table or column without a preserved-data plan.** Either back the data up to a parking table within the same migration, or explicitly mark the migration as destructive and require human acknowledgement.

**Why:** Dropped data is unrecoverable, and a one-line migration mistake during refactor has wiped years of customer history more than once.

- **No bypassing the migration framework via `psql` / `mysql` / `sqlite3` shells against production.** All DDL goes through the framework, every time, no exceptions for "just one quick fix".

**Why:** The framework's tracking table is the only ground truth for which migrations have run. Manual DDL leaves the table out of sync, and the next automated migration either re-runs or skips changes incorrectly.

## Relationship to Other Rules

- `rules/infrastructure-sql.md` covers query safety (parameterization, dialect portability) inside both application code and migrations.
- `rules/dataflow-identifier-safety.md` MUST Rule 4 (DROP Statements Require Explicit Confirmation) — sibling rule at the **primitive-DDL layer** for § 7 above. The primitive-layer flag is `force_drop` and guards individual DROP statements; the orchestrator-layer flag is `force_downgrade` and guards `apply_downgrade()` / `rollback()` calls that replay stored `down_sql`. Both layers MUST gate independently; the flag does NOT flow through.
- `rules/zero-tolerance.md` Rule 4 (No Workarounds for Core SDK Issues) — if DataFlow's auto-migration is missing a feature, or if `MigrationManager.apply_downgrade` / `rollback` is missing the `force_downgrade` parameter, fix the SDK API; do not write raw DDL or inline `down_sql` execution around it.
- `rules/zero-tolerance.md` Rule 2 (No Stubs) — a `force_downgrade` parameter that is accepted but never checked is a fake safety gate and BLOCKED under the "fake classification / fake encryption" pattern.
- `rules/framework-first.md` — DataFlow's `@db.model` is the highest-abstraction migration path for Kailash apps. Drop to a primitive migration framework only when the model layer cannot express the change.
