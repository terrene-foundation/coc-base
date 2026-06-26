---
priority: 10
scope: path-scoped
paths:
  - "deploy/**"
  - ".github/**"
  - "pyproject.toml"
  - "CHANGELOG.md"
---

# SDK Release Rules

<!-- slot:neutral-body -->

## Before Any Release

1. Full test suite passes across all supported Python versions
2. Security review by **security-reviewer** (mandatory)
3. CHANGELOG.md updated (version, date, Added/Changed/Fixed/Removed, breaking changes marked)
4. Version bumped consistently across all packages (`pyproject.toml` + `__init__.py`)
5. No uncommitted changes

**Why:** Skipping any pre-release step risks publishing a broken, insecure, or version-mismatched package to PyPI where it becomes immediately available to every downstream user.

## TestPyPI Validation

Major/minor releases MUST validate on TestPyPI before production PyPI:

```bash
twine upload --repository testpypi dist/*.whl
python -m venv /tmp/verify --clear
/tmp/verify/bin/pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ kailash==X.Y.Z
/tmp/verify/bin/python -c "import kailash; print(kailash.__version__)"
```

**Why:** PyPI uploads are immutable -- a broken release cannot be overwritten, only yanked, leaving a permanent gap in the version sequence.

**Exception**: Patch releases may skip TestPyPI with explicit human approval.

## Publishing Rules

- Proprietary packages: wheels only (`twine upload dist/*.whl`), never sdist
- No publishing when CI is failing
- No PyPI tokens in source — use `~/.pypirc`, CI secrets, or trusted publisher (OIDC)
- Research current syntax (`--help` or web search) before running release commands

**Why:** Publishing sdist for proprietary packages exposes source code, publishing on failing CI ships known-broken artifacts, and committed tokens grant anyone with repo access full PyPI publishing rights.

## Release Config

Every SDK MUST have `deploy/deployment-config.md`. Run `/deploy` to create it.

**Why:** Without a deployment config, release agents guess at package names, registries, and credentials, leading to failed or misdirected publishes.

## MUST: Eagerly-Imported Transitive Dependencies Are Declared By The Importing Package

A package whose import graph eagerly pulls in a third-party library — directly OR transitively via an upstream Kailash package's `__init__.py` re-export — MUST declare that library in its own `[project.dependencies]`. Assuming an upstream optional extra will install it is BLOCKED.

```bash
# DO — clean-venv install + import proves every eager dependency is declared
python -m venv /tmp/verify --clear && /tmp/verify/bin/pip install dist/*.whl
/tmp/verify/bin/python -c "import kailash_ml"   # fails loudly if a transitive eager import is undeclared

# DO NOT — rely on an upstream package's optional extra
# kailash.core.pool.__init__ eagerly re-exports aiosqlite (a `kailash` extra);
# bare `pip install kailash-ml` never installs extras → clean-venv ImportError
```

**BLOCKED rationalizations:** "the upstream package brings it in" / "it works in editable-install CI" / "the extra is effectively always installed" / "we'll declare it if a user reports the import error".

**Why:** `pip install <pkg>` installs declared dependencies and their core dependencies — never optional extras — so a clean-venv user of the bare package hits `ImportError` at first import while editable-install CI stays green. Sibling to the "All Files Imported By package `__init__.py` Tracked In Git" discipline: same clean-venv import-failure family.

**Trust Posture Wiring:**

- **Severity:** `halt-and-report` at the /release gate (release-specialist mechanical clean-venv eager-import sweep).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** 3× same-rule in 30d → drop 1 posture per `trust-posture.md` MUST-4.
- **Regression-within-grace:** emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart `[ack: deployment-transitive-deps]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** /release-time mechanical sweep — clean venv, install the built wheel of every published package, import each top-level module; any `ImportError` = release halt.
- **Violation scope:** this clause (declare-eager-transitive-deps).
- **Origin:** 2026-05-18 — kailash-ml clean-venv `pip install` failed at `import` on an upstream-extra-only library; same pattern hit kailash-mcp 0.2.13 → 0.2.14 the same day (issue #1086 candidate 1).

## MUST: Pre-Pledge Release Disclosure For Pre-1.0 / v0 New Public APIs

Any /release that ships a NEW public API (new module, new top-level package, new framework primitive) at a pre-1.0 / v0 / pre-pledge version anchor MUST include a "Pre-Pledge v0" disclosure section in the package README or top-level docs BEFORE the release tag is cut. The disclosure MUST enumerate five fields: (a) invariants enforced TODAY, (b) items DEFERRED to later versions, (c) explicit NON-PROMISES users MUST NOT assume, (d) how-to-verify commands exercising the enforced invariants, (e) the version status.

```markdown
# DO — README § "Pre-Pledge v0" enumerating all five fields

## <Primitive> — Pre-Pledge v0

Enforced today: signed audit chain, capability snapshot, posture ladder, ...
Deferred: cross-SDK byte-determinism conformance for vectors X/Y/Z
Non-promises: no implicit retries, no shadow audit chains, no posture auto-upgrade
Verify: `pytest tests/conformance/ -k <primitive>` ...
Status: v0 (pre-pledge — deferred items may change semantics before 1.0)

# DO NOT — v0 README advertising every aspirational feature as if enforced today
```

**BLOCKED rationalizations:** "it's v0, users know it's unstable" / "the CHANGELOG covers it" / "we'll add the disclosure when the API stabilizes" / "the docs are illustrative, not a pledge".

**Why:** The disclosure structurally separates "what we pledge" from "what we aspire to", preventing the silent-pledge failure mode: users adopt v0 assuming all advertised features are enforced today, then break when a previously-aspirational feature ships with different semantics. Inverse of `zero-tolerance.md` Rule 6 at the docs surface — the README MUST distinguish surfaces that return real data today from surfaces whose docs reserve a contract a later version satisfies.

**Trust Posture Wiring:**

- **Severity:** `halt-and-report` at the /release gate (release-specialist mechanical sweep on any new public API with a `0.*` / `v0.*` / pre-pledge version anchor).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** 3× same-rule in 30d → drop 1 posture per `trust-posture.md` MUST-4.
- **Regression-within-grace:** trigger key `prepledge_release_no_disclosure` fires emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart hard-gate `[ack: pre-pledge-disclosure]` IFF `posture.json::pending_verification` includes this rule_id AND the impending /release anchor is `0.*` AND the release diff adds a NEW public API surface.
- **Detection mechanism:** /release-time release-specialist sweep — for every new public module/package shipping at `0.*`, grep README.md + docs/ for a section titled "Pre-Pledge" / "v0 Disclosure" / "Pre-1.0 Status" (or equivalent) AND assert the 5 required fields are enumerated. Phase 2 (deferred): hook detector `.claude/hooks/lib/violation-patterns.js::detectPrePledgeReleaseMissingDisclosure`; audit fixtures land with the detector under the violation-patterns detectPrePledgeReleaseMissingDisclosure subdir per `cc-artifacts.md` Rule 9.
- **Violation scope:** this clause (5-field disclosure for new-public-API pre-1.0 releases).
- **Origin:** PR #1144 README § "Pre-Pledge v0" (2026-05-22) — pre-merge co-owner review of the disclosure caught one "we enforce X" claim the implementation actually deferred; it would have shipped as a silent pledge otherwise.

<!-- /slot:neutral-body -->
