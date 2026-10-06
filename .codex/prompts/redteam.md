---
name: redteam
description: "Coverage-driven adversarial round. Derives the attack surface; converges on closed coverage, not exhausted findings."
---

Adversarial attack on **$ARGUMENTS**. `rules/adversarial-coverage.md` is BINDING — READ IT FIRST; it may not have auto-loaded at the moment this round begins. Per-step depth: `skills/30-claude-code-patterns/role-conditioned-attackers.md`.

**The one thing this command exists to prevent:** declaring convergence because the current question stopped producing findings. Coverage governs convergence; yield alone never does. **Two instruments, two numberings.** Steps **C1–C4** are the COVERAGE instrument (derive, attack, price, warrant) — they discharge cells. Steps **1–7** are the VERIFICATION instrument (spec, e2e, flows, tests, report, parity, logs) — they produce warrants and keep their long-standing ordinals, so an external reference to "`/redteam` Step 1" or "Step 4b" still resolves. Neither substitutes for the other.

## Workspace Resolution

1. If `$ARGUMENTS` names a project use `workspaces/$ARGUMENTS/`; if it is a path, attack that artefact
2. Otherwise use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. If no workspace exists, ask the user to create one first
4. Read `workspaces/<project>/briefs/` for user context, and every prior `04-validate/` round

## Phase Check

- Verify `todos/active/` is empty (all implemented) or note remaining items
- Read `workspaces/<project>/03-user-flows/` for validation criteria
- Validation results go into `workspaces/<project>/04-validate/`
- If gaps are found, document them and feed back to implementation (use `/implement` to fix)

## Execution Model

Autonomous execution model (`rules/autonomous-execution.md`). Red team converges through iterative rounds. **BUG and INVEST-NOW findings are fixed autonomously to convergence; INCREMENTAL-IMPROVEMENT findings are dispositioned to the deferred-quality tracking list (§ Category-Based Finding Triage), not ground to convergence.** Every dispatched attacker and reviewer still RUNS every round — the errored/empty evidence gate (Criterion 3) is unchanged; only the DISPOSITION of findings is triaged by category, never the depth of review.

**Conformance Walk is `/redteam`'s primary standing gate** — it front-loads the deterministic half (judge every unit, structural-BLOCK the irrefutable failures, hand the human the pre-computed semantic-ADVISORY worklist); it does NOT replace this adversarial round. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (redteam) + § "CW vs /redteam".

## 0. Posture-aware audit DEPTH — convergence is NOT posture-gated (MUST consult first)

Read `.claude/learning/posture.json` via `state-io.js::readPosture`. **`/redteam` MUST run to convergence — every invocation at L2–L5 runs to 2 consecutive clean rounds plus Criteria 4–10; convergence is the posture-INVARIANT target.** Posture scales only the per-round DEPTH floor (WHAT each round checks), never WHETHER convergence is reached; the cumulative L5→L2 depth ladder is `skills/32-trust-posture/redteam-integration.md`. **L1_PSEUDO_AGENT is the single exception** — advisory simulation only, no autonomous `/implement` to red-team, convergence loop does not apply.

Surface posture AND the round count in the first report line. Stopping before 2 consecutive clean rounds **on BUG + INVEST-NOW findings** at L2–L5 is a violation logged via `appendViolation` against `redteam/posture-aware-depth`. Stopping WITH an open INCREMENTAL backlog is NOT a stop-early violation — convergence is scoped to bug + invest-now, not to zero incrementals.

## 0.5. Deployment-surface classification (OPT-IN; INERT on canon)

If this repo is an ecosystem **fork** (declares `ecosystem.json::upstream_canon`), it MAY classify each `.claude/**` artifact into review seats, authoring NO new classification code and reusing two shipped predicates: `.claude/bin/lib/local-rules.mjs::isLocalRulePath` → **Seat L** (deployment-local → FULL review); else the `canon-rollin-baseline` marker (`.claude/bin/lib/canon-rollin-baseline.mjs::getMarker`) splits inherited canon into **Seat D** (DIVERGED → drift-only: the delta plus its immediate blast radius, dispatched in parallel) and **Skip** (CLEAN → no review, reported explicitly per § Convergence Criteria). INERT on canon. Algorithm and per-seat depth: `skills/30-claude-code-patterns/dual-surface-redteam.md`.

