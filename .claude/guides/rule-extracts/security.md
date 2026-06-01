# Security Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/security.md`. Holds extended
examples, sanitizer contract exhaustive examples, and multi-site
kwarg plumbing full post-mortem that would exceed the 200-line rule
budget.

## Credential Decode Helpers — Extended Rationale

### Null-Byte Rejection — Why it matters

A crafted `mysql://user:%00bypass@host/db` decodes to `\x00bypass`; the MySQL C client truncates credentials at the first null byte and the driver sends an empty password, succeeding against any row in `mysql.user` with an empty `authentication_string`. Drift between sites that have the check and sites that don't is unauditable without a single helper.

Every URL parsing site that extracts `user`/`password` from `urlparse(connection_string)` MUST route through a single shared helper that rejects null bytes after percent-decoding. Hand-rolled `unquote(parsed.password)` at a call site is BLOCKED.

```python
# DO — route through the shared helper
from kailash.utils.url_credentials import decode_userinfo_or_raise

parsed = urlparse(connection_string)
user, password = decode_userinfo_or_raise(parsed)  # raises on \x00 after unquote

# DO NOT — hand-rolled at the call site
from urllib.parse import unquote
parsed = urlparse(connection_string)
user = unquote(parsed.username or "")
password = unquote(parsed.password or "")  # no null-byte check, drifts from other sites
```

**BLOCKED rationalizations:**

- "The existing site already has the check"
- "This is a new dialect, the rule doesn't apply yet"
- "We'll consolidate later"
- "The URL comes from a trusted config file, null bytes can't happen"

### Pre-Encoder Consolidation — Extended

Password pre-encoding helpers (`quote_plus` of `#$@?` etc.) MUST live in the same shared helper module as the decode path. Per-adapter copies are BLOCKED.

```python
# DO — single helper module owns both halves of the contract
from kailash.utils.url_credentials import (
    preencode_password_special_chars,
    decode_userinfo_or_raise,
)
url = preencode_password_special_chars(raw_url)
parsed = urlparse(url)
user, password = decode_userinfo_or_raise(parsed)

# DO NOT — inline pre-encode in each adapter
pwd = pwd.replace("@", "%40").replace(":", "%3A").replace("#", "%23")
url = f"postgresql://{user}:{pwd}@{host}/{db}"  # drifts from decode path silently
```

**Why (extended):** Encode and decode are dual halves of one contract; splitting them across modules guarantees one half drifts. Round-trip tests are only meaningful when both ends share the helper.

Origin: `workspaces/arbor-upstream-fixes/.session-notes` (2026-04-12)

## Sanitizer Contract — Exhaustive Examples

DataFlow's input sanitizer (`packages/kailash-dataflow/src/dataflow/core/nodes.py::sanitize_sql_input`) is a defense-in-depth display-path safety net, NOT the primary SQLi defense. Parameter binding (`$N` / `%s` / `?`) is the primary defense.

### 1. String Inputs Token-Replaced, Not Quote-Escaped

For declared-string fields, the sanitizer MUST replace dangerous SQL keyword sequences with grep-able sentinel tokens (`STATEMENT_BLOCKED`, `DROP_TABLE`, `UNION_SELECT`, etc.). Quote-escaping (`'` → `''`) is BLOCKED.

```python
# DO — token-replace produces grep-able audit trail
"'; DROP TABLE users; --" → "'; STATEMENT_BLOCKED users; -- COMMENT_BLOCKED"

# DO NOT — quote-escape: the payload survives in storage
"'; DROP TABLE users; --" → "''; DROP TABLE users; --"
```

**Why:** Token-replace makes attacker intent grep-able post-incident (`grep STATEMENT_BLOCKED audit.log`). Quote-escape preserves the payload as data, masking that an attack was attempted. The actual injection defense is parameter binding; the sanitizer is the audit trail.

### 2. Type-Confusion MUST Raise, Not Silently Coerce

For declared-string fields receiving `dict` / `list` / `set` / `tuple` values, the sanitizer MUST raise `ValueError("parameter type mismatch: …")`. Silent coercion via `str(value)` is BLOCKED — it lets a nested structure bypass the string-only sanitizer.

