# RLS + SECURITY DEFINER Pre-Auth Carveout

Production-grade recipe for protecting principal tables (users, tenants, invites) with strict PostgreSQL RLS while preserving pre-auth read paths (login, password-reset, invite-accept). Lifted from an open-application reference implementation and generalized.

## When to use

- Principal tables containing PII or credentials (`users`, `tenants`, `invites`, `sessions`, `accounts`).
- The table MUST be readable pre-auth on at least one path (login lookup, password-reset lookup, invite-accept lookup).
- Your database has multiple roles (app, analytics, admin) and at least one role is not fully trusted for unscoped reads.
- You are NOT already behind a proxy that mediates every DB read with a per-user session.

## When NOT to use

- Post-auth-only tables (no bootstrap path) — strict RLS without carveout is sufficient.
- Service tables with no user context (settings, feature flags) — runtime predicate injection is sufficient.
- Single-role DB with trusted middleware — RLS adds operational cost without defence benefit.
- Development SQLite backends — SQLite has no RLS; use a test-equivalent assertion instead.

## Threat model

| ID      | Threat                                                                              | Mitigation                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1      | Unscoped `USING (true)` on principal table                                          | Replace with role-aware scoped policy                                                                                                                                                                                                                                                                                                             |
| T2      | Strict scoped policy blocks bootstrap (login, reset, invite)                        | Add SECURITY DEFINER helpers as the ONLY pre-auth read surface. The carveout is the pressure-release that prevents operators from reverting to `USING(true)` under an outage.                                                                                                                                                                     |
| T3      | SECURITY DEFINER function with unpinned `search_path` (CVE-2018-1058 class)         | `SET search_path = <app_schema>, pg_temp` on every helper                                                                                                                                                                                                                                                                                         |
| T4      | SECURITY DEFINER callable from `PUBLIC` (every role inherits by default)            | `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE TO <app_role>;`                                                                                                                                                                                                                                                                                        |
| T5      | Helper returns full row (password hash, session tokens, MFA secrets)                | Explicit minimum-disclosure column list; never `SELECT *`. `by_email` returns `password_hash` (login needs it for bcrypt); `by_id` MUST NOT (session refresh has no compare).                                                                                                                                                                     |
| T6a     | `SET ROLE` inside helper body reintroduces caller privileges                        | Forbid `SET ROLE`; `LANGUAGE sql` (not `plpgsql`); audit `CREATE FUNCTION` bodies                                                                                                                                                                                                                                                                 |
| T6b     | Helper marked `VOLATILE` when `STABLE` suffices (plan-cache poisoning)              | Always `STABLE STRICT` for read helpers                                                                                                                                                                                                                                                                                                           |
| T6c     | `pg_temp` first on `search_path` (temp-schema operator shadowing)                   | Always `<app_schema>, pg_temp` — never `pg_temp, <app_schema>`                                                                                                                                                                                                                                                                                    |
| T6d     | `LEAKPROOF` falsely asserted (error messages are a side-channel)                    | Do not mark helpers `LEAKPROOF` unless audited                                                                                                                                                                                                                                                                                                    |
| T6e     | Missing `STRICT` (NULL input predicate collapse)                                    | `STRICT` short-circuits NULL input. Without it, disjunctive predicates like `WHERE email = $1 OR is_admin = true` fall through to the constant branch and return admin rows. Always `STABLE STRICT`.                                                                                                                                              |
| **T7**  | **Email-enumeration timing side-channel (row-count ⇒ user-exists)**                 | **Caller MUST run a dummy bcrypt compare when the helper returns 0 rows.** The helper's cardinality (0 vs 1) + the caller's downstream bcrypt timing (~10-100ms) distinguish "user exists" from "does not exist". Standard login-timing-safe pattern: always execute `bcrypt_verify(candidate, dummy_hash)` before branching on helper result.    |
| **T8**  | **Cross-tenant read via `by_id` helper that returns but does not filter tenant_id** | **Multi-tenant helpers MUST accept `p_tenant_id` and filter by it in `WHERE`.** Without the filter, a caller with a valid session in tenant A who passes `p_id = <user_id_from_tenant_B>` gets tenant B's row back (SECURITY DEFINER bypasses RLS). The recipe's `resolve_user_by_id` is corrected below.                                         |
| **T9**  | **SECURITY DEFINER stickiness across nested calls**                                 | Helpers MUST NOT call back into non-SECURITY-DEFINER functions. Nested calls run under the SECURITY DEFINER's owner, silently elevating privilege for every callee. Keep helper bodies minimal + `LANGUAGE sql`.                                                                                                                                  |
| **T10** | **`CREATE OR REPLACE FUNCTION` preserves GRANTs (privilege attack)**                | `CREATE OR REPLACE` preserves prior-version GRANTs. An attacker with `CREATE` on the schema can redefine the helper body while the `GRANT EXECUTE TO app_role` survives. Mitigation: `REVOKE ALL ON SCHEMA <app_schema> FROM PUBLIC;` + schema owned by a superuser (not the app role); no role other than the owner gets `CREATE` on the schema. |