## C1. Derive the attack surface — do not enumerate it

Build the coverage table from `rules/adversarial-coverage.md` §3: **7 roles × 6 phases = 42 cells**. Do NOT substitute a list of agents, checks or "perspectives" for this step (MUST-1) — a roster is a preference, a derivation is a proof obligation. A finding that will not place in a cell means the decomposition is wrong and is RE-DERIVED, never patched with an extra axis.

**Cell dispositions and their evidence.** `attacked` requires a cited attacker dispatch (Criterion 8). `OPEN` is the default and the fail-safe: an undeclared `n/a`, an uncited `attacked`, and a cell whose attacker return failed the evidence gate are ALL `OPEN`. **Cell history is carried, never rebuilt.** Each cell records the round that opened it, the round that disposed it, and the warrant. A round that rebuilds the table from scratch loses the history Criteria 8–9 read, and is BLOCKED.

**`n/a` is PRE-REGISTERED at C1, before any attack, or it is OPEN.** Which cells are inapplicable follows from the artefact's own shape and is knowable before you learn what attacking each would cost. Declare the `n/a` set NOW, each cell keyed to exactly one enumerated structural condition — **no emission step · no retention · no boundary crossing · no predecessor version · no recipient · no record-subject**. The set may only SHRINK across rounds, never grow. An `n/a` claimed AFTER its round's findings exist is OPEN, whatever its reason: it is an assertion made by a party who already knew its price.

**Eight cells can never be `n/a`.** R1 subject, R2 predicate, R3 verifier and R7 payoff are constitutive — a clause binding no one, requiring nothing, checkable by no one, with no cheapest path, is not a normative clause; and P1 draft and P2 bind are unconditional, since every governed clause is written and takes force. So **R1/R2/R3/R7 × P1/P2 is a never-`n/a` core**, and `n/a` there is incoherent rather than merely suspicious. R6 co-context adds **two more** (R6×P1, R6×P2) unless the round explicitly ASSERTS this clause is the only one in force — an assertion someone can be wrong about, which is a better artefact than an excuse. **This core is DERIVED from `rules/adversarial-coverage.md` §3's completeness-by-construction claim, and it has NOT been measured against a corpus.** If one real artefact legitimately needs an `n/a` inside the core, the derivation is wrong and §3's claim is weaker than it states — attack it here first. An `n/a` that no enumerated structural condition justifies routes to a **named human acceptor at ANY level, with no threshold** (`rules/completion-criterion.md` MUST-6). There is deliberately no permitted fraction: a count-based bar prices excuses in bulk, and the signature has to stay scarce enough to mean something.

**The table RE-OPENS when the artefact changes.** A closed cell describes the artefact as it stood when it was attacked. Therefore, when a fix LANDS (Step 5) or `/vet` grades a claim FALSE: every cell of the changed artefact re-opens, plus every cell anywhere whose warrant cited the changed lines, plus — for a swept sibling (`rules/sweep-completeness.md`) — that sibling's cells for the roles the change could alter. Record the re-open with the round and the landing that caused it. **Carrying a table forward at 0 OPEN across a round that landed a fix is BLOCKED**; it certifies an artefact that no longer exists.

## C2. Run role-conditioned attackers — one per role, blind to each other

Dispatch **seven** attackers, one per role, each given ONLY that role's question — take it verbatim from the `rules/adversarial-coverage.md` §3 role table's question column and phrase it as an imperative to REFUTE. None is told it is reviewing work this session produced (MUST-5), and none is fed another attacker's findings before aggregation.

**Concurrency (`rules/worktree-isolation.md` Rule 4, which governs).** Cold start: launch a first wave of **≤3** and read its return signal. If ≥2 of a wave die within ~30–48s carrying "(not your usage limit)", every later wave stays ≤3; if the wave returns clean, widen. The SIGNAL is the gate, never a fixed batch number, and a usage-limit death is a quota event — an account swap, not a back-off. **Blindness is preserved by ordering, not by simultaneity:** every wave is LAUNCHED before ANY result is read. A throttled, errored, empty or status-fragment return leaves its cell **OPEN** and MUST be re-run or resumed. **Downgrading a throttled cell to `n/a` is BLOCKED** — the return told you nothing about the cell, including whether it applies. Never run one generalist attacker asked for "any problems" — a single attacker collapses to its own most-available question, the documented failure this command exists to prevent (`adversarial-coverage.md` §4).

