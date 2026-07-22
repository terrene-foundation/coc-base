---
name: redteam
description: "Load phase 04 (validate) for the current workspace. Red team testing."
---

## Workspace Resolution

1. If `$ARGUMENTS` specifies a project name, use `workspaces/$ARGUMENTS/`
2. Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. If no workspace exists, ask the user to create one first
4. Read all files in `workspaces/<project>/briefs/` for user context

## Phase Check

- Verify `todos/active/` is empty (all implemented) or note remaining items
- Read `workspaces/<project>/03-user-flows/` for validation criteria
- Validation results go into `workspaces/<project>/04-validate/`
- If gaps are found, document them and feed back to implementation (use `/implement` to fix)

## Execution Model

Autonomous execution model (see `rules/autonomous-execution.md`). Red team converges through iterative rounds. **BUG and INVEST-NOW findings are fixed autonomously to convergence; INCREMENTAL-IMPROVEMENT findings are dispositioned to the deferred-quality tracking list (§ Category-Based Finding Triage below), not ground to convergence.** Every dispatched reviewer still RUNS every round — the errored/empty-reviewer evidence gate (Convergence Criterion 3) is unchanged; only the DISPOSITION of findings is triaged by category, never the depth of review.

**Conformance Walk is `/redteam`'s primary standing gate** — it front-loads the deterministic half (judge every unit, structural-BLOCK the irrefutable failures, hand the human the pre-computed semantic-ADVISORY worklist); it does NOT replace this adversarial round. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (redteam) + § "CW vs /redteam".

## Workflow

### 0. Posture-aware audit DEPTH — convergence is NOT posture-gated (MUST consult first)

Read `.claude/learning/posture.json` via `state-io.js::readPosture`. **`/redteam` MUST run to convergence — every invocation at L2–L5 runs to 2 consecutive clean rounds + Convergence Criteria 4–6 below; convergence is the posture-INVARIANT target.** Posture scales only the per-round DEPTH floor (WHAT each round checks), never WHETHER convergence is reached. Depth is cumulative down the ladder (`skills/32-trust-posture/redteam-integration.md`):

- **L5_DELEGATED**: each round ≥ mechanical sweeps (grep/AST parity, `pytest --collect-only`, file-existence, marker scrub)
- **L4_CONTINUOUS_INSIGHT**: + closure-parity verification of every prior-round finding
- **L3_SHARED_PLANNING**: + spec-compliance audit (Step 1, AST/grep-verified)
- **L2_SUPERVISED**: + full spec-compliance vs every `pending_verification` rule
- **L1_PSEUDO_AGENT**: advisory simulation only — no autonomous /implement to red-team; the convergence loop does not apply (the single exception)

Surface posture AND the round count in the first report line. Stopping before 2 consecutive clean rounds **on BUG + INVEST-NOW findings** (per § Category-Based Finding Triage) at L2–L5 (e.g., shipping after Round 1 at L5) is itself a violation logged via `appendViolation` against `redteam/posture-aware-depth`. Stopping WITH an open INCREMENTAL-IMPROVEMENT backlog (dispositioned to the deferred-quality tracking list) is NOT a stop-early violation — convergence is scoped to bug + invest-now, not to zero incrementals.

### 0.5. Deployment-surface classification (OPT-IN; INERT on canon)

If this repo is an ecosystem **fork** (declares `ecosystem.json::upstream_canon`), the fork MAY classify each `.claude/**` artifact into review seats so it reviews its own risk surfaces and skips clean inherited canon. INERT on canon (canon is not a fork — every `.claude/**` is authoritative source). Reuses two shipped predicates, authors NO new classification code: `.claude/bin/lib/local-rules.mjs::isLocalRulePath` → **Seat L** (deployment-local → FULL review); else the `canon-rollin-baseline` marker (`.claude/bin/lib/canon-rollin-baseline.mjs::getMarker`) splits inherited canon into **Seat D** (DIVERGED → drift-only: the delta + its immediate blast-radius, dispatched via the parallel primitive) and **Skip** (CLEAN → no review, reported explicitly per § Convergence Criteria). Depth + algorithm: `skills/30-claude-code-patterns/dual-surface-redteam.md`.

