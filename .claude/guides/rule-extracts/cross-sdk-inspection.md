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

## Rule 4e — Existing Fold Fields Round-Trip Through Every Serializer (full example)

```python
# DO — ONE shared fold-serde is the single encode/decode for the fold fields; EVERY
#      serializer routes through it, and an end-to-end real-store round-trip pins verify() TRUE.
# delegation_fold_serde.py — the single source of truth for the v2/v3 fold fields
_FOLD_FIELDS = ("constraints", "resource_limits", "scope", "multi_sig", "multi_sig_policy")
def encode_fold(model) -> dict:
    out = {}
    for f in _FOLD_FIELDS:
        v = getattr(model, f, None)
        if v is not None:                    # prune-when-unset keeps legacy byte-neutral
            out[f] = v
    return out
def decode_fold(payload: dict, model) -> None:
    for f in _FOLD_FIELDS:
        if f in payload:
            setattr(model, f, payload[f])
# chain-store, W3C-VC, JWT, UCAN, to_dict/from_dict ALL call encode_fold / decode_fold.

@pytest.mark.integration
async def test_v3_delegation_round_trips_through_real_store(trust_store):
    d = make_v3_delegation(constraints=..., scope=...)   # carries fold fields
    signed = sign(d)
    await trust_store.put(signed)
    got = await trust_store.get(signed.id)               # real SqliteTrustStore round-trip
    assert verify(got) is True                            # fails if ANY serializer dropped a fold field

# DO NOT — one serializer omits a fold field; it signs correctly but drops the field on round-trip
def _serialize_delegation(self, d):                       # the chain-store serializer
    return {"signing_payload_version": d.signing_payload_version}   # omits constraints/scope/...
# → a v2/v3 delegation reconstructs WITHOUT constraints → re-derived pre-image differs → verify() FALSE.
#   Every per-serializer unit test passes (each only round-trips the fields IT knows); only a HOLISTIC
#   post-multi-wave redteam tracing the real-store round-trip end-to-end catches it.
```

**BLOCKED rationalizations:**

- "Each serializer's unit test round-trips clean" (each only round-trips the fields IT knows — the cross-serializer gap is invisible to every one)
- "The signing path works, so the model is fine" (signing is not the failure; RECONSTRUCTION after one serializer drops a fold field is)
- "This serializer is new; the existing three are trusted" (the completeness contract is over EVERY serializer, re-derived per serializer)
- "A shared serde is over-engineering; each serializer can list its own fields" (parallel field lists drift exactly like `security.md` Multi-Site Kwarg Plumbing — one shared serde is the closure)

This is `security.md` Multi-Site Kwarg Plumbing at the persistence layer; the fix is ONE shared encode/decode serde (the Pre-Encoder Consolidation pattern) wired into every serializer + an end-to-end store/interop round-trip regression pinning `verify()` TRUE. Sibling of Rule 4d (opposite polarity: 4d governs a field ADDED, 4e governs an existing fold field DROPPED by one serializer).

Evidence: kailash-py #1841 (kailash 2.59.0, 2026-07-20) — `TrustLineageChain._serialize_delegation` carried `signing_payload_version` but omitted the v2/v3 fold fields (`constraints`/`resource_limits`/`scope`/`multi_sig`/`multi_sig_policy`) across four serializers; a v2/v3 delegation lost fold fields on real-`SqliteTrustStore` round-trip → `verify()` FALSE. A HOLISTIC post-multi-wave redteam caught the HIGH the per-shard reviews structurally could not; closed via a shared `delegation_fold_serde.py` wired into all four serializers (a `typing.Protocol` broke the CodeQL-flagged import cycle).

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

## Rule-body extracts (2026-08-19 structural cleanup)

Everything in the sections below was moved **VERBATIM** out of
`.claude/rules/cross-sdk-inspection.md` to hold that path-scoped rule under the
over-budget `consumer-test` / `consumer-sdk-src` rule-injection profiles.

