---
priority: 0
scope: baseline
---

# Zero-Tolerance Rules

See `.claude/guides/rule-extracts/zero-tolerance.md` for extended BLOCKED-pattern examples, sub-rule prose detail, and Phase 5 audit evidence.

## Scope

ALL sessions, ALL agents, ALL code, ALL phases. ABSOLUTE and NON-NEGOTIABLE.

## Rule 1: Pre-Existing Failures, Warnings, And Notices MUST Be Resolved Immediately

If you found it, you own it. Fix in THIS run — do not report, log, or defer.

**Applies to** (equal weight): test/build/type failures, compiler/linter warnings, deprecation notices, WARN/ERROR in workspace logs since the previous gate, runtime warnings (`DeprecationWarning`/`ResourceWarning`/`RuntimeWarning`), peer-dependency / version-resolution warnings. A warning is not "less broken" than an error — it is an error the framework chose to keep running through.

**Process:** diagnose root cause → fix → regression test → verify → commit. Scan most recent test runner + build output for WARN+ entries before reporting any gate complete (full triage protocol in `rules/observability.md` Rule 5).

**BLOCKED responses:**

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- "Known issue for future resolution"
- "Warning, non-fatal — proceeding"
- "Notice only, not blocking"
- ANY acknowledgement/logging without an actual fix

**Why:** Deferring creates a ratchet — every session inherits more failures. Today's `DeprecationWarning` is next quarter's "it stopped working when we upgraded".

**Exceptions:** User says "skip this", OR upstream third-party deprecation unresolvable in this session → pinned version + documented reason / upstream issue link / explicit-owner todo. Silent dismissal still BLOCKED.

**See also:** `rules/time-pressure-discipline.md` — most common bypass is user pressure framing; the throughput response is parallelization, not deferral.

### Rule 1a: Scanner-Surface Symmetry

Findings on a PR scan MUST be treated identically to findings on a main scan. "Same on main, therefore not introduced here" is BLOCKED.

