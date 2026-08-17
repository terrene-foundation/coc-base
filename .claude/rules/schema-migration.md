---
priority: 10
scope: path-scoped
paths:
  - "**/migrations/**"
  - "**/db/**"
  - "**/*.sql"
  - "**/models.py"
  - "**/schema.py"
  - "**/dataflow/**"
  - "**/*.py"
  - "**/*.rb"
---

# Schema & Data Migration Rules

<!-- slot:neutral-body -->

The schema is the contract between code and data. Every change to that contract MUST go through a numbered, reviewable, reversible migration. Direct DDL and ad-hoc data fixes are how schemas drift from code, and how production silently breaks.

Full worked DO/DO-NOT code per clause, the cross-language `force_downgrade` signatures, the evidence chains, and the per-rule origin narratives live in `guides/rule-extracts/schema-migration.md`. A copy-pasteable migration scaffold lives in `skills/02-dataflow/migration-scaffold.md`, which is **kailash tier** — delivered only to Kailash-subscribing targets, absent at a stack-agnostic base template (`sync-manifest.yaml` § cc tier: "Do NOT host a coc-core rule's depth under a NARROWER tier"). This file holds the load-bearing MUST / MUST NOT clauses, their `**Why:**` lines, and their BLOCKED corpora.

## MUST Rules

### 1. All Schema Changes Through Numbered Migrations

