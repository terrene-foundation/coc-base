---
priority: 0
scope: baseline
---

# Zero-Tolerance Rules

See `.claude/guides/rule-extracts/zero-tolerance.md` for extended BLOCKED-pattern examples and Phase 5 audit evidence.

## Scope

ALL sessions, ALL agents, ALL code, ALL phases. ABSOLUTE and NON-NEGOTIABLE.

## Rule 1: Pre-Existing Failures, Warnings, And Notices MUST Be Resolved Immediately

If you found it, you own it. Fix it in THIS run — do not report, log, or defer.

**Applies to** ("found it" includes, with equal weight):

- Test failures, build errors, type errors
- Compiler / linter warnings, deprecation notices
- WARN/ERROR in workspace logs since previous gate
- Runtime warnings (`DeprecationWarning`, `ResourceWarning`, `RuntimeWarning`)
- Peer-dependency / missing-module / version-resolution warnings

A warning is not "less broken" than an error. It is an error the framework chose to keep running through.

**Process:** diagnose root cause → fix → regression test → verify (`pytest` or project test cmd) → commit.

**BLOCKED responses:**

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- "Known issue for future resolution"
- "Reporting this for future attention"
- "Warning, non-fatal — proceeding"
- "Deprecation warning, will address later"
- "Notice only, not blocking"
- ANY acknowledgement/logging/documentation without an actual fix

**Why:** Deferring creates a ratchet — every session inherits more failures; codebase degrades faster than any single session can fix. Warnings are the leading indicator: today's `DeprecationWarning` is next quarter's "it stopped working when we upgraded".

**Mechanism:** The log-triage protocol in `rules/observability.md` Rule 5 has concrete scan commands. If `observability.md` isn't loaded (config-file edits), MUST still scan most recent test runner + build output for WARN+ entries before reporting any gate complete.

**Exceptions:** User explicitly says "skip this"; OR upstream third-party deprecation unresolvable in this session → pinned version + documented reason OR upstream issue link OR todo with explicit owner. Silent dismissal still BLOCKED.

### Rule 1a: Scanner-Surface Symmetry

Findings reported by a security scanner on a PR scan MUST be treated identically to findings on a main scan. "This also exists on main, therefore not introduced here" is BLOCKED.

```python
# DO — fix the finding in this PR regardless of main's state
logger.info("redis.connect", url=mask_url(redis_url))
# DO NOT — "same alert on main, out of scope"
logger.info("redis.connect", url=redis_url)  # still leaks
```

**BLOCKED responses:** "Pre-existing on main, out of scope" / "CodeQL only flags PR diffs" / "Will be addressed when main re-scans" / "Same alert ID upstream" / "Main branch baseline suppresses it".