**ZERO de-scoping.** Every `MUST`, `MUST NOT`, BLOCKED-rationalization entry,
DO/DO-NOT block and the failure-mode statement of every `**Why:**` line stayed in
the rule body. Each clause-scoped `Trust Posture Wiring` block in the rule body
keeps all 8 canonical field labels with their normative statements; what moved
here is the per-field measured narrative, the gate-sweep recipes, the severity /
no-dedicated-key reasoning, and the per-instance Origin provenance. The Wiring
sections below reproduce each block's PRE-EXTRACTION field text in full, so no
measured number and no falsifying context is lost — with ONE stated exception. The three
`**Regression-within-grace:**` bullets whose keys were cited-never-defined were updated IN
PLACE per loom#2102, so those three match neither the pre-extraction original (which named
the retired key) nor the current rule body (which additionally carries a clause-specific
`Rule-8 deviation:` sentence this extract does NOT — measured: 0 occurrences here, 3 in
`.claude/rules/cross-sdk-inspection.md`). For those three, the RULE BODY is authoritative on
the Rule-8 rationale; "retained verbatim" below holds for every other bullet.

### Rule 4b — Wiring narrative

Pre-extraction text of the rule body's `**Trust Posture Wiring (byte-changing
cross-SDK lockstep):**` block, retained verbatim:

- **Severity:** `halt-and-report` at gate-review (reviewer + security-reviewer at `/implement` confirm any canonical-encoder switch on a signing/hash site is classified byte-neutral-vs-byte-changing with an empirical byte-diff, and byte-changing switches carry a pinned-bytes tripwire + cross-SDK issue); `advisory` at hook layer.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (a byte-changing canonical switch shipped single-SDK, or unclassified) contribute per `trust-posture.md` MUST-4 (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (loom#2102).
- **Receipt requirement:** SessionStart `[ack: cross-sdk-inspection]` IFF `posture.json::pending_verification` includes this rule_id (soft-gate).
- **Detection mechanism:** Phase 1 — gate-level reviewer at `/implement`: for any diff touching a canonical-encoder/serialization helper on a signing/hash path, demand the empirical byte-diff classification + (for byte-changing) the pinned-current-bytes regression test + the cross-SDK lockstep issue. Probes `.claude/test-harness/probes/cross-sdk-inspection.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred): a regression-suite invariant enumerating signing-site encoders and asserting each pinned.
- **Violation scope:** this clause (canonical-encoder switches on cross-SDK signing/hash pre-images). Every violation row names the encoder site + the missing classification or tripwire.
- **Origin:** kailash 2.43.1 cross-SDK canonical-encoder family sweep (2026-06-20) — byte-diff classification of 97 `default=str` sites: audit-chain + witness-family + envelope-HMAC byte-CHANGING/lockstep, envelope_hash byte-NEUTRAL/shipped; `specs/trust-canonical-encoders.md`.

**Measured Origin, restated for readability.** The family sweep byte-diffed **97**
`default=str` sites at kailash 2.43.1 (2026-06-20). Verdicts: audit-chain +
witness-family + envelope-HMAC classified **byte-CHANGING** → cross-SDK lockstep
(current bytes pinned as tripwires, no single-SDK switch); `envelope_hash`
classified **byte-NEUTRAL** → shipped single-SDK. The falsifying context that
makes those numbers readable: a byte-NEUTRAL verdict means the normalization
layer already pre-normalizes every divergent type, so the swap emits **zero**
changed bytes on fixed production inputs — had any of the three byte-CHANGING
sites been read as neutral by reasoning rather than by byte-diff, the switch
would have shipped single-SDK and silently diverged every on-disk signed
artifact from the sibling SDK's bytes.

### Rule 4c — Wiring narrative

