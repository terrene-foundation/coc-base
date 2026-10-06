# autonomous-execution.md — Extended Evidence and Examples

Extended Origin evidence and example detail for `.claude/rules/autonomous-execution.md`. The rule body carries the compact clauses; this extract carries the depth (not baseline-emitted). Created 2026-06-11 as the paired extraction for the Gate-1 ingest cycle's baseline additions per `rules/rule-authoring.md` MUST Rule 10 path (a).

## Rule 1 — Shard Threshold: Full Example

```markdown
# DO — sharded plan with explicit invariant count

- Shard 1: wire TrustExecutor into express.read (invariants: redact, audit, clearance)
- Shard 2: wire into express.list (same 3 invariants, batch path)
- Shard 3: tenant isolation across both paths (cache key, audit rows, metric labels)

# DO NOT — one mega-todo

- Wire TrustExecutor through express, add audit rows, handle tenant isolation,
  update all 14 call sites, add integration tests, migrate legacy callers
```

## Rule 1 — A Shard Is One AGENT's Pass, Not One Worktree's (2026-09-12)

Until 2026-09-12 Rule 1 defined a shard as "(one session, one worktree, one implementation pass)".
`rules/wip-discipline.md` MUST-9 (`journal/0607`) then made the LANE — one worktree + one branch —
the unit the WIP ceiling counts, and a lane dispatches as many agents as its item set supports inside
that ONE worktree. Read literally, "one worktree" sized a whole lane as a single shard, which is the
single-serial-worker lane the directive rejects. The definition now reads "(one agent, one
implementation pass)": a lane packs several shards, one per agent, kept apart by MUST-9's partition
contract (disjoint writer file sets, one committer, per-agent build directories).

**Definitional, not an obligation change — and why.** The thresholds, the MUST binding them, and
what they bound are untouched. The budget measures what ONE model context holds in attention —
invariants, call-graph hops, relevant surface — and the rule's own **Why** already says so ("the
model stops tracking cross-file invariants"). Under the retired one-worktree-per-agent model a
worktree carried exactly one agent, so "one worktree" and "one agent" named the same unit; the word
that stopped coinciding was replaced by the unit it stood for. "One session" went for the same
reason: a lane orchestrator's session dispatches many shards. How many shards a worktree may carry
is governed by MUST-9, which carries its own Trust Posture Wiring. Because no obligation moved, this
edit does NOT end § Per-Session Capacity Budget's `trust-posture.md` MUST-8 grandfather exemption.

**Emission.** The lane context lives here rather than in the baseline body. Abridged size of the rule
(`stripRuleFrontmatter → abridgeV6 → stripSlotMarkers`, 2026-09-12 lane working tree): 7,057 B →
7,041 B (−16 B); MUST / MUST NOT / BLOCKED / `**Why:**` counts unchanged (31 / 5 / 8 / 10).

## Rule 2 — Size By Complexity: Full Example

```markdown
# DO — differentiated sizing

- Todo: generate 14 CRUD repositories (~2k LOC boilerplate, single shard)
- Todo: rewrite job scheduler (~400 LOC logic, single shard)
- Todo: migrate scheduler across 6 services (6 shards, one per service)

# DO NOT — uniform LOC cap

- Every todo under 500 LOC — fragments CRUD into meaningless shards AND
  overflows the invariant budget on scheduler work
```

## Rule 4 — Fix-Immediately: Extended DO Example

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

## Rule 4 — Full Origin Evidence

2026-04-20 — a null-bind fix shipped on one path; review surfaced a sibling path gap (same bug class, ~300 LOC, one shard); initial disposition was "file follow-up issue"; user corrected; fix shipped same session.