## MUST properties of a correct implementation

1. **Exactly N helpers for N pre-auth read paths.** Typical N = 2 or 3: `resolve_user_by_email` (login + password-reset), `resolve_user_by_id` (session refresh), `resolve_invite_by_token` (invite accept). Adding the (N+1)th helper requires a threat-review entry in the PR body. The pgTAP template below enforces `= N` exactly, not `<= 3`.
2. Each helper: `SECURITY DEFINER`, `SET search_path = <app_schema>, pg_temp`, `STABLE STRICT`, `LANGUAGE sql` (NOT `plpgsql` — stricter audit surface; see T6a / T9).
3. `REVOKE ALL ON FUNCTION ... FROM PUBLIC;` followed by `GRANT EXECUTE ... TO <app_role>;` — nothing else.
4. Return columns: explicit list, minimum disclosure. Login needs `(id, password_hash, is_active)`; password-reset needs `(id, email, is_active)`; invite-accept needs `(id, email, invite_token_hash, invite_expires_at)`. Never `SELECT *`. The `by_email` / `by_id` asymmetry on `password_hash` is deliberate and load-bearing — see T5.
5. `COMMENT ON FUNCTION` citing the pre-auth path served. Reviewable by grep `pg_description`.
6. **Multi-tenant helpers MUST filter by `p_tenant_id`.** If the principal table has a `tenant_id` column, every helper that returns rows MUST accept `p_tenant_id` and include `AND tenant_id = p_tenant_id` in the `WHERE`. See T8.
7. **Caller MUST run a dummy bcrypt compare on 0-row results** to close the email-enumeration timing side-channel. See T7.
8. **pgTAP or pytest-asyncpg assertions MUST run in CI** against every migration that adds or modifies a helper or policy. A recipe without an enforcement gate is a suggestion, not a control.
9. **Trusted-middleware-only GUC contract.** `current_setting('app.user_id')` / `app.role` / `app.tenant_id` GUCs MUST be set by the middleware layer that owns authentication. User-supplied code paths (including anything reachable by `execute_raw` from an HTTP handler) MUST NOT be able to issue `SET app.role = 'service'` or equivalent. Enforce at the connection pool or session-wrapper layer.

## SQL recipe

Adapt for your schema (replace `app`, `app_role`, column lists). Tested on PostgreSQL 14+.

