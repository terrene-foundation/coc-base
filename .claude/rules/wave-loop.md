---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/todos/**"
  - "**/.claude/commands/**"
  - "**/02-plans/**"
---

# Wave-Loop — Verify-And-Feed-Forward Between Milestone-Groups

See `.claude/guides/rule-extracts/wave-loop.md` for worked examples, BLOCKED corpora,
measured narratives and Origin depth — every `extract §` pointer below resolves there.

Verification **deferred to the end** — one terminal `/redteam` after `/implement` drains
`todos/active/` — lets a defect injected at any handoff compound until fixing it re-touches
many already-"completed" todos. The wave-loop inserts a **verify-and-feed-forward gate between
milestone-groups**: it adds NO new phase and makes the existing `redteam → codify →
(re-)todos → implement` loop **re-entrant per milestone-group**.
Framing in full, and what the gate REUSES unchanged rather than restating: extract § "Preamble — the terminal-verification design".

## MUST Rules

### 1. A Wave Is One Value-Ranked Milestone-Group Of Budget-Fitting Shards

A **wave** is exactly ONE value-ranked milestone-group (`commands/todos.md` § "3. Create
comprehensive todos", ranked per `rules/value-prioritization.md` MUST-1) whose every todo has
been sharded to fit `rules/autonomous-execution.md` § Per-Session Capacity Budget MUST-1.
THREE bounds hold simultaneously; violating any is BLOCKED:

- **Lower bound (anti-per-todo).** The gate fires at the milestone-GROUP boundary, never per
  shard. Per-shard convergence is BLOCKED.
- **Upper bound A (anti-whole-project, value axis).** A project with ≥2 value-distinct
  milestone-groups MUST decompose into ≥2 waves, so ≥1 inter-wave gate fires before the
  terminal redteam. One-wave-equals-whole-project reproduces today's deferred-verification
  failure and is BLOCKED.
- **Upper bound B (anti-overflow, invariant-surface axis).** A wave's CUMULATIVE
  load-bearing-invariant surface (the union of its shards' tracked invariants) MUST be ≤10
  base, OR ≤30–50 with a live executable convergence/eval harness (the
  `rules/autonomous-execution.md` MUST-3 feedback-loop multiplier). A milestone-group whose
  shard-union exceeds this MUST split into ≥2 waves at the invariant boundary — **even when
  value-coherent.**

**Serial carve-out (the value gate, mirrors `rules/agents.md` § The Default Execution Mode Is The Triad).** A
genuinely single-milestone, single-convergence-surface project (one ≤500-LOC fix, one
invariant set) MAY run as ONE wave — its terminal `/redteam` IS its only wave gate. The
serial case MUST stay serial; forcing a ≥2-wave split on it is the per-todo ceremony this
rule forbids.

**Declaration is compulsory — it is the gate's on-ramp (the rule is inert without it).**
Every `/todos` plan MUST declare an EXPLICIT wave sequence (Wave 1…N, N≥1). The serial
carve-out is a one-wave declaration WITH its stated one-milestone/one-convergence-surface
justification — NEVER the silent absence of a declaration. A multi-shard plan that declares
no wave sequence, OR that collapses ≥2 value-distinct milestone-groups (or a shard-union
exceeding bound-B) into one wave WITHOUT a stated justification, is BLOCKED.

Worked examples, BLOCKED corpus + the bound-B / declaration rationale: extract § MUST-1.

**Why:** The shard gate bounds IMPLEMENTATION attention; the wave gate bounds VERIFICATION
attention — the same budget (`rules/autonomous-execution.md` MUST-1 "context window is not
attention"), one phase up. The value axis alone lets a value-coherent high-invariant wave
overflow invisibly; the invariant axis alone lets a low-invariant whole-project wave defer to
the end. Both bounds required.

### 2. The Inter-Wave Gate Fires At Every Boundary Except After The Final Wave

At the completion of every wave that is NOT the last, the orchestrator MUST run the
inter-wave gate G1→G5 before launching the next wave. Each step re-sequences EXISTING
machinery. Launching wave N+1 before G1–G4 complete clean is
BLOCKED.

- **G1 — redteam to convergence** — `/redteam` scoped to THIS wave's shards, to full Convergence
  Criteria, posture-invariant; convergence is on **BUG + INVEST-NOW findings only**.
- **G2 — capture the learning (LIGHTWEIGHT)** — Journal the CLAIMED-vs-FOUND delta as a
  `DISCOVERY`/`GAP` + spec update + a `.session-notes` refresh that MUST update the wave-tracker
  file. **Full `/codify` is RESERVED for cross-project learnings — NOT run every wave**.
  _Reuses:_ `commands/journal.md`; `commands/wrapup.md`.
- **G3 — update specs + remaining todos** — First-instance spec update + sibling re-derivation
  sweep; amend UNSTARTED later-wave todos for drift the wave caused.
- **G4 — re-value-rank** — Re-rank the remaining waves and re-validate every deferred
  value-anchor. _Reuses:_ `rules/value-prioritization.md` MUST-1 + MUST-3.
- **G5 — launch next wave** — Only after G1–G4 are clean; decompose onto the parallel primitive
  at ≥2 independent shards.

Full cells + worked examples + BLOCKED corpus: extract § MUST-2 gate table / § MUST-2.

**Why:** The whole defect-compounding failure mode is verification deferred past the
boundary where the learning is cheapest to apply.

### 3. The Wave-Gate Redteam Runs To Convergence (Per-Wave Instantiation Of 4a)

G1 runs `/redteam` to full convergence per `commands/redteam.md` § Convergence Criteria,
scoped to the wave, posture-invariant. Shipping a wave before its redteam reaches 2
consecutive clean rounds **on BUG + INVEST-NOW findings** (`commands/redteam.md` § Category-Based
Finding Triage / `rules/product-completion-first.md`; INCREMENTAL findings accrete to the
deferred-quality backlog carried to the terminal `/sweep` and do NOT reset the wave's clean-round
counter) is BLOCKED — the terminal-redteam obligation, fired per wave. **G1 MUST honor the errored-reviewer evidence gate
(criterion 3 of the § Convergence Criteria G1 binds, per `rules/agents.md` § "Redteam Reviewer
Dispatch — Errored/Empty Is Zero Evidence" + `rules/evidence-first-claims.md` MUST-3): a G1
"clean round" counts ONLY when EVERY dispatched reviewer genuinely ran. On the
`rules/worktree-isolation.md`
Rule 4 synchronized-throttle signal, back off dispatch concurrency and re-run the throttled
reviewers before claiming G1 convergence.**

Depth — the binding rationale — lives in `.claude/guides/rule-extracts/wave-loop.md` § "MUST-3 — the binding note".

### 4. Later Waves Are Provisional, Re-Validated At Each Boundary — Not Frozen

`/todos` still writes ALL todos once (filtering scope is BLOCKED; the forest MUST stay
visible per `rules/value-prioritization.md` MUST-1). What changes: not-yet-started-wave todos
are **PROVISIONAL** — at each gate they are amended per `rules/specs-authority.md` Rule 5c and
re-ranked per `rules/value-prioritization.md` MUST-3 (G3/G4). Treating later-wave todos as frozen-final, OR deleting them to "wave 1
only" (losing forest visibility), is BLOCKED.

### 5. Wave-Boundary Convergence/Codify/Update Claims Cite Durable Receipts (Anti-Theatre)

Every wave-boundary claim ("Wave N converged", "learning codified", "specs/todos updated",
"re-ranked") MUST cite a durable external receipt per `rules/verify-resource-existence.md`
MUST-4: a journal entry, commit SHA, or `observations.jsonl` round-verdict. Self-attestation
in the disposition document ("Wave 2 converged ✓") is BLOCKED — structurally identical to the
self-attested verdict MUST-4 already blocks.

### 6. Never Idle-Wait While Independent In-Budget Work Is Launchable

When the orchestrator is BLOCKED waiting on in-flight background agents AND independent,
parallelizable, in-budget autonomous work exists, it MUST launch that work rather than idle.
Idle-waiting while ≥1 independent in-budget shard is launchable is BLOCKED. This clause FILLS
idle time; it NEVER overrides a gate. It is BOUNDED (cross-ref, not restated) by: genuine
data/build dependencies; the structural human gates (`rules/autonomous-execution.md` §
Structural vs Execution Gates); capacity + throttle
(`rules/autonomous-execution.md` § Per-Session Capacity Budget + this rule's MUST-1 bound-B +
`rules/worktree-isolation.md` Rule 4); prudence/sensitivity confirmation
(`rules/recommendation-quality.md` MUST-8 + `commands/autonomize.md` § Prudence); and the
**clean-gate-stop** (`rules/recommendation-quality.md` MUST-3 — a converged hand-to-human stop
IS complete; manufacturing work to avoid stopping is BLOCKED).

Worked examples + BLOCKED corpus: extract § MUST-6.

**Why:** idle main-agent time while independent in-budget work is launchable is pure throughput
loss; the bounding gates ensure "always executing" never degrades into "always overriding a
gate".

### 7. Reconcile A Pre-Existing Backlog Item Against Ground Truth Before Implementing It

Before implementing any PRE-EXISTING open backlog item (a GH issue, a workspace todo, a carried
forest-ledger row, a journal follow-up), the orchestrator MUST reconcile it against current
ground truth: (a) grep/read the on-disk target surface the item names, (b) `gh issue view <N>
--json body,comments` when it is issue-backed, (c) grep `journal/` for a governing DECISION/DEFER.
Implementing on the backlog's say-so WITHOUT reconciling is BLOCKED.

**(b) MUST read BOTH halves, and no single flag does.** `--json body,comments` returns both; two
explicit invocations are an acceptable alternative. A single partial flag is not. Why a partial
read makes the item look SHORTER than it is, and the measurement of both partial poles on `gh` 2.x
(which flag truncates which half, and why prescribing `--comments` alone installs the mirror-image
defect): extract § "MUST-7(b) — the measured both-halves poles".

Worked examples + BLOCKED corpus: extract § MUST-7.

**Why:** backlog state decays as code evolves; an open item routinely lags a landed fix or a
governing DEFER, so implementing on its say-so re-does or contradicts delivered work. Distinct axis from
`rules/value-prioritization.md` MUST-3 (which ranks WHICH item is most valuable); this clause
gates WHETHER the item is still real before implementing — cross-ref, not restated.

### 8. A Multi-Surface Wave Pins Its Corpus Per Surface; A Freeze Is A Recorded Lease

A wave delivering ONE corpus to ≥2 surfaces (`/sync-to-use` + `/sync-to-build` targets,
ecosystem forks, downstream templates) MUST carry a machine-readable ledger at
`workspaces/<wave>/corpus-ledger.json` naming, for EVERY surface, the FULL 40-hex `cut_sha`
it was cut from, its PR, and its state; and every Gate-2 PR body MUST carry that same SHA as
a greppable `corpus-sha: <40-hex>` trailer, never only as prose. Distinct `cut_sha` values
across surfaces means the wave shipped N corpora: that is REPORTED, not blocked, and MUST be
accepted by a NAMED human in `divergence_accepted_by` — absorbing it silently is BLOCKED.
Freezing a shared branch to FAKE atomicity is BLOCKED unless recorded as a lease carrying
`declared_by`, `reason`, `release_condition`, and a calendar `expires`; a freeze that is
memory-held, release-conditionless, expired, or held once every surface reads `merged` IS
the violation. Detector: `.claude/bin/check-wave-corpus-ledger.mjs`.

Worked example + BLOCKED corpus: extract § MUST-8.

**Why:** The wave model assumes all surfaces land together, so when they cannot the only
lever left is a manual global freeze — the widest instrument for a per-surface problem,
with a blast radius covering every operator who was never party to the wave. A
machine-readable per-surface SHA converts divergence into a reported state, and a lease with an
author, a release condition and a calendar backstop turns "the freeze lifts when someone
remembers" into a finding. Incident, schema, and the four lease fields:
extract § MUST-8.

### 9. A Wave Lands As ONE Integration PR, Not One PR Per Shard — Converge Before Opening

A wave's shards MUST converge onto ONE integration branch and land through ONE PR to the default branch. Opening a PR per shard is BLOCKED: CI cost scales with the number of PRs AND with the number of merges to the default branch, not with the amount of work. Equally, a shard's branch MUST be converged — self-verified, rebased onto the current default branch, the repo's CI-parity set run locally (`git.md` § Pre-FIRST-Push CI Parity Discipline) — BEFORE its first push, because every subsequent re-push discards a whole CI cycle.

The integration branch is `chore/<wave-id>-integration[-<letter>]`. Shards are merged into it LOCALLY; the integration branch is pushed ONCE and carries the wave's single CI cycle.

**Pushing a shard branch is FREE — it is OPENING THE PR that costs a CI cycle.** So shards SHOULD be pushed as they converge, and "unpushed work is fragile" does NOT argue for opening N PRs. **That trigger topology is a per-repo property, so VERIFY it before relying on it here:** `gh run list --branch <branch>` immediately after a no-PR push MUST return empty. An unverified assumption that pushes are free is a claim about a mutable repo surface (`instrument-discipline.md` MUST-1) — re-measure, never inherit.

```text
# DO — N shards converge locally, ONE push, ONE CI cycle, ONE merge to the default branch
git -C <integration-worktree> merge --no-ff <shard-1> ... <shard-N>   # locally, no CI
<run the repo's CI-parity set ONCE over the integrated tree>
git push -u origin chore/<wave-id>-integration            # the wave's ONE CI cycle
gh pr create --title "chore(<wave-id>): land the wave integration — N branches, one CI cycle"

# DO NOT — one PR per shard
gh pr create   # × N → N CI cycles on the branches, PLUS N push-triggered cycles on the default branch
# DO NOT — push a shard before it is converged (each re-push discards a whole CI cycle)
```

**BLOCKED rationalizations:** "a PR per shard is easier to review" / "unpushed work is fragile, so each shard needs its own PR" (pushing is free; OPENING the PR is what costs) / "the shards are independent, so they should land independently" / "I'll push now and fix the gate failures on the branch" / "CI is cheap".

**Why:** CI spend is driven by PR count and default-branch merge count, not by work volume, so a shard-per-PR wave multiplies the wave's CI bill by N while producing exactly the same landed diff — and a pushed-but-unconverged branch re-pays a full cycle on every fix-up.

#### Clause-scoped wiring — MUST-9 (one integration PR per wave, added 2026-08-19)

Applies to **MUST-9** ONLY; ships canonical-8-field-compliant per `trust-posture.md` MUST-8. MUST 1–8 stay on their own wiring blocks until each is itself `/codify`-touched (clause-scoped precedent: this file's MUST-6/7 and MUST-8 blocks).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a wave landed through ONE integration PR, and that each shard branch was converged and CI-parity-clean before its first push); `advisory` at any hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-08-19 → 2026-08-26).
- **Cumulative posture impact:** same-class violations (a wave landed as one PR per shard; a shard branch pushed before convergence and then re-pushed to fix gate failures) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key. Named deviation from the key-per-clause shape, recorded here per `trust-posture.md` Rule 8 (a bounded CI-spend overrun does not warrant an instant-drop key; reasoning in the extract § "MUST-9 wiring — probe-registration depth"). Same disposition MUST-6/7 and MUST-8 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: wave-loop]` IFF `posture.json::pending_verification` includes the `wave-loop` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects any session that landed a multi-shard wave and confirms (a) exactly ONE PR carried the wave to the default branch, from a `chore/<wave-id>-integration[-<letter>]` head, and (b) each shard branch's first push followed a local CI-parity run. **NO structural detector is claimed and none is deferred** per `hook-output-discipline.md` MUST-5(b): wave membership is not derivable from any tool-call-time signal, so detection is PERMANENTLY REVIEW-LAYER. Scanner: none (semantic). Probes: the `MUST-9-firing` bipolar pair in `.claude/test-harness/probes/wave-loop.probes.json`, dispatched at gate-review via `/test-harness-probe`.

Depth — the MUST-9 probe-registration narrative — lives in `.claude/guides/rule-extracts/wave-loop.md` § "MUST-9 wiring — probe-registration depth".

- **Violation scope:** MUST-9 ONLY (clause-scoped). Every `violations.jsonl` row names the wave id and the PR count it landed as.
- **Origin:** BUILD stream (Rust SDK, measured 2026-08-12); landed at loom via Gate-1 ingest 2026-08-19. Classified GLOBAL — the contract names no language runtime.

## MUST NOT

- Freeze a shared branch as the response to surfaces that cannot land together.

**Why:** The freeze is the widest available instrument for a per-surface problem and
restores no invariant — atomicity was lost at the first divergent cut, not at merge time.
Pin, ledger, and report the divergence instead (MUST-8).

- Size a wave by value-coherence alone, ignoring the cumulative invariant surface.

**Why:** A value-coherent milestone can union far more invariants than one convergence pass
can hold; the value axis does not bound the verification-attention budget (MUST-1 bound B).

- Run a full `/codify` at every wave boundary as the default G2.

**Why:** Per-wave full `/codify` produces N codify-lease/PR cycles per project
(`rules/knowledge-convergence.md` MUST-3 contention); lightweight journal+spec capture is the
default, full `/codify` reserved for cross-project learnings.

- Convert the inter-wave gate into a human approval gate.

**Why:** The inter-wave gate is an EXECUTION gate (`rules/autonomous-execution.md` §
Structural vs Execution Gates); the structural human gates remain `/todos` plan-approval and
`/release`.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at `/codify` gate-review (cc-architect / reviewer greps
  the workspace journal for a per-wave-boundary convergence receipt + a re-value-rank
  receipt). No `block` — the signal is a review-layer judgment, not a structural tool-call
  primitive (`rules/hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (a wave launched without its gate; a
  mega-wave overflowing the invariant ceiling; a self-attested wave verdict) contribute to
  `rules/trust-posture.md` MUST Rule 4 cumulative math (3× same-rule / 5× total in 30d → drop
  1 posture).
- **Regression-within-grace:** any same-class violation within 7 days → emergency downgrade
  L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `wave_gate_skipped` added to
  that rule's emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: wave-loop]` in the agent's first
  response IF `posture.json::pending_verification` includes this rule_id. Soft-gate.
- **Detection mechanism:** Phase 1 — cc-architect / reviewer mechanical sweep at `/todos` +
  `/codify` + `/redteam`, in five checks: **(0) the declaration check (the on-ramp) — an
  undeclared or under-declared `/todos` plan per MUST-1 IS the violation**; then, for any multi-wave
  workspace, the four receipt checks — per-boundary convergence receipt (MUST-5), re-value-rank
  receipt (G4), bound-B compliance, and a genuine ran-signal from EVERY dispatched reviewer per
  the MUST-3 evidence-gate. Full checklist (a)–(d), with what each check discriminates: extract
  § "Trust Posture Wiring — the MUST-1/2/3/5 sweep checklist".
  **Probes: REGISTERED — `.claude/test-harness/probes/wave-loop.probes.json`**, 22 rows in 11
  bipolar `pair_id` pairs — one firing pair per derived clause (the ten
  `check-clause-coverage.mjs::deriveClauses` returns, MUST-1…MUST-9 and MUST-NOT) plus
  a meta-compliance pair, candidates at `.claude/audit-fixtures/wave-loop/`. Registered in
  `eval-manifest.json` (probe-only), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`;
  no workflow invokes `coc-probe-dispatch.mjs`, and `.claude/test-harness/**` is never-synced.
  The MUST-5 pair is the load-bearing one.
  Phase 2 (deferred per
  `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real wave-loop projects): a
  `.claude/hooks/lib/violation-patterns.js` Stop-event detector (advisory) + audit fixtures at
  `.claude/audit-fixtures/wave-loop/` per `rules/cc-artifacts.md` Rule 9. **NARROWED 2026-09-11 to
  check (0), the declaration check — the only half a detector can decide.** The four RECEIPT checks
  are retired in place: a receipt PRESENT but FALSE is the failure mode MUST-5 exists for, and
  receipt CONTENT is semantic adequacy `hook-output-discipline.md` MUST-2 caps below `block` and
  `rule-authoring.md` MUST NOT names. Rationale: `phase2-deferrals.json` key
  `wave-loop.md#convergence-receipt`.

Depth — that bookkeeping and the MUST-5 pole diff — lives in `.claude/guides/rule-extracts/wave-loop.md` § "Trust Posture Wiring — probe-registration depth".

- **Violation scope:** MUST 1 (wave sizing — three bounds + compulsory wave-declaration),
  MUST 2 (gate fires every non-final boundary), MUST 3 (GENUINE G1 convergence — a clean round
  counts only when every dispatched reviewer ran), MUST 5 (durable receipt), MUST 6 (idle-wait
  while independent in-budget work is launchable), MUST 7 (backlog item implemented without
  ground-truth reconciliation). Every `violations.jsonl` row records which MUST clause fired.
- **Origin:** See § Origin below.

### Clause-scoped wiring — MUST-6 + MUST-7 (orchestration hygiene, added 2026-07-18)

MUST-6 + MUST-7 land AT/AFTER the `trust-posture.md` MUST-8 SHA and ship canonical-8-field-compliant;
the pre-existing MUST 1/2/3/5 wiring above is unchanged.

- **Severity:** `halt-and-report` at `/codify` + `/redteam` gate-review (cc-architect / reviewer
  confirm the session did not idle while an independent in-budget shard was launchable, and that any
  implemented pre-existing backlog item carried a same-session reconciliation trace); `advisory` at
  the hook layer per `rules/hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-07-18 → 2026-07-25).
- **Cumulative posture impact:** same-class violations (an idle-wait with launchable independent work;
  a backlog item implemented without reconciliation) contribute to `rules/trust-posture.md` MUST-4
  cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the
  GENERIC `regression_within_grace` emergency trigger per `rules/trust-posture.md` MUST-4 (1× = drop 1
  posture) — NO dedicated per-clause trigger key (a session-history judgment property does not warrant
  an instant-drop key; MUST-6/7 do NOT reuse MUST 1/2/3's `wave_gate_skipped` key). Named deviation
  from the canonical key-per-clause shape, recorded here per `rules/trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: wave-loop]` IFF
  `posture.json::pending_verification` includes this rule_id (shared with the MUST 1/2/3/5 wiring).
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect / reviewer inspect the session
  transcript for an idle-wait window with launchable independent work (MUST-6) and for a
  reconciliation trace before any pre-existing-backlog implementation (MUST-7) — and, where that item
  was issue-backed, that the trace covered BOTH halves per MUST-7(b) (a partial read is a finding,
  not a pass). **MUST-6 — Phase 2 PARTLY SHIPPED (2026-08-18):**
  `.claude/hooks/fleet-drain-guard.js` (`Stop`) over `.claude/hooks/lib/fleet-drain.js`,
  fixtures `.claude/audit-fixtures/fleet-drain/`, registered in `ci-audit-fixtures.json`; it
  reconciles the `Stop` payload's `background_tasks` array and the per-session dispatch ledger
  against dispatchable `## Outstanding ledger (forest)` rows, and emits `halt-and-report`. It is
  BOUNDED and does not over-claim what is armed: it
  detects the COUNT, not MUST-6's independence judgment. THREE BOUNDS in full + the MEASURED
  severity justification:
  extract § "MUST-6/7 wiring — the fleet-drain detector, measured". MUST-7 keeps its Phase-1
  coverage and its own Phase 2 (deferred per
  `rules/trust-posture.md` § Two-Phase Rollout): an advisory Stop-event detector, whose audit
  fixtures land with that detector at
  `.claude/audit-fixtures/wave-loop/orchestration-hygiene/` per `rules/cc-artifacts.md` Rule 9.
  The `Phase 2 (deferred …)` wording is load-bearing — rewording it de-sanctions the
  forward-pointer and reds `validate-xref-integrity.mjs` (same extract §).
- **Violation scope:** MUST-6 + MUST-7 ONLY (clause-scoped); the pre-existing MUST 1/2/3/5 sections stay
  on their own wiring above.
- **Origin:** See § Origin (journal/0543 — co-owner-directed origination).

### Clause-scoped wiring — MUST-8 (corpus pinning + freeze lease, added 2026-08-16)

Applies to **MUST-8** and its paired MUST NOT bullet ONLY; ships canonical-8-field-compliant
per `rules/trust-posture.md` MUST-8. The MUST 1/2/3/5 and MUST-6/7 blocks above are unchanged.

- **Severity:** `halt-and-report` at `/codify` + `/redteam` gate-review (cc-architect /
  reviewer confirm a multi-surface wave carried a ledger, that every surface row is pinned to
  a full SHA, that any divergence names a human acceptor, and that any freeze was a recorded
  lease); `advisory` at the hook layer per `rules/hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a multi-surface wave with no ledger; an
  unpinned or abbreviated surface SHA; divergence with no named acceptor; a freeze that is
  incomplete, expired, or stale) contribute to `rules/trust-posture.md` MUST-4
  cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through
  the GENERIC `regression_within_grace` emergency trigger per `rules/trust-posture.md` MUST-4
  (1× = drop 1 posture) — NO dedicated per-clause trigger key, and it does NOT reuse MUST
  1/2/3's `wave_gate_skipped` key (that fires on a skipped inter-wave gate, a different
  shape). Named deviation from the canonical key-per-clause form, recorded here per
  `rules/trust-posture.md` Rule 8, on the same reasoning MUST-6/7 recorded.
- **Receipt requirement:** SessionStart soft-gate `[ack: wave-loop]` IFF
  `posture.json::pending_verification` includes this rule_id (shared across every clause).
- **Detection mechanism:** structural, SHIPPED WITH THE CLAUSE — no phase is deferred.
  Scanner `.claude/bin/check-wave-corpus-ledger.mjs` reads every
  `workspaces/*/corpus-ledger.json` and reds on any pin, state/`merged_sha`, divergence-
  acceptance or freeze-lease violation; it exits 3 (UNRUN, explicitly NOT a pass) when no
  ledger exists, so a silent no-op cannot read as clean. Bipolar fixtures at
  `.claude/audit-fixtures/wave-corpus-ledger/`, registered `mode: run` in
  `.claude/test-harness/ci-audit-fixtures.json` and executed by `.claude/bin/run-audit-fixtures.mjs`.
  Per-arm red conditions + fixture poles: extract §
  "MUST-8 wiring — the scanner's per-arm red conditions". Gate-review then covers what the scanner is
  NOT scoped to answer (`rules/instrument-discipline.md` MUST-4): whether the ledger enumerates
  every surface the wave actually touched, and whether a freeze was WARRANTED. Probes: the
  `MUST-8-firing` bipolar pair in `.claude/test-harness/probes/wave-loop.probes.json`, candidates
  at `.claude/audit-fixtures/wave-loop/`; the superseded "no probe suite ships for this clause"
  reading is corrected in place, because a Wiring row asserting an absent tier is the
  absence-reads-as-clean shape this rule's own MUST-5 governs.
- **Violation scope:** MUST-8 + its paired MUST NOT bullet ONLY (clause-scoped). Every
  `violations.jsonl` row names the wave, the surface, and which arm fired.
- **Origin:** See § Origin (the nine-surface Gate-2 wave cut at loom `959a2524`).

## Distinct From / Cross-References

- **Distinct from:** `rules/sweep-completeness.md` blocks substituting a cheaper proxy for a
  mandated step; this rule blocks deferring verification past the wave boundary.
- **Composes with (does not restate)** the rules and commands each MUST clause cites inline. The
  roster, and the per-clause map naming WHICH section of each is reused where: extract §
  "Composes with — the per-clause cross-reference map".

## Origin

2026-06-06 — co-owner-directed origination (`rules/artifact-flow.md` § Co-Owner-Directed
Origination); receipt-first journal `journal/0226`. Amended 2026-07-18 —
co-owner-directed origination (`journal/0543`) added MUST-6 + MUST-7 + the G2 wave-tracker
refresh line + their clause-scoped 8-field wiring.
Amended 2026-08-16 — MUST-8, from the nine-surface Gate-2 wave cut at loom `959a2524`.
Amended 2026-08-19 — MUST-9. Design provenance + the full MUST-8 incident and root cause: extract § "Origin —
design provenance and the amendment records" and § MUST-8.

**Extraction record (2026-08-19 + 2026-09-13, ZERO de-scoping).** Structural-cleanup extractions
taken to hold this rule's path-scoped injection budget (`.claude/bin/check-rule-injection-budget.mjs`):
the preamble framing, MUST-1's bound-B and declaration rationale, MUST-7(b)'s measured `gh`-flag
poles, the MUST-6/7 fleet-drain measurement, the MUST-1/2/3/5 sweep checklist, the MUST-8 scanner
arms, the probe-registration narratives, the composes-with map, the design provenance and the
length-rationale enumeration moved VERBATIM to `.claude/guides/rule-extracts/wave-loop.md`; every
MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**` line stayed here.
**`rule-authoring.md` Rule 10 / Rule 11 do NOT fire:** Rule 10 § "Trigger scope" limits it to
`priority: 0` + `scope: baseline` rules and this rule is `scope: path-scoped`, so these are
STRUCTURAL-CLEANUP extractions, NOT Rule-10 paired extractions and NOT Rule-11 recurrence input
(the disposition `journal/0148` recorded).

**Length rationale (per `rules/rule-authoring.md` MUST NOT length cap).** Over the 200-line
guidance. Named rationale: the body is already minimized — MUST-3/4/5 collapsed to
reference-bindings, MUST-6/7 cross-ref their bounding gates, every worked example, BLOCKED corpus
and narrative extracted — and the residual is structural: nine MUST clauses each carrying DO/DO-NOT

- BLOCKED corpus + Why per `rule-authoring.md` MUST 3/4, the G1→G5 gate, the 3-bound wave
  definition, the **compulsory-declaration clause**, and FOUR mandatory 8-field Trust Posture Wiring
  blocks (`trust-posture.md` MUST-8). Full enumeration + sibling precedent: extract § "Length
  rationale — the full enumeration".