```python
# DO — type-confusion is rejected at the validate_inputs gate
if declared_type is str and isinstance(value, (dict, list, set, tuple)):
    raise ValueError(
        f"parameter type mismatch: field '{field_name}' declared as 'str' "
        f"but received '{type(value).__name__}' — type confusion blocked"
    )

# DO NOT — silent str() coercion
value = str(value)  # {"x": "'; DROP TABLE"} becomes "{'x': \"'; DROP TABLE\"}"
# ↑ the dict's contents get sanitized as a string but the original
#   structure already left the validation boundary
```

**Why:** A malicious upstream node that passes `{"injection": "'; DROP TABLE …"}` for a field declared as `str` bypasses every string-only check. Raising at the type-confusion boundary closes the bypass; coercion-to-string converts a structural attack into an unaudited storage event.

### 3. Safe Types Are Returned As-Is

Values of declared-safe types (`int`, `float`, `bool`, `Decimal`, `datetime`, `date`, `time`) MUST pass through unchanged. `dict` and `list` MUST also pass through unchanged when the field's declared type is `dict` or `list` (JSON / array columns). Bug #515 documents this: premature `json.dumps()` on dict/list breaks parameter binding in `AsyncSQLDatabaseNode`.

**BLOCKED rationalizations:**

- "Token-replace is weaker than quote-escape, we should switch"
- "We should silently coerce dict to JSON for safety"
- "Type-confusion is an upstream concern, not the sanitizer's job"
- "The integration tests can catch these"

Origin: GitHub issues #492 (bulk_upsert SQLi via string-escape) + #493 (sanitizer contract drift, 3 pre-existing failing tests). The contract above pins the decision so a future refactor doesn't swing back to quote-escape.

## Multi-Site Kwarg Plumbing — Full Example

When a security-relevant kwarg (classification policy, tenant scope, clearance context, audit correlation ID) is plumbed through a helper, EVERY call site of that helper MUST be updated in the SAME PR. Updating the "primary" call site and deferring siblings is BLOCKED.

```python
# DO — grep every caller, update every sibling, same PR
# Helper added `policy` + `model_name` kwargs for classification sanitisation.
#
# $ grep -rn 'validate_model(' src/ packages/
# packages/kailash-dataflow/src/dataflow/features/express.py:_validate_if_enabled
# packages/kailash-dataflow/src/dataflow/engine.py::validate_record
# tests/...  (tests covered separately)
#
# Both production call sites get policy+model_name in this PR:
engine.validate_record(instance) -> validate_model(instance, policy=..., model_name=...)
express._validate_if_enabled(...) -> validate_model(instance, policy=..., model_name=...)

# DO NOT — update primary site, skip the sibling
express._validate_if_enabled(...) -> validate_model(instance, policy=..., model_name=...)
engine.validate_record(instance)  -> validate_model(instance)   # bypasses sanitiser
# ↑ The unpatched sibling surface still leaks classified field names / values in
#   error messages; the sanitisation contract is broken on one public entry point.
```

**BLOCKED rationalizations:**

- "The primary call site is the one users hit 99% of the time"
- "The sibling is rarely used; we'll patch it in a follow-up"
- "The helper signature is backwards-compatible, sibling can stay as-is"
- "Test coverage will catch divergence later"
- "The kwarg has a safe default — siblings still get baseline behaviour"

**Why (extended):** A helper that takes a security-relevant kwarg has the kwarg precisely because the unqualified call leaks or misbehaves. Leaving any sibling call site on the unqualified signature ships the exact failure mode the kwarg was introduced to fix; the "safe default" is by definition the insecure default (otherwise the kwarg would not exist). The fix is mechanical — `grep -rn 'helper_name(' .` and patch every hit in the same PR.

**Evidence:** BP-049 (2026-04-19) landed `validate_model(policy=..., model_name=...)` in PR #522 but left `DataFlowEngine.validate_record(instance)` unqualified; post-release reviewer caught it; fast-patched in PR #529 (kailash-dataflow 2.0.12).

Origin: PR #522 / PR #529 (2026-04-19) — BP-049 validation sanitiser plumbing missed one sibling.

## Kailash-Specific Security — Extended

- **DataFlow**: Access controls on models, validate at model level, never expose internal IDs
- **Nexus**: Authentication on protected routes, rate limiting, CORS configured
- **Kaizen**: Prompt injection protection, sensitive data filtering, output validation