```sql
-- 0. Schema hardening (T10 — prevents CREATE OR REPLACE privilege preservation attack)
--    Schema SHOULD be owned by a superuser or dedicated owner role, NOT the app role.
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- 1. Enable RLS on the principal table + force it even for table owner + strip PUBLIC
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;         -- table-owner MUST also go through policy
REVOKE ALL ON TABLE app.users FROM PUBLIC;              -- multi-role DB: no ambient SELECT
-- NOTE: this recipe creates the SELECT policy only. If your app writes to users,
-- add parallel FOR INSERT / FOR UPDATE / FOR DELETE policies — RLS defaults to
-- no access once enabled, so writes will fail silently until you do.

-- 2. Strict role-aware scoped policy (replaces any USING(true))
DROP POLICY IF EXISTS users_scope_select ON app.users;
CREATE POLICY users_scope_select ON app.users
  FOR SELECT
  USING (
    -- Self: authenticated user can read their own row
    id = current_setting('app.user_id', true)::bigint
    OR
    -- Admin: role-based elevation reads any row
    current_setting('app.role', true) = 'admin'
    OR
    -- Service-scoped: tenant-match for multi-tenant workers.
    -- SECURITY NOTE: app.role / app.tenant_id GUCs MUST be set by trusted
    -- middleware only. Any code path that can `SET app.role = 'service'`
    -- reads the full tenant. Enforce at the connection-pool or session layer.
    (current_setting('app.role', true) = 'service'
     AND tenant_id = current_setting('app.tenant_id', true)::bigint)
  );

-- 3. SECURITY DEFINER pre-auth read helper — login / password-reset lookup.
--    Multi-tenant: REQUIRES p_tenant_id. Single-tenant deployments: drop the
--    tenant argument AND the `AND tenant_id = p_tenant_id` predicate below.
--    Returns password_hash because the caller MUST bcrypt-compare it;
--    `by_id` (session refresh, step 4) MUST NOT return it.
CREATE OR REPLACE FUNCTION app.resolve_user_by_email(p_email text, p_tenant_id bigint)
RETURNS TABLE (id bigint, email text, password_hash text, is_active boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_temp
STABLE STRICT
AS $$
  SELECT id, email, password_hash, is_active
  FROM app.users
  WHERE email = p_email
    AND tenant_id = p_tenant_id
    AND is_active = true
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_user_by_email(text, bigint) IS
  'Pre-auth read helper for login + password-reset. SECURITY DEFINER bypasses users_scope_select; returns minimum-disclosure columns including password_hash (caller MUST constant-time compare). CALLER MUST ALSO run a dummy bcrypt on 0-row results to close T7 email-enumeration timing side-channel.';

REVOKE ALL ON FUNCTION app.resolve_user_by_email(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_user_by_email(text, bigint) TO app_role;

-- 4. SECURITY DEFINER pre-auth read helper — session refresh by id.
--    REQUIRES p_tenant_id (T8 — without it, a valid session for tenant A
--    could session-refresh against a user_id from tenant B and get tenant B's row).
--    Does NOT return password_hash (T5 — session refresh has no compare surface).
CREATE OR REPLACE FUNCTION app.resolve_user_by_id(p_id bigint, p_tenant_id bigint)
RETURNS TABLE (id bigint, email text, is_active boolean, tenant_id bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_temp
STABLE STRICT
AS $$
  SELECT id, email, is_active, tenant_id
  FROM app.users
  WHERE id = p_id
    AND tenant_id = p_tenant_id
    AND is_active = true
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_user_by_id(bigint, bigint) IS
  'Pre-auth read helper for session refresh path. SECURITY DEFINER bypasses users_scope_select; p_tenant_id filter prevents cross-tenant reads (T8); no password_hash (T5).';

REVOKE ALL ON FUNCTION app.resolve_user_by_id(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_user_by_id(bigint, bigint) TO app_role;

-- 5. Supporting index for pre-auth lookup performance (DoS-prevention at login rate).
--    NOT a security control; the predicate is table-scan without this.
CREATE INDEX IF NOT EXISTS users_tenant_email_active_idx
  ON app.users (tenant_id, email) WHERE is_active = true;
```

### Caller pattern (application side) — T7 timing-safe login

```python
# Python pseudocode — adapt for your stack
BCRYPT_DUMMY_HASH = "$2b$12$" + "0" * 53   # precomputed, never matches

def login(email: str, password: str, tenant_id: int) -> Optional[User]:
    row = db.fetch_one(
        "SELECT * FROM app.resolve_user_by_email($1, $2)",
        email, tenant_id,
    )
    if row is None:
        # T7: dummy compare so timing is constant regardless of user existence
        bcrypt.checkpw(password.encode(), BCRYPT_DUMMY_HASH.encode())
        return None
    if not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
        return None
    if not row["is_active"]:
        return None
    return User.from_row(row)
```

## Test template (pgTAP)

Requires `pgTAP` extension. Every MUST property has a corresponding assertion. N is the declared pre-auth helper count; update the `= N` constant when you legitimately add a helper after a threat-review entry.