Pre-extraction text of the rule body's `**Trust Posture Wiring
(conformance-vector integrity-manifest re-pin):**` block, retained verbatim:

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + release-specialist at `/release` confirm any conformance-vector diff re-pins its `*.sha256`); `block` at the structural CI gate (`shasum -a256 -c` is a structural exit-code signal per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (vector changed without manifest re-pin) contribute per `trust-posture.md` MUST-4 (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (loom#2102).
- **Receipt requirement:** SessionStart `[ack: cross-sdk-inspection]` IFF `posture.json::pending_verification` includes this rule_id (soft-gate; shared with Rule 4b).
- **Detection mechanism:** Phase 1 — the CI `Verify vector integrity` step (`shasum -a256 -c *.sha256`) is the structural detector; the canonical-vector `/redteam` integrity-manifest-sweep lens enumerates every `*.sha256` and runs the check. Phase 2 (deferred): a pre-commit hook asserting that a changed `*.json` under a vectors dir co-changes its manifest.
- **Violation scope:** this clause (conformance-vector integrity-manifest re-pin). Every violation row names the vector file + its stale manifest.
- **Origin:** PR #1411 Gap 1 (2026-06-20) — the `PACT_VECTORS.sha256` re-pin omission a "converged" redteam missed because no round ran `shasum -c`; closed by commit `b4929d924` + a new integrity-manifest-sweep lens.

### Rule 4d — Wiring narrative

Pre-extraction text of the rule body's `**Trust Posture Wiring (cross-SDK
signed-model field additions):**` block, retained verbatim:

- **Severity:** `halt-and-report` at gate-review (reviewer + security-reviewer at `/implement` confirm any new field on a signing/hash-pre-image model prunes-when-unset AND ships a byte-identity regression pin); `advisory` at the hook layer (per `hook-output-discipline.md` MUST-2 a lexical model-field-addition scan cannot carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-11 → 2026-07-18).
- **Cumulative posture impact:** same-class violations (a new field on a cross-SDK signed model that changes the not-configured pre-image) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated per-clause trigger key (minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers a post-cutoff grace-period clause). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart `[ack: cross-sdk-inspection]` IFF `posture.json::pending_verification` includes this rule_id (soft-gate; one file-level `cross-sdk-inspection` ack shared across all sub-rules of this file).
- **Detection mechanism:** Phase 1 — gate-level reviewer at `/implement`: for any diff adding a field to a model reachable from a `serialize_for_signing` / signing / hash pre-image, demand the prune-when-unset builder + the byte-identity regression pin (not-configured → no new key; configured → new key present). Phase 2 (deferred): a regression-suite invariant enumerating signed-model fields and asserting each new one prunes-when-unset.
- **Violation scope:** this clause (new-field additions to cross-SDK signing/hash pre-image models). Every violation row names the model + the un-pruned field.
- **Origin:** kailash-py #1510 BH5 (PR #1671 → release #1672, kailash 2.48.0, 2026-07-11) — adding `circuit_*` fields to `OperationalConstraintConfig` (nested in the signed `ConstraintEnvelopeConfig`) changed the Ed25519 pre-image for every envelope; a two-round `/redteam` caught the HIGH, fixed via `_envelope_signing_dict` prune-when-unset (the BH3 unbound-form backward-compat pattern).

### Rule 4d — clause mechanism detail (the null-key pre-image change)

Moved verbatim from the Rule 4d clause body — the language-level mechanism that
makes a naive optional-field addition byte-CHANGING:

> `model_dump(mode="json")` / `to_dict()` emits a `None`-default field as a
> `null` key, so a naive addition changes the signed bytes for EVERY existing
> instance — a pre-existing or sibling-SDK-signed artifact then fails
> verification even though nothing about it changed.

### Rule 4e — Wiring narrative

Pre-extraction text of the rule body's `**Trust Posture Wiring (cross-SDK
signed-model serializer round-trip):**` block, retained verbatim:

- **Severity:** `halt-and-report` at gate-review (reviewer + security-reviewer at `/implement` + the holistic post-multi-wave redteam confirm every serializer of a signed model round-trips every fold field through one shared serde AND an end-to-end real-store regression pins `verify()` TRUE); `advisory` at the hook layer (per `hook-output-discipline.md` MUST-2 a serializer-completeness property is judgment-bearing over cross-file state, not a structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-20 → 2026-07-27).
- **Cumulative posture impact:** same-class violations (a fold field dropped by one serializer of a cross-SDK signed model) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated per-clause trigger key (minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers a post-cutoff grace-period clause). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition Rule 4d + `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart `[ack: cross-sdk-inspection]` IFF `posture.json::pending_verification` includes this rule_id (soft-gate; one file-level `cross-sdk-inspection` ack shared across all sub-rules of this file, matching 4b/4c/4d).
- **Detection mechanism:** Phase 1 — gate-level reviewer at `/implement` + the holistic post-multi-wave redteam: for any signed model with ≥2 serialization paths, enumerate every serializer and confirm each round-trips every fold field via the one shared serde, backed by an end-to-end real-store round-trip regression asserting `verify()` TRUE. Phase 2 (deferred): a regression-suite invariant enumerating signed-model serializers and asserting fold-field parity across all of them.
- **Violation scope:** this clause (existing-fold-field round-trip completeness across every serializer of a cross-SDK signed model). Every violation row names the model + the serializer that dropped the fold field.
- **Origin:** kailash-py #1841 (kailash 2.59.0, 2026-07-20) — `TrustLineageChain._serialize_delegation` carried `signing_payload_version` but omitted the v2/v3 fold fields (`constraints`/`resource_limits`/`scope`/`multi_sig`/`multi_sig_policy`) across four serializers; a v2/v3 delegation lost fold fields on real-`SqliteTrustStore` round-trip → `verify()` FALSE. A HOLISTIC post-multi-wave redteam caught the HIGH the per-shard reviews structurally could not; closed via a shared `delegation_fold_serde.py` wired into all four serializers (prune-when-unset legacy byte-neutral; a `typing.Protocol` broke the CodeQL-flagged import cycle). Sibling of Rule 4d (opposite polarity). Landed at loom via `/sync-from-build` Gate-1 classification.

