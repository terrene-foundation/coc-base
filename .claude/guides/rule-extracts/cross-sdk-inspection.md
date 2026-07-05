# Cross-SDK Issue Inspection — Extended Examples

Companion reference for `.claude/rules/cross-sdk-inspection.md`. Holds the full
code examples the rule body abridges to a compact DO/DO-NOT + pointer, so the
path-scoped rule stays under the per-profile rule-injection budget (`loom#678`).

## Rule 3a — Structural API-Divergence Disposition (full test pair)

When the sibling SDK reports a bug at an API surface this SDK does NOT expose,
the disposition MUST include BOTH a sibling-path Tier 2 test (the bug class may
manifest at a different parameter-binding surface here) AND a signature-invariant
test (so a future arity-growth refactor toward the sibling shape fails loudly).

```python
# DO — both tests; one exercises the sibling path, one locks the signature
@pytest.mark.regression
async def test_issue_XXX_cross_sdk_parity_via_sibling_path(test_suite):
    # The Rust bug triggered at execute_raw(sql, params). Python execute_raw
    # has no params. The parameter-binding path in Python is Express.bulk_create.
    db = DataFlow(test_suite.config.url)
    # ... exercise shrinking-arity bulk_create against real Postgres
    assert poisoned_result.get("success") is True

@pytest.mark.regression
def test_issue_XXX_execute_raw_has_no_params_arg():
    # Structural invariant: if this signature ever grows a `params` kwarg,
    # the sibling bug class becomes reachable here and cross-SDK parity
    # MUST be re-audited.
    import inspect
    from dataflow.core.pool_lightweight import LightweightPool
    sig = inspect.signature(LightweightPool.execute_raw)
    non_self = [p.name for n, p in sig.parameters.items() if n != "self"]
    assert non_self == ["sql"], f"signature drifted: {sig}"

# DO NOT — close the cross-SDK issue with only a hand-waving comment
gh issue close XXX --comment "N/A — Python execute_raw has no params arg"
# ↑ no test, no invariant; a future refactor silently reopens the bug class
#   and the original sibling-report loses its correlation
```

**BLOCKED rationalizations:**

- "The signatures are obviously different, no test needed"
- "Our implementation can't have that bug"
- "The structural invariant is enforced by the type system"
- "Cross-SDK is belt-and-suspenders; one test is enough"
- "We'll add the invariant test when the signature changes"

Evidence: issue #525 (cross-SDK of the Rust SDK's #424) — Python `execute_raw(sql)`
structurally cannot hit the Rust binding-layer UTF-8 corruption; disposition landed
both an Express `bulk_create` sibling-path test AND a signature invariant test
locking `LightweightPool.execute_raw(sql)` at PR #528.

## Rule 4 — Byte-Vector Pinning (full example)

Any helper claiming byte-shape parity with a sibling SDK MUST pin ≥3 byte-vector
cases empirically derived from the sibling SDK's actual output, covering sentinels
(empty input, all-zero, single-byte), as raw hex strings in a regression test — NOT
abstract "same length" / "starts with sha256:" assertions.

```python
# DO — pin actual byte vectors from sibling SDK
@pytest.mark.regression
def test_fingerprint_secret_matches_kailash_rs_byte_for_byte():
    # Vectors derived from the Rust SDK Blake2bVar(4) digest output at v3.23.0
    cases = [
        (b"",                             "00000000"),  # empty-input sentinel
        (b"hello",                        "8ed5b1d4"),
        (b"\x00" * 32,                    "0a0e0a8b"),
        (b"OPENAI_API_KEY=sk-12345",      "f3c2b1d8"),
    ]
    for raw, expected in cases:
        assert fingerprint_secret(raw) == expected, f"divergence on {raw!r}"

# DO NOT — abstract parity claim with no byte pinning
def test_fingerprint_secret_has_4_hex_chars():
    out = fingerprint_secret(b"hello")
    assert len(out) == 4 and all(c in "0123456789abcdef" for c in out)
    # ↑ proves shape but NOT byte-for-byte equivalence to the sibling SDK
```

The empty-input sentinel is the canonical divergence point: a digest mode emits a
stable hash; a MAC mode emits a length-prefixed empty MAC (`Blake2bMac<U4>` vs
`Blake2bVar(4)` — lengths agree, bytes don't). Evidence: the Rust SDK PR #598 first
cut shipped MAC mode while kailash-py uses digest mode; caught by 2 reviewers only
because abstract parity assertions were absent.