Additional cross-class evidence — the Rust SDK 2026-05-01 session: (a) bedrock register_bedrock_region rustdoc broken-intra-doc-link on a feature-gated symbol, fixed in same shard via plain-backticks (PR #735 commit 01c18ece); (b) PyOAuth2Client `#[pymethods]` rustdoc private_intra_doc_links because PyO3 methods are private-by-default, fixed in same shard via plain-backticks (PR #736 commit 729630cd); (c) PyNexus EventBus #679 Wave-2 implementation following Wave-1's premature deferral — the deferred-shard-was-actually-fittable signal that triggered same-shard fix-immediately. Three evidence points across two distinct rule-violation classes (rustdoc broken-link feature-gated, rustdoc private_intra_doc_links on PyO3) confirm Rule 4 generalizes beyond null-bind sibling sweeps.

Additional cross-class evidence — kailash-kaizen 2.20.0 release cycle 2026-05-06: security-reviewer flagged 1 HIGH (prompt-injection via output-rendered traits) + 2 MEDIUM (raw-role logging, unbounded cache DoS) findings against PR #836; all three fit within the shard's remaining budget (each <30 LOC, 4 invariants total); all three landed in the same commit `ba476b88`; security-reviewer re-approved on the post-fix diff. Confirms Rule 4 generalizes from code-reviewer surfacings to security-reviewer surfacings — same gate-level review pattern.

## 10x Throughput Multiplier

Extracted from the rule body 2026-07-29 as the `rules/rule-authoring.md` MUST Rule 10 path (a) paired extraction for the `instrument-discipline.md` baseline addition (receipt: `journal/0569`). ZERO de-scoping — the rule retains the ~10x claim and the `time-pressure-discipline.md` cross-reference; this carries the per-factor breakdown and the conversions.

Autonomous AI execution with mature COC institutional knowledge produces ~10x sustained throughput vs an equivalent human team.

| Factor                                               | Multiplier |
| ---------------------------------------------------- | ---------- |
| Parallel agent execution                             | 3-5x       |
| Continuous operation (no fatigue, no context-switch) | 2-3x       |
| Knowledge compounding (zero onboarding)              | 1.5-2x     |
| Validation quality overhead                          | 0.7-0.8x   |
| **Net sustained**                                    | **~10x**   |

**Conversion**: "3-5 human-days" → 1 session. "2-3 weeks with 2 devs" → 2-3 sessions. "33-50 human-days" → 3-5 days parallel.

**Does NOT apply to**: Greenfield domains (first session ~2-3x), novel architecture decisions, external dependencies (API access, approvals), human-authority gates (calendar-bound).

**See also**: `rules/time-pressure-discipline.md` — under time-pressure framings, parallelization IS the throughput response; procedure drops are BLOCKED even when explicitly authorized.

## Rule 4 — The Two Bounds

Extracted from the rule body 2026-07-29 in the same Rule-10 path (a) paired extraction (`journal/0569`). ZERO de-scoping — the rule body retains both bounds in compact form plus the BLOCKED relabelling clause; this carries the full statement of each.

**Bounded by the category (`rules/product-completion-first.md` MUST-3).** The fix-now mandate applies to a same-class within-budget gap classified BUG or INVEST-NOW; an INCREMENTAL one (off-path polish) MAY route to the deferred-quality list with a value-anchor. The category verdict — NOT convenience, NOT severity — gates the lane: relabelling a warm BUG/INVEST-NOW gap "incremental" to defer it is BLOCKED.

**Bounded by the shard budget.** This rule does NOT override MUST Rule 1 (shard threshold). If the surfaced gap exceeds ≤500 LOC load-bearing / ≤5–10 invariants / ≤3–4 call-graph hops, filing the follow-up issue IS the correct disposition — the gap is a new shard, not a continuation of the current one.

## Concurrent-Operator Capacity

The per-session budget in `rules/autonomous-execution.md` § Per-Session Capacity Budget sizes ONE
operator's shard. When several verified operators work the same corpus concurrently, the budget is
carried per `verified_id`, parallelization is restricted to NON-SAME-adjacency lanes, and every lane
is opened with a `/claim` record. That contract — the per-`verified_id` budgets, the adjacency
classes, and the `/claim`-record discipline — lives in `rules/multi-operator-coordination.md` §8,
which is the authority; this pointer exists because the single-operator budget above is the first
place a reader looks for it.
