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

**Trust Posture Wiring (Eagerly-Imported Transitive Dependencies):**

- **Severity:** `halt-and-report` at the /release gate (release-specialist mechanical clean-venv eager-import sweep).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** 3× same-rule in 30d → drop 1 posture per `trust-posture.md` MUST-4.
- **Regression-within-grace:** emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart `[ack: deployment-transitive-deps]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** /release-time mechanical sweep — clean venv, install the built wheel of every published package, import each top-level module; any `ImportError` = release halt. **Probes: REGISTERED — `.claude/test-harness/probes/deployment.probes.json`**, 12 rows in 6 bipolar `pair_id` pairs (one firing pair per derived clause, plus a meta-compliance pair), with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/deployment/`. Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses in `clause-coverage-baseline.json`. This clause's pair is the load-bearing one for the sweep above: its violating pole RUNS a TestPyPI stage and an import check and passes both, because the import goes into the ambient environment rather than a `--clear` venv — so a check that the sweep HAPPENED scores it clean, and only reading which environment it ran in catches it. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.
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

**Trust Posture Wiring (Pre-Pledge Release Disclosure):**

- **Severity:** `halt-and-report` at the /release gate (release-specialist mechanical sweep on any new public API with a `0.*` / `v0.*` / pre-pledge version anchor).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** 3× same-rule in 30d → drop 1 posture per `trust-posture.md` MUST-4.
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (retired, loom#2102); Rule-8 deviation: the release gate already holds the stop for this class.
- **Receipt requirement:** SessionStart hard-gate `[ack: pre-pledge-disclosure]` IFF `posture.json::pending_verification` includes this rule_id AND the impending /release anchor is `0.*` AND the release diff adds a NEW public API surface.
- **Detection mechanism:** /release-time release-specialist sweep — for every new public module/package shipping at `0.*`, grep README.md + docs/ for a section titled "Pre-Pledge" / "v0 Disclosure" / "Pre-1.0 Status" (or equivalent) AND assert the 5 required fields are enumerated. Phase 2 (deferred): hook detector `.claude/hooks/lib/violation-patterns.js::detectPrePledgeReleaseMissingDisclosure`; audit fixtures land with the detector under the violation-patterns detectPrePledgeReleaseMissingDisclosure subdir per `cc-artifacts.md` Rule 9.
- **Violation scope:** this clause (5-field disclosure for new-public-API pre-1.0 releases).
- **Origin:** PR #1144 README § "Pre-Pledge v0" (2026-05-22) — pre-merge co-owner review of the disclosure caught one "we enforce X" claim the implementation actually deferred; it would have shipped as a silent pledge otherwise.

## MUST: Two Trunks, Asymmetric By Design — `dev` Carries Throughput, `main` Carries Quality

A repo running the two-trunk model MUST keep the two trunks ASYMMETRIC. The asymmetry is the point; collapsing them into "two branches with the same rules" forfeits the whole benefit. Four obligations, all four binding:

1. **`dev` is the THROUGHPUT trunk.** Lane work merges into `dev` CONTINUOUSLY and UN-GATED — no PR-gate matrix, no review wait, no cost. A push to `dev` MUST fire ZERO gate workflow runs; verify against the runs API for that SHA, where a non-empty run set is the falsifying result and means the workflow triggers are misconfigured, not that the model is in force.
2. **The DEV-SERVER deploy runs off a PINNED `dev` commit — never `main`, never a moving ref.** The deploy names an immutable SHA. Deploying the `dev` branch tip by name, or promoting `main` onto the dev server, is BLOCKED.
3. **`main` is the QUALITY trunk and the ONLY source of PRODUCTION.** `dev` → `main` is ONE PR carrying the accumulated lane work, ONE full gate run, on a deliberate cadence. A production deploy's ref MUST be reachable from `main`; deploying to production from `dev`, from a lane branch, or from an un-promoted SHA is BLOCKED.
4. **A standing PROMOTION CADENCE MUST be declared and honored.** Declare it in `deploy/deployment-config.md` (§ Release Config). Letting `dev` → `main` drift with no cadence is BLOCKED.

**Scope note — "never deploy from `main`" is the DEV-SERVER rule, not a production rule.** Obligations 2 and 3 name different TARGETS and do not conflict: the DEV server is never fed from `main`, and PRODUCTION is fed from `main` and nowhere else. Reading obligation 2 as "production must never come from `main`" inverts the model.

**A deploy to a namespace serving real client traffic still requires an explicit human yes** — unchanged by this clause, and not softened by `main` being the pre-agreed production source. The topology decides WHERE production may come from; it never decides WHETHER this promotion happens.

```bash
# DO — free landing on dev; pinned dev-server ref; one deliberate promotion; production off main
git switch dev && git merge --no-ff lane/x && git push        # fires no gate run
deploy --env dev  --ref 9f3c1a2                               # PINNED immutable SHA
gh pr create --base main --head dev --title "promote: dev → main (weekly cadence)"
git merge-base --is-ancestor "$REF" main && deploy --env prod --ref "$REF"   # + human yes

# DO NOT — flatten the asymmetry, float the ref, or let the cadence lapse
gh pr create --base dev --head lane/x   # gating dev re-imposes the bottleneck dev removes
deploy --env dev  --ref dev             # moving ref: what shipped is unknowable after the next push
deploy --env prod --ref dev             # production off the un-gated trunk
# ...six weeks with no promotion PR → the next one is an unreviewable megamerge
```

**BLOCKED rationalizations:**

- "Both trunks should have the same checks — consistency is good hygiene"
- "Gating `dev` too is safer, and it costs nothing"
- "Deploying the `dev` branch tip is close enough to a pinned commit"
- "The directive says never deploy from `main`, so production can't come from `main` either"
- "`main` is already gated, so the production deploy needs no human yes"
- "We'll promote to `main` when there's something worth promoting"
- "A promotion cadence is process overhead — we promote when we're ready"
- "One big promotion PR is more efficient than several small ones"
- "`dev` and `main` have the same content right now, so it doesn't matter which we deploy"
- "The lane branch is green, ship it to prod from there"

**Why:** The asymmetry IS the mechanism — `dev` buys throughput precisely by being un-gated and `main` buys quality precisely by being gated once — so anything that makes the two alike (gating `dev`, or shipping production from `dev`) relocates the bottleneck instead of removing it. Without a standing promotion cadence `main` rots and the first promotion after a long gap is a large, hard-to-review merge: the same bottleneck arriving late and all at once.

**Trust Posture Wiring (Two Trunks, Asymmetric By Design):**

- **Severity:** `halt-and-report` at the `/deploy` + `/release` gate (release-specialist confirms the production ref is reachable from `main`, the dev-server ref is an immutable SHA, and the declared promotion cadence has been honored); `advisory` at any hook layer per `hook-output-discipline.md` MUST-2 — which environment a deploy invocation targets is read from its arguments, and a mis-read would block work the operator was instructed to perform.
- **Grace period:** 7 days from clause landing (2026-09-10 → 2026-09-17).
- **Cumulative posture impact:** same-class violations (a production deploy from a ref not reachable from `main`; a dev-server deploy naming a moving ref; a gate matrix fired on a `dev` push; a promotion cadence undeclared or lapsed) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the `/deploy` + `/release` gate already holds the stop for this class, so an instant-drop key would double-count it. Same disposition this file's § Pre-Pledge clause took.
- **Receipt requirement:** SessionStart soft-gate `[ack: deployment-two-trunks]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — release-specialist at `/release` + reviewer at `/implement` confirm (a) `git merge-base --is-ancestor <prod-ref> main` succeeds, (b) the dev-server deploy names a SHA rather than a branch name, (c) the most recent `dev` push carries no gate workflow run, and (d) `deploy/deployment-config.md` declares a promotion cadence whose last honored promotion falls inside it. Those four signals are STRUCTURAL — a git-object fact, an argv token, a runs-API read, a parsed-document field — so a mechanical gate is BUILDABLE here and this clause does not pretend otherwise; none ships with it, and gate-review is the enforcement layer until one is separately accepted. **Probes: REGISTERED — `.claude/test-harness/probes/deployment.probes.json`** carries a `MUST-Two-Trunks-firing` bipolar pair whose violating pole satisfies EVERY one of those four structural signals — the ref is a pinned immutable SHA, the CI query is controlled, the cadence is declared and honoured, and the human approval is obtained in a genuine user turn — and is still a violation, because the one test obligation 3 names (`git merge-base --is-ancestor <ref> main`) is never run and would have returned 1. That is the measured gap a mechanical gate on those four signals would NOT close, and it is why the semantic tier is not redundant with the buildable one.
- **Violation scope:** this clause (two-trunk asymmetry) ONLY — its four obligations plus the dev-server-vs-production scoping; every other clause in this file keeps its own wiring.
- **Origin:** 2026-09-10 — co-owner directive, verbatim: _"main -> production server, dev -> dev server."_ and _"The latter is always speed and throughput, the former is stellar quality."_ Extends the same day's parent directive that lane work merges into `dev` continuously and for free (a `dev` push fires zero workflow runs, verified through the runs API against a `main` control) while `dev` → `main` is one PR, one gate run, on a deliberate cadence, with the dev-server deploy off a pinned `dev` commit. The parent's "never from `main`" is scoped to the DEV-SERVER deploy by the scope note above.

<!-- /slot:neutral-body -->