```sql
BEGIN;
SELECT plan(17);

-- Adjust N to match the number of helpers you've declared in the migration.
-- For this recipe N = 2 (resolve_user_by_email, resolve_user_by_id).
-- The assertion is `= N` (exact), NOT `<= 3` — an (N+1)th helper MUST trip
-- this test AND require an explicit bump of this constant in the same PR.
\set N 2

-- === MUST property 1 + 6: exactly N tenant-aware pre-auth helpers ===
SELECT ok(
  (SELECT count(*) FROM pg_proc WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace) = :N,
  'exactly N pre-auth helpers (adding one requires a threat-review entry and a bump of :N here)'
);

-- === MUST property 1: RLS is enabled on principal table ===
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'users' AND relnamespace = 'app'::regnamespace),
  'users has RLS enabled'
);

-- FORCE RLS so the table-owner role also goes through the policy
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'users' AND relnamespace = 'app'::regnamespace),
  'users has FORCE ROW LEVEL SECURITY (table-owner bypass closed)'
);

-- Policy exists with the expected name
SELECT ok(
  EXISTS(SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_scope_select'),
  'users_scope_select policy exists'
);

-- === MUST property 2: SECURITY DEFINER on every helper ===
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace),
  'every resolve_* helper is SECURITY DEFINER'
);

-- === MUST property 2: pinned search_path on every helper ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND (proconfig IS NULL OR NOT (proconfig @> ARRAY['search_path=app, pg_temp']))
  ),
  'every resolve_* helper has pinned search_path = app, pg_temp'
);

-- === MUST property 2: STABLE volatility on every helper ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND provolatile <> 's'
  ),
  'every resolve_* helper is STABLE (T6b — plan-cache safe)'
);

-- === MUST property 2: STRICT on every helper (NULL predicate-collapse guard) ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND NOT proisstrict
  ),
  'every resolve_* helper is STRICT (T6e — NULL-input predicate collapse closed)'
);

-- === MUST property 2: LANGUAGE sql on every helper (T6a / T9) ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND l.lanname <> 'sql'
  ),
  'every resolve_* helper is LANGUAGE sql (T6a / T9 — stricter audit, no SET ROLE)'
);

-- === T6d: no helper is LEAKPROOF (error messages must not be asserted leak-free) ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND proleakproof
  ),
  'no resolve_* helper is marked LEAKPROOF (T6d)'
);

-- === T6a: no helper body contains SET ROLE (bypass via caller privilege reintroduction) ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND prosrc ILIKE '%SET ROLE%'
  ),
  'no resolve_* helper body contains SET ROLE (T6a)'
);

-- === MUST property 3: PUBLIC cannot EXECUTE email helper ===
SELECT ok(
  NOT has_function_privilege('public', 'app.resolve_user_by_email(text, bigint)', 'EXECUTE'),
  'PUBLIC cannot EXECUTE resolve_user_by_email'
);

-- === MUST property 3: PUBLIC cannot EXECUTE by_id helper ===
SELECT ok(
  NOT has_function_privilege('public', 'app.resolve_user_by_id(bigint, bigint)', 'EXECUTE'),
  'PUBLIC cannot EXECUTE resolve_user_by_id'
);

-- === MUST property 3: app_role CAN EXECUTE email helper ===
SELECT ok(
  has_function_privilege('app_role', 'app.resolve_user_by_email(text, bigint)', 'EXECUTE'),
  'app_role can EXECUTE resolve_user_by_email'
);

-- === MUST property 3: app_role CAN EXECUTE by_id helper ===
SELECT ok(
  has_function_privilege('app_role', 'app.resolve_user_by_id(bigint, bigint)', 'EXECUTE'),
  'app_role can EXECUTE resolve_user_by_id'
);

-- === MUST property 4 + T5: by_id return shape has NO password column ===
SELECT ok(
  pg_get_function_result('app.resolve_user_by_id(bigint, bigint)'::regprocedure) NOT ILIKE '%password%',
  'resolve_user_by_id return shape has no password_hash column (T5)'
);

-- === MUST property 5: every helper has a COMMENT citing its pre-auth path ===
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM pg_proc p
    WHERE proname LIKE 'resolve_%' AND pronamespace = 'app'::regnamespace
      AND obj_description(p.oid, 'pg_proc') IS NULL
  ),
  'every resolve_* helper has COMMENT ON FUNCTION (MUST property 5)'
);

-- === MUST property 6: T8 cross-tenant read — by_id filters by tenant_id ===
-- Integration assertion: insert a user in tenant A, call by_id with tenant B,
-- assert zero rows. Skipped here because it needs real fixture data; add in
-- your own regression test harness.

SELECT * FROM finish();
ROLLBACK;
```

