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

Origin: a BUILD-repo upstream-fixes session (2026-04-12).

## Sanitizer Contract — Exhaustive Examples

DataFlow's input sanitizer (the dataflow package (`src/dataflow/core/nodes.py::sanitize_sql_input`)) is a defense-in-depth display-path safety net, NOT the primary SQLi defense. Parameter binding (`$N` / `%s` / `?`) is the primary defense.

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
# the dataflow package directory src/dataflow/features/express.py:_validate_if_enabled
# the dataflow package directory src/dataflow/engine.py::validate_record
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

## Enforcement-Surface Parity — Shared-Rank-Function Pattern + Detection

The eval-helper call-site grep (Multi-Site Kwarg Plumbing above) is structurally insufficient here: the registration / monotonic-tightening validator is a SEPARATE function with no shared callee, so a grep that follows one helper's call sites CANNOT reach it. The two surfaces MUST consume a SINGLE shared restrictiveness/ordering function so they cannot drift; a hand-synced second copy is a MED-severity finding that MUST carry a pinned parity test asserting byte-identical parse + ordering against the eval gate.

```python
# DO — one shared rank function; the registration validator consumes it, same PR
def _restrictiveness(v):              # the SINGLE ordering: None=widest, unrecognized=tightest
    if v is None: return -1
    try: return LEVELS.index(parse(v))
    except Exception: return len(LEVELS)           # ANY parse failure -> tightest (fail-closed)
def _check_clearance(caller, required): ...                    # eval gate (parse -> fail-closed)
def _validate_monotonic_tightening(old, new):                  # registration gate — SAME PR
    if _restrictiveness(new) < _restrictiveness(old):
        raise GovernanceError(...)                             # may only KEEP or RAISE the bar

# DO NOT — promote the gate at eval, leave the tightening validator blind
def _check_clearance(caller, required): ...                    # new fail-closed gate
def _validate_monotonic_tightening(old, new):
    ...   # never learned the new dimension -> a re-registration that DROPS (secret->None)
          # or LOWERS (secret->public) the bar is accepted as "tightening" -> gate silently stripped
```

**BLOCKED rationalizations:** "The eval gate is the enforcement point; the validator is secondary" / "grep of the eval helper's call sites found nothing" / "the validator has a safe default" / "the new dimension is rare; re-registration won't hit it" / "the eval check already fails closed, so the bypass is theoretical".

**Detection:** for any field promoted to a fail-closed authorization control at an eval surface, FIRST enumerate ALL validators that reference the control's field/type (the helper-following grep is precisely what cannot find the independent surfaces), THEN grep each re-registration / monotonic-tightening validator for that field name — absence is a finding.

Origin: kailash-py #1456 → kailash-pact 0.14.3 (PR #1459). #1456 promoted `McpToolPolicy.clearance_required` to a fail-closed gate at `_check_clearance` (eval, Step 3.5) but left `_validate_monotonic_tightening` (re-registration) blind to it; a `secret`→None / `secret`→`public` re-registration was accepted as "tightening", silently stripping the gate. Cross-SDK sibling: the Rust SDK binding (same shape).

## Redactor Contract — Extended

### 1. Minimum Subject-Id Length Floor (≥8 chars)

A substring-match redactor that scrubs every string containing a `subject_id` substring MUST reject ids shorter than 8 chars with a typed error citing the floor and the received length. Empty-id rejection alone is insufficient — single-char and 2-char ids substring-match catastrophically into benign role-knowledge strings.

```text
# DO — fail closed on a too-short id (typed error names floor + received length)
redact_subject_keyed(payload, subject_id="a")
→ Error: subject_id length 1 below MIN_SUBJECT_ID_CHARS=8 (over-redaction guard)

# DO NOT — empty-check only; 1–7-char ids over-redact benign strings
redact_subject_keyed(payload, subject_id="alice")
→ "malice aforethought" → "m[REDACTED] aforethought"   # role knowledge destroyed
```

Practical subject refs (sovereign_ref, role_id, agent_id, UUIDs, emails) are all ≥8 chars — the floor is the structural defense against the over-redaction class, which defeats the "successor inherits role knowledge" contract by scrubbing content the successor is entitled to.

### 2. Numbered-Sentinel Key Scrub (companion clause)

A subject-keyed redactor scrubbing object KEYS that match the subject id MUST scrub BOTH the key AND the value. Preserving the original matching key under a `"[REDACTED]"` value leaks the departed subject's identity as audit metadata — a downstream reader can enumerate which entries belonged to them.

```text
# DO — numbered sentinel preserves audit shape, scrubs identity
{"alice@example.com": "...", "bob@example.com": "..."} (subject = alice@example.com)
→ {"[REDACTED_KEY_1]": "[REDACTED]", "bob@example.com": "..."}
# count of scrubbed keys preserved via per-key counter; byte-level audit trail
# preserved via the original_hash return (hash-preserving redaction contract)

# DO NOT — preserve the matching key as "audit metadata"
→ {"alice@example.com": "[REDACTED]", ...}   # identity leaks as the key itself
```

