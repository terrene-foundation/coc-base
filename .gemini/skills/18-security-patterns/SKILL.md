---
name: security-patterns
description: "Kailash security — input validation, secrets, injection prevention, authn/z, OWASP."
---

# Security Patterns - Kailash SDK

Mandatory security patterns for all Kailash SDK development. These patterns prevent common vulnerabilities and ensure secure application development.

## Overview

Security patterns cover:

- Secret management (no hardcoded credentials)
- Input validation (prevent injection attacks)
- Authentication and authorization
- OWASP Top 10 prevention
- Secure API design
- Environment variable handling

## Critical Rules

### 1. NEVER Hardcode Secrets

```python
# ❌ WRONG - Hardcoded credentials
api_key = "sk-1234567890abcdef"
db_password = "mypassword123"

# ✅ CORRECT - Environment variables
import os
api_key = os.environ["API_KEY"]
db_password = os.environ["DATABASE_PASSWORD"]
```

### 2. Validate All User Inputs

```python
# ❌ WRONG - No validation
def process_user_input(user_data):
    return db.execute(f"SELECT * FROM users WHERE id = {user_data}")

# ✅ CORRECT - Parameterized queries (via DataFlow)
workflow.add_node("User_Read", "read_user", {
    "id": validated_user_id  # DataFlow handles parameterization
})
```

### 3. Use HTTPS for API Calls

```python
# ❌ WRONG - HTTP in production
workflow.add_node("HTTPRequestNode", "api", {
    "url": "http://api.example.com/data"  # Insecure!
})

# ✅ CORRECT - HTTPS always
workflow.add_node("HTTPRequestNode", "api", {
    "url": "https://api.example.com/data"
})
```

## Security Checklist

### Before Every Commit

- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated
- [ ] SQL/code injection prevented
- [ ] HTTPS used for all API calls
- [ ] Sensitive data not logged
- [ ] Error messages don't expose internals

### Before Every Deployment

- [ ] Environment variables configured
- [ ] Secrets stored in secure vault
- [ ] Authentication enabled
- [ ] Authorization rules defined
- [ ] OWASP Top 10 checked
- [ ] Security review completed

## SSRF Prevention (Webhook/Outbound HTTP)

When making outbound HTTP requests to user-supplied URLs:

1. **Validate URL scheme** — only `http://` and `https://`
2. **Resolve DNS and check IP** — block RFC 1918, loopback, link-local, cloud metadata
3. **Check IPv4-mapped IPv6** — `::ffff:127.0.0.1` bypasses IPv4-only blocklists. Extract the mapped IPv4 address and re-validate
4. **Pin resolved IP** — replace hostname with resolved IP in the URL to prevent DNS rebinding. Set `Host` header to original hostname
5. **Block `0.0.0.0/8`** — routes to localhost on some systems

Reference implementation: See the Nexus webhook transport source for a working `_validate_target_url()` pattern.

## Canonical Anchor Form (Cross-SDK)

Audit-chain anchors (hash-linked records proving the ordering of audited events) MUST use a single **canonical-form helper** as the source of truth for the byte sequence that gets hashed. The failure mode this prevents: every chain-verify path that re-derives the canonical form in-module silently accepts a divergent byte layout, breaking cross-SDK chain compatibility without surfacing an error until an anchor minted by one SDK is verified by another.

### MUST: Canonical-Form Helper Is The Single Source Of Truth

Every write path that mints an anchor AND every verify path (range-verify, anchor-chain-verify) MUST route through the shared canonical-form helper. In-module re-implementation of the canonical byte layout is BLOCKED.

```python
# Python — DO — route through the shared canonical-form helper
from kailash.audit.canonical import canonical_anchor_input, canonical_json_dumps

payload_bytes = canonical_anchor_input(
    prev_hash=prev,
    sequence=seq,
    tenant_id=tenant,
    event=canonical_json_dumps(event_dict),
)
h = sha256_hex(payload_bytes)
```

```rust
// Compiled-language equivalent — DO — route through the shared canonical-form helper
use kailash_audit::canonical::{canonical_anchor_input, canonical_json_serialize};

let payload_bytes = canonical_anchor_input(
    prev_hash, sequence, tenant_id,
    &canonical_json_serialize(&event)?,
);
let h = sha256_hex(&payload_bytes);
```