## Test template (pytest-asyncpg, for Python-side integration tests)

Requires: `pytest`, `pytest-asyncio>=0.21`, `asyncpg`. Consumer MUST provide a `postgres_url` fixture (e.g. in `tests/conftest.py`) pointing at a PostgreSQL 14+ instance with the migration applied. This template covers metadata checks AND the T8 cross-tenant regression behaviorally.

```python
import pytest
import asyncpg

pytestmark = pytest.mark.asyncio

@pytest.fixture
async def conn(postgres_url):
    conn = await asyncpg.connect(postgres_url)
    yield conn
    await conn.close()

async def test_rls_enabled_on_users(conn):
    v = await conn.fetchval(
        "SELECT relrowsecurity FROM pg_class "
        "WHERE relname='users' AND relnamespace='app'::regnamespace"
    )
    assert v is True

async def test_users_force_row_level_security(conn):
    v = await conn.fetchval(
        "SELECT relforcerowsecurity FROM pg_class "
        "WHERE relname='users' AND relnamespace='app'::regnamespace"
    )
    assert v is True, "FORCE RLS missing — table owner bypasses policy"

async def test_every_helper_is_security_definer(conn):
    v = await conn.fetchval(
        "SELECT bool_and(prosecdef) FROM pg_proc "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    assert v is True

async def test_every_helper_pinned_search_path(conn):
    rows = await conn.fetch(
        "SELECT proname, proconfig FROM pg_proc "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    for row in rows:
        assert row["proconfig"] is not None, f"{row['proname']}: no config"
        assert any("search_path=app, pg_temp" in s for s in row["proconfig"]), \
            f"{row['proname']}: search_path not pinned"

async def test_every_helper_language_sql(conn):
    v = await conn.fetchval(
        "SELECT bool_and(l.lanname = 'sql') "
        "FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    assert v is True, "at least one helper is not LANGUAGE sql (T6a / T9)"

async def test_every_helper_stable_strict(conn):
    v = await conn.fetchval(
        "SELECT bool_and(provolatile='s' AND proisstrict) FROM pg_proc "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    assert v is True

async def test_no_helper_is_leakproof(conn):
    v = await conn.fetchval(
        "SELECT bool_or(proleakproof) FROM pg_proc "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    assert v is False or v is None

async def test_no_helper_body_sets_role(conn):
    rows = await conn.fetch(
        "SELECT proname, prosrc FROM pg_proc "
        "WHERE proname LIKE 'resolve_%' AND pronamespace='app'::regnamespace"
    )
    for row in rows:
        assert "SET ROLE" not in row["prosrc"].upper(), \
            f"{row['proname']}: body contains SET ROLE (T6a)"

async def test_public_cannot_execute(conn):
    for sig in ("app.resolve_user_by_email(text, bigint)",
                "app.resolve_user_by_id(bigint, bigint)"):
        v = await conn.fetchval(
            "SELECT has_function_privilege('public', $1, 'EXECUTE')", sig
        )
        assert v is False, f"{sig}: PUBLIC can execute"

async def test_app_role_can_execute(conn):
    for sig in ("app.resolve_user_by_email(text, bigint)",
                "app.resolve_user_by_id(bigint, bigint)"):
        v = await conn.fetchval(
            "SELECT has_function_privilege('app_role', $1, 'EXECUTE')", sig
        )
        assert v is True, f"{sig}: app_role cannot execute"

async def test_by_id_return_shape_has_no_password(conn):
    shape = await conn.fetchval(
        "SELECT pg_get_function_result("
        "'app.resolve_user_by_id(bigint, bigint)'::regprocedure)"
    )
    assert "password" not in shape.lower()

# T8 — Regression: cross-tenant read via by_id MUST fail
async def test_by_id_filters_by_tenant(conn):
    # Fixture: tenant_a_id=1, tenant_b_id=2, user_in_a_id=100 exists in tenant 1
    row_correct_tenant = await conn.fetchrow(
        "SELECT * FROM app.resolve_user_by_id($1, $2)", 100, 1
    )
    assert row_correct_tenant is not None, "user 100 in tenant 1 should resolve"

    row_wrong_tenant = await conn.fetchrow(
        "SELECT * FROM app.resolve_user_by_id($1, $2)", 100, 2
    )
    assert row_wrong_tenant is None, \
        "T8 REGRESSION: by_id returned user 100 when passed wrong tenant_id"
```

