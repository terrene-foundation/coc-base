---
id: "AUTONOMOUS-EXECUTION"
---

# Autonomous Execution Model

See `.claude/guides/rule-extracts/autonomous-execution.md` for extended examples + Rule-4 Origin evidence.

COC executes through **autonomous AI agent systems**, not human teams. All deliberation, analysis, recommendations, and effort estimates MUST assume autonomous execution unless the user explicitly states otherwise.

Human defines the operating envelope. AI executes within it. Human-on-the-Loop, not in-the-loop.

## MUST NOT (Deliberation)

- Estimate effort in "human-days" or "developer-weeks"
- Recommend approaches constrained by "team size" or "resource availability"
- Suggest phased rollouts motivated by "team bandwidth" or "hiring"
- Assume sequential execution where parallel autonomous execution is possible
- Frame trade-offs in terms of "developer experience" or "cognitive load on the team"

**Why:** Human-team framing causes the agent to recommend suboptimal approaches (phasing, sequencing, simplifying) that waste autonomous execution capacity.

## MUST (Deliberation)

- Estimate effort in **autonomous execution cycles** (sessions, not days)
- Recommend the **technically optimal approach** unconstrained by human resource limits
- Default to **maximum parallelization** across agent specializations
- Frame trade-offs in terms of **system complexity**, **validation rigor**, and **institutional knowledge capture**

**Why:** Without autonomous framing, effort estimates inflate 10x and plans are artificially sequenced to fit human-team constraints that don't exist.

## 10x Throughput Multiplier

Autonomous execution with mature COC knowledge sustains ~10x throughput vs an equivalent human team. Per-factor multiplier table, human-time→session conversions, and the does-NOT-apply cases: `.claude/guides/rule-extracts/autonomous-execution.md` § 10x Throughput Multiplier. Under time-pressure framings parallelization IS the throughput response; procedure drops stay BLOCKED even when explicitly authorized (`rules/time-pressure-discipline.md`).

## Structural vs Execution Gates

**Structural (human required):** Plan approval (/todos), release authorization (/release), envelope changes.

**Execution (autonomous convergence):** Analysis quality (/analyze), implementation correctness (/implement), validation rigor (/redteam), knowledge capture (/codify). Human observes but does NOT block.

## Root-Cause Fix Is The Default Disposition (MUST)

When a defect admits BOTH a symptom patch and a root-cause long-term fix, the session MUST adopt the root-cause fix. Where that fix is CLEARLY better — no genuine competing-design doubt — AND breaches no directive, rule or user instruction, the session MUST proceed WITHOUT stopping to ask: the envelope already authorizes it. Stopping to ask on a clear in-envelope root-cause fix is BLOCKED, as is shipping the patch with the root cause filed as follow-up.

**Carried into delegation, never assumed.** An orchestrator delegating a shard MUST place this clause in that shard's curated slice (`rules/governed-throughput.md` MUST-1) — a sub-agent that never loads this rule ships the patch.

**Bounded.** It does NOT convert a STRUCTURAL gate into an execution one (§ Structural vs Execution Gates) — plan approval, release authorization and envelope changes still need the human — nor license a fix exceeding the shard budget (§ Per-Session Capacity Budget Rule 1). Under genuine design doubt, state the trade-off and ask.

```markdown
# DO — clear, in-envelope root cause → implement it, no permission turn

stale handle returned → fix the invalidation path that produced it

# DO NOT — patch the symptom, or ask permission for the unambiguous fix

wrap the stale read in a retry; "shall I fix the invalidation instead?"
```

**Why:** A symptom patch leaves the defect live and re-pays the diagnosis cost on every recurrence; asking permission for an unambiguous in-envelope fix spends a human turn authorizing what the envelope already authorized.

**BLOCKED rationalizations:**

- "I'll patch it now and file the root cause as a follow-up"
- "The deeper fix is out of scope for this task"
- "I should check with the user before changing that"
- "Asking is the conservative choice"
- "The user didn't explicitly ask for the deeper fix"
- "A smaller diff is easier to review"
- "The root-cause fix touches more files, so it's riskier"
- "I don't want to assume, so I'll ask"
- "The patch unblocks us; the root cause is next session's work"
- "I'll note the root cause in the PR description instead"
- "Better to confirm the approach before investing the effort"
- "The symptom fix is what was literally asked for"

## Per-Session Capacity Budget

Autonomous capacity is high but not infinite. It degrades along multiple axes simultaneously — LOC is only the proxy. Work that exceeds the budget below MUST be sharded at `/todos` time, before implementation begins.

### 1. Shard When Any Threshold Is Exceeded (MUST)

