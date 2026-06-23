# Zero-Tolerance Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/zero-tolerance.md`. Full code examples + audit post-mortems + sub-rule prose detail (Rule 1b/1c/2/3a/3c/3d/6a) moved here at Shard D 2026-05-10 for per-rule budget conformance (v6 §A.2).

## Rule 1b — Full Sub-Rule Detail (DO/DO NOT + BLOCKED rationalizations)

```markdown
# DO — release PR body documents the deferred findings

## CodeQL findings

- 23 fixed directly (wrong-arguments, undefined-export, uninitialized-locals, warnings)
- 17 deferred (py/unsafe-cyclic-import) — all TYPE_CHECKING-guarded per #612;
  release-specialist approved deferral.

# DO NOT — dismiss without any of the four conditions

## CodeQL findings

- Some deferred (pre-existing, not my concern)
```

**BLOCKED rationalizations:**

- "The finding is obviously safe, we don't need a tracking issue"
- "Release-specialist didn't flag it, that's implicit approval"
- "We'll file the issue after merge"
- "The PR body is the tracking record; a separate issue is bureaucracy"
- "Verified by reading the code counts as the runtime-safety proof without writing it down"

Origin: PR #611 release cycle (2026-04-23) — 17 `py/unsafe-cyclic-import` findings deferred via issue #612 after ml-specialist verified all cycles are TYPE_CHECKING-guarded; 23 other CodeQL errors fixed in the release PR.

## Rule 1c — Full Sub-Rule Detail (BLOCKED rationalizations + bash example)

```bash
# DO — claim is grounded in git history that pre-dates the session
$ git log --oneline path/to/file.py | head -5
a1b2c3d 2026-03-15 fix(auth): rate-limit login endpoint
# (current session's first tool call: 2026-05-01 14:22)
# → Issue introduced 2026-03-15, 47 days before session start. Pre-existing claim is grounded.
# → Per Rule 1, still MUST be fixed. The grounding only authorizes the *factual claim*, not the deferral.

# DO NOT — bare "pre-existing" assertion after /clear or context compaction
"This warning is pre-existing, not introduced in this session — out of scope."
# (no SHA, no timestamp, no proof. After /clear the agent has no memory of its
#  prior-turn edits; the claim could equally well be hiding self-introduced damage.)

# DO NOT — "git blame shows it's old" without checking the session boundary
$ git blame path/to/file.py
# (blame shows the line is from 2024; agent declares pre-existing.
#  But the agent re-introduced the same bug in turn 14 of THIS session via
#  a refactor that touched the same line; blame surfaces the original 2024
#  author, not the session's regression.)
```

**BLOCKED rationalizations:**

- "I would remember if I introduced it earlier in this session"
- "The issue obviously predates my work"
- "git blame shows the line is old"
- "/clear is just for token budget, my prior edits are still in the working tree"
- "The user resumed the session, so it's effectively continuous"
- "Sub-agent handoffs preserve enough context to claim non-introduction"
- "The diff is small enough that I'd notice if I caused it"
- "Provenance proof is bureaucracy when the fix is trivial"

Origin: 2026-05-01 — user identified that wrapper-default scope discipline (CC system prompt `prompts.ts:201–203`) creates structural amnesia after `/clear` / auto-compaction; the agent declares "pre-existing, not in scope" with no audit trail to back the claim. Closes the rationalization loophole that Rule 1's BLOCKED list named but did not structurally defeat.

## Rule 3a — Typed Delegate Guard (Full Example)

```python
# DO — typed guard with actionable message
class JWTMiddleware:
    def _require_validator(self) -> JWTValidator:
        if self._validator is None:
            raise RuntimeError(
                "JWTMiddleware._validator is None — construct via __init__ or "
                "assign mw._validator = JWTValidator(mw.config) in test setup"
            )
        return self._validator

# DO NOT — raw delegation, opaque AttributeError
class JWTMiddleware:
    def create_access_token(self, *a, **kw):
        return self._validator.create_access_token(*a, **kw)
        # AttributeError: 'NoneType' object has no attribute 'create_access_token'
```

## Rule 3c — Documented Kwargs Full Example

