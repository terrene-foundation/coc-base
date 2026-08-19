---
id: "WAVE-LOOP"
paths: ["**/workspaces/**", "**/todos/**", "**/.claude/commands/**", "**/02-plans/**"]
---

# Wave-Loop — Verify-And-Feed-Forward Between Milestone-Groups

Autonomous coding today runs `analyze → plan → todos → implement → ONE terminal /redteam`:
`/todos` writes every todo once, `/implement` drains `todos/active/` to empty, `/redteam`
runs once at the end feeding gaps only back to `/implement`. Verification **deferred to the
end** means a defect injected at any handoff (analysis→plan→todos→implement — each loses
fidelity) is not caught until the terminal redteam, by which point fixing it re-touches many
already-"completed" todos. That terminal-verification design IS the
implement→redteam→QA→fix→repeat loop that runs countless times.

The wave-loop inserts a **verify-and-feed-forward gate between milestone-groups**. It adds NO
new phase — it makes the existing `redteam → codify → (re-)todos → implement` loop
**re-entrant per milestone-group**, so drift is caught and fed forward at each boundary
instead of compounding silently. Convergence (`commands/redteam.md` § Convergence Criteria)
and parallel-decompose (`rules/agents.md` § The Default Execution Mode Is The Triad)
are REUSED unchanged, scoped to the wave; this rule does not restate them.

## MUST Rules

### 1. A Wave Is One Value-Ranked Milestone-Group Of Budget-Fitting Shards

