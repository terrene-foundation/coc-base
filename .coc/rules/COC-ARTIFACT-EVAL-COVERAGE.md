---
id: "COC-ARTIFACT-EVAL-COVERAGE"
paths: [".claude/**"]
---

# COC Artifact Eval Coverage — Every Artifact Ships Structural Fixtures AND A Probe Set

Every COC artifact (rule / agent / skill / command / hook / COC-tool under `.claude/`) is a behavior-shaping deliverable: it changes what a consuming agent is licensed to do. An artifact that ships with no eval coverage advertises a behavior nobody verified — the same lookaway risk `spec-accuracy.md` blocks for specs, one surface over. `cc-artifacts.md` Rule 9 already mandates committed structural fixtures for mechanical audit TOOLS; this rule GENERALIZES that contract to ALL COC artifact types and adds the semantic-probe half: a structural fixture proves the artifact's SHAPE (return contract, exit code, presence), a probe proves the artifact's EFFICACY (it actually fires on a violating input and stays quiet on a compliant one — the question `probe-driven-verification.md` mandates asking directly, never via regex over prose).

Two tiers, two gates. **Structural** fixtures run offline/deterministic in CI (`coc-eval-all.mjs`) and RED the PR check. **Semantic** probes run at gate-review (`/test-harness-probe` at `/redteam` + `/codify`) as `halt-and-report`, because they need an LLM judge CI does not have (the loom↔csq boundary keeps CI LLM-free). Neither tier alone is convergence.

## MUST Rules

### 1. Every Added Or Modified COC Artifact Ships Structural Fixtures AND A Probe Set

Every COC artifact ADDED or MODIFIED in a `/codify` MUST ship the eval coverage ITS TYPE mandates, registered in `.claude/test-harness/eval-manifest.json` (per the C2 manifest schema — `type`, `scanner`, `fixturesDir`, `expected`, `probes`): a `type:tool` artifact MUST ship a **structural fixture set** (non-null `scanner` + non-empty `expected`; `probes:null` — a tool has no mandated LLM-judge probe per the bootstrap note, and `coc-manifest-integrity.mjs` check (d) HARD-FAILS a `type:tool` entry with a null scanner). A **prose artifact** (rule / command / skill / agent / hook) MUST ship a **probe set** at `.claude/test-harness/probes/<artifact-id>.probes.json` covering its type's mandatory semantic properties (`scanner:null` is permitted — its structural fixture set is OPTIONAL, its efficacy IS the probe). Shipping an artifact registered with NEITHER tier — no manifest-registered structural fixtures AND no probe set — is BLOCKED; that floor is what the "with NEITHER" MUST-NOT below enforces, and the per-type mandate above is which tier is REQUIRED for which type. Each mandatory property MUST carry BOTH a `violation` scenario (the artifact MUST fire) AND a `compliant` scenario (the artifact MUST stay quiet) — no-false-positive is half the efficacy test. Every non-rule detection property (compliance, outcome-fidelity) needs a BIPOLAR schema pair — a compliant-polarity schema (clean = pass) and a violation-polarity schema (detected = pass); a `violation` probe MUST use the violation-polarity schema so a correctly-detected violation scores PASS (`.claude/test-harness/lib/probe-schemas.mjs`: `Compliance{,Violation}Answer`, `OutcomeFidelity{,Violation}Answer`).