The matching-key counter prevents map collapse across multiple matching keys; any residue predicate (`payload_mentions_subject`) MUST treat matching keys as residue, symmetric with the scrubber.

**Cross-SDK landing requirement:** when an equivalent subject-keyed redactor lands in a sibling SDK (Python, Ruby, Node), the min-length floor AND the numbered-sentinel key scrub MUST be part of the ORIGINAL landing — not a follow-up.

**Evidence:** the Rust SDK `eatp::redact_subject_keyed` shipped with only an empty-id check (PR #1123 commit `f2cd020e`); /redteam Round 1 flagged HIGH (1–7-char ids over-redact role knowledge) + MEDIUM (preserved matching key leaks predecessor identity). Same-shard fix (commit `6a332ef5`) added the `MIN_SUBJECT_ID_CHARS = 8` floor + regression test `redact_subject_keyed_short_subject_id_is_rejected` + the `[REDACTED_KEY_N]` sentinel + symmetric residue predicate.

## Kailash-Specific Security — Extended

- **DataFlow**: Access controls on models, validate at model level, never expose internal IDs
- **Nexus**: Authentication on protected routes, rate limiting, CORS configured
- **Kaizen**: Prompt injection protection, sensitive data filtering, output validation

## Structural surface enumeration — why the sweep is the backstop, not the control

Depth for `rules/security.md` § Enforcement-Surface Parity, reached via that
file's header pointer ("Depth for most sections below lives in
`.claude/guides/rule-extracts/security.md`").

NOTE ON PLACEMENT (loom#1422 AC-5, loom#1355). AC-5 asked § Enforcement-Surface
Parity to cross-reference the predicate IN THE RULE, so the clause points at
something structural rather than at human memory. That pointer is NOT in the rule
body, and the omission is deliberate and measured rather than an oversight: the
`rs` lane composes `security.md` to 9545B against a granted per-rule ceiling of
9600B (itself an exception under #1355, expiring 2026-10-31), leaving 55B. The
shortest honest form of the clause measured ~199B, which BLOCKS the lane. Raising
the ceiling is a co-owner decision, and displacing existing contract prose to make
room would trade a live security contract for a cross-reference. So the depth
lives here, reachable from the rule's existing header pointer, at zero baseline
emission cost. If the rs per-rule ceiling is ever raised, the one-line pointer
belongs back in § Enforcement-Surface Parity.

### The clause asks for something a human does not reliably do

§ Enforcement-Surface Parity asks an author to find every independent validation
surface. Measured in this repo, that is not reliably achievable. The
case-sensitivity dimension had to land at ~10 protected-path sites across 4 hooks
and was missed — **by the orchestrator, while fixing a violation of this very
clause**. The Bash-lane half shipped and was declared complete; an adversarial
lens then found the Edit/Write lane fully bypassable: 9/9 canonical paths fenced,
10/10 case-variants passed. The variant set reached further than the Bash lane's,
covering the `journal/` and `.claude/team-memory/` subtrees.

That is the strongest available evidence that a rule asking a human to remember an
enumeration nobody produces is not sufficient on its own.

### The mechanism

Collapse the surfaces onto ONE shared function so a new dimension is one edit, then
add a test that ENUMERATES the surfaces and fails when a new one re-derives the
decision locally. The sweep becomes the backstop; the test is the control.

Worked reference:

- `.claude/hooks/lib/guard-path-scope.js` — the `PROTECTED_PATHS` registry. One row
  per protected path, per-row surface membership (`bash` / `layer3` / `direct` /
  `coordMode` / `postureGate`), every matcher BUILT from it. Membership is
  deliberately asymmetric because the surfaces genuinely differ.
- `tests/integration/multi-operator/protected-path-predicate-1422.test.js` — walks
  `.claude/hooks/**` and fails if any hook does its own protected-path matching.

### The enumeration test needs its own anti-vacuity control

A scanner that reports zero because it scanned nothing is the recurring instrument
failure in this corpus. The enumeration test therefore ships controls that run on
EVERY invocation, not once by hand: synthetic violation shapes that MUST flag,
legitimate non-decisions that MUST NOT, and a proof the scan reached production
text. Calibration is honest about reach — see loom#1455: it catches the plain shape
that real decay takes, not an author who wants to route around it.

### Where duplication is DELIBERATE, consolidation is BLOCKED

The discriminator is whether the copies are an accident or an independence property.
`CANONICAL_DENY_FLOOR` is hardcoded in `settings-deny-edit-guard.js`,
`settings-deny-drift-guard.js` and `.claude/bin/reconcile-settings-deny.mjs`
precisely so poisoning the mutable bin's `CANONICAL_STATE_DENY` cannot reduce the
enforced floor ("HARDCODED trust anchor (redteam F2)"). Consolidating those onto a
shared source would destroy the independence the triplication exists to provide;
`settings-deny-canon-parity.test.mjs` pinning them in lockstep is the correct
control there. An enumeration test MUST recognise that case structurally — the
#1422 test treats a permission-matcher string (`Tool(<path>)`) as a DECLARATION
rather than a path-matching decision — rather than carrying a per-file allowlist,
which is the shape that lets real fragmentation hide.