### 1. Spec compliance audit (MUST run first)

**File existence is NOT compliance.** Use the protocol in `skills/spec-compliance/SKILL.md` to verify each spec promise via AST parsing and targeted greps, NOT file existence or self-reports.

A "spec" is any documented promise about behavior, regardless of where it lives. Sources to audit:

- `specs/**` — domain specifications (PRIMARY source of truth)
- `workspaces/<project>/briefs/**` — user-supplied requirements
- `workspaces/<project>/01-analysis/**` — analyst findings, deep analyses, design notes
- `workspaces/<project>/02-plans/**` — implementation plans, ADRs, contracts
- `workspaces/<project>/todos/completed/**` — what each todo claimed to deliver
- Inline spec sections in README.md, CHANGELOG.md, or design docs the project references

For every spec promise found in these sources:

1. Extract literal acceptance assertions from the spec text (class signatures, field names, decorator call sites, MOVE shim semantics, security tests, migration completion).
2. Verify each assertion via grep or `ast.parse` against the actual code.
3. Re-derive every check from scratch — do NOT trust `.spec-coverage`, `.test-results`, `convergence-verify.py`, or any prior round's self-report. Self-reports are inputs to verify, not evidence to trust.
4. Save the assertion table to `workspaces/<project>/.spec-coverage-v2.md` (the `-v2` suffix prevents confusion with legacy file-existence reports).

**Critical patterns to flag:** constructor-signature drift, frozen-dataclass missing spec fields, `@deprecated` defined-but-unapplied, "MOVE A→B" with A still full-size, new modules with zero importing tests, fake single-`yield` streams, consumers still on the OLD path after a migrate. Full list + greps: `skills/spec-compliance/SKILL.md`.

**Specs-to-code verification** — for every file in `specs/`, extract assertions at FIELD level (not just endpoint/class level) and verify against code via grep/AST. Code diverging from spec without a logged deviation = HIGH. **Cross-spec consistency** — grep all specs for shared terms (TTLs, limits, field names, endpoint paths); contradictory values across specs = HIGH. **Brief-to-spec coverage** — for each requirement in `briefs/`, verify it maps to at least one spec section; unmapped requirements = HIGH. **Probe-coverage** — for every semantic harness assertion (refusal/recommendation/compliance/quality), verify a probe definition (schema + scoring rule) exists per `rules/probe-driven-verification.md` MUST-4; regex-on-semantic-claim = HIGH. **Operator-action surface** — enumerate every operator-setup instruction ("operator must provision/configure/add/set/enable `<X>`") in living docs and cross-check each named secret/key/runner/hook against the live config it targets (a zero-match grep = stale instruction) + doc-claim-vs-git-history; stale instruction = HIGH. Full protocol: `skills/spec-compliance/SKILL.md` check #10.

### 2. End-to-end validation

Review implementation with red team agents using playwright mcp (web) and marionette mcp (flutter).

- Test all workflows end-to-end:
  - Using backend API endpoints only
  - Using frontend API endpoints only
  - Using browser via Playwright MCP only

### 3. User flow validation

Red team agents read `workspaces/<project>/03-user-flows/` and validate every detailed storyboard.

- Workflows include: what is seen, clicked, expected, value delivered
- Every transition between steps must be evaluated
- Focus on intent, vision, requirements — never naive technical assertions

### 4. Test verification — re-derive, do NOT trust .test-results

See `rules/testing.md` § Audit Mode Rules.