A **wave** is exactly ONE value-ranked milestone-group (`commands/todos.md` § "numbered
milestones/groups", ranked per `rules/value-prioritization.md` MUST-1) whose every todo has
been sharded to fit `rules/autonomous-execution.md` § Per-Session Capacity Budget MUST-1.
THREE bounds hold simultaneously; violating any is BLOCKED:

- **Lower bound (anti-per-todo).** The gate fires at the milestone-GROUP boundary, never per
  shard. Per-shard convergence is BLOCKED — it overflows the verification-attention budget
  the other way and degrades into ritual.
- **Upper bound A (anti-whole-project, value axis).** A project with ≥2 value-distinct
  milestone-groups MUST decompose into ≥2 waves, so ≥1 inter-wave gate fires before the
  terminal redteam. One-wave-equals-whole-project reproduces today's deferred-verification
  failure and is BLOCKED.
- **Upper bound B (anti-overflow, invariant-surface axis).** A wave's CUMULATIVE
  load-bearing-invariant surface (the union of its shards' tracked invariants) MUST be ≤10
  base, OR ≤30–50 with a live executable convergence/eval harness (the
  `rules/autonomous-execution.md` MUST-3 feedback-loop multiplier). A milestone-group whose
  shard-union exceeds this MUST split into ≥2 waves at the invariant boundary — **even when
  value-coherent.** The wave gate thereby inherits the shard gate's attention ceiling at the
  aggregate; without it a value-coherent 8-shard wave (~50 invariants) "converges clean" on a
  surface too large to hold — `rules/sweep-completeness.md` theatre one layer up.

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
exceeding bound-B) into one wave WITHOUT a stated justification, is BLOCKED — an undeclared or
under-declared plan makes the MUST-2 inter-wave gate inert by construction (no boundary to
fire at), converting "no wave structure" from an invisible default into an explicit,
challengeable claim the `/todos` gate and detection sweep can test.

Worked examples + BLOCKED corpus: extract § MUST-1.

**Why:** The shard gate bounds IMPLEMENTATION attention; the wave gate bounds VERIFICATION
attention — the same budget (`rules/autonomous-execution.md` MUST-1 "context window is not
attention"), one phase up. The value axis alone lets a value-coherent high-invariant wave
overflow invisibly; the invariant axis alone lets a low-invariant whole-project wave defer to
the end. Both bounds required.

### 2. The Inter-Wave Gate Fires At Every Boundary Except After The Final Wave

At the completion of every wave that is NOT the last, the orchestrator MUST run the
inter-wave gate G1→G5 before launching the next wave. Each step re-sequences EXISTING
machinery; the gate adds no new phase. Launching wave N+1 before G1–G4 complete clean is
BLOCKED.

| Step                                        | Action                                                                                                                                                                                                                       | Reuses                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **G1 — redteam to convergence**             | `/redteam` scoped to THIS wave's shards, to full Convergence Criteria, posture-invariant; convergence is on **BUG + INVEST-NOW findings only**                                                                               | `/redteam` + `agents.md` § Redteam Reviewer Dispatch                           |
| **G2 — capture the learning (LIGHTWEIGHT)** | Journal the CLAIMED-vs-FOUND delta as a `DISCOVERY`/`GAP` + spec update + a `.session-notes` refresh that MUST update the wave-tracker file. **Full `/codify` is RESERVED for cross-project learnings — NOT run every wave** | `commands/journal.md`; `commands/wrapup.md`; `rules/specs-authority.md` Rule 5 |
| **G3 — update specs + remaining todos**     | First-instance spec update + sibling re-derivation sweep; amend UNSTARTED later-wave todos for drift the wave caused                                                                                                         | `rules/specs-authority.md` Rule 5/5b/5c                                        |
| **G4 — re-value-rank**                      | Re-rank the remaining waves and re-validate every deferred value-anchor                                                                                                                                                      | `rules/value-prioritization.md` MUST-1 + MUST-3                                |
| **G5 — launch next wave**                   | Only after G1–G4 are clean; decompose onto the parallel primitive at ≥2 independent shards                                                                                                                                   | `rules/agents.md` § The Default Execution Mode Is The Triad                    |

Full cells, with every cross-reference each step reuses: extract § MUST-2 gate table.

Worked examples + BLOCKED corpus: extract § MUST-2.

**Why:** The whole defect-compounding failure mode is verification deferred past the
boundary where the learning is cheapest to apply. G1–G4 apply it at the boundary; G5 only
proceeds on a clean, fed-forward base.

### 3. The Wave-Gate Redteam Runs To Convergence (Per-Wave Instantiation Of 4a)

G1 runs `/redteam` to full convergence per `commands/redteam.md` § Convergence Criteria,
scoped to the wave, posture-invariant. Shipping a wave before its redteam reaches 2
consecutive clean rounds **on BUG + INVEST-NOW findings** (`commands/redteam.md` § Category-Based
Finding Triage / `rules/product-completion-first.md`; INCREMENTAL findings accrete to the
deferred-quality backlog carried to the terminal `/sweep` and do NOT reset the wave's clean-round
counter) is BLOCKED — the terminal-redteam obligation, fired per wave. This
rule binds the criteria and adds only the wave-local amplification below; it does not
re-derive them. **The per-wave design runs N boundary redteam rounds vs the terminal design's
one — multiplying throttle exposure — so G1 MUST honor the errored-reviewer evidence gate
(criterion 3 of the § Convergence Criteria G1 binds, per `rules/agents.md` § "Redteam Reviewer
Dispatch — Errored/Empty Is Zero Evidence" + `rules/evidence-first-claims.md` MUST-3): a G1
"clean round" counts ONLY when EVERY dispatched reviewer genuinely ran — a false-converged
wave feeds an un-reviewed base into G5's next wave. On the `rules/worktree-isolation.md`
Rule 4 synchronized-throttle signal, back off dispatch concurrency and re-run the throttled
reviewers before claiming G1 convergence.**

### 4. Later Waves Are Provisional, Re-Validated At Each Boundary — Not Frozen

`/todos` still writes ALL todos once (filtering scope is BLOCKED; the forest MUST stay
visible per `rules/value-prioritization.md` MUST-1). What changes: not-yet-started-wave todos
are **PROVISIONAL** — at each gate they are amended per `rules/specs-authority.md` Rule 5c and
re-ranked per `rules/value-prioritization.md` MUST-3 (G3/G4). The wave boundary IS the
re-validation trigger. Treating later-wave todos as frozen-final, OR deleting them to "wave 1
only" (losing forest visibility), is BLOCKED.

### 5. Wave-Boundary Convergence/Codify/Update Claims Cite Durable Receipts (Anti-Theatre)

Every wave-boundary claim ("Wave N converged", "learning codified", "specs/todos updated",
"re-ranked") MUST cite a durable external receipt per `rules/verify-resource-existence.md`
MUST-4: a journal entry, commit SHA, or `observations.jsonl` round-verdict. Self-attestation
in the disposition document ("Wave 2 converged ✓") is BLOCKED — structurally identical to the
self-attested verdict MUST-4 already blocks. Binds the existing rail; invents none.

### 6. Never Idle-Wait While Independent In-Budget Work Is Launchable

When the orchestrator is BLOCKED waiting on in-flight background agents AND independent,
parallelizable, in-budget autonomous work exists, it MUST launch that work rather than idle.
Idle-waiting while ≥1 independent in-budget shard is launchable is BLOCKED. This clause FILLS
idle time; it NEVER overrides a gate. It is BOUNDED (cross-ref, not restated) by: genuine
data/build dependencies; the structural human gates (`rules/autonomous-execution.md` §
Structural vs Execution Gates — plan-approval, release); capacity + throttle
(`rules/autonomous-execution.md` § Per-Session Capacity Budget + this rule's MUST-1 bound-B +
`rules/worktree-isolation.md` Rule 4); prudence/sensitivity confirmation
(`rules/recommendation-quality.md` MUST-8 + `commands/autonomize.md` § Prudence); and the
**clean-gate-stop** (`rules/recommendation-quality.md` MUST-3 — a converged hand-to-human stop
IS complete; manufacturing work to avoid stopping is BLOCKED).

Worked examples + BLOCKED corpus: extract § MUST-6.

**Why:** idle main-agent time while independent in-budget work is launchable is pure throughput
loss; the bounding gates ensure "always executing" never degrades into "always overriding a
gate" — the two failure modes this clause holds apart.

### 7. Reconcile A Pre-Existing Backlog Item Against Ground Truth Before Implementing It

Before implementing any PRE-EXISTING open backlog item (a GH issue, a workspace todo, a carried
forest-ledger row, a journal follow-up), the orchestrator MUST reconcile it against current
ground truth: (a) grep/read the on-disk target surface the item names, (b) `gh issue view <N>
--json body,comments` when it is issue-backed, (c) grep `journal/` for a governing DECISION/DEFER.
Implementing on the backlog's say-so WITHOUT reconciling is BLOCKED.

**(b) MUST read BOTH halves, and no single flag does.** An issue's substance splits across its
BODY and its COMMENTS — an item that accreted findings after filing carries most of itself in
comments — so a partial read makes the item look SHORTER than it is, which is precisely the
mis-reconciliation this clause exists to block. Measured, both poles, on `gh` 2.x: bare
`gh issue view <N>` prints the body and NOT the comment bodies (it prints `comments: 1`, a TALLY
that reads as if they were surfaced — `instrument-discipline.md` MUST-3(b)); `--comments` prints
the comments and NOT the body — the mirror-image defect, so prescribing it alone would install
this same bug in the opposite direction. `--json body,comments` returns both; two explicit
invocations are an acceptable alternative. A single partial flag is not.

Worked examples (incl. the `--json body,comments` form) + BLOCKED corpus: extract § MUST-7.

**Why:** backlog state decays as code evolves; an open item routinely lags a landed fix or a
governing DEFER, so implementing on its say-so re-does or contradicts delivered work (caught
already-done work repeatedly in the origin session). Distinct axis from
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
with a blast radius covering every operator who was never party to the wave. Making the
delivered corpus SHA a machine-readable per-surface field converts divergence from an
undetectable state into a reported one, which removes the reason to fake atomicity at all;
and a lease with an author, a release condition, and a calendar backstop turns "the freeze
lifts when someone remembers" into a finding. Incident, schema, and the four lease fields:
extract § MUST-8.

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
`/release`. Human-on-the-Loop, not in-the-loop.

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
- **Detection mechanism:** Phase 1 — cc-architect / reviewer mechanical sweep at `/todos` + Probes `.claude/test-harness/probes/wave-loop.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`.
  `/codify` + `/redteam`. **(0) Declaration check (the on-ramp): EVERY `/todos` plan MUST
  carry an explicit wave-sequence declaration; a multi-shard plan with no declared wave
  sequence, OR ≥2 value-distinct milestone-groups / a bound-B-exceeding shard-union collapsed
  to one wave without a stated justification, is the violation** — this fires on the
  undeclared/under-declared case, NOT only on already-multi-wave workspaces. (1) Any multi-wave
  workspace MUST then show (a) a journal convergence receipt per non-final wave (MUST-5), (b) a
  re-value-rank receipt per boundary (G4), (c) no wave's shard-union exceeding the MUST-1
  bound-B ceiling, (d) each non-final wave's convergence receipt names the full reviewer wave
  AND confirms every dispatched reviewer returned a genuine ran-signal (no errored / empty /
  timed-out / throttled reviewer counted toward a clean round) per the MUST-3 evidence-gate — a
  receipt-present-but-false-converged wave passes (a) yet fails (d). Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3
  real wave-loop projects): a `.claude/hooks/lib/violation-patterns.js` Stop-event detector
  (advisory) + audit fixtures at `.claude/audit-fixtures/wave-loop/` per `rules/cc-artifacts.md`
  Rule 9.
- **Violation scope:** MUST 1 (wave sizing — three bounds + compulsory wave-declaration), MUST 2 (gate fires every
  non-final boundary), MUST 3 (G1 reaches GENUINE convergence — a clean round counts only when every dispatched
  reviewer ran; a false-converged wave is a MUST-3 violation), MUST 5 (durable receipt), MUST 6
  (idle-wait while independent in-budget work is launchable), MUST 7 (backlog item implemented
  without ground-truth reconciliation). Every `violations.jsonl` row records which MUST clause fired.
- **Origin:** See § Origin below.

### Clause-scoped wiring — MUST-6 + MUST-7 (orchestration hygiene, added 2026-07-18)

MUST-6 + MUST-7 land AT/AFTER the `trust-posture.md` MUST-8 SHA and ship canonical-8-field-compliant;
the pre-existing MUST 1/2/3/5 wiring above is unchanged.

- **Severity:** `halt-and-report` at `/codify` + `/redteam` gate-review (cc-architect / reviewer
  confirm the session did not idle while an independent in-budget shard was launchable, and that any
  implemented pre-existing backlog item carried a same-session reconciliation trace); `advisory` at
  the hook layer per `rules/hook-output-discipline.md` MUST-2 — both properties are session-history
  judgments, not tool-call-time structural signals.
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
  was issue-backed, that the trace covers BOTH the body and the comments (a bare `gh issue view`, or
  `--comments` alone, is a PARTIAL read and is a finding, not a pass). **MUST-6 — Phase 2 PARTLY
  SHIPPED (2026-08-18):** `.claude/hooks/fleet-drain-guard.js` (`Stop`, lifecycle) over
  `.claude/hooks/lib/fleet-drain.js`, fixtures `.claude/audit-fixtures/fleet-drain/` (50 bipolar
  cases, registered in `ci-audit-fixtures.json`). It counts, per turn boundary, the MAIN agent's
  named running lanes against dispatchable `## Outstanding ledger (forest)` rows, and emits
  `halt-and-report` — NOT the `advisory` this block previously booked. The upgrade is justified and
  the justification is a MEASUREMENT, not a preference: both counts are STRUCTURAL, so
  `hook-output-discipline.md` MUST-2's bar on `block` from a LEXICAL signal is not what caps this;
  the EVENT is. `instruct-and-wait.js` tests `STOP_LIKE_EVENTS` before its `block` branch, so `Stop`
  + `block` returns `{continue:true}` exit 0 while the control `PreToolUse` + `block` returns
  `{continue:false}` exit 2 — no severity blocks here, and `halt-and-report` is the strongest
  available. THREE BOUNDS, stated so the rule does not over-claim what is armed: it detects the
  COUNT, never the independence judgment MUST-6 turns on; it is scoped to lanes the MAIN agent
  named, so a session carrying main-agent dispatches without a `name` reports UNKNOWN and stays
  silent (measured: 2 of 9 ledgers on the authoring clone); and the under-capacity arm ships
  OBSERVING, not advising, because its lane floor is uncalibrated — only the zero-lane DRAINED
  boundary advises. MUST-7 keeps its Phase-1 coverage and its own Phase 2 (deferred per
  `rules/trust-posture.md` § Two-Phase Rollout): an advisory Stop-event detector, whose audit
  fixtures land with that detector at
  `.claude/audit-fixtures/wave-loop/orchestration-hygiene/` per `rules/cc-artifacts.md` Rule 9.
  That `Phase 2 (deferred …)` form is load-bearing, not stylistic: `validate-xref-integrity.mjs`
  sanctions a forward-pointer to a not-yet-created fixture dir ONLY when the citing block matches
  `PHASE2_DEFERRED_RE` or `FIXTURES_LAND_WITH_RE`, so rewording this sentence de-sanctions the
  reference and reds the xref gate — which is exactly what happened when MUST-6's half was
  declared shipped and this clause was rephrased alongside it.
- **Violation scope:** MUST-6 + MUST-7 ONLY (clause-scoped); the pre-existing MUST 1/2/3/5 sections stay
  on their own wiring above.
- **Origin:** See § Origin (journal/0543 — co-owner-directed origination).

### Clause-scoped wiring — MUST-8 (corpus pinning + freeze lease, added 2026-08-16)

Applies to **MUST-8** and its paired MUST NOT bullet ONLY; ships canonical-8-field-compliant
per `rules/trust-posture.md` MUST-8. The MUST 1/2/3/5 and MUST-6/7 blocks above are unchanged.

- **Severity:** `halt-and-report` at `/codify` + `/redteam` gate-review (cc-architect /
  reviewer confirm a multi-surface wave carried a ledger, that every surface row is pinned to
  a full SHA, that any divergence names a human acceptor, and that any freeze was a recorded
  lease); `advisory` at the hook layer per `rules/hook-output-discipline.md` MUST-2 — whether
  a branch lock was a freeze is a session-history judgment with no tool-call-time signal.
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a multi-surface wave with no ledger;
  a surface pinned to an abbreviated SHA or unpinned; divergence with no named acceptor; a
  freeze declared with no `release_condition` or `expires`; a freeze held past expiry or past
  the last surface merging) contribute to `rules/trust-posture.md` MUST-4 cumulative-window
  math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through
  the GENERIC `regression_within_grace` emergency trigger per `rules/trust-posture.md` MUST-4
  (1× = drop 1 posture) — NO dedicated per-clause trigger key, and it does NOT reuse MUST
  1/2/3's `wave_gate_skipped` key (that fires on a skipped inter-wave gate, a different
  shape). Named deviation from the canonical key-per-clause form, recorded here per
  `rules/trust-posture.md` Rule 8, on the same reasoning MUST-6/7 recorded: a ledger/lease
  property is mechanically checkable at gate-review and does not warrant an instant-drop key.
