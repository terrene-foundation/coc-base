---
priority: 10
scope: path-scoped
paths:
  - "**/routes/**"
  - "**/handlers/**"
  - "**/api/**"
  - "**/*_endpoint*"
  - "**/*_handler*"
  - "**/*_route*"
---

# UI-Backend Defense Rules


<!-- slot:neutral-body -->

Backend handlers MUST treat the UI as hostile input. The UI's value restrictions — dropdown allowlists, radio-button groups, required-field markers, client-side validation — are ergonomics, not security boundaries. A backend handler that relies on "the UI only sends these values" is one UI bug (or one curl-wielding attacker) away from accepting inputs it was never designed for.

This rule mandates layered defense across the three tiers of a typical request pipeline (handler → validator → model) and targets the specific failure modes documented in gh-coc-claude-rs#51 item 2: enum-trust bypass, shape-bypass via non-dict inputs, and admin-endpoint implicit trust.

## MUST Rules

### 1. Every Backend Handler With An Enum / Pluggable Value MUST Allowlist It Server-Side

Any handler accepting an enum, a string with a finite set of valid values, or a pluggable type identifier (policy type, auth method, notification channel, posture mode) MUST validate the value against a server-side allowlist, regardless of what the UI does.

```python
# DO — server-side allowlist, independent of UI
ALLOWED_AUTH_METHODS = {"password", "oauth2", "saml", "api_key"}

@app.post("/admin/auth/configure")
async def configure_auth(payload: AuthConfig):
    if payload.method not in ALLOWED_AUTH_METHODS:
        raise HTTPException(400, f"auth.method must be one of {sorted(ALLOWED_AUTH_METHODS)}")
    # ... proceed with validated method

# DO NOT — trust the UI's dropdown
@app.post("/admin/auth/configure")
async def configure_auth(payload: AuthConfig):
    # UI only shows the 4 valid methods, so payload.method is "safe"
    apply_auth_config(payload.method, payload.settings)
# ↑ a UI bug that sends method=None, or a curl bypass that sends
#   method="__proto__" / method="disabled" / method="" drops
#   straight into apply_auth_config() with no server-side gate
```

**BLOCKED rationalizations:**

- "The UI already restricts this to four values"
- "Admin-only endpoint, no allowlist needed"
- "Pydantic / model validator catches unknown methods anyway"
- "We can add the allowlist if the UI ever changes"
- "Internal tool, threat model doesn't include curl"

**Why:** UI restrictions and backend security are different concerns. The UI's dropdown is UX affordance — it helps users pick a valid value. The backend allowlist is an authentication/authorization gate — it refuses invalid values regardless of source. Removing either breaks its concern; collapsing them into one check leaves the security side of the surface exposed to every non-UI caller (tests, scripts, attackers, future integrations).

### 2. Allowlist Validators MUST Reject Unexpected SHAPE Explicitly

The allowlist check MUST run on a value of the expected shape (dict with expected keys, list of expected types, scalar of expected type). If the input has the wrong shape — naked string where a dict is expected, a JSON list where an object is expected, `None` where a value is required — the validator MUST explicitly reject it with a typed error.

Implicit shape-checking via "attribute access will raise" is BLOCKED. The shape check MUST be a separate explicit step.

```python
# DO — explicit shape check BEFORE the allowlist
def validate_policy(payload: object) -> None:
    if not isinstance(payload, dict):
        raise ValidationError(
            f"policy payload must be a JSON object; got {type(payload).__name__}"
        )
    if "type" not in payload:
        raise ValidationError("policy payload missing required key 'type'")
    if payload["type"] not in ALLOWED_POLICY_TYPES:
        raise ValidationError(
            f"policy.type must be one of {sorted(ALLOWED_POLICY_TYPES)}"
        )

# DO NOT — implicit shape check via .get() or attribute access
def validate_policy(payload):
    if payload.get("type") not in ALLOWED_POLICY_TYPES:  # payload might be a list
        raise ValidationError("unknown policy type")
# ↑ payload=[{"type": "rbac"}] reaches .get() and raises AttributeError;
#   payload=None short-circuits the check entirely; payload="rbac"
#   (naked string) also bypasses — every "unexpected shape" takes a
#   different unhandled path.
```

**BLOCKED rationalizations:**

- "Model validator catches non-dict inputs anyway"
- "Pydantic handles shape, we only need to check the enum"
- "The `.get()` will return None, which fails the allowlist check"
- "Wrong shape just raises AttributeError, which is fine"

