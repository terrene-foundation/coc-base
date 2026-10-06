# Multi-Site Kwarg Plumbing — depth

Depth for `rules/security.md` § "Multi-Site Kwarg Plumbing". The rule carries the MUST clause; this
file carries the worked DO/DO-NOT, the BLOCKED corpus, and the origin.

When a security-relevant kwarg (classification policy, tenant/clearance scope, audit ID) is plumbed
through a helper, EVERY call site MUST be updated in the SAME PR. Primary-site-only is BLOCKED.

```python
# DO — grep every caller, update every sibling, same PR
# $ grep -rn 'validate_model(' src/ packages/
# → both production call sites get policy+model_name in this PR
engine.validate_record(instance)   -> validate_model(instance, policy=..., model_name=...)
express._validate_if_enabled(...)  -> validate_model(instance, policy=..., model_name=...)

# DO NOT — update the primary site, skip the sibling
# (the unpatched sibling still leaks classified field names in error messages)
engine.validate_record(instance)   -> validate_model(instance, policy=..., model_name=...)
express._validate_if_enabled(...)  -> validate_model(instance)   # sibling bypasses the sanitiser
```

**BLOCKED rationalizations:** "The primary call site is the one users hit 99% of the time" / "The
sibling is rarely used; we'll patch it in a follow-up" / "The helper signature is
backwards-compatible, sibling can stay as-is" / "Test coverage will catch divergence later" / "The
kwarg has a safe default — siblings still get baseline behaviour".

**Why:** A sibling left on the unqualified signature ships the EXACT failure mode the kwarg was
added to fix — and the "safe default" the last rationalization leans on IS the insecure default,
because the default is what the vulnerable path was already doing. The grep is the whole defense:
the kwarg's presence at one call site tells you nothing about the others, and nothing in the type
system links them.

Origin: PR #522 / PR #529 (2026-04-19) — BP-049 validation-sanitiser plumbing missed one sibling.