### Rule 4e — clause mechanism detail (per-serializer blindness + detection surface)

Moved verbatim from the Rule 4e clause body and its `**Why:**` tail — why the gap
is invisible per-serializer, and which review surface can see it:

> This is invisible to every per-serializer unit test (each round-trips only the
> fields IT knows).

> Detection is the holistic post-multi-wave redteam (`agents.md` § Holistic
> Post-Multi-Wave Redteam) — per-shard reviews see only their own serializer
> diff, so the cross-serializer completeness gap is invisible to each.

> The single shared serde + a real-store round-trip regression is the only
> structural closure.

### Rule 6 — Wiring narrative

Pre-extraction text of the rule body's `**Trust Posture Wiring (cross-SDK
references in public-published artifacts):**` block, retained verbatim:

- **Severity:** `halt-and-report` at gate-review (reviewer + security-reviewer at `/implement` + release-specialist at `/release` grep CHANGELOG / README / package-metadata diffs for a private-repo-qualified Rust-SDK reference before publish); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (a private-repo-qualified Rust-SDK reference landing in a public-published artifact) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (loom#2102).
- **Receipt requirement:** SessionStart soft-gate `[ack: cross-sdk-inspection]` IFF `posture.json::pending_verification` includes this rule_id (shared with Rules 4b/4c).
- **Detection mechanism:** Phase 1 (gate-review) — release-specialist at `/release` + reviewer at `/implement` grep the public-artifact diff (`CHANGELOG.md`, `README.md`, `pyproject.toml`/`Cargo.toml` metadata) for `kailash-rs`, `<org>/kailash-rs`, `bindings/kailash-rs`, and `kailash-rs#` — any hit that is not a bare de-org'd number is a finding. Phase 2 (deferred) — a `scan-synced-disclosure.mjs` extension asserting no private-repo-qualified Rust-SDK token in public-published paths.
- **Violation scope:** this clause (Rule 6 — private-repo-qualified Rust-SDK references in public-published artifacts). Every violation row names the public artifact + the qualified token.
- **Origin:** kailash-py #1487/#1488 (2026-07-02) — CHANGELOG (27 refs) + README (3 bare refs) genericized after the repo-path correction surfaced the private org in public-reaching artifacts. Landed at loom via `/sync-from-build` py Shard B (journal/0402).

**The Phase-1 detection recipe, restated as a runnable sweep.** Grep the
public-artifact diff — `CHANGELOG.md`, `README.md`, and the `pyproject.toml` /
`Cargo.toml` package metadata — for the four token shapes `kailash-rs`,
`<org>/kailash-rs`, `bindings/kailash-rs`, and `kailash-rs#`. Any hit that is not
a bare de-org'd issue/PR number is a finding. Measured at the originating
incident: **27** qualified CHANGELOG references + **3** bare README references
were genericized; the falsifying context is that a bare de-org'd number (`#598`)
is NOT a finding — once the repo is unnamed the number discloses nothing, so a
sweep that flagged those too would be over-reporting rather than detecting.

### Automation — maintenance-workflow Phase 4.5

Moved verbatim from the rule body's `## Automation` section:

> When the Claude Code Maintenance workflow is active, the fix job prompt
> includes cross-SDK inspection as Phase 4.5 (between codify and commit). When
> paused, this must be done manually.