- **Receipt requirement:** SessionStart soft-gate `[ack: wave-loop]` IFF
  `posture.json::pending_verification` includes this rule_id (shared across every clause).
- **Detection mechanism:** structural, SHIPPED WITH THE CLAUSE — no phase is deferred.
  Scanner `.claude/bin/check-wave-corpus-ledger.mjs` reads every
  `workspaces/*/corpus-ledger.json` and reds on an abbreviated/absent `cut_sha`, a
  state/`merged_sha` contradiction, unaccepted divergence, an incomplete/expired/stale freeze
  lease, or a malformed ledger; it exits 3 (UNRUN, explicitly NOT a pass) when no ledger
  exists, so a silent no-op cannot read as clean. Bipolar fixtures — a violating pole that
  MUST red and a conformant pole that MUST stay green for every arm, plus a self-control
  proving the instrument discriminates before it reports — at
  `.claude/audit-fixtures/wave-corpus-ledger/`, registered `mode: run` in
  `.claude/test-harness/ci-audit-fixtures.json` and executed by
  `.claude/bin/run-audit-fixtures.mjs`. Gate-review then covers what the scanner is NOT
  scoped to answer (`rules/instrument-discipline.md` MUST-4): whether the ledger enumerates
  every surface the wave actually touched, and whether a freeze was WARRANTED. **No probe
  suite ships for this clause** — stated explicitly rather than naming a phantom path; the
  semantic tier is UNCOVERED and owed at gate-review via `/test-harness-probe`, the same
  disposition `rules/agents.md` § Worktree-Orchestration wiring records.