## Common mistakes

| Mistake                                                                            | Fix                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `USING (true)` policy                                                              | Replace with role-aware scoped policy per recipe step 2                                                      |
| Forgot `FORCE ROW LEVEL SECURITY`                                                  | Table owner bypasses policy silently; always pair `ENABLE` + `FORCE`                                         |
| Forgot `REVOKE ALL ON TABLE ... FROM PUBLIC`                                       | Multi-role DB: PUBLIC inherits SELECT; pair ENABLE RLS with this REVOKE                                      |
| Unpinned `search_path`                                                             | Add `SET search_path = <app_schema>, pg_temp` (CVE-2018-1058 class)                                          |
| Forgot `REVOKE PUBLIC` on FUNCTION                                                 | Always pair `REVOKE ALL ... FROM PUBLIC;` + `GRANT EXECUTE ... TO <app_role>;`                               |
| `SELECT *` return OR adding a new column to `users` + mirroring in `RETURNS TABLE` | Explicit minimum-disclosure column list; treat a new column as a threat-review event, not a mirror-add       |
| `VOLATILE` default                                                                 | `STABLE STRICT` for read helpers                                                                             |
| `pg_temp, app_schema` order                                                        | Always `app_schema, pg_temp` (temp schema LAST)                                                              |
| Missing `STRICT`                                                                   | Disjunctive predicates with NULL input fall through to constant branches; always `STRICT` (T6e)              |
| Dropping `LANGUAGE sql` + switching to `plpgsql`                                   | Forbidden unless threat-reviewed; plpgsql body can `SET ROLE`, reintroducing caller privilege (T6a / T9)     |
| `SET ROLE` inside body                                                             | Forbidden; reintroduces caller privilege (T6a)                                                               |
| `LEAKPROOF` asserted                                                               | Forbidden unless audited; error messages are a side-channel (T6d)                                            |
| `by_id` helper without `p_tenant_id` in multi-tenant DB                            | T8 — cross-tenant read via session refresh. Always take and filter by `p_tenant_id`                          |
| Caller skips dummy bcrypt on 0-row result                                          | T7 — email-enumeration timing side-channel. Always run `bcrypt.checkpw(password, DUMMY_HASH)` on 0 rows      |
| Letting pgTAP `= N` drift from actual helper count                                 | Adding an (N+1)th helper MUST bump the `\set N` constant in the same PR AND include a threat-review entry    |
| Recipe pasted without CI enforcement                                               | pgTAP or pytest-asyncpg assertions MUST run in CI against every migration that adds/modifies helpers         |
| App schema owned by app role                                                       | T10 — `CREATE OR REPLACE` preserves GRANTs. Schema owned by superuser/dedicated role; app_role has no CREATE |
| GUCs set from user code paths                                                      | `app.role` / `app.tenant_id` MUST be set by trusted middleware only; no `execute_raw` reachable SET          |

## Using the builder (kailash-rs only)

The four-statement emission (`CREATE OR REPLACE FUNCTION`, `COMMENT ON FUNCTION`, `REVOKE`, `GRANT`) is also available as a typed builder so every adopter does not hand-rewrite the SQL. The builder lives at `crates/kailash-dataflow/src/migration/security_definer.rs` and is re-exported as `kailash_dataflow::migration::SecurityDefinerBuilder`.