```
# DO NOT — in-module re-implementation
# The following shape silently diverges from the shared canonical-form
# helper as soon as its field order / delimiter / encoding evolves:
#   python:
#     payload = f"{prev_hash}|{sequence}|{tenant_id}|{json.dumps(event)}"
#     h = hashlib.sha256(payload.encode()).hexdigest()
#   rust:
#     let payload = format!("{}|{}|{}|{}", prev_hash, sequence, tenant_id, serde_json::to_string(&event)?);
#     let h = sha256_hex(payload.as_bytes());
```

**Why:** A chain's cross-SDK compatibility is fully defined by the canonical byte layout of each anchor's input. The moment a verify path re-derives that layout from scratch, the canonical-form contract has two authors — and the two drift. Verification against the shared helper + byte-stable test vectors is the single structural defense. See `test-vectors/audit-chain-canonical.json` for the shared fixture that both SDKs MUST serialize byte-identically.

### MUST: Constant-Time Comparison On Hash Equality

Every hash comparison in a verify path MUST use a constant-time comparison primitive. String `==` / `!=` on an attacker-influenced hash input is a timing oracle that leaks prefix-match length, allowing an attacker to forge an anchor hash one byte at a time across many verify attempts.

```python
# Python — DO
import hmac
if not hmac.compare_digest(expected_hash, computed_hash):
    raise ChainVerifyError("hash mismatch")
```

```rust
// Compiled-language equivalent — DO — route through the constant-time comparison primitive
use kailash_core::crypto::constant_time_eq;
if !constant_time_eq(expected_hash, &computed_hash) {
    return Err(ChainVerifyError::HashMismatch);
}
```

```
# DO NOT — variable-time equality on attacker-influenced input
# Python:
if expected_hash == computed_hash: ...
# Rust:
if expected_hash == computed_hash { ... }
```

