---
priority: 0
scope: baseline
---

# Autonomous Execution Model

<!-- slot:neutral-body -->

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

Autonomous AI execution with mature COC institutional knowledge produces ~10x sustained throughput vs equivalent human team.

| Factor                                               | Multiplier |
| ---------------------------------------------------- | ---------- |
| Parallel agent execution                             | 3-5x       |
| Continuous operation (no fatigue, no context-switch) | 2-3x       |
| Knowledge compounding (zero onboarding)              | 1.5-2x     |
| Validation quality overhead                          | 0.7-0.8x   |
| **Net sustained**                                    | **~10x**   |

**Conversion**: "3-5 human-days" → 1 session. "2-3 weeks with 2 devs" → 2-3 sessions. "33-50 human-days" → 3-5 days parallel.

**Does NOT apply to**: Greenfield domains (first session ~2-3x), novel architecture decisions, external dependencies (API access, approvals), human-authority gates (calendar-bound).

## Structural vs Execution Gates

**Structural (human required):** Plan approval (/todos), release authorization (/release), envelope changes.

**Execution (autonomous convergence):** Analysis quality (/analyze), implementation correctness (/implement), validation rigor (/redteam), knowledge capture (/codify). Human observes but does NOT block.

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
# DO — sharded plan with explicit invariant count

- Shard 1: wire TrustExecutor into express.read (invariants: redact, audit, clearance)
- Shard 2: wire into express.list (same 3 invariants, batch path)
- Shard 3: tenant isolation across both paths (cache key, audit rows, metric labels)

# DO NOT — one mega-todo

- Wire TrustExecutor through express, add audit rows, handle tenant isolation,
  update all 14 call sites, add integration tests, migrate legacy callers
```

**Why:** Beyond the budget the model stops tracking cross-file invariants and pattern-matches instead. Errors on line 400 poison everything after and surface only at `/redteam`. Evidence: the Phase 5.11 orphan (2,407 LOC of trust integration code with zero production call sites) was one conceptual change that exceeded the invariant budget — nothing caught it until the audit.

### 2. Size By Complexity, Not LOC Alone (MUST)

Todo sizing MUST distinguish boilerplate from load-bearing logic. Boilerplate scales ~5× further than logic before sharding triggers, because the model holds a single pattern and stamps it out.

```markdown
# DO — differentiated sizing

- Todo: generate 14 CRUD repositories (~2k LOC boilerplate, single shard)
- Todo: rewrite job scheduler (~400 LOC logic, single shard)
- Todo: migrate scheduler across 6 services (6 shards, one per service)

# DO NOT — uniform LOC cap

- Every todo under 500 LOC — fragments CRUD into meaningless shards AND
  overflows the invariant budget on scheduler work
```

**Why:** Uniform LOC caps fail on both ends. Sizing reflects what's held in attention (invariants, call-graph depth), not what's typed (line count).

### 3. Feedback Loops Multiply Capacity (MUST)

Shards with an executable feedback loop (unit tests, `cargo check`, type checker, integration harness that runs during the session) MAY use up to 3–5× the base budget. Shards without a live loop (spec drafting, config editing, refactors in untested modules) MUST use the base budget.

**Why:** Feedback loops convert "write 2000 LOC then discover it's wrong" into "write 200 LOC, test, continue." The multiplier is real but requires the loop to actually fire during the session — "redteam will catch it later" is not a feedback loop.

### 4. Fix-Immediately When Review Surfaces A Same-Class Gap Within Shard Budget (MUST)

When a gate-level review (reviewer, security-reviewer, gold-standards-validator) or self-verification surfaces a latent gap in the SAME BUG CLASS as the in-flight PR AND the gap fits within one remaining shard budget (≤500 LOC load-bearing logic / ≤5–10 invariants / ≤3–4 call-graph hops), the session MUST spawn the fix immediately rather than filing a follow-up issue. Filing the follow-up issue instead of fixing is BLOCKED.

```markdown
# DO — review surfaces 40+ sibling sites with the same bug, remaining

# capacity covers one shard, fix immediately

- PR A fixes null-bind on one code path (say, the SQL-cast parser)
- Reviewer flags 40+ sibling sites on a complementary path with the
  SAME hardcoded pattern (~300 LOC, identical bug class)
- Shard 2 (same session): apply the typed helper to the sibling path →
  ship as PR B before session end

# DO NOT — file a follow-up issue when the gap is same-bug-class and

# fits the shard budget

- PR A fixes one path
- "Filing issue #NNN for the 40+ sibling sites — that's the next
  session's work"
  → user pushback: "why aren't you resolving it?"
```

**BLOCKED rationalizations:**

- "That's the next session's work"
- "A separate PR is cleaner for review"
- "The follow-up issue captures it, we won't forget"
- "The in-flight PR is already reviewed, adding more risks reopening it"
- "Budget allows it but the blast radius is higher if something breaks"
- "Splitting into two PRs is the conservative approach"

**Why:** Same-bug-class gaps surfaced during review cost the least to fix while the context is loaded — the invariants, call graph, and domain model are all warm in attention. Filing a follow-up issue requires the next session to reload the entire context from scratch, typically 2–5× the marginal cost of continuing. Evidence: 2026-04-20 — a reviewer flagged 40+ sibling sites with the same hardcode pattern as the just-fixed PR. The agent filed a follow-up issue instead of fixing; the user pushed back ("why aren't you resolving it"); the fix shipped same session. Filing the follow-up wasted one user-turn of friction and one session-handoff context-reload that was unnecessary.

**Bounded by the shard budget.** This rule does NOT override MUST Rule 1 (shard threshold). If the surfaced gap exceeds ≤500 LOC load-bearing / ≤5–10 invariants / ≤3–4 call-graph hops, filing the follow-up issue IS the correct disposition — the gap is a new shard, not a continuation of the current one.

Origin: 2026-04-20 — a null-bind fix shipped on one path; review surfaced a sibling path gap (same bug class, ~300 LOC, one shard); initial disposition was "file follow-up issue"; user corrected; fix shipped same session. Additional cross-class evidence — kailash-rs 2026-05-01 session: (a) bedrock register_bedrock_region rustdoc broken-intra-doc-link on a feature-gated symbol, fixed in same shard via plain-backticks (PR #735 commit 01c18ece); (b) PyOAuth2Client `#[pymethods]` rustdoc private_intra_doc_links because PyO3 methods are private-by-default, fixed in same shard via plain-backticks (PR #736 commit 729630cd); (c) PyNexus EventBus #679 Wave-2 implementation following Wave-1's premature deferral — the deferred-shard-was-actually-fittable signal that triggered same-shard fix-immediately. Three evidence points across two distinct rule-violation classes (rustdoc broken-link feature-gated, rustdoc private_intra_doc_links on PyO3) confirm Rule 4 generalizes beyond null-bind sibling sweeps. Additional cross-class evidence — kailash-kaizen 2.20.0 release cycle 2026-05-06: security-reviewer flagged 1 HIGH (prompt-injection via output-rendered traits) + 2 MEDIUM (raw-role logging, unbounded cache DoS) findings against PR #836; all three fit within the shard's remaining budget (each <30 LOC, 4 invariants total); all three landed in the same commit `ba476b88`; security-reviewer re-approved on the post-fix diff. Confirms Rule 4 generalizes from code-reviewer surfacings to security-reviewer surfacings — same gate-level review pattern.

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

<!-- /slot:neutral-body -->