**Why:** "Same on main" is the institutional ratchet that defers fixes forever. Rule 1 covers this in spirit; an explicit scanner-surface clause closes the rationalization gap. See guide for `__all__` / `__getattr__` second-instance variant (PR #506).

### Rule 1b: Scanner Deferral Requires Tracking Issue + Runtime-Safety Proof

Rule 1a mandates that scanner findings MUST be fixed, not dismissed. A LEGITIMATE deferral disposition exists for findings that are provably runtime-safe AND require architectural refactor out of release-scope — but ONLY if all four conditions are met. Missing any one of them, the "deferral" IS silent dismissal under a different name and is BLOCKED.

Required conditions (ALL four):

1. **Runtime-safety proof** — the finding is verified safe (e.g., every cyclic import is `TYPE_CHECKING`-guarded; the "unsafe" path is unreachable at runtime). Verification is a PR comment citing the guard lines.
2. **Tracking issue** — filed against the repo with title `codeql: defer <rule-id> — <short-context>`, body including acceptance criteria for the full fix.
3. **Release PR body link** — the tracking issue is linked from the release PR's body with explicit "deferred, safe per #<issue>" language.
4. **Release-specialist agreement** — release-specialist confirms the deferral in review OR user explicitly overrides with "full fix".

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

**Why:** Without written runtime-safety proof + tracking issue + release PR link + release-specialist signoff, a "deferred" finding is indistinguishable from a silent dismissal — nothing forces the follow-up and nothing surfaces the backlog. The four conditions are the structural defense: verification is the grep-able claim; the tracking issue is the workstream; the release PR link is the audit trail; the release-specialist signoff is the human gate. Rule 1a blocks dismissal; Rule 1b documents the ONLY legitimate path to defer.

Origin: PR #611 release cycle (2026-04-23) — 17 `py/unsafe-cyclic-import` findings deferred via issue #612 after ml-specialist verified all cycles are TYPE_CHECKING-guarded; 23 other CodeQL errors fixed in the release PR.

### Rule 1c: "Pre-Existing" Is Unprovable After Context Boundary

Any disposition that classifies an issue as "pre-existing", "not introduced in this session", or "outside the session's blast radius" MUST cite a specific commit SHA AND demonstrate that the SHA pre-dates the session's first tool call. After `/clear`, auto-compaction, conversation resume, sub-agent handoff, or any other context boundary, the agent has no audit trail of its prior-turn edits — the "pre-existing" claim is structurally unfalsifiable and is BLOCKED. The disposition under uncertainty is: fix it.

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

**Why:** Wrapper-default scope discipline (CC's "a bug fix doesn't need surrounding code cleaned up", `~/repos/contrib/claude-code-source-code/src/constants/prompts.ts:201`) is sound for short-horizon coding assistants where the agent's edit log IS the session log. In COC's long-horizon institutional codebase, sessions cross `/clear`, auto-compaction, and resume boundaries that erase the edit log; the agent's recall is no longer evidence. `git blame` is also insufficient — the agent may have re-introduced an old bug via a same-session refactor that blame attributes to the original author. The structural defense is symmetric: either cite a SHA that proves pre-existence relative to session start, or fix it. "Pre-existing" without provenance grounding is BLOCKED regardless of how confident the claim feels.

Origin: 2026-05-01 — user identified that wrapper-default scope discipline (CC system prompt `prompts.ts:201–203`) creates a structural amnesia after `/clear` / auto-compaction; the agent declares "pre-existing, not in scope" with no audit trail to back the claim. Closes the rationalization loophole that Rule 1's BLOCKED list named but did not structurally defeat.

## Rule 2: No Stubs, Placeholders, Or Deferred Implementation

Production code MUST NOT contain:

- `TODO`, `FIXME`, `HACK`, `STUB`, `XXX` markers
- `raise NotImplementedError`
- `pass # placeholder`, empty function bodies
- `return None # not implemented`

**No simulated/fake data:** `simulated_data`, `fake_response`, `dummy_value`, hardcoded mock responses, placeholder dicts. **Frontend mock is a stub too:** `MOCK_*`, `FAKE_*`, `DUMMY_*`, `SAMPLE_*` constants; `generate*()` / `mock*()` producing synthetic display data; `Math.random()` for UI.

**Why:** Frontend mock data is invisible to Python detection but has the same effect — users see fake data presented as real.

**Extended BLOCKED patterns** (Phase 5 audit + kailash-ml-audit W33b) — see guide for full code examples:

- **Fake encryption** — class stores `encryption_key` but `set()` writes plaintext. Audit trail shows "encrypted"; disk shows plaintext.
- **Fake transaction** — `@contextmanager` named `transaction` that commits after every statement (no BEGIN/COMMIT/rollback).
- **Fake health** — `/health` returns 200 without probing DB/Redis. Orchestrators make routing decisions on lies.
- **Fake classification / redaction** — `@classify(REDACT)` stored but never enforced on read. Documented security control ships as no-op.
- **Fake tenant isolation** — `multi_tenant=True` flag with cache key missing `tenant_id` dimension.
- **Fake integration via missing handoff field** — frozen dataclass on pipeline's critical path omits the field the NEXT primitive needs. Each primitive's unit tests pass (each constructs its own fixture); the advertised 3-line pipeline breaks on every fresh install. Fix: add missing field; populate at every return site; add Tier-2 E2E regression (see `rules/testing.md` § End-to-End Pipeline Regression). Evidence: kailash-ml W33b `TrainingResult(frozen=True)` without `trainable`; `km.register` raised `ValueError` on fresh install.
- **Fake metrics** — silent no-op counters because `prometheus_client` missing + no startup warning. Dashboards empty while operators believe they're reporting.
- **Fake dispatch** — accepted in a `Literal[...]` / `Enum` / declared-string-set dispatch parameter, but no branch in the dispatcher. Every accepted literal MUST have a corresponding branch in the function body. The validator gate (`if kind not in {"x", "y", "z"}: raise`) followed by a dispatcher that branches only on `"x"` and falls through to a default for `"y"` and `"z"` IS the same failure-mode class as fake encryption / fake transaction / fake health: the documented contract advertises a feature the code does not implement. Evidence: kailash-ml `_wrappers.py:474–485` accepted `kind="clustering"`, `"alignment"`, `"llm"`, `"agent"` as valid `Literal` values — none had a dispatch branch; every one fell through to `DLDiagnostics(subject)`. Documented in spec §3.1 as supported; silently broken in practice (#701 bonus finding). Detection: `/redteam` MUST AST-walk every `Literal[...]` / `Enum`-valued dispatch parameter and confirm every accepted literal has a `match` arm or `if`/`elif` branch. Rust's `match` exhaustiveness check structurally covers `enum DiagnosticKind`; `&str` dispatch in Rust does NOT — same gap if Rust adds a string-dispatch surface. Python lacks the structural check entirely; the rule is the only defense.

## Rule 3: No Silent Fallbacks Or Error Hiding

- `except: pass` (bare except + pass) — BLOCKED
- `catch(e) {}` (empty catch) — BLOCKED
- `except Exception: return None` without logging — BLOCKED

**Why:** Silent error swallowing hides bugs until they cascade into data corruption or production outages with no stack trace to diagnose.

**Acceptable:** `except: pass` in hooks/cleanup where failure is expected.

### Rule 3a: Typed Delegate Guards For None Backing Objects

Any delegate method forwarding to a lazily-assigned backing object MUST guard with a typed error before access. Allowing `AttributeError` to propagate from `None.method()` is BLOCKED.

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

**Why:** Opaque `AttributeError` blocks N tests at once with no actionable message; typed guard turns the failure into a one-line fix instruction.

### Rule 3c: Documented Kwargs Accepted But Unused

A documented kwarg accepted in the public signature but with zero effect on the function body IS the silent-fallback failure mode at API surface level. Every kwarg listed in the public signature AND documented in the spec MUST be consumed by at least one branch of the function body. Accepting a kwarg and dropping it on the floor is BLOCKED.

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

**Why:** A documented kwarg is a contract. A kwarg accepted into the signature, listed in the spec, and silently dropped IS a contract violation indistinguishable from a stub return — the user passes a real `DataLoader`, the function returns a result, the user's loader was never read. Same failure-mode class as `except: pass` (Rule 3) and fake encryption (Rule 2): the documented behavior advertises something the code does not perform. Detection: at every `def f(*, kw1, kw2, kw3)` boundary, confirm `kw1`, `kw2`, `kw3` each appear at least once in the function body OR are explicitly forwarded to a callee. If the parameter exists only to satisfy a type-checker or to defer implementation, raise `NotImplementedError` until the branch is wired — silent drop is BLOCKED.

Origin: kailash-ml 1.5.x followup (#701) — `diagnose(model, kind="dl", data=loader)` accepted `data=` in its public signature, documented in spec §3.1 as a `DataLoader` union member, and silently dropped it on the `kind="dl"` branch because `DLDiagnostics` had no method consuming a loader. The kwarg's existence was a lie that survived three SDK releases. Rust's type system structurally prevents the pattern (a function that takes `data: DataLoader` and never reads it produces an unused-variable warning); Python provides zero structural defense — the rule IS the defense.

### Rule 3d: Dual-Shape Return + Structural Guard = Silent Fallback

A property or method whose return type is a union of structurally-distinct shapes (e.g., `Union[ConfigWrapper(dict), KaizenConfig(dataclass)]`) MUST NOT be consumed via a structural existence guard (`hasattr(value, "method")`) that resolves True for one branch and False for the other. The guard silently flips False on the branch that lacks the attribute, and the documented behavior never fires for users on that branch. Either dispatch on a discriminator (`isinstance` / type check) OR collapse the API to a single return shape.

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

**Why:** A dual-shape API consumed via structural guard is the same failure-mode class as fake encryption / fake transaction / fake dispatch (Rule 2): the documented contract advertises a feature the code does not perform on every branch. Tests written against the structurally-richer branch (dict has `.get`) silently mask the gap; users on the typed branch get a no-op. Detection: at every `hasattr(x, "<method>")` callsite where `x` has a union return type, walk back to the declared type — if any branch lacks `<method>`, the guard is silently flipping for that branch's users. Either dispatch on a discriminator (the consumer KNOWS which shape it has) or collapse the API (one shape eliminates the ambiguity).

Origin: kailash-kaizen #822 (2026-05-05) — `Kaizen.config` returns `Union[ConfigWrapper(dict), KaizenConfig(dataclass)]`; consumer at `agents.py:458` guarded with `hasattr(config, "get")` which is False for the dataclass branch. Documented `signature_programming_enabled` gate silently never fired for users who passed `KaizenConfig(signature_programming_enabled=True)`. Fix shipped in kailash-kaizen 2.19.0 via `getattr(config, "signature_programming_enabled", None) is True or (hasattr(config, "get") and config.get(...) is True)`.

## Rule 4: No Workarounds For Core SDK Issues

This is a BUILD repo. You have the source. Fix bugs directly.

**Why:** Workarounds create parallel implementations that diverge from the SDK, doubling maintenance cost and masking the root bug.

**BLOCKED:** Naive re-implementations, post-processing, downgrading.

## Rule 5: Version Consistency On Release

ALL version locations updated atomically:

1. `pyproject.toml` → `version = "X.Y.Z"`
2. `src/{package}/__init__.py` → `__version__ = "X.Y.Z"`

**Why:** Split version states cause `pip install kailash==X.Y.Z` to install a package whose `__version__` reports a different number, breaking version-gated logic.

## Rule 6: Implement Fully

- ALL methods, not just the happy path
- If endpoint exists, it returns real data
- If service is referenced, it is functional
- Never leave "will implement later" comments
- If you cannot implement: ask the user what it should do, then do it. If user says "remove it," delete the function.

**Test files excluded:** `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `__tests__/`

**Why:** Half-implemented features present working UI with broken backend — users trust outputs that are silently incomplete or wrong.

**Iterative TODOs:** Permitted when actively tracked (workspace todos, issue-linked).

### Rule 6a: Remove Fully — Public-API Removal Requires Deprecation Cycle

Public-API removal MUST land with a `DeprecationWarning` shim covering at least one minor cycle, plus a CHANGELOG migration section explicitly documenting the 1.x → next-1.x callsite change. Removal-without-shim is BLOCKED. The removal is "complete" only when the shim has lived through one minor release AND the CHANGELOG migration entry is in place.

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

**Why:** Public-API removal without a deprecation cycle hard-breaks every downstream callsite on first import after `pip upgrade` / `cargo update`. The user did nothing wrong; their code worked yesterday and stops working today with a TypeError or NameError that gives no migration path. The deprecation shim converts a hard break into a warning the user can act on; the CHANGELOG migration section converts "what do I do now?" into "follow these 3 steps." Same structural-completion principle as Rule 6 (Implement Fully): a removal that ships without shim + CHANGELOG entry is half-implemented — the new API works, but the migration path is missing.

Origin: kailash-ml 1.5.0 release (2026-04-27) — `InferenceServer(registry=, cache_size=)`, `warm_cache`, `load_model(name, model)` were dropped without deprecation cycle, shim, or CHANGELOG migration entry. Every 1.1.x callsite hard-broke on first import in 1.5.0. The same structural gap applies to any compiled-language SDK that removes a `pub` symbol without a `#[deprecated]` shim — downstream crates hard-break on dependency upgrade.

Origin: 2026-04-12 + DataFlow 2.0 Phase 5 audit + 2026-04-23 W33b + 2026-04-29 followup audit. See guide for full BLOCKED-pattern code examples + audit evidence.
