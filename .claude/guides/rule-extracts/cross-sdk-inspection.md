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

**BLOCKED rationalizations:**

- "Both SDKs use SHA-256; the implementations must agree"
- "Length + hex-char regex is sufficient"
- "We'll align the byte shapes when a divergence is reported"
- "The sibling SDK's vectors will drift; pinning them creates maintenance"
- "Cross-SDK log correlation is a nice-to-have, not a contract"

Origin: the Rust SDK PR #598 (2026-04-25) cross-SDK fingerprint helper — first cut had empty-input + algorithm-mode divergence with kailash-py; caught by reviewers but only because abstract parity assertions were absent. Codified to make the absence loud.

## Rule 3a — Origin

Origin: Issue #525 / PR #528 (2026-04-19) — the Rust SDK's #424 parity check.

## Rule 4a — Sibling-Canonical Fixtures (full example)

```
# DO — vendor the canonical file from the sibling repo
$ cp ../kailash-py/tests/fixtures/trace-event-canonical.json \
     bindings/<rust-sdk-repo>/test-vectors/trace-event-canonical.json
$ git add bindings/<rust-sdk-repo>/test-vectors/trace-event-canonical.json
# Update Rust loader + Python binding test + pin-gen script to read canonical shape — same PR.

# DO NOT — maintain a parallel hand-authored copy
# rs-side fixture: { "id": "v1", "input": "..." }   ← drifted shape
# py-side fixture: { "name": "v1", "input_repr": "..." }   ← canonical shape
# fingerprints happen to match for V4-V5 but not V1-V3; cross-SDK contract silently broken.
```

**BLOCKED rationalizations:**

- "Re-authoring is faster than vendoring; the JSON is short"
- "We'll vendor when the sibling SDK formalizes the canonical"
- "Field-name divergence is cosmetic, fingerprints still match"
- "Vendoring creates a sync burden every time the sibling updates the fixture"
- "Our loader can normalize either shape; vendoring isn't strictly required"

Parallel copies drift in shape (`id`/`input` vs `name`/`input_repr`) AND content (different cosmetic input data); vendoring guarantees byte-for-byte file-level parity. Orphaned consumers reading the old shape fail at first CI run with KeyError / `cannot find field` / "missing field `id`". The "sync burden" argument inverts the actual cost: parallel copies create N × M sync work on every fixture edit; vendoring creates 1 sync work per edit (a file copy from sibling repo).

Origin: the Rust SDK PR #761 (merged 8286775f, 2026-05-02) — vendored `test-vectors/trace-event-canonical.json` from `terrene-foundation/kailash-py:main`. Pre-vendor: rs-side fixture had `id`/`input` shape with V1-V3 inputs cosmetically different from py-side; V4-V5 fingerprints already matched, V1-V3 weren't. Post-vendor: all 5 V1-V5 fingerprints reproduce byte-for-byte through both Rust `compute_trace_event_fingerprint` AND Python binding `serialize_canonical_json`. Same-shard sibling consumer fix per `autonomous-execution.md` Rule 4 (Python binding test orphaned at first push, CI surfaced it, fix-immediately landed in same PR commit `10274a5d`). Codified GLOBAL via /sync rs Gate 1 (2026-05-02 second cycle).

## Rule 4b — Byte-CHANGING Canonical-Encoder Switches (full example)

```python
# DO — empirically classify, then pin current bytes for the byte-CHANGING site (py-illustrative)
@pytest.mark.regression
def test_witness_sign_payload_pins_current_default_str_bytes():
    # CROSS_SDK_BLOCKED: AuditAnchor reaches the encoder un-normalized; default=str
    # stringifies the dataclass repr, canonical_scalars asdict-expands it → different SHA.
    # the sibling SDK mirrors these CURRENT bytes; a single-SDK switch diverges the two SDKs.
    assert _sign_payload(fixture) == "edfdf52b…"   # tripwire until the sibling-SDK lockstep
# (the byte-NEUTRAL sibling — envelope_hash, where normalization pre-normalizes — SHIPPED single-SDK)

# DO NOT — switch a byte-CHANGING signing encoder single-SDK (py-illustrative)
def to_canonical_json(self):
    return json.dumps(self._hashable_dict(), default=canonical_scalars)  # was default=str
    # ↑ silently diverges every on-disk signed artifact from the sibling SDK's bytes;
    #   no test pins the old bytes, so the cross-SDK break is invisible until a verify fails.
```

**BLOCKED rationalizations:**

- "canonical_scalars is stricter / more correct, so switching is an improvement"
- "I reasoned through the types; it can't change the bytes" (reason is not a byte-diff)
- "The sibling SDK will catch up on its next release"
- "It's one encoder; the lockstep ceremony is overkill"
- "Pinning the OLD bytes blocks the migration I'm trying to do"

Empirical byte-diff (run the code, compare SHAs) is the only sound classifier — "I reasoned the types are equivalent" is exactly how the audit-chain / witness-family / envelope-HMAC sites were each almost switched single-SDK. Pinning the current bytes converts the deferred lockstep from an un-tracked memory into a test that fails loudly the moment someone switches one side.