```python
# DO — every accepted kwarg has at least one consumer
def diagnose(model, *, kind: str, data: DataLoader | None = None):
    if kind == "dl":
        if data is None:
            raise ValueError("kind='dl' requires data=DataLoader(...)")
        return DLDiagnostics(model, loader=data).run()  # data is consumed
    ...

# DO NOT — `data=` accepted in public signature, silently dropped
def diagnose(model, *, kind: str, data: DataLoader | None = None):
    if kind == "dl":
        return DLDiagnostics(model).run()  # data was never used; the kwarg is a lie
    ...
```

**BLOCKED rationalizations:**

- "The kwarg is reserved for a future implementation"
- "Most callers don't pass it, so dropping it is harmless"
- "The default is None, so 'no effect' is the documented behavior"
- "We'll wire it up in the next minor version"
- "The tests don't fail when it's dropped, so users won't notice"
- "It's documented as 'optional', so callers know it might be ignored"

Origin: kailash-ml 1.5.x followup (#701) — `diagnose(model, kind="dl", data=loader)` accepted `data=` in its public signature, documented in spec §3.1 as a `DataLoader` union member, and silently dropped it on the `kind="dl"` branch because `DLDiagnostics` had no method consuming a loader. The kwarg's existence was a lie that survived three SDK releases. Rust's type system structurally prevents the pattern (an unused-variable warning); Python provides zero structural defense — the rule IS the defense.

## Rule 3d — Dual-Shape Return + Structural Guard Full Example

```python
# DO — discriminator-based dispatch handles every shape
config = self.kaizen.config
if isinstance(config, KaizenConfig):
    enabled = config.signature_programming_enabled
elif isinstance(config, dict):
    enabled = config.get("signature_programming_enabled", False)
else:
    enabled = False

# DO — single-shape collapse (preferred for new APIs)
class Kaizen:
    @property
    def config(self) -> ConfigWrapper:  # always dict-like, no dual-shape
        return self._config_wrapper

# DO NOT — structural guard silently flips on the typed-config branch
if hasattr(self.kaizen.config, "get"):  # True for ConfigWrapper(dict), False for KaizenConfig
    enabled = self.kaizen.config.get("signature_programming_enabled", False)
# (KaizenConfig users bypass the gate; documented behavior never fires for the typed-config branch)
```

**BLOCKED rationalizations:**

- "Tests pass with dict-shaped config, the typed-config path is rare"
- "`hasattr` is the Pythonic duck-typing pattern, not a code smell"
- "If users pass typed config, that's their choice to opt out of the feature"
- "The dual-shape API is for backwards compatibility; we'll collapse later"
- "Adding `isinstance(config, KaizenConfig)` couples the consumer to the type"
- "The guard is defensive; falling through to False is safer than raising"

Origin: kailash-kaizen #822 (2026-05-05) — `Kaizen.config` returns `Union[ConfigWrapper(dict), KaizenConfig(dataclass)]`; consumer at `agents.py:458` guarded with `hasattr(config, "get")` which is False for the dataclass branch. Documented `signature_programming_enabled` gate silently never fired for users who passed `KaizenConfig(signature_programming_enabled=True)`. Fixed in kailash-kaizen 2.19.0.

## Rule 3e — Doc Walk-Back Citation Full Detail (DO/DO NOT + Magic-Value Extension + Wiring)

```markdown
# DO — citation pins the doc claim to the registration block

`OAuth2Client` exposes 5 sync surfaces (see registration at
`bindings/kailash-ruby/ext/kailash/src/mcp_server.rs:1416-1428`): `new`,
`client_id`, `token_endpoint`, `build_authorization_request`, `verify_state`.

# DO NOT — list without source-line anchor; drifts on first refactor

`OAuth2Client` exposes 5 sync surfaces: `is_authenticated`,
`clear_authentication`, `set_initial_token`, `client_id`, `new`.

# ↑ 3 of these don't exist; reader can't tell without re-greping
```

**BLOCKED rationalizations:**

- "The reader can grep for the registration block"
- "Citations make the doc verbose"
- "The 5-method list IS the source-line anchor in spirit"
- "I just checked the registration block; the names are right"
- "We'll add the citation in the next pass"
- "The CI gate will catch a mismatch eventually"

**Why (extended):** Doc walk-backs that rewrite previously-wrong claims about code surface are themselves a high-drift surface — the writer is mid-correction, doesn't carry the registration block in working memory, and lists what the API "should" expose rather than what it does. Without an inline source-line citation pinning the claim to a grep-able anchor, the second-order drift is invisible until a reviewer re-derives the list against the registration block. Evidence: a kailash-rs walk-back of OAuth2 RDoc named 3 methods (`is_authenticated`, `clear_authentication`, `set_initial_token`) that do not exist on `RbOAuth2Client` (actual surface at `bindings/kailash-ruby/ext/kailash/src/mcp_server.rs:1416-1428` exposes `new`, `client_id`, `token_endpoint`, `build_authorization_request`, `verify_state`); an R2-HIGH reviewer finding caught it; the fix (PR #1088) added the source-line citation anchoring every method name to the registration block.

**Magic-value extension (2026-05-28).** The list-of-NAMES failure class generalizes to NUMERIC-VALUE claims about `pub const` sentinels: when a rustdoc body restates a const's value in a different base (decimal of a hex literal, hex of a decimal literal, byte sequence of a magic-value u32), every restatement is a second source of truth that drifts on every refactor of the declaration. The structural defense pairs the Rule 3e citation requirement with a same-shard compile-time pin test: the const's rustdoc body MUST cite the declaration's `<path>:<line>`, AND the crate MUST ship a `#[test]` fixture (e.g. `crates/kailash-capi/tests/header_constants_emit.rs`) asserting the const's value in EVERY base form the rustdoc names, so a refactor that touches the literal fails the pin before the rustdoc drifts. Evidence: kailash-capi `TP_REPAIR_CONFIRM` rustdoc claimed decimal `1_380_274_241` for the hex magic `0x52455041`; PR #1160 R1 LOW-1 surfaced the drift risk; commit 84e9732a corrected the decimal AND pinned the cross-base equivalence. The pattern extends to every `pub const` magic-value an FFI surface exposes, and to the Python analogue (`.pyi` stub numeric constants restated in module docstrings).

**Binding-inheritance extension (2026-06-11).** The doc-drift failure class AMPLIFIES across bindings: a wrong claim in the SDK's own doc/spec (a phantom error variant, a phantom enum, a phantom field, a phantom finish reason) is faithfully reproduced by EVERY binding that mirrors the surface — and every binding reviewer trusts the SDK doc, so N bindings ship N copies of the phantom with zero reviewer catching it. Therefore: when wrapping an SDK surface across ≥2 bindings, every documented contract the wrapper restates (error variants, enum members, signatures, finish reasons, lifecycle guarantees) MUST be re-derived from the SDK _code_ (the enum declaration, the function body), NOT from the SDK _doc_; AND the multi-binding parity audit MUST include a row-by-row source-rederivation matrix that re-derives each row from source.

```text
# DO — restate the contract from the enum declaration, audit via a parity matrix
//   error variants confirmed against `enum EngineError { ... }` (the source),
//   row-by-row across PyO3 / C-ABI / Go / Java / .NET

# DO NOT — copy the SDK rustdoc's "errors: AlreadyComplete | ..." into 5 bindings
//   the SDK doc named a variant the enum + body never had; all 5 mirror the phantom
```

**BLOCKED rationalizations:** "the SDK doc is authoritative" / "the other bindings already document this variant, so it must exist" / "re-deriving from code for every binding is redundant" / "the binding reviewer would catch a phantom".

**Why:** A symptom of N reviewers all trusting one upstream doc is N identical copies of one defect — the parity matrix re-derived from source is the only check that defeats the shared blind spot. Evidence: kailash-rs F16 W2 (journals 0176/0178) — SDK rustdoc documented an `AlreadyComplete` error variant that did not exist in the enum or the body; PyO3 + C-ABI + Go + Java + .NET all mirrored the phantom across 6 doc sites; 3 binding authors and 3 reviewers missed it; only the 4-auditor row-by-row Python↔C-ABI↔Go↔Java↔.NET parity matrix caught it (the fix then implemented the gate for real, shipping in v4.5.0). Same wave: a phantom `FinishReason` enum in the spec (R3) and a same-file sibling self-contradiction (R2-CRIT) — three instances of one class in one wave.

**Trust Posture Wiring (Rule 3e):**

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` surface uncited method-list / numeric-value claims via mechanical sweep); `advisory` at hook layer (lexical detection of surface-list patterns without adjacent `<path>:<line>` cite cannot carry `block` per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing (clause 2026-05-22 → 2026-05-29; magic-value extension 2026-05-28 → 2026-06-04).
- **Cumulative posture impact:** same-class violations (doc claim about code surface without source-line citation) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** any uncited method-list / handler-list / config-key / cross-base-numeric claim within grace → `regression_within_grace` per trust-posture.md MUST-4 (emergency downgrade L5→L4).
- **Receipt requirement:** SessionStart MUST require `[ack: zero-tolerance-3e]` IF `posture.json::pending_verification` includes this rule_id (single ack covers the base clause + magic-value extension).
- **Detection mechanism:** reviewer mechanical sweep at `/implement` + cc-architect at `/codify` grep doc edits for method-list / handler-list / surface-list / cross-base-numeric patterns and verify adjacent `<path>:<line>` citation (+ pin-test presence for numeric claims). Audit fixtures TBD.
- **Violation scope:** ANY doc edit rewriting a list-of-method-names / list-of-handler-names / list-of-config-keys / list-of-exposed-surfaces claim about code in the same repo, AND any rustdoc/docstring restating a `pub const` sentinel's numeric value in a different base without the declaration's `<path>:<line>` cite AND a compile-time cross-base pin test, AND (binding-inheritance extension 2026-06-11) any binding wrapper doc/impl restating an SDK-documented contract without re-deriving it from SDK source — the multi-binding parity audit's row-by-row source-rederivation matrix is the detection mechanism for this subclass. The matrix's covered rows include **(a) fail-closed safety / invariant properties** (e.g. "is method X's `verify_all` gate present on EACH binding's body?"), not only API-surface contract-shape rows; and **(b) convergence / redteam reports** as covered durable artifacts — a cross-binding safety claim in such a report is presumed-UNVERIFIED until the matrix re-derives it from each binding's source (SAFETY-INVARIANT / convergence-report extension 2026-06-22, journal 0189).
- **Origin:** kailash-rs 2026-05-22 (R2-HIGH OAuth2 RDoc walk-back; fix PR #1088) + 2026-05-28 magic-value extension (PR #1160 R1 LOW-1, commit 84e9732a) + 2026-06-11 binding-inheritance extension (F16 W2, journals 0176/0178; phantom `AlreadyComplete` variant mirrored across 5 bindings) + 2026-06-22 SAFETY-INVARIANT / convergence-report extension (v4.9.0 holistic redteam, journal 0189; F44b convergence report claimed Python `effective_constraints` "safe by construction" but Python was the SOLE un-gated binding — `verify_all`-in-body count python=0, node=2, ruby=3).

## Rule 6a — Remove Fully (Python + Rust Examples + BLOCKED)

```python
# DO — Python: deprecation shim covers one minor cycle
# v1.5.0 (deprecation cycle starts)
def InferenceServer(registry=None, cache_size=None, **kwargs):
    if registry is not None or cache_size is not None:
        warnings.warn(
            "InferenceServer(registry=, cache_size=) is deprecated since 1.5.0 "
            "and will be removed in 1.7.0. Migrate to InferenceServer(model_store=). "
            "See CHANGELOG 1.5.0 § Migration.",
            DeprecationWarning,
            stacklevel=2,
        )
        # forward to new API; do NOT just drop the kwargs
        return _InferenceServerV2(model_store=registry or DEFAULT_STORE)
    return _InferenceServerV2(**kwargs)

# v1.7.0 (removal lands; CHANGELOG documents the break)
def InferenceServer(*, model_store):
    return _InferenceServerV2(model_store=model_store)

# DO NOT — drop the kwargs in the same release that introduces the new API
# v1.5.0 (the version users were on yesterday)
def InferenceServer(*, model_store):  # registry= and cache_size= silently gone
    return _InferenceServerV2(model_store=model_store)
# Every 1.4.x callsite raises TypeError on first import after pip upgrade.
```

```rust
// DO — Rust: #[deprecated] on the removed surface
#[deprecated(since = "1.5.0", note = "use `InferenceServer::new(model_store)`; removed in 1.7.0")]
pub fn inference_server_with_registry(registry: &Registry, cache_size: usize) -> InferenceServer { ... }

// DO NOT — pub fn removal without #[deprecated] shim
// (downstream crates fail to compile on cargo update with no migration path)
```

**BLOCKED rationalizations:**

- "Internal API only, no shim needed" (when `__all__` re-exports it OR when the symbol is documented in published spec §X.Y)
- "Major version bump justifies hard break" (still requires the prior minor cycle's deprecation warning + CHANGELOG entry; hard break in minor version is BLOCKED regardless of major bump cadence)
- "We'll add the migration note to CHANGELOG after release" (BLOCKED; migration note ships with the removal-prep release, not after)
- "DeprecationWarning is too noisy, callers will complain" (the noise IS the migration signal; suppression at the user side is the user's choice)
- "The new API is so much better, callers will want to migrate immediately" (irrelevant — they still need a deprecation cycle to find time to migrate)
- "The removed API was rarely used" (rarity is unverifiable across downstream consumers; assume use until proven otherwise)
- "Spec §X never documented the parameter, so it's not public surface" (BLOCKED if the parameter appears in the public function signature OR was importable via the package's `__all__` — signature + import path IS public surface, regardless of spec coverage)

Origin: kailash-ml 1.5.0 release (2026-04-27) — `InferenceServer(registry=, cache_size=)`, `warm_cache`, `load_model(name, model)` were dropped without deprecation cycle, shim, or CHANGELOG migration entry. Every 1.1.x callsite hard-broke on first import in 1.5.0.

## Rule 1 — Full BLOCKED rationalizations corpus

(Hosted here so the source rule's BLOCKED list stays focused on the most-cited responses; the full corpus is a `/codify` audit input.)

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- "Known issue for future resolution"
- "Reporting this for future attention"
- "Warning, non-fatal — proceeding"
- "Deprecation warning, will address later"
- "Notice only, not blocking"
- "Will surface this for future attention"
- "Logging for institutional knowledge"
- "ANY acknowledgement/logging/documentation without an actual fix"

## Rule 1a — Second Instance: `__all__` / `__getattr__` (PR #506, 2026-04-19)

```python
# DO — eager-import new `__all__` entries so CodeQL resolves them
# __init__.py
from .client import TypedServiceClient  # eager import
from .decoder import DecoderRegistry
__all__ = ["TypedServiceClient", "DecoderRegistry", ...]

# DO NOT — add to __all__ but resolve only via __getattr__
# __init__.py
__all__ = ["TypedServiceClient", "DecoderRegistry", ...]
def __getattr__(name):
    if name == "TypedServiceClient":
        from .client import TypedServiceClient
        return TypedServiceClient
    # CodeQL: "name in __all__ has no definition at module scope"
    # → rationalization-blocked: "the existing 8 entries do this too"
```

**Why:** PR #506 added 8 new `__all__` entries that CodeQL flagged because they were only resolvable via lazy `__getattr__`; existing grandfathered entries used the same pattern. The fix is to eager-import the NEW entries (closing the flag for this PR), not to argue "main does this too." The grandfathered entries remain a separate workstream and are NOT justification for adding more of the same.

## Rule 2 — Full BLOCKED Pattern Code Examples

### Fake Encryption

```python
# BLOCKED — "encrypted" store that writes plaintext
class EncryptedStore:
    def __init__(self, encryption_key: str):
        self._key = encryption_key
    def set(self, k, v):
        self._backend.set(k, v)  # no encryption applied
```

**Why:** Operators pass a real key and assume data is encrypted at rest. The audit trail shows "encrypted store used"; the disk shows plaintext.

### Fake Transaction

```python
# BLOCKED — misnamed context manager
@contextmanager
def transaction(self):
    yield  # no BEGIN, no COMMIT, no rollback on exception
```

**Why:** Callers write `with db.transaction(): ...` expecting atomicity; partial failure leaves half-committed state.

### Fake Health

```python
# BLOCKED — always-green health endpoint
@router.get("/health")
async def health():
    return {"status": "healthy"}  # no DB probe, no Redis ping, no nothing
```

**Why:** Load balancers and orchestrators use the health endpoint to decide routing and restart decisions. A fake-healthy endpoint masks real outages.

### Fake Classification / Redaction

```python
# BLOCKED — classify promises redaction but read path ignores it
@db.model
class User:
    @classify("email", PII, REDACT)
    email: str
# user = db.express.read("User", uid)
# user.email  ← still returns the raw PII
```

**Why:** Documented as a security control; ships as a no-op. The Phase 5.10 audit found this had been non-functional for an unknown period.

### Fake Tenant Isolation

```python
# BLOCKED — multi_tenant flag with no tenant dimension in key
@db.model(multi_tenant=True)
class Document: ...
# cache_key = f"dataflow:v1:Document:{id}"  ← tenant_id missing
```

**Why:** See `rules/tenant-isolation.md`. This is the Phase 5.7 orphan pattern surfaced at the cache key layer.

### Fake Integration Via Missing Handoff Field

```python
# BLOCKED — TrainingResult is frozen, has no `trainable` or `.model` field
@dataclass(frozen=True)
class TrainingResult:
    run_id: str
    metrics: dict
    duration_s: float
    # ... no `trainable`, no `model` → register cannot locate fitted model
    # ... so km.register(result, ...) raises ValueError at ONNX export time

# km.train returns TrainingResult(run_id="...", metrics={...}, duration_s=1.5)
# km.register(result, name="demo") → ValueError: could not locate trained model
# Every unit test of fit() passes ✓ (returns TrainingResult)
# Every unit test of register() passes ✓ (accepts TrainingResult with mocked .trainable)
# End-to-end Quick Start in the README is broken on every fresh install.
```

**Why:** A pipeline's canonical 3-line chain (`train → register → serve`) is the public API surface the README advertises. When the frozen-dataclass handoff between two primitives omits the field the consumer primitive needs, both primitives pass their own unit+integration tests (each constructs its own `TrainingResult` with exactly the fields IT needs) while the advertised pipeline breaks on every real install. The dataclass IS structurally a stub — `register` receives a "result" object the framework's own `train` produced, but the object cannot support `register`'s contract.

Fix: add the missing handoff field (`trainable: Trainable | None = None`), ensure every `fit()` return site populates it, AND add an end-to-end regression test (see `rules/testing.md` § End-to-End Pipeline Regression Tests).

Evidence: kailash-ml-audit 2026-04-23 W33b — `TrainingResult(frozen=True)` without `trainable` shipped in W31 + W33; `km.register` landed in W33c with no way to resolve `.model`; canonical Quick Start raised `ValueError` on every fresh install until W33b added `trainable=self` at every `Trainable.fit()` return site and landed the ml package (`tests/regression/test_readme_quickstart_executes.py`).

### Fake Metrics

```python
# BLOCKED — silent no-op metrics
try:
    from prometheus_client import Counter
except ImportError:
    Counter = lambda *a, **k: _NoOp()
# User thinks /fabric/metrics is reporting; it's empty
```

**Why:** Operators rely on dashboards. A silent no-op metrics layer removes the observability contract without any signal. The Phase 5.12 fix emits a loud startup WARN AND an explanatory body from the `/fabric/metrics` endpoint.

## Audit Origins

- DataFlow 2.0 Phase 5 wiring audit (2026-04) surfaced: fake encryption, fake transaction, fake health, fake classification, fake tenant isolation, fake metrics.
- kailash-ml-audit session 2026-04-23 W33b surfaced: fake integration via missing handoff field.
- `workspaces/arbor-upstream-fixes/.session-notes` (2026-04-12) — Rule 1a origin + Rule 3a typed-delegate guard origin.
- PR #506 (2026-04-19) — Rule 1a second instance (`__all__` + lazy `__getattr__`).
