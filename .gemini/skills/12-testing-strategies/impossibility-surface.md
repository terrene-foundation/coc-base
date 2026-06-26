---
name: impossibility-surface
description: "Justify happy-path test gaps that a lower-layer security control makes physically unreachable. Use when a test you 'should' write cannot be executed and you need to document why so auditors don't file the missing test as a bug."
priority: HIGH
tags: [testing, security, ssrf, allowlist, binding-layer, audit]
paths:
  - "tests/**"
  - "**/*test*"
  - "**/*spec*"
---

# Impossibility Surface

When a happy-path test for a layer cannot run because a documented security control or OS-level constraint at a *lower* layer makes it physically impossible, that test gap is an **impossibility surface**. The pattern says: write the gap down with the *reason* and a *link to where the coverage actually lives*, so future auditors don't file the missing test as a defect and the next contributor doesn't try to "fix" it by weakening the security control.

This is **not** a blanket excuse to skip tests. It is a narrow pattern for one specific situation: the test physically cannot run.

## Scope — What This Skill IS And IS NOT

**This pattern IS** a justification framework for happy-path coverage that genuinely cannot run at the layer being tested. The canonical example: a Python binding test that tries to wire a wiremock server bound to `127.0.0.1` on the loopback interface, but the underlying Rust HTTP client's SSRF guard blocks every loopback IP before the request leaves the binding. The happy path is documented and exercised at the lower layer (Rust wiremock suite); the higher layer (Python binding) cannot reach it without disabling the security control that is the entire point of the binding.

**This pattern is NOT** any of the following:

- A reason to skip **error-path tests**. Error paths are the entire reason the binding layer exists. They MUST be exercised at every layer.
- A reason to skip **eager-validation tests** (constructor-time rejection of bad input). Eager validation is fast, has no SSRF dependency, and MUST be tested at every layer.
- A reason to skip **rejection-behavior tests** (the test that proves the security control fires). Those are the most important tests; without them the control could be silently broken.
- A reason to skip a test because the test setup is *inconvenient*, *slow*, or *requires more infrastructure than the author wants to write*. Those gaps are technical debt, not impossibility surfaces.
- A reason to skip a test because *the team hasn't gotten to it yet*. That is a TODO, not an impossibility.

**The test:** a gap is an impossibility surface only if the answer to *"what would it take to write this test?"* is *"weaken or bypass a documented security control, or run the test in an environment that doesn't exist."* If the answer is *"more time"* or *"a fixture I haven't built"*, it is not an impossibility surface.

## MUST Rules

### 1. Document The Impossibility Surface At The Top Of The Test File

When a test file deliberately omits a category of test (e.g., happy-path roundtrips) because of an impossibility surface, the file MUST open with a docstring or comment block that:

1. States WHICH category of test is missing and at this layer
2. States WHY the lower-layer control makes it impossible (named control, file/line reference if available)
3. POINTS to the file/path where the coverage actually lives at the lower layer
4. CONFIRMS that error paths, rejection behavior, and eager validation ARE covered in this file

```python
# DO — opens with a clear impossibility-surface declaration
"""Tests for the Python binding of the ServiceClient.

These tests deliberately do NOT spin up a real HTTP server. The inner
HttpClient blocks every loopback and private IP (127.0.0.1, 10.x,
192.168.x, 169.254.x) before the allowlist check runs, so a
"roundtrip against localhost" is not reachable from Python — wiremock
binds to loopback and the SSRF guard rejects it before the request
leaves the binding.

Happy-path wiremock coverage lives in:
    crates/kailash-nexus/src/service_client.rs
    (lines 947-1300+, ~50 wiremock-backed test functions)

What THIS file covers:
- Module exports + exception hierarchy (lines 43-94)
- Constructor validation + header rejection (lines 101-165)
- SSRF blocking on every method, every private-IP shape (lines 172-239)
- Allowlist enforcement (lines 246-258)
- Exception class distinctness + type correctness (lines 265-306)
"""

# DO NOT — silently omit happy-path tests with no explanation
"""Tests for the ServiceClient Python binding."""

def test_constructor_rejects_invalid_url(): ...
def test_get_blocks_loopback(): ...
# (where are the happy-path tests? auditor files a HIGH finding)
```

**Why:** Without the docstring, the next auditor running coverage analysis sees "no happy-path tests for `client.get()` at the Python layer" and files it as a HIGH gap. They then waste hours either re-writing the test (which fails for the same reason) or trying to disable the SSRF guard (which is the security control). The docstring is the cheapest possible defense against repeat-discovery.