1. Do NOT read `.test-results` to verify test counts. The file is written by `/implement` and may report old-code coverage while new spec modules have zero tests.
2. Run `pytest --collect-only -q` (or your project's equivalent test enumeration command) on the test directories.
3. For each new module the spec created, grep the test directory for an import of that module. Zero importing tests = HIGH finding regardless of "tests pass".
4. Run any NEW tests that red team writes (E2E, regression tests for findings).
5. If a test is suspected wrong, re-run THAT test specifically.

### 4b. Eval-harness with adversarial testing (MUST create, maintain, use)

`/redteam` MUST own a persistent **probe-driven eval harness** at the project's `tests/redteam-evals/` asserting SEMANTIC/intent properties Tier-1/2/3 cannot see (intent-misalignment, plan-drift, spec-divergence, refusal-vs-rationalization, hallucinated data, mock-leakage). **CREATE** ≥1 adversarial probe per spec success-criterion + brief intent. **MAINTAIN** by accreting every defect any wave's redteam surfaced as a regression probe — never pruned (the semantic twin of `rules/testing.md` § Regression). **USE** the full corpus each round: a failing accreted probe carries the CATEGORY of the defect it encodes (`rules/product-completion-first.md` MUST-1) — a BUG/INVEST-NOW probe BLOCKS convergence, an INCREMENTAL probe routes to the deferred-quality tracking list — NOT an auto-HIGH regardless of category; "Tier-1/2/3 pass" is INSUFFICIENT (`rules/user-flow-validation.md` MUST-1). Probe-driven per `rules/probe-driven-verification.md` (regex/keyword scoring of a semantic assertion = BLOCKED); offline-CI degrades to STRUCTURAL, never regex-fallback. Mechanics + accretion procedure: `skills/12-testing-strategies/probe-driven-verification.md`.

### 5. Report results

Report all detailed steps and results in validation. Include the assertion tables from Step 1 verbatim — every row must show the literal verification command and its actual output, not "exists: yes".

### 6. Parity check (if required)

If parity required: test-run old system, record outputs. For natural-language output, use LLM evaluation (not keyword/regex). See `.env` for model.

### 7. Log triage gate

Per `rules/observability.md` MUST Rule 5: scan build/test output + `*.log` for WARN+ entries. Group identical entries, disposition each as Fixed (commit SHA) / Deferred (tracked todo) / Upstream (pinned version) / False positive. Unacknowledged WARN+ entries BLOCK convergence.

## Agent Teams

**Core red team (always):**

- **analyst** — Step 1 owner. Reads `skills/spec-compliance/SKILL.md`, derives assertion tables from each plan, runs AST/grep verification, produces `.spec-coverage-v2.md`.
- **testing-specialist** — Step 4 owner. Re-derives test coverage via `pytest --collect-only` (or the project's equivalent). Verifies new modules have new tests.
- **value-auditor** — Skeptical buyer perspective on every page/flow
- **security-reviewer** — Full security audit; verifies every spec § Security Threats subsection has tests

**Validation perspectives (selective):**

- `co-reference` skill — methodological compliance
- **gold-standards-validator** — naming/licensing compliance
- **reviewer** — code quality across changed files

**Frontend validation (if applicable):**

- **uiux-designer** — visual hierarchy, responsive, accessibility, AI interaction

## Convergence Criteria

ALL must be true:

1. **0 CRITICAL findings** across all agents
2. **0 HIGH findings** across all agents
3. **2 consecutive clean rounds with no new BUG or INVEST-NOW findings** (per § Category-Based Finding Triage) — a new INCREMENTAL-IMPROVEMENT finding is logged to the deferred-quality tracking list and does NOT reset the clean-round counter (severity is irrelevant: a LOW bug still blocks; a MED incremental still defers). A "clean round" counts ONLY when EVERY dispatched reviewer returned a genuine ran/evidence signal per `rules/agents.md` § "Redteam Reviewer Dispatch — Errored/Empty Is Zero Evidence"; an errored / empty / timed-out / throttled reviewer is ZERO evidence (per `rules/evidence-first-claims.md` MUST-3), MUST be re-run, and MUST NOT count toward a clean round. A "0 findings" tally from a reviewer that never ran is false convergence.
4. **Spec compliance: 100% AST/grep verified** — every spec section has an assertion table where every row shows a literal verification command (`grep …`, `ast.parse(…)`, `wc -l …`) and its actual output. Rows saying "exists: yes" are BLOCKED.
5. **New code has new tests** — `pytest --collect-only` shows ≥1 test importing each new module. Zero new tests for a new module = HIGH, regardless of suite-level "tests pass".
6. **Frontend integration: 0 mock data** — no `MOCK_*/FAKE_*/DUMMY_*` constants, no `mock*()` / `generate*Data()` functions, no hardcoded display arrays.
7. **Eval-harness green + accreted** (Step 4b) — every spec success-criterion + brief intent has ≥1 adversarial probe; every prior-wave defect has a regression probe; **0 failing BUG/INVEST-NOW probes** (a failing INCREMENTAL probe routes to the deferred-quality tracking list and does NOT block convergence, per § Category-Based Finding Triage); probe-driven (regex-on-semantic = HIGH).

Criteria 1-3 are necessary but NOT sufficient. Without 4-7, convergence certifies code quality on incomplete software. These criteria are **posture-invariant** — posture (Step 0) scales the per-round audit DEPTH, never the convergence target; `/redteam` at L2–L5 runs until all criteria hold across 2 consecutive clean rounds. **Wave-scope:** when invoked at a wave boundary (`rules/wave-loop.md` MUST-2 G1), all criteria apply scoped to that wave's shards.

**Skip-class carve-out (fork dual-surface seat, Step 0.5).** An explicit "N inherited-canon-CLEAN artifacts skipped (reviewed upstream)" line is NOT a coverage gap and does NOT block convergence — a CLEAN artifact is byte-identical to the last-accepted canon blob canon already reviewed to convergence, so its review is delegated upstream by construction (`skills/30-claude-code-patterns/dual-surface-redteam.md` § skip-class carve-out). The skip MUST be reported explicitly with its count; a DECLARED delegated-upstream skip is transparent and accounted-for, distinct from a silent omission (severity is irrelevant: the CLEAN class carries no fork-side delta to find). Seat L + Seat D are still reviewed to full convergence — only the byte-identical-to-canon surface is skipped.

## Category-Based Finding Triage

Every surfaced finding is classified into exactly ONE category (BUG / INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT) BEFORE its disposition — the classifier, positive-allowlist definitions, severity-decoupling, fail-closed discipline (ambiguity → immediate), and name-the-success-criterion mitigation ("no criterion covers this path" → ESCALATE, not auto-defer) are OWNED by `rules/product-completion-first.md` (referenced per `rules/specs-authority.md` Rule 9, not restated); this is the shared definition `rules/wave-loop.md` G1 and the `rules/agents.md` gates inherit. Consequence for `/redteam`: **Convergence Criteria 3 + 7 are scoped to BUG + INVEST-NOW** (fixed to 2 clean rounds, severity-independent); INCREMENTAL findings route to the deferred-quality tracking list (four generalized `zero-tolerance.md` Rule-1b conditions), do NOT reset the clean-round counter, and are surfaced at `/sweep` (`.codex/skills/sweep/` § report contract) — never silently decided.

### Journal (MUST — phase-complete gate)

Before reporting `/redteam` complete, create journal entries for journal-worthy findings surfaced during validation:

- **RISK** — vulnerabilities, weaknesses, or failure modes discovered
- **GAP** — missing tests, docs, edge cases, or spec-compliance holes

Use `/journal new <TYPE> <slug>` (or write directly to `workspaces/<project>/journal/NNNN-TYPE-slug.md`). Skip only when validation genuinely produced nothing journal-worthy — use judgment, not formulas. Do not batch: create each entry as you recognize it.