A single shard (one session, one worktree, one implementation pass) MUST stay within ALL of:

- **≤500 LOC of load-bearing logic** — state machines, schedulers, invariant-holding code. Does NOT count CRUD, DTOs, route registration, or generated boilerplate.
- **≤5–10 simultaneous invariants** the implementation must hold (tenant isolation + audit + redaction + cache key shape + error taxonomy = 5).
- **≤3–4 call-graph hops** of cross-file reasoning.
- **≤15k LOC of relevant surface area** in working context for correctness.
- Describable in **3 sentences or fewer**. If it takes more, the shard is too big.

```markdown
# DO — sharded plan, explicit invariant count per shard (3 shards × 3 invariants)

# DO NOT — one mega-todo bundling all paths + call sites + tests + migration
```

**Why:** Beyond the budget the model stops tracking cross-file invariants and pattern-matches instead. Errors on line 400 poison everything after and surface only at `/redteam`. See Origin for Phase 5.11 evidence.

### 2. Size By Complexity, Not LOC Alone (MUST)

Todo sizing MUST distinguish boilerplate from load-bearing logic. Boilerplate scales ~5× further than logic before sharding triggers, because the model holds a single pattern and stamps it out.

```markdown
# DO — differentiated: 14 CRUD repos ~2k LOC boilerplate = 1 shard; 400 LOC scheduler logic = 1 shard

# DO NOT — uniform "every todo under 500 LOC" cap (fragments CRUD, overflows scheduler invariants)
```

**Why:** Uniform LOC caps fail on both ends. Sizing reflects what's held in attention (invariants, call-graph depth), not what's typed (line count).

### 3. Feedback Loops Multiply Capacity (MUST)

Shards with an executable feedback loop (unit tests, `cargo check`, type checker, integration harness that runs during the session) MAY use up to 3–5× the base budget. Shards without a live loop (spec drafting, config editing, refactors in untested modules) MUST use the base budget.

**Why:** Feedback loops convert "write 2000 LOC then discover it's wrong" into "write 200 LOC, test, continue." The multiplier is real but requires the loop to actually fire during the session — "redteam will catch it later" is not a feedback loop.

### 4. Fix-Immediately When Review Surfaces A Same-Class Gap Within Shard Budget (MUST)