**Why:** Variable-time string / slice equality short-circuits at the first differing byte. On a verify endpoint that returns quickly-vs-slowly based on prefix match, an attacker submits crafted anchor hashes and measures response time to reconstruct the expected hash byte-by-byte. Constant-time comparison walks the full length regardless of the first-diff position; each SDK exposes one approved constant-time-equality primitive (Python: `hmac.compare_digest`; Rust: the SDK's `constant_time_eq` helper, backed by an audited constant-time crate) — routing every hash-verify site through the SDK primitive keeps the enforcement point singular. Error messages on mismatch MUST NOT echo expected/found hash values — the error body is itself a side channel.

### MUST: Verify Paths Reach Production Call Sites

Every range-verify and anchor-chain-verify surface MUST have at least one production call site in the framework's hot path — not only in tests. An anchor chain whose verify path is never called in production is the orphan failure mode (see `rules/orphan-detection.md`): the chain mints fine, operators believe tamper-detection is running, nothing ever runs the check.

**Cross-SDK test vector:** both SDKs' canonical-form helpers MUST produce byte-identical output for the fixture at `test-vectors/audit-chain-canonical.json`. A regression test in each SDK loads the fixture, runs its helper, and asserts equality to the recorded golden output. Drift in either direction is a HIGH finding.

## Default-Deny When Untrusted Input Selects Which Primitive To Instantiate

When untrusted input (e.g. an LLM-emitted plan from a natural-language brief) selects WHICH node/primitive type to realize, the node-type surface IS a code-execution boundary. The sound model is **default-deny**, not denylist-subtraction:

1. **Positive allowlist ∩ live registry.** Realize only types in a vetted `_SAFE_NODE_TYPES` frozenset, intersected with the live registry — NOT "all registered nodes minus a denylist". Denylist-subtraction is unsound by construction: every new SDK node added between releases is implicitly trusted, and code-exec helpers (e.g. a node that execs via a `CodeExecutor` helper) are invisible to a class-scope denylist scan.
2. **Enforce at the choke point.** Apply the allowlist where the node is actually instantiated (`_realize()` at add-node time), not only at a higher `validate_plan()` gate — a typed plan whose shape differs from what the higher gate inspects bypasses it; the choke point cannot be bypassed.
3. **Keep a hardcoded denylist FLOOR.** Subtract a small set of explicitly-dangerous types BEFORE the allowlist applies, so a future allowlist expansion cannot re-admit code-exec / SSRF surfaces.
4. **Ship an INVERSE-COMPLETENESS test.** Walk the MRO of every allowlisted type and AST-scan every source path for `exec` / `eval` / `compile` / `import_module` / `__import__` / unsafe deserialization (`pickle|marshal|dill|cloudpickle.loads`, `yaml.load`) / code-executor references — so a future code-executing node added under a familiar name fails the allowlist TEST, not production.
5. **Reject NaN/inf/out-of-range at the confidence-gate construction boundary** (e.g. pydantic `ConfigDict(extra="forbid", allow_inf_nan=False)` + `math.isfinite` check), closing the confidence-bypass class.

```python
# DO — allowlist ∩ registry at the choke point, denylist floor first
candidates = (registry.types() - _DANGEROUS_NODE_TYPES) & _SAFE_NODE_TYPES
if plan_node.node_type not in candidates:
    raise UnsafeNodeTypeError(plan_node.node_type)   # at _realize(), add-node time

# DO NOT — registry minus denylist (every new node implicitly trusted)
if plan_node.node_type in _DANGEROUS_NODE_TYPES:
    raise UnsafeNodeTypeError(plan_node.node_type)
workflow.add_node(plan_node.node_type, ...)
```

**Reference implementation (Python SDK 2.27.0):** `src/kailash/workflow/from_brief.py` (`_SAFE_NODE_TYPES`, `_DANGEROUS_NODE_TYPES`, `_realize`), `kailash/_from_brief/{validator,confidence}.py`, `tests/unit/workflow/test_from_brief_safe_allowlist.py` (inverse-completeness test). Cross-SDK: the default-deny + choke-point + inverse-completeness triad is language-invariant; equivalent brief-to-primitive surfaces in other SDK implementations carry the same obligation.

Origin: from_brief security model (issue #1125, shipped in 2.27.0; security fixes PR #1184, 2026-05-27). Redteam evidence: a typed-plan shape bypassed the higher validate gate, and a static "denylist closed" verdict was disproven by construction (a transformer node realized through the gate) — resolved by moving enforcement to the choke point and switching to the positive allowlist.

## Error Message Security

Never return raw exception messages to clients — they leak file paths, class names, database URLs.

```
# ❌ WRONG — leaks internals
return {"error": str(exception)}

# ✅ CORRECT — log internally, return generic message
log_exception("Operation failed")
return {"error": "Internal server error"}
```

## Common Vulnerabilities Prevented

| Vulnerability            | Prevention Pattern                        |
| ------------------------ | ----------------------------------------- |
| SQL Injection            | Use DataFlow parameterized nodes          |
| Code Injection           | Avoid `eval()`, use PythonCodeNode safely |
| Credential Exposure      | Environment variables, secret managers    |
| XSS                      | Output encoding, CSP headers              |
| SSRF                     | DNS-pinned delivery, blocked IP ranges    |
| CSRF                     | Token validation, SameSite cookies        |
| Insecure Deserialization | Validate serialized data                  |

## Integration with Rules

Security patterns are enforced by:

- `.claude/rules/security.md` - Security rules
- `.claude/hooks/validate-bash-command.js` - Command validation
- `gold-standards-validator` agent - Compliance checking

## When to Use This Skill

Use this skill when:

- Handling user input or external data
- Storing or transmitting credentials
- Making API calls to external services
- Implementing authentication/authorization
- Conducting security reviews
- Preparing for deployment

## Related Skills

- **[17-gold-standards](../17-gold-standards/SKILL.md)** - Mandatory best practices
- **[16-validation-patterns](../16-validation-patterns/SKILL.md)** - Validation patterns
- **[01-core-sdk](../01-core-sdk/SKILL.md)** - Core workflow patterns
- **[12-testing-strategies/oidc-offline-crypto-test-vectors](../12-testing-strategies/oidc-offline-crypto-test-vectors.md)** - Alg-confusion (RS256→HS256 / alg:none) fail-closed verification defense + deterministic offline asymmetric-crypto test vectors

## Support

For security-related questions, invoke:

- `security-reviewer` - OWASP-based security analysis
- `gold-standards-validator` - Compliance checking
- `testing-specialist` - Security testing patterns