## C3. Price every escape — the incentive check

Independently of R7's sweep, **every** clause offering an alternative, exemption, default, or a state meaning *"not done"* gets the MUST-3 check, and the answer is RECORDED. One register row per clause:

```
Clause:             <id>
Escape branch:      <what a payoff-maximising deployment does instead>
Cost of escape:     <…>
Cost of compliance: <…>
Verdict:            REQUIREMENT | PREFERENCE (escape ≤ compliance)
Disposition:        ROUTED <how> | ACCEPTED-BY <named human> | OPEN
```

A `PREFERENCE` verdict is a finding, not a note — fix by **route, don't excuse**: the escape becomes a declared, counted departure that forfeits the matching conformance claim. The register gates Criterion 10.

## C4. Warrant every finding, and search functionally

A finding carries a `file:line` opened and read, a command and its output, or a parsed structure. A finding warranted only by an argument is labelled **HYPOTHESIS** and does not discharge a cell (MUST-4). **Absence claims and design decisions are the same assertion** — both need a functional search asking what the mechanism would be CALLED if it already existed, with the search terms RECORDED (MUST-6).

## 1. Spec compliance audit (MUST run first of the verification steps; it gates Criterion 4)

**File existence is NOT compliance.** Use `skills/spec-compliance/SKILL.md` to verify each spec promise by AST parsing and targeted grep. A "spec" is any documented promise about behavior — `specs/**` (PRIMARY), `briefs/**`, `01-analysis/**`, `02-plans/**`, `todos/completed/**`, and inline spec sections in README / CHANGELOG / design docs. For every promise: extract the literal acceptance assertions, verify each against actual code, **re-derive every check from scratch** (do NOT trust `.spec-coverage`, `.test-results`, `convergence-verify.py`, or any prior round's self-report — self-reports are inputs to verify, never evidence to trust), and save the assertion table to `workspaces/<project>/.spec-coverage-v2.md`.

**Critical patterns to flag:** constructor-signature drift · frozen-dataclass missing spec fields · `@deprecated` defined-but-unapplied · "MOVE A→B" with A still full-size · new modules with zero importing tests · fake single-`yield` streams · consumers still on the OLD path after a migrate. Full list and greps: `skills/spec-compliance/SKILL.md`.

HIGH classes to sweep, with the drift patterns and greps for each in `skills/spec-compliance/SKILL.md` (check #10): specs-to-code divergence at FIELD level · cross-spec contradiction (TTLs, limits, field names, endpoint paths) · unmapped brief requirement · missing probe coverage for a semantic assertion (`rules/probe-driven-verification.md` MUST-4; regex-on-semantic-claim = HIGH) · stale operator-action instruction (a zero-match grep against the live config it names).

## 2. End-to-end validation

Test every workflow end-to-end three ways — backend API endpoints only, frontend API endpoints only, and the browser via Playwright MCP only (marionette MCP for Flutter).

## 3. User-flow validation

Validate every detailed storyboard in `workspaces/<project>/03-user-flows/`: what is seen, clicked, expected, and the value delivered, with every transition between steps evaluated. Focus on intent, vision and requirements, never naive technical assertions.
Report all detailed steps and results in validation. Include the assertion tables from Step 1 verbatim — every row must show the literal verification command and its actual output, not "exists: yes". **Emit the convergence verdict as STRUCTURED DATA (MUST — producer half of `rules/probe-driven-verification.md` MUST-6):** a convergence receipt (`04-validate/redteam-*.md`) MUST carry `<!-- coc:convergence status=<S> rounds=<n> crit=<n> high=<n> -->` as line 2 — the first non-blank line directly under the H1, the CANONICAL POSITION and the only line a reader parses. `status` is a CLOSED allowlist: `CONVERGED` / `NOT_CONVERGED` / `IN_PROGRESS`. No marker at that position reads as UNKNOWN, never as a status — absence is never defaulted. Why the position is the whole contract, and why an exclusion list is BLOCKED: that rule's MUST-6.

## 4. Test verification — re-derive, do NOT trust `.test-results`

Per `rules/testing.md` § Audit Mode Rules: `.test-results` is written by `/implement` and may report old-code coverage while new spec modules have zero tests. Run the project's test-enumeration command against the test directories; for each new module the spec created, grep the test tree for an import of it (**zero importing tests = HIGH regardless of "tests pass"**); run any NEW tests this round writes; re-run a suspected-wrong test specifically rather than the whole suite.

## 4b. Eval-harness with adversarial testing (MUST create, maintain, use)

`/redteam` MUST own a persistent **probe-driven eval harness** at `tests/redteam-evals/` asserting SEMANTIC/intent properties Tier-1/2/3 cannot see (intent-misalignment, plan-drift, spec-divergence, refusal-vs-rationalization, hallucinated data, mock-leakage). **CREATE** ≥1 adversarial probe per spec success-criterion and brief intent. **MAINTAIN** by accreting every defect any wave's redteam surfaced as a regression probe — never pruned. **USE** the full corpus each round: a failing accreted probe carries the CATEGORY of the defect it encodes (`rules/product-completion-first.md` MUST-1), so a BUG/INVEST-NOW probe BLOCKS convergence and an INCREMENTAL probe routes to the deferred-quality list — NOT an auto-HIGH regardless of category; "Tier-1/2/3 pass" is INSUFFICIENT (`rules/user-flow-validation.md` MUST-1). Probe-driven per `rules/probe-driven-verification.md` (regex/keyword scoring of a semantic assertion = BLOCKED); offline CI degrades to STRUCTURAL, never regex-fallback. Mechanics: `skills/12-testing-strategies/probe-driven-verification.md`.

## 5. Report the round

Write `workspaces/<project>/04-validate/NN-round-NN-<slug>.md` carrying: the **coverage table** with every cell's disposition, warrant and history; each finding with its warrant and its `(role, phase)` cell; the incentive-check register; the Step-1 assertion tables verbatim — every row showing the literal verification command and its actual output, never "exists: yes"; and the convergence block, naming what the next round attacks if BLOCKED. Then fix on discovery and sweep siblings (`rules/sweep-completeness.md`) — a fix applied to one instance and not its siblings is not a fix — and **re-open the cells that fix touched per C1** before the round is closed.

## 6. Parity check (if required)

Test-run the old system and record outputs. For natural-language output use LLM evaluation, never keyword/regex. See `.env` for the model.

## 7. Log triage gate

Per `rules/observability.md` MUST Rule 5: scan build/test output and `*.log` for WARN+ entries, group identical entries, and disposition each as Fixed (commit SHA) / Deferred (tracked todo) / Upstream (pinned version) / False positive. Unacknowledged WARN+ entries BLOCK convergence.

## Agent Teams

The seven attackers of C2 are the ATTACK instrument and the only thing that discharges coverage. The specialists below are **evidence producers** supplying warrants for the verification steps; "all named specialists found nothing" is never a convergence claim (MUST NOT-1), and their findings are placed in cells like any other.

**Core red team (ALWAYS dispatched, every round, no exceptions):**

- **analyst** — Step 1 owner: assertion tables, AST/grep verification, `.spec-coverage-v2.md`
- **testing-specialist** — Step 4 owner: re-derives coverage, verifies new modules have new tests
- **value-auditor** — skeptical-buyer warrant on every page and flow
- **security-reviewer** — full security audit; verifies every spec § Security Threats subsection has tests. Dispatched on EVERY round, not only security-critical ones; a security-critical change additionally needs an adversarial security-reviewer prompted to REFUTE alongside the correctness reviewer (`rules/agents.md` § "Correctness-Review-Clean Is Not Security-Clean")

**Validation perspectives (selective):** `co-reference` skill (methodological compliance) · **gold-standards-validator** (naming/licensing) · **reviewer** (code quality across changed files).

**Frontend validation (if applicable):** **uiux-designer** — visual hierarchy, responsive, accessibility, AI interaction.

## Convergence Criteria

ALL ten must hold. Report all ten; any one failing ⇒ NOT converged, and the report names which.

1. **0 CRITICAL findings in the gating half** across all attackers and reviewers
2. **0 HIGH findings in the gating half** across all attackers and reviewers
3. **Yield falling — 2 consecutive clean rounds with no new BUG or INVEST-NOW finding.** An INCREMENTAL finding does NOT reset the counter (severity is irrelevant: a LOW bug blocks, a MED incremental defers). A round counts clean ONLY when EVERY dispatched attacker and reviewer returned a genuine ran/evidence signal (`rules/agents.md` § "Redteam Reviewer Dispatch" + § "Agent-Result-Delivery"); an errored / empty / timed-out / throttled / status-fragment return is ZERO evidence (`rules/evidence-first-claims.md` MUST-3), MUST be re-run or resumed, MUST NOT count clean, and leaves its cell OPEN. **This is the YIELD condition and NEVER gates alone** (`adversarial-coverage.md` MUST-2).
4. **Spec compliance: 100% AST/grep verified** — every spec section has an assertion table whose every row shows a literal verification command and its actual output. Rows saying "exists: yes" are BLOCKED.
5. **New code has new tests** — enumeration shows ≥1 test importing each new module; zero = HIGH regardless of suite-level "tests pass".
6. **Frontend integration: 0 mock data** — no `MOCK_*/FAKE_*/DUMMY_*` constants, no `mock*()` / `generate*Data()` functions, no hardcoded display arrays.
7. **Eval-harness green + accreted** (Step 4b) — every success-criterion and brief intent has ≥1 probe, every prior-wave defect has a regression probe, **0 failing BUG/INVEST-NOW probes**; probe-driven (regex-on-semantic = HIGH).
8. **Coverage closed, and every closure CITED.** 0 OPEN cells. Each `attacked` cell carries BOTH halves: (a) the **prose warrant** — the agent, and the finding or the explicit CLEAN verdict it returned; and (b) the **machine-readable token `ledger:<track>`**, naming the launch-ledger row of the dispatch that attacked it (`rules/orchestration-launch-ledger.md` MUST-1). The two are additive, not alternatives: the prose stands alone at gate-review and is the half that survives if the checker is ever unavailable; the token exists so a parser has something to join on. **`track` is already a ledger column and already unique per wave, so the citation is DERIVED rather than minted** — there is no second identifier that can drift from the first, which is why the token is not a composite of role, agent and round. Cells closed by one dispatch share its token; the same token cited from cells of DIFFERENT roles is a reuse error and leaves them OPEN, as does a token naming a row whose status is `in-flight` or `stopped` rather than `landed`. **A cell warranted only by its own row in the table is OPEN, exactly as a spec row saying "exists: yes" is BLOCKED under Criterion 4.** Each `n/a` is pre-registered per C1. Cells re-opened by a landed fix (C1) are OPEN until re-attacked. A published coverage table is a precondition of ANY convergence claim (MUST NOT-1). **What this criterion actually enforces, stated so it does not over-claim.** It is a **citation requirement enforced at gate-review** — a reviewer reads the round file against the ledger. A mechanical arm is **in flight in this wave on a separate lane**; it is neither absent nor landed, and its scope is bounded by what the ledger contract actually guarantees. It verifies **existence** and **non-reuse**. It verifies **ordering ONLY where the cited row carries a `spawned_at` or an introduction commit** — MUST-1 mandates neither a stable row id nor a per-row timestamp, so where one is absent the checker reports UNRUNNABLE, never PASS, and earlier waves stay UNRECORDED rather than back-filled (back-filling would fabricate the very evidence ordering exists to check). It does NOT verify that the cited track is the dispatch for THAT cell's ROLE — that correspondence lives in half (a) and is checked by a human. The residual beyond all of it is permanent and semantic: no cross-check can establish that the cited attacker attacked THAT cell, which is what the probe suite covers.
9. **Questions stable** — no new cell added in the last two rounds. Falling yield under an EXPANDING question set is not convergence.
10. **Incentive register closed** — every clause offering an alternative, exemption, default or "not done" state has a register row (C3), and every `PREFERENCE` verdict is either ROUTED or carries a named human acceptor. An `OPEN` PREFERENCE row blocks convergence; a register that is published but unresolved is not a discharge.

**PRECONDITION + BOUNDS — `rules/completion-criterion.md` (read it; not restated here).** A ratified acceptance list authored by a party distinct from the one satisfying it MUST predate round 1 (MUST-1); `/redteam` with no such list halts rather than inferring one. Criteria 1–3 are scoped to the **gating half** — `BUG`/`INVEST-NOW` or on-list (MUST-2); severity RANKS and never gates alone (`rules/product-completion-first.md` MUST-1), ambiguity resolving INTO the gating half. The round cap is a **CIRCUIT BREAKER — hitting it is abnormal termination, never "converged"**: escalate naming open findings AND open cells; the gating half is uncapped, the instrument ROTATES between rounds, and a last-known-good state MUST survive every round (MUST-4). A shipped residual needs a **named human acceptor** with revisit trigger and calendar backstop (MUST-6); a LIVE actively-harming finding notifies IMMEDIATELY in parallel and still does not gate (MUST-2). Criteria 1–3 are necessary but NOT sufficient: without 4–10 convergence certifies code quality on incomplete software attacked through one question. All ten are **posture-invariant** — posture (Step 0) scales per-round DEPTH, never the target. **Wave-scope:** at a wave boundary (`rules/wave-loop.md` MUST-2 G1) all criteria apply scoped to that wave's shards.

**Skip-class carve-out (fork dual-surface seat, Step 0.5).** An explicit "N inherited-canon-CLEAN artifacts skipped (reviewed upstream)" line is NOT a coverage gap and does NOT block convergence — a CLEAN artifact is byte-identical to **the last-accepted** canon blob canon already reviewed to convergence, so its review is delegated upstream by construction. A byte-match against any EARLIER or superseded blob is NOT the CLEAN class and does not qualify. The skip MUST be reported explicitly with its count; a DECLARED delegated-upstream skip is transparent and accounted for, distinct from a silent omission (severity is irrelevant: the CLEAN class carries no fork-side delta to find). Seat L and Seat D are still reviewed to full convergence. Depth: `dual-surface-redteam.md` § skip-class carve-out.

## Category-Based Finding Triage

Every finding is classified into exactly ONE category (BUG / INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT) BEFORE its disposition. The classifier, positive-allowlist definitions, severity decoupling, fail-closed discipline (ambiguity → immediate) and name-the-success-criterion mitigation ("no criterion covers this path" → ESCALATE, not auto-defer) are OWNED by `rules/product-completion-first.md` (referenced per `rules/specs-authority.md` Rule 9, not restated); this is the shared definition `rules/wave-loop.md` G1 and the `rules/agents.md` gates inherit. Consequence here: **Criteria 3 and 7 are scoped to BUG + INVEST-NOW**; INCREMENTAL findings route to the deferred-quality tracking list (the four generalized `zero-tolerance.md` Rule-1b conditions), do NOT reset the clean-round counter, and are surfaced at `/sweep` (`.agents/skills/sweep/` § report contract) — never silently decided. Category is ORTHOGONAL to coverage: an INCREMENTAL finding still DISCHARGES its cell, and an INCREMENTAL fix that LANDS still re-opens the cells it touched (C1).

**Handoff to `/codify` (MUST — phase-complete gate).** The handoff is the convergence RECEIPT, not a claim, and WRITING it is MANDATED rather than referenced because the reference alone demonstrably did not fire. Before reporting `/redteam` complete, write `workspaces/<project>/04-validate/redteam-<YYYY-MM-DD>.md` carrying the Step-3 `<!-- coc:convergence status=<S> rounds=<n> crit=<n> high=<n> -->` marker at line 2; `/codify`'s Phase Check finds it by that glob, newest-first, and parses only line 2. Then route on `status` — the § Convergence Criteria verdict over ALL TEN, not Criterion 3 alone: **`CONVERGED`** ⇒ the successor is **`/codify`**, named with the receipt path in the closing line; **`NOT_CONVERGED` / `IN_PROGRESS`** ⇒ the successor is another `/redteam` round naming the failing criterion and what it attacks, and handing an unconverged round to `/codify` is BLOCKED. Reporting `/redteam` complete with no receipt at that path is BLOCKED — `/codify` reads a never-written receipt as ADOPTION-PENDING, never as "validation passed".

## Journal (MUST — phase-complete gate)

Before reporting `/redteam` complete, create entries for journal-worthy findings: **RISK** (vulnerability, weakness, failure mode), **GAP** (missing test, doc, edge case, spec-compliance hole, or a cell that stayed OPEN), **CONNECTION** (an unexpected interaction between clauses). Use `/journal new <TYPE> <slug>` or write `workspaces/<project>/journal/NNNN-TYPE-slug.md`; check the highest `NNNN-` and increment. Skip only when validation genuinely produced nothing journal-worthy — use judgment, not formulas. Do not batch.