- **Violation scope:** MUST-8 + its paired MUST NOT bullet ONLY (clause-scoped). Every
  `violations.jsonl` row names the wave, the surface, and which arm fired.
- **Origin:** See § Origin (the nine-surface Gate-2 wave cut at loom `959a2524`).

## Distinct From / Cross-References

- **Composes with (does not restate):** `commands/redteam.md` § Convergence Criteria (G1/
  MUST-3) — incl. criterion 3's errored-reviewer evidence-gate; `rules/agents.md` § "Redteam
  Reviewer Dispatch — Errored/Empty Is Zero Evidence" (the G1 evidence-gate MUST-3 binds) +
  § The Default Execution Mode Is The Triad (G5/serial carve-out);
  `rules/value-prioritization.md` MUST-1+3 (G4 + later-wave re-validation);
  `rules/specs-authority.md` Rule 5/5b/5c (G2/G3); `rules/autonomous-execution.md` §
  Per-Session Capacity Budget (the shard gate the wave gate sits above) + § Structural vs
  Execution Gates; `rules/verify-resource-existence.md` MUST-4 (MUST-5 rail);
  `rules/knowledge-convergence.md` MUST-3 (why G2 is lightweight).
- **Distinct from:** `rules/sweep-completeness.md` blocks substituting a cheaper proxy for a
  mandated step; this rule blocks deferring verification past the wave boundary. Both guard
  verification theatre, different triggers.