## Rule 4c — Conformance-Vector Integrity-Manifest Re-Pin (full example)

```bash
# DO — re-pin the manifest in the same commit that changes the vector
$ edit tests/trust/pact/conformance/vectors/audit_anchor.json   # the canonical fix
$ shasum -a256 tests/trust/.../audit_anchor.json                 # recompute
$ edit PACT_VECTORS.sha256                                       # re-pin in SAME commit
$ shasum -a256 -c PACT_VECTORS.sha256                            # verify green before push

# DO NOT — change the vector, leave the manifest stale
$ edit tests/trust/.../audit_anchor.json && git commit           # manifest unchanged
# ↑ remote `Verify vector integrity` (shasum -c) goes RED ("audit_anchor.json: FAILED");
#   a "converged" redteam that never ran shasum -c declares clean over a red CI gate.
```

**BLOCKED rationalizations:**

- "The vector change is correct; the manifest is a separate concern"
- "CI will catch the manifest if it's stale" (catching it red ≠ shipping it green)
- "The redteam already converged" (a convergence claim over a red remote gate is false — `verify-resource-existence.md` MUST-4)
- "shasum -c isn't part of the canonical-conformance lens-set"

Evidence: PR #1411 (2026-06-20) shipped the correct `audit_anchor.json` canonical fix but omitted the `PACT_VECTORS.sha256` re-pin → red `Cross-SDK Conformance` gate that a prior "converged (2 clean passes)" redteam missed because no round ran `shasum -c`.

## Rule 4d — Prune-When-Unset From The Signing Pre-Image (full example)

```python
# DO — a shared signing-pre-image builder prunes the UNSET new field
_NEW_OPTIONAL_FIELDS = ("circuit_failure_threshold", "circuit_window_seconds", "circuit_cooldown_seconds")
def _signing_dict(model) -> dict:
    payload = model.model_dump(mode="json")
    nested = payload.get("operational")
    if isinstance(nested, dict):
        for f in _NEW_OPTIONAL_FIELDS:
            if nested.get(f) is None:
                nested.pop(f, None)          # unset → zero bytes → byte-identical to pre-addition
    return payload
# both sign AND verify call _signing_dict(...) (a mismatch breaks within-version signatures)

# DO NOT — add the field, sign the raw model_dump (null key changes EVERY signature)
payload = serialize_for_signing(model.model_dump(mode="json"))   # emits "circuit_*":null for a breaker-less
# → every pre-existing / cross-SDK-signed instance now fails verify(); a backward-compat + cross-SDK break
```

**BLOCKED rationalizations:**

- "The field is optional, adding it is backward-compatible"
- "`exclude_none=True` on the dump fixes it" (it drops OTHER pre-existing nulls too — a wider break)
- "I reasoned the bytes; a not-set field can't matter" (reason is not a byte-diff)
- "The within-version sign/verify round-trip passes" (it can't catch cross-VERSION — both halves use the new code)
- "It's a new SDK version; existing signatures re-issuing is fine"

Prune-when-unset makes the addition byte-neutral for the not-configured case (the BH3 unbound/bound pattern applied to field additions), confining the lockstep to instances that actually opt into the new field.

Evidence: kailash-py #1510 BH5 (PR #1671 → release #1672, kailash 2.48.0, 2026-07-11) — adding `circuit_*` fields to `OperationalConstraintConfig` (nested in the signed `ConstraintEnvelopeConfig`) changed the Ed25519 pre-image for every envelope; a two-round `/redteam` caught the HIGH, fixed via `_envelope_signing_dict` prune-when-unset.

## Rule 6 — Public-Artifact Private-Repo Reference (full example)

```markdown
# DO — public artifact names the SDK by role, keeps the bare number

CHANGELOG: "Aligned the trace-event fingerprint with the Rust SDK (parity vector #598)."

# DO NOT — public artifact names the private repo / org / crate-path / qualified issue

CHANGELOG: "Aligned with <private-org>/kailash-rs#598 (bindings/kailash-rs/test-vectors/…)."
```

**BLOCKED rationalizations:** "the repo name is public knowledge anyway" / "the CHANGELOG needs the exact cross-ref to be useful" / "it's only the org slug, not a customer name" / "the crate path documents where the vector lives" / "we'll scrub it before the next public release".

Public artifacts (PyPI/crates long-description, README, CHANGELOG) are indexed by every registry, search engine, and downstream consumer; a private-repo-qualified reference is a permanent, correlatable breadcrumb to the private Rust SDK's existence, org, and internal layout — the Foundation-Independence (Directive 0) + `#255`/`#260` no-private-identifiers fence.

Evidence: #1487 / #1488 (2026-07-02) — CHANGELOG (27 refs) + README (3 bare refs) genericized after a repo-path correction surfaced the private org in public-reaching artifacts.

## Examples — cross-SDK issue filing

```
# Issue #52 in the Rust SDK: per-request API key override
# → Filed kailash-py#12 as cross-SDK alignment
gh issue create --repo terrene-foundation/kailash-py \
  --title "feat(kaizen): per-request API key override" \
  --label "cross-sdk" \
  --body "Cross-SDK alignment with the Rust SDK's #52"
```