### Length rationale — full sub-rule enumeration

Moved verbatim from the rule body's length-rationale paragraph:

> Rule body exceeds the 200-line guidance. Named rationale:
> **cross-SDK-signing-contract scope** — the rule codifies the complete
> cross-SDK inspection + byte-parity contract across its numbered rules (1–6,
> incl. the 3a / 4b–4e sub-rules): every-issue inspection, cross-reference, EATP
> D6 semantics, structural API-divergence disposition, byte-vector pinning,
> vendored fixtures, byte-changing lockstep, integrity-manifest re-pin,
> new-field prune-when-unset (4d), existing-fold-field serializer round-trip
> (4e), and public-artifact disclosure — the four cross-SDK signing sub-rules
> (4b/4c/4d/4e) each carry the canonical 8-field clause-scoped Trust-Posture
> Wiring the post-MUST-8-cutoff clauses require. Depth (the full DO/DO-NOT
> examples + per-rule BLOCKED corpora) is EXTRACTED to
> `.claude/guides/rule-extracts/cross-sdk-inspection.md` to hold the rule body
> compact; the residual is the load-bearing clause + Wiring per sub-rule. The
> rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission
> cost (loaded only in sessions matching its `paths:` globs) and
> `rule-authoring.md` Rule 10's proximity-band gate does NOT fire. Per that MUST
> NOT the 200-line cap is guidance and overage is permitted with a named
> rationale. Sibling precedent: `tenant-isolation.md` + `security.md` length
> rationales.

### Why-line evidence tails

Per-instance evidence tails moved out of four `**Why:**` lines in the rule body.
Each line's FAILURE-MODE statement stayed there verbatim; only the trailing
instance evidence moved here.

**Rule 4** (byte-vector pinning) — the instance that makes an abstract parity
assertion pass while the bytes diverge:

> a "same length, same prefix" assertion passes when one side is
> `Blake2bMac<U4>` (MAC) and the other `Blake2bVar(4)` (digest) — lengths agree,
> bytes don't.

**Rule 4b** (byte-CHANGING canonical-encoder switches) — the three near-miss
signing sites:

> Empirical byte-diff is the only sound classifier — reasoning about
> type-equivalence is exactly how the audit-chain / witness-family /
> envelope-HMAC sites were each almost switched single-SDK.

**Rule 4e** (fold-field serializer round-trip) — the structural-closure argument:

> The single shared serde + a real-store round-trip regression is the only
> structural closure.

**Rule 6** (public-artifact references) — the bare-number carve-out rationale:

> The bare de-org'd number carries the technical cross-reference without the
> disclosure.

## Rule-body extracts (2026-09-13 rule-injection-budget pass)

A second structural-cleanup pass moved the remaining per-field narrative, the
probe-registration boilerplate and four rationale tails out of
`.claude/rules/cross-sdk-inspection.md`, to hold that path-scoped rule under the
over-budget `consumer-sdk-src` / `consumer-test` rule-injection profiles.

**ZERO de-scoping, measured.** The enforcement-token census of the rule body is
IDENTICAL before and after: `must_clause` 5, `must_token` 54, `must_not_token` 5,
`blocked_token` 11, `why_line` 12, and each of the eight canonical
`wiring:<Field>` bullet counts 5. Every `MUST`, `MUST NOT`, BLOCKED entry,
DO/DO-NOT fenced block and `**Why:**` failure-mode statement stayed in the rule
body; each clause-scoped Wiring block keeps all 8 canonical field labels with
their normative statements. `rule-authoring.md` Rule 10 / Rule 11 do NOT fire —
Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and
this rule is `scope: path-scoped`, so this is STRUCTURAL CLEANUP, not a Rule-10
paired extraction and therefore not Rule-11 recurrence input (the disposition
`journal/0148` recorded).

### Rule 4b — probe-registration narrative (moved 2026-09-13)