**Why:** "Same on main" is the institutional ratchet that defers fixes forever. See guide for `__all__` / `__getattr__` second-instance variant (PR #506).

### Rule 1b: Scanner Deferral Requires Tracking Issue + Runtime-Safety Proof

A LEGITIMATE deferral exists for findings that are provably runtime-safe AND require architectural refactor out of release-scope — ONLY when all four conditions hold: (1) written runtime-safety proof in PR comment citing guard lines, (2) tracking issue titled `codeql: defer <rule-id> — <ctx>` with full-fix acceptance criteria, (3) release PR body link with explicit "deferred, safe per #<issue>" language, (4) release-specialist signoff in review (or user "full fix" override). Missing any → silent dismissal → BLOCKED.

**Why:** Without all four, "deferred" is indistinguishable from silent dismissal — nothing forces follow-up and nothing surfaces the backlog. See guide for kailash-ml 1.5.x evidence + full BLOCKED-rationalization corpus.

### Rule 1c: "Pre-Existing" Is Unprovable After Context Boundary

Any "pre-existing", "not introduced this session", or "outside session blast radius" disposition MUST cite a commit SHA pre-dating the session's first tool call. After `/clear`, auto-compaction, resume, or sub-agent handoff, the agent has no audit trail — the claim is structurally unfalsifiable and BLOCKED. Disposition under uncertainty: fix it.

**Why:** COC sessions cross context boundaries that erase the edit log; `git blame` is insufficient (may attribute a same-session refactor regression to the original 2024 author). See guide for full prose + the `prompts.ts:201` wrapper-prompt reference.

## Rule 2: No Stubs, Placeholders, Or Deferred Implementation

Production code MUST NOT contain: `TODO`/`FIXME`/`HACK`/`STUB`/`XXX` markers, `raise NotImplementedError`, `pass # placeholder`, empty function bodies, `return None # not implemented`.

**No simulated/fake data:** `simulated_data`, `fake_response`, `dummy_value`, hardcoded mock responses, placeholder dicts. **Frontend mock is a stub too:** `MOCK_*`/`FAKE_*`/`DUMMY_*`/`SAMPLE_*` constants; `generate*()`/`mock*()` for synthetic display data; `Math.random()` for UI.

**Why:** Frontend mock data is invisible to Python detection but has the same effect — users see fake data presented as real.

**Extended BLOCKED patterns** (Phase 5 + kailash-ml W33b) — see guide for full code + audit evidence: fake encryption · fake transaction · fake health · fake classification/redaction · fake tenant isolation · fake integration via missing handoff field · fake metrics · fake dispatch.

## Rule 3: No Silent Fallbacks Or Error Hiding

- `except: pass` (bare except + pass) — BLOCKED
- `catch(e) {}` (empty catch) — BLOCKED
- `except Exception: return None` without logging — BLOCKED

**Why:** Silent error swallowing hides bugs until they cascade into data corruption or production outages with no stack trace to diagnose.

**Acceptable:** `except: pass` in hooks/cleanup where failure is expected.

### Rule 3a: Typed Delegate Guards For None Backing Objects

Any delegate method forwarding to a lazily-assigned backing object MUST guard with a typed error before access. Allowing `AttributeError` to propagate from `None.method()` is BLOCKED.

**Why:** Opaque `AttributeError` blocks N tests at once with no actionable message; typed guard turns the failure into a one-line fix instruction. See guide for the JWTMiddleware example.

### Rule 3c: Documented Kwargs Accepted But Unused

A kwarg accepted in the public signature but with zero effect on the function body IS the silent-fallback failure mode at API surface level. Every documented kwarg MUST be consumed by ≥1 branch of the function body OR explicitly forwarded to a callee. Silent drop is BLOCKED.

**Why:** A documented kwarg is a contract. Same failure-mode class as `except: pass` (Rule 3) and fake encryption (Rule 2): the documented behavior advertises something the code does not perform. See guide for kailash-ml #701 (`diagnose(data=loader)` silently dropped) evidence.

### Rule 3d: Dual-Shape Return + Structural Guard = Silent Fallback

A property or method whose return type is a union of structurally-distinct shapes (e.g., `Union[ConfigWrapper(dict), KaizenConfig(dataclass)]`) MUST NOT be consumed via a structural existence guard (`hasattr(value, "method")`) that resolves True for one branch and False for the other. Either dispatch on a discriminator (`isinstance` / type check) OR collapse the API to a single return shape.

**Why:** `hasattr` silently flips False on the branch that lacks the attribute; the documented behavior never fires for users on that branch. Same failure-mode class as fake dispatch — the documented contract advertises a feature the code does not perform on every branch. See guide for kailash-kaizen #822 evidence.

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
- If you cannot implement: ask the user; if "remove it," delete the function

**Test files excluded:** `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `__tests__/`

**Why:** Half-implemented features present working UI with broken backend — users trust outputs that are silently incomplete or wrong.

**Iterative TODOs:** Permitted when actively tracked (workspace todos, issue-linked).

### Rule 6a: Remove Fully — Public-API Removal Requires Deprecation Cycle

Public-API removal MUST land with a `DeprecationWarning` shim covering at least one minor cycle, plus a CHANGELOG migration section explicitly documenting the callsite change. Removal-without-shim is BLOCKED. Removal is "complete" only when the shim has lived through one minor release AND the migration entry is in place.

**Why:** Removal without a deprecation cycle hard-breaks every downstream callsite on first import after `pip upgrade` / `cargo update`. The shim converts a hard break into a warning the user can act on; the CHANGELOG migration converts "what do I do now?" into actionable steps. See guide for kailash-ml 1.5.0 evidence (`InferenceServer(registry=, cache_size=)` and `warm_cache` dropped without shim).

Origin: 2026-04-12 + DataFlow 2.0 Phase 5 audit + kailash-ml-audit 2026-04-23 W33b + 2026-04-29 followup audit. See guide for full BLOCKED-pattern code examples + audit evidence.