`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, and any other DDL MUST live in a numbered migration file managed by the project's migration framework (DataFlow auto-migrate, Alembic, ActiveRecord, sqlx, etc.). DDL string literals in **application code** are BLOCKED outside of migration files.

**Scope clarification:** "Application code" means services, controllers, handlers, models, and rake/management tasks. DDL is permitted in: (a) numbered migration files, (b) the SDK's own dialect helper layer (BUILD repos only — downstream USE projects do not have a dialect helper layer), and (c) test fixtures that create and tear down test schemas.

```text
# DO — `@db.model` drives auto-migration (schema lives in code), or an explicit numbered `migrations/0042_add_user_email_index.py`
# DO NOT — a DDL string executed from application code: `await conn.execute("ALTER TABLE users ADD COLUMN email TEXT")`
```

**Why:** DDL outside the migration framework runs once on whichever environment the agent happens to touch and never on the others. The schemas drift, the next deploy fails on the un-migrated environment, and the failure looks like a code bug because the migration was never recorded. Full code: `guides/rule-extracts/schema-migration.md` § "Rule 1".

#### 1a. /redteam MUST Grep For Inline DDL Outside Migrations

`/redteam` mechanical sweep MUST scan every package source tree for DDL string literals (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `ALTER INDEX`, `CREATE SCHEMA`, `DROP SCHEMA`) appearing OUTSIDE the migration framework's directories (`migrations/`, `src/**/migrations/**`, dialect helper layers in BUILD repos, test fixtures). Any hit is a Rule 1 violation and BLOCKS the redteam round until resolved.

```bash
# DO — /redteam includes the grep audit explicitly
grep -RInE 'CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|SCHEMA)|ALTER\s+(TABLE|INDEX)|DROP\s+(TABLE|SCHEMA|INDEX)' \
    --include='*.py' --include='*.rs' --include='*.rb' -- packages/ src/ \
    | grep -vE '/(migrations|tests/fixtures|dialect)/'
# Exit 0 with no matches = clean. Any match = Rule 1 violation.
# DO NOT — rely on the rule statement alone; with no /redteam grep enforcing it, violations land silently and ship.
```

**BLOCKED rationalizations:**

- "The migration framework auto-detects schema drift, the grep is redundant"
- "We'd notice if someone added inline DDL in code review"
- "The pre-commit hook covers it" (only if the hook runs the same grep — if not, BLOCKED)
- "False positives on `CREATE TABLE` in docstrings make the grep noisy" (filter docstrings via `--include` patterns; do NOT silence the audit)
- "The dialect helper layer has DDL by design" (whitelisted via the path-exclusion clause; everything else stays in scope)
- "We'll add the grep next cycle once the false-positive baseline is captured"

**Why:** A rule that says "X is BLOCKED" with no mechanical sweep ships violations indefinitely, and three-way schema drift (spec ↔ migration ↔ inline DDL) is invisible at code-review level because the reviewer cannot hold all three artifacts in attention at once. The grep is O(seconds) and surfaces every inline-DDL site in one pass. Evidence chain + Origin (kailash-ml 1.5.x followup #699, 2026-04-29 — an `IF NOT EXISTS` no-op masked a 3-month column-set divergence): `guides/rule-extracts/schema-migration.md` § "Rule 1a".

### 2. Data Fixes Are Migrations, Not One-Off SQL

If runtime data needs to be corrected (backfills, reclassifications, deduplication), the fix MUST be a numbered migration with the same review and rollback discipline as schema changes. Ad-hoc `INSERT` / `UPDATE` / `DELETE` statements run against production are BLOCKED.

```text
# DO — the backfill IS a numbered migration (`migrations/0043_backfill_user_signup_source.py`) with a real `upgrade()` AND an inverse `downgrade()`
# DO NOT — hotfix SQL in a notebook, ticket comment, or one-off script: `psql> UPDATE users SET signup_source = 'organic' WHERE signup_source IS NULL;`
```

**Why:** A hotfix run by hand has no record, no rollback, and no audit trail. The next environment never gets the same fix, and six months later the team cannot reconstruct why production rows differ from staging. Full code: `guides/rule-extracts/schema-migration.md` § "Rule 2".

### 3. Every Migration Has a Reversible Path

`upgrade()` MUST have a corresponding `downgrade()` that returns the schema to its prior state. Migrations marked irreversible (e.g., destructive column drops with no preserved data) MUST be flagged in code and require explicit human acknowledgement before running.

```text
# DO — `upgrade()` adds the column; `downgrade()` drops exactly that column, returning the schema to its prior state
# DO NOT — silent irreversibility: `upgrade()` runs `DROP TABLE archived_events` while `downgrade()` is `pass  # placeholder` (data gone, no path back, no warning)
```

**Why:** Migrations are deployed, and deployed code rolls back. Without `downgrade()`, a failed deploy cannot return to a known-good schema and the system is stuck mid-migration with neither old nor new code able to run. Full code: `guides/rule-extracts/schema-migration.md` § "Rule 3".

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

```text
# DO — guard first: `if not force_downgrade and _contains_destructive_ddl(migration.down_sql): raise DowngradeRefusedError(...)` (Rust: `return Err(DataFlowError::DowngradeRefused(...))`), THEN replay down_sql
# DO NOT — omit the flag and loop `dataflow.execute_raw(stmt)` over stored down_sql by default; the DROP TABLE just ran
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

**Why:** Dropped data is unrecoverable and the downgrade surface is strictly wider than the individual DROP primitive — one `rollback("0042")` can execute dozens of destructive statements in a single transaction before the operator notices, and the primitive-layer `force_drop` flag does nothing for an orchestrator replaying persisted `down_sql` (it is the caller). Gating at every layer that can touch destructive DDL is the only structural defense; test suites needing rollback MUST pass `force_downgrade=True` explicitly, which is exactly the flag's purpose. Dual-language signatures + layering detail + Origin (2026-04-19 codify cycle): `guides/rule-extracts/schema-migration.md` § "Rule 7".

### 8. A New `@db.model` Field On An Existing Table Needs The FULL Paired-Artifact Set

Adding a field to an EXISTING `@db.model` (a table that already exists in every already-migrated database) is NOT complete when the field is added to the model class alone. Because DataFlow's `create_tables()` is `CREATE TABLE IF NOT EXISTS`, it NO-OPS on a table that already exists — so the new column is NEVER added to any pre-existing table, and the test suite (which creates its schema fresh, so the column IS present in the test DB) passes while production and every already-migrated database silently lack the column. The ADD is CI-invisible. A new field on an existing table MUST land the FULL paired-artifact set in the SAME PR:

1. **`ALTER TABLE ... ADD COLUMN IF NOT EXISTS <col> ...`** — a numbered migration (Rule 1) that actually adds the column to already-existing tables (fresh-create via `create_tables()` covers only new databases).
2. **Field-classification regeneration** — regenerate the model's field-classification metadata (tenant/security/redaction classification) so the new field is classified, not silently unclassified.
3. **Manifest-count bump** — increment the field-count / schema manifest that pins the model's field set, so the count-assertion and the model agree.

```text
# DO — the new `approver_id` field on an existing `@db.model` ships with ALL THREE: the numbered `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration + regenerated field-classification metadata + the bumped manifest field-count, same PR
# DO NOT — add the field to the model only and rely on `create_tables()`; tests pass on the fresh test schema while every already-migrated database errors at first read/write of the column
```

**BLOCKED rationalizations:**

- "`create_tables()` will add the column" (it is `CREATE IF NOT EXISTS` — it no-ops on an existing table; only a fresh DB gets the column)
- "Tests are green, the field is wired" (the test DB is fresh-created, so it HAS the column; existing DBs do not — CI-invisible)
- "The migration can follow in the next PR" (production is broken between the two PRs; the ALTER is part of the same change)
- "Field classification / the manifest count are bookkeeping, not blocking" (an unclassified new field bypasses the tenant/redaction contract; a stale manifest count reds the count-assertion)
- "It's one new field, the paired artifacts are overkill"

**Why:** `create_tables()`'s `CREATE IF NOT EXISTS` semantics make a model-only field addition CI-invisible — the fresh test schema always has the new column so every test passes, while every already-migrated database never receives it and errors at first read/write. Only the `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration reaches existing tables, the classification regen keeps the field inside the tenant/security contract, and the count bump keeps the pinned field-set assertion honest — one atomic change, because splitting them ships a half-migrated schema. Full paired-artifact example: `guides/rule-extracts/schema-migration.md` § "Rule 8".

**Trust Posture Wiring (Rule 8):**

- **Severity:** `halt-and-report` at gate-review (reviewer + dataflow-specialist at `/implement` + cc-architect at `/codify` confirm any new field on an existing `@db.model` landed the `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration AND the field-classification regen AND the manifest-count bump in the same PR — not a model-only addition relying on `create_tables()`); `advisory` at the hook layer (per `hook-output-discipline.md` MUST-2 the paired-artifact-completeness property is judgment-bearing over cross-file state, not a structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-21 → 2026-07-28).
- **Cumulative posture impact:** same-class violations (a new field on an existing table shipped as a model-only change without the paired ALTER migration / classification regen / manifest bump) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key (a paired-artifact-completeness property is review-layer-only, and minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — same disposition as `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge.
- **Receipt requirement:** SessionStart soft-gate `[ack: schema-migration]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any diff adding a field to an existing `@db.model`, reviewer + dataflow-specialist confirm the same PR carries (a) a numbered `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration reaching existing tables, (b) regenerated field-classification metadata for the new field, (c) the incremented manifest field-count; a model-only addition relying on `create_tables()` is a finding. Probes `.claude/test-harness/probes/schema-migration.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/schema-add-column-paired-artifacts/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 8 (new-field-on-existing-`@db.model` paired-artifact set) ONLY; Rules 1–7 stay grandfathered until each is itself `/codify`-touched.
- **Origin:** See Rule 8 Origin below.

Origin: `kailash-coc-rs` USE-template proposal — schema-migration approver-identity lesson (2026-07-21). A new `approver_id`-class field on an existing `@db.model` table was CI-invisible; the paired ALTER migration, the field-classification regen, and the manifest-count bump were all omitted. Landed at loom via `/sync-from-use` Gate-1 classification. Full narrative: `guides/rule-extracts/schema-migration.md` § "Rule 8 → Origin".

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

Siblings marked **(kailash tier)** are delivered only to Kailash-subscribing targets; a stack-agnostic base template does not receive them, so treat those as upstream context rather than a local file.

- `rules/infrastructure-sql.md` **(kailash tier)** covers query safety (parameterization, dialect portability) inside both application code and migrations.
- `rules/dataflow-identifier-safety.md` **(kailash tier)** MUST Rule 4 (DROP Statements Require Explicit Confirmation) — sibling rule at the **primitive-DDL layer** for § 7 above. The primitive-layer flag is `force_drop` and guards individual DROP statements; the orchestrator-layer flag is `force_downgrade` and guards `apply_downgrade()` / `rollback()` calls that replay stored `down_sql`. Both layers MUST gate independently; the flag does NOT flow through.
- `rules/zero-tolerance.md` Rule 4 (No Workarounds for Core SDK Issues) — if DataFlow's auto-migration is missing a feature, or if `MigrationManager.apply_downgrade` / `rollback` is missing the `force_downgrade` parameter, fix the SDK API; do not write raw DDL or inline `down_sql` execution around it.
- `rules/zero-tolerance.md` Rule 2 (No Stubs) — a `force_downgrade` parameter that is accepted but never checked is a fake safety gate and BLOCKED under the "fake classification / fake encryption" pattern.
- `rules/framework-first.md` **(kailash tier)** — DataFlow's `@db.model` is the highest-abstraction migration path for Kailash apps. Drop to a primitive migration framework only when the model layer cannot express the change.

<!-- /slot:neutral-body -->
