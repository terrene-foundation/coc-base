---
id: "COC-ARTIFACT-EVAL-COVERAGE"
paths: [".claude/**"]
---

# COC Artifact Eval Coverage — Every Artifact Ships Structural Fixtures AND A Probe Set

Every COC artifact (rule / agent / skill / command / hook / COC-tool under `.claude/`) is a behavior-shaping deliverable: it changes what a consuming agent is licensed to do. An artifact that ships with no eval coverage advertises a behavior nobody verified — the same lookaway risk `spec-accuracy.md` blocks for specs, one surface over. `cc-artifacts.md` Rule 9 already mandates committed structural fixtures for mechanical audit TOOLS; this rule GENERALIZES that contract to ALL COC artifact types and adds the semantic-probe half: a structural fixture proves the artifact's SHAPE (return contract, exit code, presence), a probe proves the artifact's EFFICACY (it actually fires on a violating input and stays quiet on a compliant one — the question `probe-driven-verification.md` mandates asking directly, never via regex over prose).

Two tiers, two gates. **Structural** fixtures run offline/deterministic in CI (`coc-eval-all.mjs`) and hard-gate the PR. **Semantic** probes run at gate-review (`/test-harness-probe` at `/redteam` + `/codify`) as `halt-and-report`, because they need an LLM judge CI does not have (the loom↔csq boundary keeps CI LLM-free). Neither tier alone is convergence.

## MUST Rules

### 1. Every Added Or Modified COC Artifact Ships Structural Fixtures AND A Probe Set

Every COC artifact ADDED or MODIFIED in a `/codify` MUST ship the eval coverage ITS TYPE mandates, registered in `.claude/test-harness/eval-manifest.json` (per the C2 manifest schema — `type`, `scanner`, `fixturesDir`, `expected`, `probes`): a `type:tool` artifact MUST ship a **structural fixture set** (non-null `scanner` + non-empty `expected`; `probes:null` — a tool has no mandated LLM-judge probe per the bootstrap note, and `coc-manifest-integrity.mjs` check (d) HARD-FAILS a `type:tool` entry with a null scanner). A **prose artifact** (rule / command / skill / agent / hook) MUST ship a **probe set** at `.claude/test-harness/probes/<artifact-id>.probes.json` covering its type's mandatory semantic properties (`scanner:null` is permitted — its structural fixture set is OPTIONAL, its efficacy IS the probe). Shipping an artifact registered with NEITHER tier — no manifest-registered structural fixtures AND no probe set — is BLOCKED; that floor is what the "with NEITHER" MUST-NOT below enforces, and the per-type mandate above is which tier is REQUIRED for which type. Each mandatory property MUST carry BOTH a `violation` scenario (the artifact MUST fire) AND a `compliant` scenario (the artifact MUST stay quiet) — no-false-positive is half the efficacy test. Every non-rule detection property (compliance, outcome-fidelity) needs a BIPOLAR schema pair — a compliant-polarity schema (clean = pass) and a violation-polarity schema (detected = pass); a `violation` probe MUST use the violation-polarity schema so a correctly-detected violation scores PASS (`.claude/test-harness/lib/probe-schemas.mjs`: `Compliance{,Violation}Answer`, `OutcomeFidelity{,Violation}Answer`).

