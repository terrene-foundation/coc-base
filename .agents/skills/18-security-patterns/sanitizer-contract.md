# Sanitizer Contract — Display Hygiene — depth

Depth for `rules/security.md` § "Sanitizer Contract — Display Hygiene". The rule carries the three
MUST clauses; this file carries the worked DO/DO-NOT code, the BLOCKED corpus, and the origin.

DataFlow's `sanitize_sql_input` is defense-in-depth DISPLAY HYGIENE, **NOT** the primary SQLi
defense — parameter binding is. Reading it as the primary defense is the misuse this contract
guards against.

## 1. String Inputs MUST Be Token-Replaced, Not Quote-Escaped

For declared-string fields the sanitizer MUST token-replace SQL keyword sequences with grep-able
sentinels (`STATEMENT_BLOCKED`, etc.). Quote-escaping (`'` → `''`) is BLOCKED.

```python
# DO — token-replace produces a grep-able audit trail
"'; DROP TABLE users; --" → "'; STATEMENT_BLOCKED users; -- COMMENT_BLOCKED"

# DO NOT — quote-escape: the payload survives in storage
"'; DROP TABLE users; --" → "''; DROP TABLE users; --"
```

**Why:** Token-replace makes attacker intent grep-able post-incident; quote-escape preserves the
payload intact as data, so the row reads as ordinary content and the attempt is invisible to any
later sweep.

## 2. Type-Confusion MUST Raise, Not Silently Coerce

For declared-string fields receiving `dict`/`list`/`set`/`tuple` values the sanitizer MUST raise
`ValueError("parameter type mismatch: …")`. Silent `str(value)` coercion is BLOCKED.

```python
# DO — type-confusion rejected at the validate_inputs gate
if declared_type is str and isinstance(value, (dict, list, set, tuple)):
    raise ValueError(
        f"parameter type mismatch: field '{field_name}' declared 'str' "
        f"but received '{type(value).__name__}'"
    )

# DO NOT — silent str() coercion
# (the dict's contents get sanitized, but the structure escaped the check earlier)
value = str(value)
```

**BLOCKED rationalizations:** "Token-replace is weaker than quote-escape, we should switch" / "We
should silently coerce dict to JSON for safety" / "Type-confusion is an upstream concern, not the
sanitizer's job" / "The integration tests can catch these".

**Why:** A nested `dict`/`list` supplied for a str-declared field bypasses EVERY string-only check
— the scan runs over a stringified structure whose interior was never inspected. Raising at the
type-confusion boundary is what closes the bypass, and it must raise rather than coerce because a
coerced value looks identical to a legitimate one downstream.

## 3. Safe Types Are Returned As-Is

Declared-safe types (`int`, `float`, `bool`, `Decimal`, `datetime`, `date`, `time`) MUST pass
through unchanged — and so MUST `dict`/`list` when the DECLARED type is `dict`/`list` (JSON and
array columns). Sanitizing a declared-JSON column corrupts legitimate data (Bug #515).

Origin: GitHub issues #492 (bulk_upsert SQLi via string-escape) + #493 (sanitizer contract drift).