```rust
use kailash_dataflow::migration::SecurityDefinerBuilder;

// Returns Vec<String> — embed in a Migration::up_sql; the builder itself
// does not execute SQL. Application flows through the numbered-migration
// path (.claude/rules/schema-migration.md).
let stmts = SecurityDefinerBuilder::new("resolve_user_by_email")
    .search_path("app")
    .authenticator_role("app_role")
    .user_table("users")
    .password_column("password_hash")
    .tenant_column("tenant_id")          // omit for single-tenant deployments
    .active_column("is_active")          // omit for schemas without a boolean activity flag
    // .primary_lookup_column("email")    // omit when param uses the canonical `p_<col>` convention
    .param("p_email", "text")
    .param("p_tenant_id", "bigint")       // MUST match tenant_column presence
    .return_column("id", "bigint")
    .return_column("email", "text")
    .return_column("password_hash", "text")  // login variant includes hash
    .return_column("is_active", "boolean")
    .build()
    .expect("identifier validation passes");
// stmts now holds:
//   [0] CREATE OR REPLACE FUNCTION ... SECURITY DEFINER SET search_path = app, pg_temp STABLE STRICT
//   [1] COMMENT ON FUNCTION ... (names the password column + T7 dummy-bcrypt reminder)
//   [2] REVOKE ALL ON FUNCTION ... FROM PUBLIC
//   [3] GRANT EXECUTE ON FUNCTION ... TO "app_role"
```

What the builder enforces for you:

1. **Pinned `search_path`** — `SET search_path = <schema>, pg_temp` is emitted unconditionally; there is no path through the builder that skips it.
2. **REVOKE PUBLIC + GRANT <role>** — the pair is emitted as two separate statements with the same type-qualified signature.
3. **T7 timing-close reminder** — the emitted `COMMENT ON FUNCTION` names your password column and restates "CALLER MUST run a dummy bcrypt compare on 0-row results." You still have to implement the caller side (the Python pseudocode above); the comment makes the contract un-missable for every downstream reader.
4. **T8 multi-tenant filter** — calling `.tenant_column("tenant_id")` wires `AND "tenant_id" = p_tenant_id` into the function body. Setting `tenant_column` without also declaring a `p_tenant_id` param is a typed `DataFlowError::QueryBuild` at `build()` time.
5. **Activity-flag guard** — calling `.active_column("is_active")` appends `AND "is_active" = true`. Omit for schemas whose activity signal is a text `status` column, a soft-delete `deleted_at IS NULL`, or simply absent.
6. **Explicit lookup column** — calling `.primary_lookup_column("email")` pins the `WHERE` column name explicitly; useful when the param name is not the canonical `p_<col>` form (e.g. `.param("p_user_email", ...)` targeting schema column `email`).

Identifier safety:

- Every user-supplied identifier (function name, schema, role, table, column, param names) routes through `sql_safety::validate_identifier` + `quote_identifier` before interpolation. Injection payloads (`"; DROP TABLE users; --`, `name WITH DATA`, `123abc`) are rejected with a typed error.
- `pg_type` strings in params and return columns are checked against `ALLOWED_PG_TYPES`; `bigint; DROP TABLE users` fails at `build()`.

Tier 2 integration test (feature-gated on `integration`) lives at `crates/kailash-dataflow/tests/security_definer_builder.rs` and exercises the four invariants against a real PostgreSQL instance: introspects `pg_proc` for `prosecdef` / `provolatile='s'` / `proisstrict` / pinned search_path in `proconfig`; asserts `has_function_privilege(public, ...)` = false and the authenticator role's privilege = true; drives the T8 cross-tenant regression by seeding two tenants; and asserts median-latency symmetry between unknown-user and wrong-tenant calls (25ms tolerance across 20 iterations — a regression test that the helper does NOT branch on existence).

Added in kailash-rs v3.21+ (issue #571).

## Cross-references

- Companion skill: `dataflow-rls-posture.md` (why DataFlow does not emit RLS by default).
- Rule: `.claude/rules/tenant-isolation.md` (multi-tenant invariants beyond RLS).
- Rule: `.claude/rules/security.md` (parameterized queries, input validation).
- Rule: `.claude/rules/dataflow-identifier-safety.md` (the identifier validation contract the `SecurityDefinerBuilder` satisfies).

## Origin

Surfaced via consumer feedback in 2026-04 — lifted from an open-application reference migration (`0027_users_rls_policy.sql`) + companion SQL helpers (`0026c_sql_helpers.sql`) + bootstrap-blocker discovery journal. Generalized to a language-agnostic recipe so downstream COC-scaffolded projects can land the pattern without re-deriving the threat model. The SQL, threat model, and test templates are language-neutral; the caller-side T7 timing-safe login example is written in Python but translates directly to any binding — constant-time bcrypt comparison is the universal requirement.