When a gate-level review or self-verification surfaces a latent gap in the SAME BUG CLASS as the in-flight PR AND the gap fits within one remaining shard budget (MUST Rule 1's thresholds), the session MUST spawn the fix immediately rather than filing a follow-up issue. Filing the follow-up issue instead of fixing is BLOCKED.

```markdown
# DO — reviewer flags 40+ sibling sites, same bug class, fits one shard →

# fix in same session as PR B

# DO NOT — "Filing issue #NNN for the sibling sites — next session's work"

# → user pushback: "why aren't you resolving it?"
```

**BLOCKED rationalizations:**

- "That's the next session's work"
- "A separate PR is cleaner for review"
- "The follow-up issue captures it, we won't forget"
- "The in-flight PR is already reviewed, adding more risks reopening it"
- "Budget allows it but the blast radius is higher if something breaks"
- "Splitting into two PRs is the conservative approach"
- "It's incremental so I'll defer it" (BLOCKED when the category is BUG/INVEST-NOW per `rules/product-completion-first.md` MUST-3 — the category verdict, not convenience, gates the lane)

**Why:** Same-class gaps cost least to fix while the context is warm; a follow-up issue forces the next session to reload everything, typically 2–5× the marginal cost. See Origin.

**Doubly bounded — by CATEGORY and by SHARD BUDGET.** Fix-now applies only to a gap classified BUG or INVEST-NOW (`rules/product-completion-first.md` MUST-3; relabelling one "incremental" to defer it is BLOCKED) AND only while it fits MUST Rule 1's thresholds; a gap exceeding them IS correctly a follow-up issue. Both bounds in full: guide § Rule 4 — The Two Bounds.

Origin: 2026-04-20 — a null-bind sibling-path gap (same bug class, ~300 LOC) initially dispositioned "file follow-up issue"; user corrected; fixed same session. Cross-class generalization (Rust SDK #735/#736, kailash-kaizen #836) + full evidence chain: `.claude/guides/rule-extracts/autonomous-execution.md`.

Concurrent-operator capacity (per-`verified_id` budgets, NON-SAME-adjacency parallelization, `/claim`-record discipline): `rules/multi-operator-coordination.md` §8.

## MUST NOT (Sharding)

- Size shards by LOC alone, ignoring invariant count and call-graph depth

**Why:** LOC is a proxy that fragments trivial work and overflows complex work.

- Defer sharding decisions to `/implement`

**Why:** Sharding at `/todos` costs a plan rewrite; sharding mid-`/implement` abandons work in progress and leaves partial state the next session must untangle.

**BLOCKED rationalizations:**

- "The 1M context window handles it"
- "Opus can keep track of more than 5 invariants"
- "We'll see how far we get"
- "Splitting is artificial, it's one conceptual change"
- "The test suite will catch any errors that slip through"
- "It's mostly boilerplate" (when it isn't)

**Why:** Context window is not attention. Model capability claims are not evidence for a specific task. "One conceptual change" is exactly how Phase 5.11 shipped 2,407 LOC of orphaned code.

Origin: Session 2026-04-13 — capacity bands discussion (~500 LOC load-bearing, ~5–10 invariants, ~3–4 call-graph hops, "describe in 3 sentences" heuristic), grounded in the Phase 5.11 orphan failure mode documented in `rules/orphan-detection.md`.

## Trust Posture Wiring — Root-Cause Fix Is The Default Disposition

Applies to the **§ Root-Cause Fix Is The Default Disposition** clause ONLY (added 2026-08-16, co-owner-directed origination, `journal/0574`); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. The pre-existing grandfathered sections of this baseline rule — § MUST/MUST NOT (Deliberation), § 10x Throughput Multiplier, § Structural vs Execution Gates, § Per-Session Capacity Budget Rules 1–4, § MUST NOT (Sharding) — stay exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge + `agents.md` § Triad).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm that a session which shipped a symptom patch recorded why the root-cause fix was NOT clear or NOT in-envelope, and that no session spent a permission turn on an unambiguous in-envelope root-cause fix); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a fix addresses the root cause is a semantic judgment over the diff and the diagnosis, with no structural tool-call-time signal.
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a symptom patch shipped where a clear in-envelope root-cause fix was available; a root cause filed as a follow-up issue instead of fixed; a permission turn spent on an unambiguous in-envelope fix; a delegated shard whose curated slice omitted this clause) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: root-cause-versus-symptom is a judgment-bearing property of the diff resolvable only at the review layer, so it does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `instrument-discipline.md`, `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge and `agents.md` § Triad took.
- **Receipt requirement:** SessionStart soft-gate `[ack: autonomous-execution]` IFF `posture.json::pending_verification` includes the `autonomous-execution` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session that fixed a defect and confirm (a) the disposition was the root-cause fix, or the transcript names which bound (genuine design doubt / directive conflict / shard-budget overflow per § Per-Session Capacity Budget Rule 1) put it out of reach, and (b) no permission turn was spent on a clear in-envelope fix. **Phase 2 is RETIRED, not pending** — no hook detector will EVER be built, because root-cause-versus-symptom is not observable from any parsed or structural signal at tool-call time (an argv token, an AST node, a git-object fact), and a lexical detector over agent prose would carry `block` on a lexical signal, which `hook-output-discipline.md` MUST-2 forbids and `rule-authoring.md` MUST NOT § "`**Detection mechanism:**` row filing `Phase 2 (deferred)`" names as booking teeth that cannot arrive. No structural audit fixtures are owed. Gate-review IS the enforcement layer here, permanently — the honest form `hook-event-selection.md` sets. **Probes: REGISTERED — `.claude/test-harness/probes/autonomous-execution.probes.json`**, 6 rows in 3 bipolar `pair_id` pairs (efficacy + no-false-positive + meta-compliance, each with BOTH a violation and a compliant pole), with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/autonomous-execution/`. Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`). Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.
- **Violation scope:** the § Root-Cause Fix Is The Default Disposition clause ONLY (clause-scoped) — the root-cause-over-symptom mandate, the proceed-without-asking mandate, and the carry-into-delegation mandate. Every `violations.jsonl` row names the defect, the disposition taken, and which of the three mandates fired. The grandfathered sections of this file keep their existing (unwired) status.
- **Origin:** See § Origin — 2026-08-16 co-owner-directed origination, `journal/0574`.

Origin: 2026-08-16 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination; receipt-first `journal/0574`, verbatim directive quoted there). Baseline rather than path-scoped because the patch-versus-root-cause decision may touch NO matching glob at the moment it is made — the same reachability class `issue-triage-routing.md` and `agents.md`'s worktree clause were each authored to close. The clause is the WHICH-FIX sibling of § Per-Session Capacity Budget Rule 4's WHEN-TO-FIX. Rule 10 disposition: PATH (a) paired extraction, funded lane-level from `git.md` → `guides/rule-extracts/git.md` per `journal/0570` § "Correcting a prior reading"; measured ledger in `journal/0574` § Measured outcome and its AMENDMENT.