**Same-codify plumbing carve-out (recorded via the omission-precedent shape).** A MODIFY that is a **same-codify cross-reference or allowlist-registration edit** to a PRE-EXISTING artifact — one that adds NO new load-bearing MUST / MUST-NOT / BLOCKED clause, only a pointer, cross-link, or a registration this same codify's OTHER changes require — does NOT trip the per-type mandate above; the edit is behavior-neutral, so a fresh probe suite would verify nothing. The carve-out is NARROW and mirrors `self-referential-codify.md` Rule 2's recorded-omission precedent: it covers ONLY the no-new-MUST plumbing edit; any MODIFY adding a new load-bearing clause is covered. **Recorded exemptions for this landing codify:** `cc-artifacts.md` (gained only the informational Rule 9 cross-reference paragraph to this rule — no new MUST) and `self-referential-codify.md` (gained only the allowlist registration this rule's landing requires — no new MUST); both are behavior-neutral plumbing, exempt per this carve-out, recorded here per the `verify-claims-before-write.md` omission-precedent shape.

**Per-type mandatory semantic properties (the minimum probe set, per Contract C3):**

| Type    | Mandatory probe properties                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| rule    | efficacy (fires on a violating transcript, cites the rule) + no-false-positive + meta-compliance (`rule-authoring.md` / `cc-artifacts.md` conformant) |
| hook    | advisory-characterization-correct (the message accurately names the violation) — structural covers return-shape                                       |
| command | outcome-fidelity (documented flow → documented outcome) + meta-compliance (`command-authoring.md`)                                                    |
| skill   | guidance-compliance (procedure is meta-rule-compliant) + outcome-fidelity                                                                             |
| agent   | mandate-honored (given a task, output complies with the agent's declared mandate)                                                                     |

```text
# DO — new rule ships both tiers, registered
Add rules/foo.md
  + eval-manifest.json entry: {"foo": {"type":"rule","scanner":"…","fixturesDir":"…","expected":{…},"probes":"…/foo.probes.json"}}
  + .claude/audit-fixtures/foo/ structural cases (fires-case + clean-pass case)
  + .claude/test-harness/probes/foo.probes.json (efficacy + no-false-positive + meta-compliance,
    EACH with a violation scenario AND a compliant scenario)

# DO NOT — ship the artifact with neither tier
Add rules/foo.md   # no manifest entry, no probe file → BLOCKED
```

**BLOCKED rationalizations:**

- "The rule is prose; a probe is overkill for it"
- "I'll add fixtures/probes later when someone modifies the artifact"
- "The artifact is too simple to need coverage"
- "cc-architect's `/codify` review is enough verification"
- "Structural fixtures cover it; the probe is redundant" (structural covers SHAPE, probe covers EFFICACY — they answer different questions)
- "The `violation` scenario is enough; a `compliant` scenario is ceremony" (no-false-positive is the half that catches the over-firing artifact)

**Why:** A structural fixture green tells you the artifact returns the right SHAPE; it says nothing about whether the artifact actually changes agent behavior. Only the probe — an LLM-judge with a JSON-schema answer per `probe-driven-verification.md` MUST-2 — answers "does this rule fire on the violating transcript and stay quiet on the compliant one." An artifact with no probe is a behavior claim nobody tested.

### 2. Every `/redteam` Finding Against A COC Artifact Lands A Named Regression Case

Every `/redteam` finding against a COC artifact MUST land a NAMED regression case whose case-name IS the finding id — a structural fixture when the finding is mechanical (wrong exit code, missing return field, orphaned reference) OR a probe when the finding is semantic (fired on a compliant input, failed to fire on a violating one, mischaracterized the violation). Fixing the finding and shipping NO regression case is BLOCKED. This converts a one-time audit into permanent coverage: the finding-id case fails the moment a future edit re-opens the class.

```text
# DO — redteam finding → named regression case
/redteam finds "R1-HIGH-2: rule fired on a compliant transcript (false positive)"
→ land probes/foo.probes.json case id "R1-HIGH-2": a compliant scenario the rule MUST stay quiet on

# DO NOT — patch the finding, add nothing to the harness
Patch the rule, close R1-HIGH-2, ship no case
→ the next edit silently re-opens the false-positive; the audit was one-time, not permanent
```

**BLOCKED rationalizations:**

- "The fix is obvious; a regression case is duplication"
- "The redteam already caught it; that's coverage"
- "I'll add the case in a follow-up"
- "The finding was a one-off, it can't recur"

**Why:** A redteam round is expensive human+agent time that verifies the artifact ONCE; without a named regression case the verification evaporates at the context boundary and the next edit re-opens the class with no tripwire. The named case makes the audit's finding a permanent, self-clearing test — the same reflex a client ecosystem fork's eval harness institutionalized (every redteam finding becomes a named harness case).

### 3. Convergence Requires Structural-Green-In-CI AND Probe-Green-At-Gate-Review

An artifact is CONVERGED only when BOTH tiers pass: (a) structural green in CI — `node .claude/bin/coc-eval-all.mjs` exits 0 (offline, deterministic, hard-gates the PR), AND (b) probe green at gate-review — `/test-harness-probe` run at `/redteam` and `/codify` reports every probe PASS (`halt-and-report`). An UNRUN or ERRORED probe is ZERO evidence, never a pass — per `evidence-first-claims.md` MUST-3 + `probe-driven-verification.md` MUST-4, an errored/empty/rate-limited judge return MUST be re-run and MUST NOT count clean. Neither tier alone is convergence: structural-only ships an unverified-efficacy artifact; probe-only ships an unverified-shape artifact.

```text
# DO — both tiers, both green, before convergence
CI:          node .claude/bin/coc-eval-all.mjs → exit 0   (structural, offline, hard-gate)
gate-review: /test-harness-probe foo           → all PASS  (semantic, halt-and-report)

# DO NOT — claim convergence on one tier, or count an errored probe clean
"structural green in CI → converged"                    # probe tier never ran
"/test-harness-probe rate-limited → count it clean"     # errored return = ZERO evidence, re-run
```

**BLOCKED rationalizations:**

- "CI is green, the artifact is done" (CI runs the structural tier only — no LLM judge)
- "The probe errored but the artifact looks right; call it clean"
- "Running probes at gate-review doubles the work"
- "Structural + a code read substitutes for the probe" (a code read is not the probe — the LLM-judge verdict IS the probe per `probe-driven-verification.md` MUST-2)

**Why:** CI is deliberately LLM-free (the loom↔csq boundary — CI must not need an LLM), so CI can only run the deterministic structural tier; the semantic tier needs the judge that lives at gate-review. Treating either tier as the whole gate ships an artifact half-verified. An errored probe read as a pass is the false-convergence `agents.md` § Redteam-Reviewer-Dispatch blocks — an un-reviewed artifact under a converged banner.

### 4. Each Enforcement Artifact Carries A Detection-Mechanism Block Naming Its Scanner + Fixtures + Probes

Every enforcement rule/artifact MUST carry a "Detection mechanism" block (in its Trust-Posture Wiring for a rule, or its equivalent contract section) that names the concrete artifact↔harness binding: the scanner (`.claude/bin/<artifact>-readiness-check.mjs` or the hook/sweep), the fixtures directory (`.claude/audit-fixtures/<id>/`), AND the probe file (`.claude/test-harness/probes/<id>.probes.json`). A Detection block that names a scanner but no fixtures/probes — or that references a fixtures/probe path that does not resolve — is BLOCKED.

```text
# DO — Detection mechanism names the full binding, every path resolving
- **Detection mechanism:** scanner `.claude/bin/foo-readiness-check.mjs`;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`.

# DO NOT — a Detection block with no harness binding
- **Detection mechanism:** cc-architect reviews it at /codify.   # no scanner, no fixtures, no probes
```

**BLOCKED rationalizations:**

- "The Detection field already names the gate reviewer; that's the mechanism"
- "Fixtures and probes are implied by the rule existing"
- "I'll wire the binding after the rule lands"

**Why:** A Detection block that names no harness binding is institutional prose — the reader cannot follow it to the eval that verifies the rule, and the next `xref-integrity` sweep cannot confirm the binding resolves. Naming scanner + fixtures + probes makes the artifact↔harness binding greppable and auditable, closing the same dangling-reference class `cc-artifacts.md` MUST NOT § "No Dangling Cross-References" blocks.

### 5. A Structural Fixture Binds To Its Named Detection Class; Disarm-Resistance Is Proven By Composed Levers, Not Single-Lever Reasoning

Two failure modes where a gate's coverage/resistance is INFERRED from a proxy instead of VERIFIED directly:

**(a) Detection-class binding.** A structural fixture set proves a scanner FLAGS-vs-STAYS-QUIET (its polarity mix). It does NOT, by exit-code + grade alone, prove a fixture exercises its INTENDED named detection class — two different violation fixtures can share the same exit + grade while failing DIFFERENT checks. Every violation-detection fixture MUST bind to the specific named check it exercises (assert the scanner's per-check output fails THAT check-id — or a content-hash pin) so a fixture-content swap that flips to a different failing check (same exit + grade) is caught. Accepting the polarity mix as sufficient is BLOCKED.

**(b) Composed-lever disarm-resistance.** A claim that a gate RESISTS a disarm class MUST be verified by EXECUTING the composed adversarial levers (run the multi-step attack; show the gate exits non-zero / stays should-be-red), NEVER by reasoning about each lever in ISOLATION. A single-lever "this lever alone is defeated" analysis does NOT establish resistance to that lever COMPOSED with another.

```text
# DO — (a) bind the fixture to its class; (b) execute the composed attack
expected["flag-injection-sha"] = { exit: 1, grade: "INVALID", critical_failures: ["fork-anchor-sha-hex"] }
# redteam: actually RUN repoint-fixturesDir + drop-negatives TOGETHER → observe the exit code

# DO NOT — (a) accept polarity mix as coverage; (b) reason one lever at a time
expected["flag-injection-sha"] = { exit: 1, grade: "INVALID" }   # any INVALID fixture satisfies it
# "repoint-fixturesDir alone is defeated by the real scanner" → SHIPS the composed repoint+prune disarm
```

**BLOCKED rationalizations:**

- "exit + grade already prove the fixture is a violation" (they prove polarity, not WHICH detection class)
- "the polarity mix is bipolar, that's full coverage" (bipolar ≠ class-bound)
- "I reasoned each lever is individually defeated" (composition is the untested case — the lever that shipped)
- "executing the composed attack is /redteam's job, not the fixture's" (the resistance CLAIM needs the composed execution before it is made)

**Why:** Both are the proxy-for-truth failure the eval harness exists to eliminate, one layer up. A polarity-only fixture set reports green while a named detection class silently goes uncovered (a content swap erases it); a single-lever resistance claim reports "defeated" while the COMPOSED levers walk through — the exact failure the canon-sync gate shipped (journal 0005 claimed "repoint `fixturesDir` is defeated" from isolated reasoning; the R7 redteam refuted it by composing repoint + `expected`-prune, fixed by the (h) bipolar floor + (i) pin in R7, and the `critical_failures` detection-class binding added in R8). Bind the fixture to its class; execute the composed attack before claiming resistance.

## MUST NOT

- Ship a COC artifact (added or modified) with neither a manifest-registered structural fixture set NOR a probe set

**Why:** An artifact with no eval coverage is an unverified behavior claim — the originating failure mode this rule blocks.

- Count an unrun, errored, or rate-limited probe as a PASS

**Why:** An errored judge return and a genuinely-clean return are indistinguishable in a tally yet opposite in meaning; counting the error clean ships an un-verified artifact under a converged banner (`evidence-first-claims.md` MUST-3).

- Close a `/redteam` finding against a COC artifact without landing its named regression case

**Why:** Without the named case the audit's verification is one-time and evaporates at the context boundary; the next edit re-opens the class with no tripwire.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm every added/modified artifact ships both tiers and that the two-tier convergence held); `block` at the structural CI tier (`coc-eval-all.mjs` non-zero exit is a deterministic file/exit-code signal per `hook-output-discipline.md` MUST-2 — structural signals MAY carry block); `advisory` at any future prose-detection hook layer (whether an artifact is "adequately probed" is judgment-bearing, not a lexical match).
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (an artifact shipped with no eval coverage; a finding closed with no regression case; a one-tier convergence claim) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (an eval-coverage-adequacy judgment is review-layer-only and semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it).
- **Receipt requirement:** SessionStart soft-gate `[ack: coc-artifact-eval-coverage]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (structural, CI + manual) — `node .claude/bin/coc-eval-all.mjs` (offline, deterministic, hard-gates the PR via `.github/workflows/coc-artifact-eval.yml`) verifies every manifest-registered artifact's structural fixtures; cc-architect at `/codify` + reviewer at `/redteam` confirm (a) every added/modified artifact has a manifest entry AND a probe file, (b) every `/redteam` finding landed its named regression case, (c) the semantic tier ran via `/test-harness-probe` and every probe genuinely PASSED (no errored return counted clean). The LLM-judge probe tier is NOT in CI (the loom↔csq boundary keeps CI LLM-free) — it is dispatched in-session via `/test-harness-probe`. Scanner: `.claude/bin/coc-eval-all.mjs` (+ per-artifact `.claude/bin/<id>-readiness-check.mjs`); fixtures: `.claude/audit-fixtures/<id>/` + `.claude/test-harness/eval-manifest.json`; probes: `.claude/test-harness/probes/<id>.probes.json`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout, after ≥3 real codify cycles exercise Phase 1) — an advisory `PostToolUse(Edit|Write)` detector flagging a `.claude/` artifact edit whose diff lands no matching manifest/probe change; audit fixtures at `.claude/audit-fixtures/coc-artifact-eval-coverage/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (both-tier coverage on add/modify) + MUST-2 (named regression case per redteam finding) + MUST-3 (two-tier convergence, errored-probe-is-zero-evidence) + MUST-4 (Detection block names the artifact↔harness binding) + MUST-5 (fixture binds to its named detection class; disarm-resistance proven by composed levers).
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Generalizes** `cc-artifacts.md` Rule 9 (committed structural fixtures for mechanical audit TOOLS) from the tool subset to ALL COC artifact types, and adds the semantic-probe half.
- **Instantiates** `probe-driven-verification.md` (semantic verification is probe-driven, never regex) and `user-flow-validation.md` MUST-7 (write-surface fixtures per failure-mode class) at the COC-artifact-authoring layer.
- **Feeds** the two-tier convergence into `wave-loop.md` G1 + `self-referential-codify.md` Rule 1 (a self-referential codify's redteam round consumes both tiers).
- **Pairs with** `evidence-first-claims.md` MUST-3 (an errored command is zero evidence) — MUST-3 here is that principle applied to a probe return.

## Origin

2026-07-16 — canon-sync + COC eval-harness institutionalization (BUILD-repo `/codify`, Contract C4). Owner-ratified. Institutionalizes the two-tier eval-coverage contract (structural fixtures in CI + LLM-judge probes at gate-review) across every COC artifact type, generalizing `cc-artifacts.md` Rule 9's tool-only fixture mandate; the redteam→named-regression-case reflex (MUST-2) mirrors a client ecosystem fork's eval harness. Structural harness (`coc-eval-all.mjs`, `eval-manifest.json`) authored in cluster K2; probe layer (`test-harness-probe.md`, `probes/`) in cluster K3; this rule + the `cc-artifacts.md` Rule 9 cross-link + the CI structural gate in cluster K4. MUST-5 (detection-class binding + composed-lever disarm-resistance) added from the same cycle's R7/R8 redteam.

**Landed at loom** 2026-07-19 via `/sync-from-build` Gate-1 classification (Wave-2 of the F4 eval-harness Tier-1 adoption, C2 MERGE-selective). loom adopts the eval ENGINE + this coverage rule but DELIBERATELY EXCLUDES the canon-sync readiness scanner (a separate F3 canon-incorporation decision), so loom's `eval-manifest.json` carries no canon-sync structural entry; loom's own structural scanners land their entries when authored. The 7-day grace clock bootstraps at land-time per `trust-posture.md` § Two-Phase Rollout.

**Grace-period bootstrap exemption — this rule's OWN probe self-coverage is DEFERRED.** MUST-1 mandates every prose artifact ship a probe set; this rule (a prose artifact) would satisfy its own mandate by registering `.claude/test-harness/probes/coc-artifact-eval-coverage.probes.json` in the manifest. At loom that registration is DEFERRED during the grace period: loom's harness steady-state is an EMPTY `eval-manifest.json` (engine-only, no local structural scanners), and the eval-harness engine self-tests (`.claude/test-harness/tests/coc-eval-all.test.mjs`) deliberately drive MINIMAL temp manifests over loom's REAL on-disk tree to exercise the CI-gate paths. Because `coc-manifest-integrity.mjs` check (e) (orphan-probe) scans the real `.claude/test-harness/probes/` dir regardless of which manifest is loaded, a probe file present on disk but unreferenced by a minimal temp manifest reds the CI engine-self-test step — a Wave-1↔Wave-2 integration seam. Per the same two-phase-rollout carve-out `self-referential-codify.md` Rule 3 applies to a bootstrapping meta-rule, the probe suite lands when loom's harness graduates from the empty-manifest steady-state OR the Wave-1 self-tests are updated to admit a registered prose/probe entry (whichever first); the canonical probe content lives in the BUILD-repo source rule's `coc-artifact-eval-coverage.probes.json`. Until then this rule's Phase-1 coverage is the cc-architect `/codify` + reviewer `/redteam` gate-review (its Detection-mechanism Phase 1), NOT a registered probe.

**Bootstrap note — the harness ENGINE is `type:tool`, not a per-type probe subject.** The eval-harness's own engine tooling (`.claude/bin/coc-eval-core.mjs`, `.claude/bin/coc-eval-all.mjs`, `.claude/bin/coc-manifest-integrity.mjs`, `.claude/test-harness/lib/probe-schemas.mjs`) is `type:tool` — its correctness is proven by its own committed self-tests (the `manifest-integrity` gate + the scanner-timeout / grade-pin regressions at `.claude/test-harness/tests/coc-eval-core.test.mjs`, `.claude/test-harness/tests/coc-eval-all.test.mjs`, and `.claude/test-harness/tests/coc-manifest-integrity.test.mjs`), NOT by the per-type mandatory-probe table in MUST-1 (which governs the prose/behavioral artifact types: rule / command / skill / agent / hook). A `type:tool` entry carries `probes: null` in the manifest (C3 — a tool has no mandated LLM-judge probe); it is covered by the structural CI tier's fixtures/self-tests. This avoids the bootstrap circularity of demanding an LLM-judge probe of the very engine that dispatches probes. (At loom the engine bins are covered by their committed self-tests directly — loom registers no `type:tool` entry for them per the empty-manifest C2 adaptation; the canon-sync structural fixtures the BUILD-repo bootstrap note also cited are NOT present at loom by the F3-exclusion decision above.)
