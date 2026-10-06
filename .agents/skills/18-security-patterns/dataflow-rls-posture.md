# DataFlow RLS Posture — Runtime Predicate, Not DDL

Authoritative reference for consumers asking "does DataFlow emit PostgreSQL Row-Level Security policies on my tables?"

## Summary

**No.** DataFlow's migration generator emits only `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`, and `DROP TABLE IF EXISTS`. It never writes `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`, or `SECURITY DEFINER`. Tenant isolation for `@db.model(multi_tenant=True)` is enforced by the DataFlow QueryInterceptor at the SQL-build layer, not by database-enforced RLS policies. The contract is a framework design invariant, not a per-language artifact.

Downstream consumers are responsible for (a) deciding whether to layer RLS on top and (b) writing the corresponding `CREATE POLICY` migrations by hand.

## Why this matters

A consumer assuming DataFlow emits RLS will skip a production-grade security control AND have no database-enforced defence if the runtime predicate injection is bypassed by a handler bug, an untrusted middleware layer, or a raw-SQL `execute_raw` call.

A consumer assuming DataFlow does NOT emit RLS (the correct reading) will write their RLS migrations deliberately, land the SECURITY DEFINER carveouts their pre-auth paths need, and produce a coherent layered defence.

## Two enforcement layers, pick deliberately

| Layer              | Mechanism                                                  | When to use                                                                                                             | Limitation                                                                                                                              |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime predicate  | QueryInterceptor injects `WHERE tenant_id = ?`             | Multi-tenant SaaS with trusted handler + middleware layer; typical default                                              | Bypassed by raw-SQL escape hatches (`execute_raw`, driver-level `query`), direct DB access via admin tools or `psql`                    |
| Database-level RLS | Hand-written `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` | Sensitive tables (users, PII, billing), untrusted middleware, multi-role DB access, compliance regimes (HIPAA, PCI-DSS) | Bootstrap paths (login, password-reset, invite-accept) need SECURITY DEFINER carveouts — see `rls-security-definer-preauth-carveout.md` |

The two layers compose. A production-grade posture for a multi-tenant SaaS with PII commonly uses BOTH: runtime predicates for default tenant scoping AND database RLS for principal tables (users, sessions, secrets).

## Consumer review checklist

Run before any production deploy of a DataFlow-scaffolded schema:

1. **Enumerate PII-bearing tables.** Any table with columns matching `email`, `phone`, `national_id`, `nric`, `password_hash`, `mfa_secret`, `session_token`, `address`, `dob`, `medical_*`. List them by name.

2. **Decide the posture for each.** For every table on the list, pick one:
   - `runtime_only` — QueryInterceptor + multi_tenant is sufficient (e.g. non-principal tables where admin DB access is untrusted but middleware is trusted)
   - `rls_layered` — add `ENABLE ROW LEVEL SECURITY` + a scoped `CREATE POLICY` migration
   - `rls_plus_carveout` — strict RLS + SECURITY DEFINER helpers for any bootstrap path that reads the table pre-auth (users-on-login, users-on-password-reset, invites-on-accept)

3. **Never leave `USING(true)`.** If any consumer-authored RLS migration contains `USING (true)` or `USING(true)`, that policy is equivalent to no RLS at all but masquerades as an enabled control. Either replace the policy with a real predicate or drop the `ENABLE ROW LEVEL SECURITY` statement so the posture is honest.

4. **For every `rls_plus_carveout` table, count the pre-auth read paths.** N helpers for N paths. Each helper MUST satisfy the MUST properties in `rls-security-definer-preauth-carveout.md` (nine at time of writing, including LANGUAGE sql / STRICT / STABLE / tenant-filter / COMMENT / CI gate / trusted-middleware-only GUC). Adding an (N+1)th helper requires a threat-review entry.

5. **Test each posture.** For every table with RLS, assert via `SELECT pg_has_role('<unauth_role>', '<schema>.<table>', 'SELECT')` (should return false without explicit grant) AND a positive test through the SDK (should succeed for the intended tenant and fail for others).

## `multi_tenant=true` is not RLS

```python
# DO — read this as "runtime predicate injection"
@db.model(multi_tenant=True)
class Document:
    ...
# At query time the DataFlow QueryInterceptor rewrites:
#   SELECT * FROM documents WHERE id = ?
# to:
#   SELECT * FROM documents WHERE tenant_id = ? AND id = ?
```

```rust
// Compiled-language equivalent — DO — read this as "runtime predicate injection"
#[db::model(multi_tenant = true)]
struct Document { /* ... */ }
// At query time the DataFlow QueryInterceptor rewrites:
//   SELECT * FROM documents WHERE id = ?
// to:
//   SELECT * FROM documents WHERE tenant_id = ? AND id = ?
```

```
# DO NOT — read either form as "DataFlow emits CREATE POLICY tenant_scope"
# It does not. The generated migration has no RLS statements in either SDK.
```

**Why:** Conflating the two leads consumers to skip writing RLS migrations when they need them, producing a posture where a raw-SQL escape hatch (`execute_raw`, driver-level query) or an admin tool bypasses all isolation.

## Cross-references

- Authoritative behaviour: DataFlow migration manager (`generate_sql_from_diff`) emits DDL only; grep your SDK's DataFlow source for `CREATE POLICY` / `ROW LEVEL SECURITY` / `SECURITY DEFINER` and expect zero matches.
- Tenancy enforcement: DataFlow's QueryInterceptor layer injects `WHERE tenant_id = ?` at SQL build time.
- Spec: `specs/dataflow.md` — "Runtime tenant scoping, NOT RLS" section (present in both py and rs specs).
- Companion skill: `rls-security-definer-preauth-carveout.md` (pre-auth bootstrap pattern when RLS is layered).
- Rule: `.claude/rules/tenant-isolation.md` (multi-tenant invariants for cache keys, audit rows, metric labels).

## Origin

Posture surfaced via consumer feedback in 2026-04. The posture applies identically across DataFlow implementations because RLS-emission is a framework contract, not a language artifact.
