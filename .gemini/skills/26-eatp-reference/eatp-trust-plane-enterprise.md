# Skill: TrustPlane Enterprise Features

Quick reference for TrustPlane enterprise capabilities. For full documentation, see the trust-plane module.

## Budget Enforcement (`trustplane.project` + `trustplane.models`)

Financial constraint tracking across sessions. Budget checks are integrated into `check()` and `record_decision()`.

**Setup**: Enable budget tracking in the constraint envelope:

```python
envelope = ConstraintEnvelope(
    financial=FinancialConstraints(
        max_cost_per_session=100.0,   # Total session budget
        max_cost_per_action=25.0,     # Per-decision limit
        budget_tracking=True,          # Enable tracking
    ),
    signed_by="Alice",
)
```

**Recording costs**: Pass `cost` on `DecisionRecord`:

```python
dec = DecisionRecord(
    decision_type=DecisionType.TECHNICAL,
    decision="Use modular architecture",
    rationale="Separation of concerns",
    cost=5.50,  # Tracked when budget_tracking=True
)
await project.record_decision(dec)
```

**Checking budget status**:

```python
status = project.budget_status
# {
#     "budget_tracking": True,
#     "session_cost": 25.0,
#     "max_cost_per_session": 100.0,
#     "max_cost_per_action": 25.0,
#     "remaining": 75.0,
#     "utilization": 0.25,
# }
```

**Budget exhaustion** raises `BudgetExhaustedError` (subclass of `ConstraintViolationError`):

```python
from kailash.trust.plane.exceptions import BudgetExhaustedError
try:
    await project.record_decision(expensive_decision)
except BudgetExhaustedError as e:
    print(f"Budget exceeded: session={e.session_cost}, limit={e.budget_limit}")
```

**NaN protection**: All 7 cost paths validate with `math.isfinite()` (Pattern 12). NaN/Inf/negative costs are blocked or rejected.

## RBAC (`trustplane.rbac`)

4 roles: `admin` (all ops), `auditor` (read-only), `delegate` (operational), `observer` (view-only). Persisted atomically to `rbac.json`. mtime-based cache invalidation for cross-process consistency (R14 fix F6).

```bash
attest rbac assign alice admin
attest rbac check alice decide    # ALLOWED / DENIED
attest rbac list
attest rbac revoke alice
```

## OIDC Identity (`trustplane.identity`)

JWT verification with JWKS auto-discovery. Configurable TTL caching (default 1 hour). Automatic cache invalidation on `kid` mismatch (key rotation).

- HTTPS validation on `issuer_url` (R14 fix H-4)
- `math.isfinite()` on `max_age_hours` (R14 fix H-3)
- Algorithm-first key resolution (R14 fix H-5)
- Providers: `okta`, `azure_ad`, `google`, `generic_oidc`

```bash
attest identity setup --issuer https://dev-123.okta.com --client-id abc123 --provider okta
attest identity verify eyJhbGciOiJSUzI1NiI...
```

## SIEM (`trustplane.siem`)

CEF and OCSF formats. Syslog: UDP (RFC 3164), TCP, TLS (RFC 5425 with octet-framing). Mutual TLS support.

- TLS socket leak prevention on handshake failure (R14 fix F4)
- CEF header newline/CR injection prevention (R14 fix F10)
- Explicit `limit=100_000` on list calls (R14 fix H-2)

```bash
attest siem test --format cef --host siem.example.com --port 6514 --tls
```

## Dashboard (`trustplane.dashboard`)

Web dashboard with bearer token auth. Token auto-generated, stored in `.dashboard-token`. `hmac.compare_digest()` for constant-time token comparison. `safe_read_text()` for token loading (R14 fix H-1).

```bash
attest dashboard              # Launch with auth
attest dashboard --no-auth    # Development mode
```

## Archive (`trustplane.archive`)

ZIP bundles with SHA-256 integrity hash. `hmac.compare_digest()` for hash verification (R14 fix C-2). Tamper detection on restore.

```bash
attest archive create --max-age-days 365
attest archive list
attest archive restore archive-20260101-120000
```

## Shadow Mode (`trustplane.shadow_store`)

Separate `shadow.db`, WAL journal mode. Retention: age-based, count-based, size-based. `validate_id()` on all public methods.

```bash
attest shadow-manage cleanup --max-age-days 90 --max-sessions 10000
attest shadow-manage stats
```

## Cloud Key Managers (`trustplane.key_managers`)

| Provider | Module                        | Algorithm   | Notes               |
| -------- | ----------------------------- | ----------- | ------------------- |
| Local    | `key_manager`                 | Ed25519     | Development default |
| AWS KMS  | `key_managers.aws_kms`        | ECDSA P-256 | Ed25519 unavailable |
| Azure KV | `key_managers.azure_keyvault` | ECDSA P-256 | Ed25519 unavailable |
| Vault    | `key_managers.vault`          | ECDSA P-256 | Via Transit engine  |

All cloud providers wrap native exceptions into `KeyManagerError` subclasses.

## Exception Hierarchy (23 classes)

All trace to `TrustPlaneError` with `.details: dict[str, Any]`. Key branches:

- `TrustPlaneStoreError` (6 subclasses) — `RecordNotFoundError` also inherits `KeyError`
- `KeyManagerError` (4 subclasses) — provider + key_id attributes
- `ConstraintViolationError` → `BudgetExhaustedError` — session_cost, budget_limit, action_cost
- `IdentityError` (2 subclasses), `RBACError`, `ArchiveError`, `TLSSyslogError`
- `LockTimeoutError` (dual: `TrustPlaneError + TimeoutError`)

## See Also

- `.gemini/skills/project/trust-plane-security-patterns.md` — 13 security patterns