### 2. Link Both Directions

The lower-layer test file (where the happy paths live) MUST also have a comment near the wiremock fixture pointing back to the higher-layer test file, so anyone editing the SSRF guard sees both places that depend on it.

```rust
// DO — bidirectional cross-reference in the Rust test file
// NOTE: These wiremock tests are the ONLY happy-path coverage for
// ServiceClient. The Python binding tests at
// the Python binding's `tests/test_service_client.py` cannot
// reach happy paths because HttpClient::validate_url() blocks
// loopback before the allowlist is checked. If you change the
// SSRF guard, both files need to be reviewed together.
#[tokio::test]
async fn get_typed_success() { ... }

# DO NOT — wiremock fixture with no reference back to the binding-layer constraint
#[tokio::test]
async fn get_typed_success() { /* wiremock setup */ }
# (the next person to "harden" the SSRF guard breaks the binding tests
#  and doesn't know they should look at the Rust suite for the gap)
```

**Why:** Single-direction documentation rots the moment the lower-layer file is refactored. Bidirectional cross-references are the structural defense against drift.

### 3. The Impossibility Must Be Verified, Not Assumed

Before declaring a test "impossible at this layer" the author MUST attempt to write it once and observe the actual failure. Document the failure mode (which security control, which line, which exception). "I think the SSRF guard would block this so I won't try" is BLOCKED.

```python
# DO — verified impossibility, observed failure mode
# Attempted 2026-04-14: tried to wire `wiremock` against 127.0.0.1:randomport
# and call client.get("/health"). Result: ServiceClientHttpError raised at
# request time with message "URL points to private/loopback network",
# from HttpClient::validate_url() at http_client.rs:300 (private/loopback
# block). Confirmed the SSRF guard (Layer 3) fires BEFORE the allowlist
# (Layer 4 at line 306-307), so even `allowed_hosts=["127.0.0.1"]` does
# not bypass it. Test confirms this: `allowlist_still_blocks_private_ips`.

# DO NOT — assumed impossibility, no verification
# (no comment, just "doesn't make sense to test this here")
```

**Why:** Assumed impossibilities are how real test gaps get hidden. A 5-minute experiment confirms whether the gap is genuine and produces the exact reference the docstring needs.

## MUST NOT

- Cite "impossibility surface" to skip an **error-path test**

**Why:** Error paths are testable at every layer (the error itself is the assertion). Skipping an error-path test by citing an impossibility surface is exactly the rationalization this skill exists to prevent.

- Cite "impossibility surface" to skip an **eager-validation test** (constructor-time rejection)

**Why:** Eager validation runs in `__init__` / `new()` — it never reaches the lower-layer security control, so the security control cannot make it impossible.

- Cite "impossibility surface" to skip a **rejection-behavior test** that proves the security control fires

**Why:** Rejection tests ARE the test of the security control. Skipping them means the control could silently break and nothing would notice.

- Use "impossibility surface" as a synonym for "I haven't written this yet"

**Why:** That is a TODO. Mark it as a TODO and either fix it or convert it to a real impossibility surface with the verified failure mode.

**BLOCKED rationalizations:**

- "The lower layer covers it, so we don't need it here"
- "It would be redundant to test it at both layers"
- "The test would just exercise the security control, not the new code"
- "Setting up wiremock at this layer is too much work"
- "The team hasn't gotten to it yet"

## Cross-References

- `rules/testing.md` — Tier coverage requirements; impossibility surfaces are exceptions to per-tier coverage rules and MUST be documented.
- `skills/spec-compliance/SKILL.md` — Spec-compliance verification protocol; auditors checking new modules for tests should consult impossibility-surface declarations before filing gaps.
- Layered system coverage (when one layer wraps another) is a recurring pattern across Kailash framework boundaries (Python bindings → Rust core, Nexus → DataFlow, Trust plane → application code). The same docstring pattern applies wherever a higher layer cannot reach a lower-layer-protected path.

Origin: 2026-04-14 — a binding's Python test file could not exercise happy-path roundtrips because the underlying core's `HttpClient::validate_url()` blocked loopback before the allowlist ran. The 38 Python binding tests cover error paths, eager validation, and rejection behavior; happy-path coverage stays in the core wiremock suite. Without the docstring at the top of the Python test file, every code review re-discovered the gap.