**Why:** A future refactor that replaces Pydantic with a lighter validator, or inlines the check without shape validation, silently re-opens shape-bypass. Explicit shape rejection converts "we hope the validator catches this" into "the validator catches this because the check is here." The shape check is also the grep target a reviewer needs to verify the defense is in place.

### 3. Layered Defense — Allowlist At Handler, Shape-Reject At Validator, Type-Strict At Model

Every enum / pluggable-value field MUST be defended at three layers:

1. **Handler**: allowlist check (MUST Rule 1)
2. **Validator**: shape rejection + allowlist (MUST Rule 2)
3. **Model**: type-strict field (Pydantic `Literal[...]`, SQLAlchemy `Enum`, or typed dataclass)

Removing any one layer on the grounds that "another layer catches it" is BLOCKED.

```python
# DO — all three layers in place
from typing import Literal

class AuthConfig(BaseModel):
    # Layer 3: model is type-strict
    method: Literal["password", "oauth2", "saml", "api_key"]
    settings: dict

ALLOWED_AUTH_METHODS = {"password", "oauth2", "saml", "api_key"}

def validate_auth_payload(payload: object) -> AuthConfig:
    # Layer 2: shape rejection + allowlist
    if not isinstance(payload, dict):
        raise ValidationError("auth payload must be a JSON object")
    if payload.get("method") not in ALLOWED_AUTH_METHODS:
        raise ValidationError(f"method must be one of {sorted(ALLOWED_AUTH_METHODS)}")
    return AuthConfig(**payload)

@app.post("/admin/auth/configure")
async def configure_auth(raw: dict):
    # Layer 1: handler allowlist (even though validator will catch it)
    if raw.get("method") not in ALLOWED_AUTH_METHODS:
        raise HTTPException(400, "invalid auth method")
    config = validate_auth_payload(raw)
    return apply_auth_config(config)

# DO NOT — collapse to one layer on the grounds the model catches it
@app.post("/admin/auth/configure")
async def configure_auth(config: AuthConfig):  # Pydantic "will catch it"
    return apply_auth_config(config)
# ↑ works today. Tomorrow someone switches to `raw: dict` + manual
#   dispatch for performance / flexibility, and every layer that
#   "used to catch it" is gone.
```

**Why:** Each layer catches a different failure mode. The handler catches the raw-request shape before anything is parsed; the validator catches structured-but-invalid input; the model catches type-level contract violations at field access. One layer's guarantees do not extend to the others because each is reached via a different future refactor path. The defense-in-depth cost is low (three short checks); the collapse cost is a CVE.

## MUST NOT

- Implicitly trust a value because "it came from our UI"

**Why:** The UI is one of N callers of the endpoint; every other caller (tests, scripts, curl, future integrations, attackers who bypass the UI) is unconstrained by UI rules.

- Move allowlist logic into client-side code

**Why:** Client-side code is inspectable and modifiable; moving server enforcement into it deletes the enforcement entirely.

- Replace a handler-level allowlist with "the model validator handles it"

**Why:** The handler sees the raw request; the model sees parsed-and-typed input. A shape that never reaches the model (because the parser rejected it) still reached the handler — where decisions like logging, metrics, and rate-limiting already fired on untrusted input.

## Audit Protocol

Mechanical audit, run during `/redteam`:

```bash
# Every handler accepting an enum should have a matching server-side allowlist set
rg -A 20 '(@app\.(post|put|delete|patch)|def .*_endpoint|async def .*_handler)' \
   | rg -B 1 'Literal\[|Enum\[' \
   | rg 'ALLOWED_|ALLOWLIST_|VALID_' -c || echo "HIGH: handler with enum lacks allowlist constant"

# Every validator MUST include an isinstance check before the allowlist check
rg -B 2 'not in ALLOWED_|not in ALLOWLIST_' \
   | rg 'isinstance\(|is None|type\(' -c || echo "HIGH: allowlist without shape check"
```

Origin: gh-coc-claude-rs#51 item 2 (2026-04-17). Admin endpoints that accept `policy_type` / `auth_method` / `classification_mode` were found to rely on the admin UI's dropdown as the only validation, with no server-side allowlist and no shape check. A UI bug that sent `None` (instead of the currently-selected value) reached the model's `Enum` field and the attack was caught by Pydantic — but only because the model happened to use a strict enum. The next refactor to replace Pydantic with a lighter validator would have silently re-opened the bypass. This rule codifies the three-layer defense so no future refactor collapses the contract.

<!-- /slot:neutral-body -->