## Origin

2026-06-06 — co-owner-directed origination (`rules/artifact-flow.md` § Co-Owner-Directed
Origination); verbatim directive + receipt-first journal `journal/0226`. Designed by a
9-agent analysis workflow (5 analysts → synthesis → 3 adversarial reviewers, workspace
`workspaces/autonomous-wave-loop/`), validated by the authoring-side meta-ablation at
`.claude/test-harness/tests/wave-loop-ablation.test.mjs`. MUST-1 bound B (invariant-surface)
originates from the ceremony-axis review; the MUST-3/4/5 reference-binding collapse from the
duplication review. MUST-1 + MUST-2 are the genuinely-new load-bearing content; MUST-3/4/5
are reference-bindings to the rules they compose with. Amended 2026-07-18 — co-owner-directed
origination (`journal/0543`) added MUST-6 (never-idle-wait) + MUST-7 (reconcile-first) + the G2
wave-tracker refresh line + their clause-scoped 8-field wiring; the default execution mode is the
triad parallelize + `/autonomize` + `/redteam`-to-convergence (`rules/agents.md` § The Default Execution Mode Is The Triad).

Amended 2026-08-16 — MUST-8 (corpus pinning + divergence ledger + freeze lease). A
nine-surface Gate-2 wave was cut at loom `959a2524`: six surfaces cut, five merged, four
blocked, after which `main` was frozen by hand "so the wave ships one corpus". The freeze
blocked unrelated work for a full session; the one-corpus goal had already been lost at the
first divergent cut; and nothing on disk recorded who declared the freeze, what would
release it, or when it lapsed. Root cause: the wave model assumed all surfaces land
together, so the only lever when they could not was a manual global freeze — and because the
corpus SHA a surface synced from lived in PR prose, divergence was undetectable rather than
merely inconvenient. Paired extraction (`rules/rule-authoring.md` Rule 10 path (a)) moved
this file's worked examples, BLOCKED corpora, and full G1→G5 cells to
`.claude/guides/rule-extracts/wave-loop.md`, funding the clause within the `workspace-note`
injection budget rather than raising it. Full incident, ledger schema, and lease-field table:
extract § MUST-8.