Moved verbatim from the rule body's `**Detection mechanism:**` bullet in the
`Trust Posture Wiring (byte-changing cross-SDK lockstep)` block. The bullet
retains the registered probe path, the row/pair counts, the per-clause firing-pair
enumeration, the fixtures directory, the load-bearing-pair identification and the
Phase-2 deferral; what moved is the registration bookkeeping, the correction
paragraph and the dispatchability/consumer narrative:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses in `clause-coverage-baseline.json`. The MUST-3a pair is the load-bearing one and is built to the shape the graduated deferral named: its violation pole NOTICES the structural API divergence and writes it up accurately — signature quoted, sibling-binding call sites enumerated with file and line — so a judge keying on whether the divergence was SEEN scores it clean, and it is a violation only because the disposition stopped at that note instead of landing the Tier-2 sibling-path test and the signature-invariant test the clause requires. An earlier revision of this row said the suite was NOT YET AUTHORED and pointed at `phase2-deferrals.json::probe_authorship_deferrals`; that was true when written and is now FALSE, corrected here rather than left standing, because a Wiring row claiming an absent tier is the same absence-reads-as-clean shape this rule governs. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives this suite and enforcement at those targets is gate-review.

### Rule 3a — the re-audit trigger (moved 2026-09-13)

Moved verbatim from numbered disposition 2 in the Rule 3a clause body. The
disposition itself ("A structural invariant test that pins the signature —
asserts the API signature that prevents the bug class from existing at this
surface") stayed in the rule:

> If a future refactor grows the signature to match the sibling shape, the invariant test fails loudly and forces a re-audit.

### Rule 4d — the lockstep-scope tail (moved 2026-09-13)

Moved verbatim from the Rule 4d clause body. The classification itself ("The
not-configured case is byte-NEUTRAL; ONLY the configured case is a coordinated
cross-SDK lockstep") stayed in the rule; what moved is the parenthetical
elaboration:

> The not-configured case is byte-NEUTRAL (no cross-SDK lockstep); ONLY the configured case is a coordinated lockstep (the sibling SDK adds the same field + the same prune-when-unset rule + matching key-order/number-typing).

### Rule 4e — the omitted-fold-field failure chain (moved 2026-09-13)

Moved verbatim from the Rule 4e clause body. The obligation (fold fields MUST
round-trip through EVERY serializer via one shared serde, plus the end-to-end
real-store `verify()` regression) stayed in the rule:

> When ONE serializer OMITS a fold field, a value that signs correctly reconstructs WITHOUT that field on round-trip → the re-derived pre-image differs → `verify()` returns FALSE → the signing surface is non-functional end-to-end.

## Rule-body extracts (2026-09-15 rule-injection-budget pass)

A third structural-cleanup pass cut `.claude/rules/cross-sdk-inspection.md` further
to relieve the two remaining tight injection-budget profiles (`consumer-test`,
`consumer-sdk-src`), both of which this `priority: 10` path-scoped rule fires in.

**ZERO de-scoping, MEASURED on this tree — not asserted.** The enforcement-token
census of the rule body is IDENTICAL before and after: `must_clause` 5,
`must_token` 54, `must_not_token` 5, `blocked_token` 11, `why_line` 12, and each
of the eight canonical `wiring:<Field>` bullet counts 5. No citation member left
the file (the three citation classes are compared as SETS with duplicates
collapsed, per `check-descoping.mjs`'s own design call 1). Measured by importing
`extractInventory` from `.claude/bin/check-descoping.mjs` and diffing the
merge-base blob against the working tree — `check-descoping.mjs`'s own CLI
resolves both sides with `git show` and has no working-tree mode, so on an
uncommitted lane its `CLEAN` is not evidence about an unstaged diff. The harness
was fired first at a known-answer mutation (one `**Why:**` line deleted, one
`BLOCKED` token removed, the sole `specs/trust-canonical-encoders.md` citation
dropped) and returned three findings, so it is shown to discriminate HERE.

`rule-authoring.md` Rule 10 / Rule 11 do NOT fire, on the same disposition the
2026-09-13 pass recorded: Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` rules ONLY, and this rule is `scope: path-scoped`. This is
STRUCTURAL CLEANUP, not a Rule-10 paired extraction, and therefore not Rule-11
recurrence input.

### What was CONSOLIDATED rather than moved

Five per-block `**Trust Posture Wiring (…)**` intro lines each carried a private
pointer into this guide ("Per-field narrative + the sweep recipe", "the
missed-`shasum -c` convergence account", "the grep path"). All five pointers were
folded into the rule's single file-level `Depth — … — lives in …` line; the bold
block titles stayed. The guide sections they pointed at are unchanged.

Four `**Receipt requirement:**` bullets (Rules 4c/4d/4e/6) were replaced by
"as Rule 4b — one file-level ack covers every sub-rule". The normative statement
they restated verbatim — SessionStart `[ack: cross-sdk-inspection]` IFF
`posture.json::pending_verification` includes this rule_id — is still IN the rule
body, on Rule 4b's bullet. Nothing left the loaded surface.

Five `**Violation scope:**` bullets dropped a parenthetical that restated their
own Wiring-block title, which sits a few lines above each in the same file.

Eight `**Why:**` lines dropped a depth-pointer lead-in ("Re-audit trigger, full
test pair, …", "MAC-vs-digest instance, empty-input divergence, …", "Three
near-miss signing sites, …", "Structural-closure argument, …", "Bare-number
carve-out rationale, …") and the repeated `guide § "Why-line evidence tails"`
section anchor. Each line's FAILURE-MODE statement and its `BLOCKED corpus +
<evidence>: guide.` tail stayed. Every topic those lead-ins named is already
written out above: the re-audit trigger at § "Rule 3a — the re-audit trigger", the
MAC-vs-digest instance AND the empty-input sentinel divergence at § "Rule 4 —
Byte-Vector Pinning", the three near-miss signing sites, the structural-closure
argument and the bare-number carve-out at § "Why-line evidence tails".

### Regression-within-grace deviation rationales (moved 2026-09-15)

Moved verbatim from three `**Regression-within-grace:**` bullets. The normative
statement — GENERIC `regression_within_grace` per `trust-posture.md` MUST-4
(1× = drop 1 posture), no dedicated key, a named Rule-8 deviation — stayed in
every bullet; only the per-clause reason for the deviation moved:

> **Rule 4b:** byte-CHANGING classification is an empirical byte-diff made at gate-review.

> **Rule 4c:** the CI `shasum -a256 -c` step already reds deterministically on a stale manifest.

> **Rule 6:** gate-review is the enforcement layer here, and MUST-4's `critical` row is NOT claimed for a repo-slug breadcrumb.

Rule 6's bullet retains the second half (`MUST-4`'s `critical` row is NOT claimed
here) because it bounds which emergency trigger the clause does NOT reach; only
the gate-review half moved.

### Origin tails (moved 2026-09-15)

Moved from two `**Origin:**` bullets, each of which keeps its anchoring
issue/PR/date reference in the rule:

> **Rule 4c** (PR #1411 Gap 1, closed by `b4929d924`): … + a new integrity-manifest-sweep lens.

> **Rule 4e** (kailash-py #1841, kailash 2.59.0): sibling of Rule 4d (opposite polarity). Landed at loom via Gate-1.

Rule 4e's tail is a restatement of its own clause body's first sentence ("Rule 4e
is the OPPOSITE defect polarity to Rule 4d"), which stayed in the rule.

### Rule 4b — the probe row/pair FIGURE, deleted rather than carried (2026-09-15)

The `**Detection mechanism:**` bullet stated "24 rows in 12 bipolar `pair_id`
pairs". Re-derived on this tree the figure was TRUE (24 rows, 12 `pair_id`s), and
it was still DELETED in favour of a derivation instruction — "read the row/pair
counts off the suite, never off this line" — because the structural statement
beside it (one bipolar firing pair per clause `check-clause-coverage.mjs::deriveClauses`
returns, plus a meta-compliance pair) already DETERMINES the count, so the
transcribed number was a second claim about the world that can rot independently
of the contract it was standing in for.

For the same reason the bullet's "ZERO deferred clauses in
`clause-coverage-baseline.json`" was reworded to name the field it is a claim
about — "`deferred` EMPTY in `clause-coverage-baseline.json`" — which is
re-derivable in one read (`rules["cross-sdk-inspection"].deferred`, measured `{}`
on this tree) rather than a tally to be trusted. The registered probe path, the
`deriveClauses` anchor, the per-clause MUST enumeration, the fixtures directory,
the `eval-manifest.json` / `probe-suite-integrity.test.mjs::PINNED_SUITES`
registration, the `coc-probe-dispatch.mjs` non-invocation and the never-synced
`.claude/test-harness/**` consumer note all stayed in the rule body.