**Same-codify plumbing carve-out (recorded via the omission-precedent shape).** A MODIFY that is a **same-codify cross-reference or allowlist-registration edit** to a PRE-EXISTING artifact — one that adds NO new load-bearing MUST / MUST-NOT / BLOCKED clause, only a pointer, cross-link, or a registration this same codify's OTHER changes require — does NOT trip the per-type mandate above; the edit is behavior-neutral, so a fresh probe suite would verify nothing. The carve-out is NARROW and mirrors `self-referential-codify.md` Rule 2's recorded-omission precedent: it covers ONLY the no-new-MUST plumbing edit; any MODIFY adding a new load-bearing clause is covered. **Recorded exemptions for this landing codify:** `cc-artifacts.md` (gained only the informational Rule 9 cross-reference paragraph to this rule — no new MUST) and `self-referential-codify.md` (gained only the allowlist registration this rule's landing requires — no new MUST); both are behavior-neutral plumbing, exempt per this carve-out, recorded here per the `verify-claims-before-write.md` omission-precedent shape.

**Probe-file extension + the three manifest declarations (the gate fails closed when unconfigured).** A probe DEFINITION ships as `.probes.json` — the JSON array of `artifact_id`-keyed rows `coc-manifest-integrity.mjs` check (b) parses. `.probes.jsonl` is what `/test-harness-probe` emits for probe RESULTS; a `.jsonl` file under `.claude/test-harness/probes/` is therefore a STAGED definition, never a registered one. Check (e) enumerates BOTH extensions, so renaming a probe file no longer hides it from the orphan check — a staged-but-unregistered probe MUST instead be declared per-file as `_deferred_probes: {"<path>": {reason, graduation}}`. Symmetrically, a manifest with ZERO entries MUST carry `_declared_empty: {reason, graduation}` (check (k)): an absent, unparseable, or undeclared-empty manifest is an UNCONFIGURED harness and `coc-eval-all.mjs` FAILS CLOSED on it, while a declared zero-entry run exits 0 only under a `NO STRUCTURAL COVERAGE` banner and never prints `ALL STRUCTURAL PASS`. Third, a repo whose class routes structural-entry pins to its OWN eval-manifest but which pins none MUST carry `_declared_no_pins: {reason, graduation, expires}` (check (i)): an UNDECLARED pin set is not an EMPTY one, so the undeclared case is loud and actionable rather than silently vacuous, and declaring no-pins while real pins exist is itself an error (the declaration would re-authorize a future un-pinned run). All three declarations are stale-checked — carrying one past its stated graduation condition or expiry is a HARD fail — so none can harden into a standing exemption.

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

An artifact is CONVERGED only when BOTH tiers pass: (a) structural green in CI — `node .claude/bin/coc-eval-all.mjs` exits 0 **AND asserts coverage** (`--json` `summary.coverage_asserted: true`; a zero-structural-entry run exits 0 having verified NOTHING and is not convergence evidence — cite the coverage, never the exit code alone), AND (b) probe green at gate-review — `/test-harness-probe` run at `/redteam` and `/codify` reports every probe PASS (`halt-and-report`). An UNRUN or ERRORED probe is ZERO evidence, never a pass — per `evidence-first-claims.md` MUST-3 + `probe-driven-verification.md` MUST-4, an errored/empty/rate-limited judge return MUST be re-run and MUST NOT count clean. Neither tier alone is convergence: structural-only ships an unverified-efficacy artifact; probe-only ships an unverified-shape artifact.

```text
# DO — both tiers, both green, over a manifest that actually covers the artifact
CI:          node .claude/bin/coc-eval-all.mjs --json → exit 0 AND coverage_asserted:true
gate-review: /test-harness-probe foo                  → all PASS  (semantic, halt-and-report)

# DO NOT — claim convergence on one tier, on a vacuous run, or on an errored probe
"structural green in CI → converged"                    # probe tier never ran
"exit 0 over an empty manifest → structural green"      # 0 artifacts checked; verified nothing
"/test-harness-probe rate-limited → count it clean"     # errored return = ZERO evidence, re-run
```

**BLOCKED rationalizations:**

- "CI is green, the artifact is done" (CI runs the structural tier only — no LLM judge)
- "coc-eval-all exited 0, so the structural tier passed" (exit 0 over a zero-entry manifest verified NOTHING — read `coverage_asserted`, and see the `NO STRUCTURAL COVERAGE` banner the run prints)
- "The probe errored but the artifact looks right; call it clean"
- "Running probes at gate-review doubles the work"
- "Structural + a code read substitutes for the probe" (a code read is not the probe — the LLM-judge verdict IS the probe per `probe-driven-verification.md` MUST-2)

**Why:** CI is deliberately LLM-free (the loom↔csq boundary — CI must not need an LLM), so CI can only run the deterministic structural tier; the semantic tier needs the judge that lives at gate-review. Treating either tier as the whole gate ships an artifact half-verified. An errored probe read as a pass is the false-convergence `agents.md` § Redteam-Reviewer-Dispatch blocks — an un-reviewed artifact under a converged banner.

### 4. Each Enforcement Artifact Carries A Detection-Mechanism Block Naming Its Scanner + Fixtures + Probes

Every enforcement rule/artifact MUST carry a "Detection mechanism" block (in its Trust-Posture Wiring for a rule, or its equivalent contract section) that names the concrete artifact↔harness binding: the scanner (`.claude/bin/<artifact>-readiness-check.mjs` or the hook/sweep), the fixtures directory (`.claude/audit-fixtures/<id>/`), AND the probe file (`.claude/test-harness/probes/<id>.probes.json`). A Detection block that names a scanner but no fixtures/probes — or that references a fixtures/probe path that does not resolve — is BLOCKED.

**The declared exit for an UNWRITTEN probe suite.** A suite whose AUTHORSHIP is deferred MUST still be NAMED — the binding stays greppable — and its absence MUST be declared in `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals` keyed by the probe path, carrying `rule` + `risk` band + substantive `reason` + `graduation` + a calendar `expires` inside that band's horizon. This is the ONLY honest exit: silently omitting the path is the MUST-4 gap itself, and the `<!-- detection-binding-check: absent-by-design -->` marker asserts a path that must NEVER exist, so using it for a suite that SHOULD exist converts a dated omission into a permanent silent green. An UNDECLARED non-resolving probe path stays BLOCKED, and an EXPIRED declaration is not a declaration — `detection-binding-check.mjs` reds it as a dangler and `phase2-deferral-integrity.mjs` fails the registry, independently. Do NOT conflate it with `eval-manifest.json::_deferred_probes`, its exact complement: that declares a suite that IS on disk but unregistered and goes stale when the file is ABSENT; this declares a suite that is UNWRITTEN and goes stale when the file APPEARS.

```text
# DO — Detection mechanism names the full binding, every path resolving
- **Detection mechanism:** scanner `.claude/bin/foo-readiness-check.mjs`;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`.

# DO — the suite is unwritten: NAME it anyway, and declare the absence with a date
- **Detection mechanism:** scanner `…`; fixtures `…`; probes
  `.claude/test-harness/probes/foo.probes.json` — NOT YET AUTHORED, declared in
  phase2-deferrals.json::probe_authorship_deferrals (expires 2026-12-18).

# DO NOT — a Detection block with no harness binding
- **Detection mechanism:** cc-architect reviews it at /codify.   # no scanner, no fixtures, no probes

# DO NOT — launder an unwritten suite as one that must never exist
<!-- detection-binding-check: absent-by-design <probes path> — not written yet -->
```

**BLOCKED rationalizations:**

- "The Detection field already names the gate reviewer; that's the mechanism"
- "Fixtures and probes are implied by the rule existing"
- "I'll wire the binding after the rule lands"
- "The suite isn't written, so leaving the probe path out is the accurate thing to do" (omission is the gap; naming it under a dated declaration is)
- "absent-by-design is the closest declared route, so use that" (it means never-exists; a deferred suite should exist — the marker would make the omission permanent and silent)

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

### 6. Adding A Declaration Surface Obliges Registering It — Run The Preflight Before Push

`eval-manifest.json` is one of SEVERAL registries a `.claude/**` placement can owe a row to, and the obligation set is DISTRIBUTED — no artifact enumerates it, so an author must already know every coupling. Therefore: any change ADDING a declaration surface (a `*.test.mjs` suite under `.claude/test-harness/tests/` or `.claude/bin/`; an `audit-fixtures/<dir>/run.mjs`; a probe file; a scanner; a hook; a deployment-local rule; a Wiring block deferring a Phase-2 detector; a bin tool a SHIPPED command invokes; a module fenced out of the community edition) MUST run `node .claude/bin/registration-preflight.mjs` and reach exit 0 BEFORE pushing. Pushing an un-preflighted declaration change is BLOCKED. Two corollaries, both load-bearing:

**(a) Report every finding at once — never fail-fast on a coupling sweep.** A sweep over N independent obligations MUST evaluate all N and report them together. Exiting on the first is what makes one forgotten row HIDE the rest, converting one fix into N push cycles.

**(b) A local harness green is not a CI-equivalent green.** `run-harness-suites.mjs` runs only `mode: bulk`; `dedicated` and `excluded` rows are counted as wired and NOT executed — and three of the twelve dedicated suites ARE declaration-closure gates. A `175/175` trailer is therefore a green over a SMALLER DENOMINATOR than the gate runs. Citing it as "CI will pass" is BLOCKED; run the dedicated suites the runner's own epilogue names, or say the question is unanswered.

```text
# DO — preflight before push; it names the exact row and reports ALL findings
$ node .claude/bin/registration-preflight.mjs
MISSING  bin-suites  → declare in .claude/test-harness/ci-suites-bin.json
MISSING  always-include → declare in sync-tier-aware.mjs::ALWAYS_INCLUDE
# DO NOT — push on a local bulk-only green, then meet the registries one at a time
$ node .claude/bin/run-harness-suites.mjs   # 175/175 → "CI will be green"  ← 12 suites never ran
```

**BLOCKED rationalizations:**

- "the full harness passed locally" (bulk only — the dedicated closure gates did not run)
- "CI will tell me" (that is the latency this clause exists to remove; it also masks, one row per push)
- "I only added a test file, that is not a declaration surface" (a `*.test.mjs` file IS one — it owes a registry row)
- "the preflight duplicates CI, so running it is ceremony" (it duplicates the CHECKS; it does not duplicate the ORDER or the non-masking)
- "I registered the obvious one, the others do not apply here" (which apply is the preflight's verdict, not the author's recollection)
- "fixing the first finding is enough to unblock the push" (the sweep reports all of them precisely so it is not)

**Why:** Measured across one session, FIVE separate registries were tripped by ONE failure shape — a placement added a declaration surface and did not register it — and every instance was caught by its gate while NOT ONE was caught by review. Review cannot hold a distributed obligation set in attention; a 7-second sweep can. And the masking is not incidental: the cheapest gate runs first and exits before the others, so discovering the couplings serially is the DEFAULT outcome, not bad luck.

## MUST NOT

- Cite a `run-harness-suites.mjs` green as evidence CI will pass, without running the `dedicated` suites its epilogue names

**Why:** The bulk denominator excludes twelve suites, three of them declaration-closure gates — the green is over a smaller set than the gate runs (`instrument-discipline.md` MUST-2a).

- Ship a COC artifact (added or modified) with neither a manifest-registered structural fixture set NOR a probe set

**Why:** An artifact with no eval coverage is an unverified behavior claim — the originating failure mode this rule blocks.

- Count an unrun, errored, or rate-limited probe as a PASS

**Why:** An errored judge return and a genuinely-clean return are indistinguishable in a tally yet opposite in meaning; counting the error clean ships an un-verified artifact under a converged banner (`evidence-first-claims.md` MUST-3).

- Close a `/redteam` finding against a COC artifact without landing its named regression case

**Why:** Without the named case the audit's verification is one-time and evaporates at the context boundary; the next edit re-opens the class with no tripwire.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm every added/modified artifact ships both tiers and that the two-tier convergence held); `block` at the structural CI tier (`coc-eval-all.mjs` non-zero exit is a deterministic file/exit-code signal per `hook-output-discipline.md` MUST-2 — structural signals MAY carry block). **Enforcement reality — re-measured 2026-08-08 and it CHANGED: a red check now DOES block merge at loom** (`required_status_checks.contexts` → `["Required checks"]`, `enforce_admins.enabled` → `true`; loom #65 step 1). The 2026-07-26 / 2026-08-01 measurements found no such key and `false`, and were true when written. **Whether a check blocks is a claim about MUTABLE repo settings: re-measure it, never cite this line** — and read the shape with `has()`, never `--jq '{required_status_checks}'`. **Read the shape with `has()`, never `--jq '{required_status_checks}'`** — the object-construction form CONSTRUCTS the key and yields `null` for a missing one, so it cannot distinguish ABSENT from PRESENT-AND-NULL and is a non-discriminating instrument in this rule's own sense (`instrument-discipline.md` MUST-1). An earlier revision of this line said the API "returns `required_status_checks: null`", which is what that weaker form shows; the conclusion is unchanged (an absent key is at least as permissive as a null one). What would make `block` literal: add this check to `required_status_checks.contexts` and enable `enforce_admins`. Until then cite the gate as evidence-producing, not merge-preventing; `advisory` at any future prose-detection hook layer (whether an artifact is "adequately probed" is judgment-bearing, not a lexical match).
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (an artifact shipped with no eval coverage; a finding closed with no regression case; a one-tier convergence claim) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (an eval-coverage-adequacy judgment is review-layer-only and semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it).
- **Receipt requirement:** SessionStart soft-gate `[ack: coc-artifact-eval-coverage]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (structural, CI + manual) — `node .claude/bin/coc-eval-all.mjs` (offline, deterministic; runs on every PR matching the FOUR-entry `paths:` filter in `.github/workflows/coc-artifact-eval.yml` (`.claude/**`, `tests/integration/multi-operator/**`, the workflow file itself, `variants/**`) and targeting `main`; it carries no `push:`/`schedule:`/`workflow_dispatch:` trigger, so a PR touching only `journal/` or `workspaces/` does NOT run it. Naming only `.claude/**` here would understate the trigger set — the `variants/**` entry is load-bearing (the workflow's own comment records it was added because a fork's root-level overlays made the detect job's `variants/` arm unreachable), so describing the filter as `.claude/**`-only re-states the fork-coverage error that comment documents fixing) verifies every manifest-registered artifact's structural fixtures, and FAILS CLOSED when the manifest is absent, unparseable, or empty-without-`_declared_empty`; cc-architect at `/codify` + reviewer at `/redteam` confirm (a) every added/modified artifact has a manifest entry AND a probe file, (a2) any green cited as structural evidence came from a run with `coverage_asserted: true` — not a zero-entry exit 0 — and any `_declared_empty` / `_deferred_probes` declaration in the diff carries a real graduation condition, (b) every `/redteam` finding landed its named regression case, (c) the semantic tier ran via `/test-harness-probe` and every probe genuinely PASSED (no errored return counted clean). The LLM-judge probe tier is NOT in CI (the loom↔csq boundary keeps CI LLM-free) — it is dispatched in-session via `/test-harness-probe`. Scanner: `.claude/bin/coc-eval-all.mjs` (+ per-artifact `.claude/bin/<id>-readiness-check.mjs`, and `.claude/bin/detection-binding-check.mjs` for MUST-4's own binding predicate); fixtures: `.claude/audit-fixtures/<id>/` + `.claude/test-harness/eval-manifest.json`; probes: this rule's own suite at `.claude/test-harness/probes/coc-artifact-eval-coverage.probes.json` (the per-artifact form is `.claude/test-harness/probes/<id>.probes.json`). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout, after ≥3 real codify cycles exercise Phase 1) — an advisory `PostToolUse(Edit|Write)` detector flagging a `.claude/` artifact edit whose diff lands no matching manifest/probe change; audit fixtures at `.claude/audit-fixtures/coc-artifact-eval-coverage/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (both-tier coverage on add/modify) + MUST-2 (named regression case per redteam finding) + MUST-3 (two-tier convergence, errored-probe-is-zero-evidence) + MUST-4 (Detection block names the artifact↔harness binding) + MUST-5 (fixture binds to its named detection class; disarm-resistance proven by composed levers).
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-6 (declaration-coupling preflight)

Applies to **MUST-6** ONLY (added 2026-08-11); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. MUST-1..5 stay on the Wiring block above (clause-scoped precedent: `security.md` § Enforcement-Surface Parity, `agents.md` § Correctness-Review-Clean).

- **Severity:** `block` at the CI structural tier — `registration-preflight.mjs`'s non-zero exit is a deterministic exit-code signal, which `hook-output-discipline.md` MUST-2 permits to carry `block`. Whether a red PREVENTS merge is MUTABLE branch-protection state: re-measure it with `has()` per the MUST-1..5 Severity field above, never cite a prior measurement. `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm a declaration-surface change ran the preflight to exit 0 pre-push, and that no bulk-only harness green was cited as CI-equivalent).
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (a declaration surface pushed un-preflighted; a coupling sweep that fails fast instead of reporting all findings; a bulk-only `run-harness-suites.mjs` green cited as CI-equivalent) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key. Named deviation per `trust-posture.md` Rule 8: the CI step already reds deterministically on the registration half, so an instant-drop key would double-count it, and minting one would drag `trust-posture.md` (a `self-referential-codify.md` allowlist file) into a self-referential edit. Same disposition MUST-1..5 took above.
- **Receipt requirement:** SessionStart soft-gate `[ack: coc-artifact-eval-coverage]` IFF `posture.json::pending_verification` includes this rule_id (shared with the MUST-1..5 wiring).
- **Detection mechanism:** Phase 1 (STRUCTURAL, CI + manual — no Phase-2 deferral, so no `phase2-deferrals.json` entry is owed). `node .claude/bin/registration-preflight.mjs` evaluates every declared coupling with NO fail-fast and exits non-zero on any missing declaration, missing checker, or uncovered registry; it runs in `.github/workflows/coc-artifact-eval.yml` as the "Declaration-closure preflight (registration couplings)" step, on the same four-entry `paths:` filter and `main` target described in the MUST-1..5 Detection field above. Its own suite `.claude/bin/registration-preflight.test.mjs` (`mode: bulk` in `ci-suites-bin.json`) pins both vacuity fences by FIRING them on known-positives: an absent checker reports `checker-missing` (never a skip), and a registry no row names reports UNCOVERED. Gate-review confirms the pre-push run and the no-CI-equivalence reading of any cited harness green.
- **Violation scope:** MUST-6 ONLY — its (a) no-fail-fast and (b) not-CI-equivalent corollaries, plus the paired MUST NOT bullet. MUST-1..5 stay on the Wiring block above.
- **Origin:** 2026-08-11 — five registries (`ci-suites.json`, `ci-audit-fixtures.json`, `sync-tier-aware.mjs::ALWAYS_INCLUDE`, `phase2-deferrals.json`, community-edition membership) tripped by one omission shape in a single session; each caught by its gate, none by review. See § Origin.

## Distinct From / Cross-References

- **Generalizes** `cc-artifacts.md` Rule 9 (committed structural fixtures for mechanical audit TOOLS) from the tool subset to ALL COC artifact types, and adds the semantic-probe half.
- **Instantiates** `probe-driven-verification.md` (semantic verification is probe-driven, never regex) and `user-flow-validation.md` MUST-7 (write-surface fixtures per failure-mode class) at the COC-artifact-authoring layer.
- **Feeds** the two-tier convergence into `wave-loop.md` G1 + `self-referential-codify.md` Rule 1 (a self-referential codify's redteam round consumes both tiers).
- **Pairs with** `evidence-first-claims.md` MUST-3 (an errored command is zero evidence) — MUST-3 here is that principle applied to a probe return.

## Origin

2026-07-16 — canon-sync + COC eval-harness institutionalization (BUILD-repo `/codify`, Contract C4). Owner-ratified. Institutionalizes the two-tier eval-coverage contract (structural fixtures in CI + LLM-judge probes at gate-review) across every COC artifact type, generalizing `cc-artifacts.md` Rule 9's tool-only fixture mandate; the redteam→named-regression-case reflex (MUST-2) mirrors a client ecosystem fork's eval harness. Structural harness (`coc-eval-all.mjs`, `eval-manifest.json`) authored in cluster K2; probe layer (`test-harness-probe.md`, `probes/`) in cluster K3; this rule + the `cc-artifacts.md` Rule 9 cross-link + the CI structural gate in cluster K4. MUST-5 (detection-class binding + composed-lever disarm-resistance) added from the same cycle's R7/R8 redteam.

**Landed at loom** 2026-07-19 via `/sync-from-build` Gate-1 classification (Wave-2 of the F4 eval-harness Tier-1 adoption, C2 MERGE-selective). loom adopts the eval ENGINE + this coverage rule but DELIBERATELY EXCLUDES the canon-sync readiness scanner (a separate F3 canon-incorporation decision), so loom's `eval-manifest.json` carries no canon-sync structural entry; loom's own structural scanners land their entries when authored. The 7-day grace clock bootstraps at land-time per `trust-posture.md` § Two-Phase Rollout.

**Grace-period bootstrap exemption — SUPERSEDED 2026-07-29; this rule's OWN probe self-coverage is now REGISTERED and RUNS.** MUST-1 mandates every prose artifact ship a probe set; this rule (a prose artifact) satisfies its own mandate through `.claude/test-harness/probes/coc-artifact-eval-coverage.probes.json`, which IS registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`). The paragraph this replaces said the registration was DEFERRED "until loom's harness graduates from [the zero-entry] steady-state". Both halves of that reason are stale: the registration landed without any graduation (a probe-only entry asserts no STRUCTURAL coverage, which is the quantity `_declared_empty` and integrity check (k) key on, so the two coexist by design), and the suite has been dispatched — first run recorded at (loom-internal reference). Leaving the paragraph standing made the rule false about its own file, and the meta-compliance probe graded that same file `compliant: true` while it said so.

**What DOES remain deferred** is the Phase-2 hook detector named in this rule's Detection-mechanism block, on the ordinary two-phase-rollout schedule (`trust-posture.md` § Two-Phase Rollout) — not the probe tier. The probe tier's own disarm-resistance floor (bipolar poles, non-empty suites, pinned registration, `judge_model` pin, answer-key separation) is `.claude/test-harness/tests/probe-suite-integrity.test.mjs`; the semantic tier is dispatched at gate-review via `/test-harness-probe` and is deliberately NOT in CI, so a green CI run is never evidence the probes passed.

**Amended 2026-07-26 (loom#1368 part 2) — the deferral is now DECLARED, not hidden.** The paragraph above previously recorded a different mechanism: a staged probe file was kept on disk under the `.probes.jsonl` extension specifically because integrity check (e) matched only `*.probes.json`, so the rename made it invisible to the orphan check and the engine self-tests' minimal temp manifests stayed green. That was a coverage claim nobody ran, cleared by a filename. Check (e) now enumerates both extensions and the self-tests inherit the committed `_deferred_probes` declarations, so a staged probe is legal only while explicitly declared with a graduation condition, is printed as a `NOTE:` on every CI run, and reds the gate the moment the declaration is dropped or outlives its file.

**Bootstrap note — the harness ENGINE is `type:tool`, not a per-type probe subject.** The eval-harness's own engine tooling (`.claude/bin/coc-eval-core.mjs`, `.claude/bin/coc-eval-all.mjs`, `.claude/bin/coc-manifest-integrity.mjs`, `.claude/test-harness/lib/probe-schemas.mjs`) is `type:tool` — its correctness is proven by its own committed self-tests (the `manifest-integrity` gate + the scanner-timeout / grade-pin regressions at `.claude/test-harness/tests/coc-eval-core.test.mjs`, `.claude/test-harness/tests/coc-eval-all.test.mjs`, and `.claude/test-harness/tests/coc-manifest-integrity.test.mjs`), NOT by the per-type mandatory-probe table in MUST-1 (which governs the prose/behavioral artifact types: rule / command / skill / agent / hook). A `type:tool` entry carries `probes: null` in the manifest (C3 — a tool has no mandated LLM-judge probe); it is covered by the structural CI tier's fixtures/self-tests. This avoids the bootstrap circularity of demanding an LLM-judge probe of the very engine that dispatches probes. (At loom the engine bins are covered by their committed self-tests directly — loom registers no `type:tool` entry for them per the empty-manifest C2 adaptation; the canon-sync structural fixtures the BUILD-repo bootstrap note also cited are NOT present at loom by the F3-exclusion decision above.)