**Length rationale (per `rules/rule-authoring.md` MUST NOT length cap).** ~300 lines after the
2026-07-18 co-owner-directed addition of MUST-6 (never-idle-wait) + MUST-7 (reconcile-first) +
their clause-scoped 8-field wiring, over the 200 guidance. Named rationale: the body is already
minimized — MUST-3/4/5 are collapsed to reference-bindings, the duplicative `agents.md` clause
was dropped per the duplication review, and MUST-6/7 cross-ref their bounding gates rather than
restating them — and the residual is structural: the mandatory 8-field Trust Posture Wiring
(`trust-posture.md` MUST-8, now two clause-scoped blocks) + the 5-step G1→G5 gate table + the
3-bound wave definition + the **compulsory-declaration clause** (the gate's on-ramp — without it
the rule is inert, per the 2026-06-07 co-owner review) + MUST-6/7 (each with DO/DO-NOT + BLOCKED
corpus + Why per `rule-authoring.md` MUST 3/4) are each load-bearing and non-decomposable. The
orchestration-hygiene pair is the co-owner-directed core of `journal/0543`; splitting it into a
separate rule would fracture the wave-loop's own "always-executing" contract across two files.
Sibling precedent: `user-flow-validation.md` + `multi-operator-coordination.md` Origins.
