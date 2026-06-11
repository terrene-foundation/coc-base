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

Additional cross-class evidence — kailash-rs 2026-05-01 session: (a) bedrock register_bedrock_region rustdoc broken-intra-doc-link on a feature-gated symbol, fixed in same shard via plain-backticks (PR #735 commit 01c18ece); (b) PyOAuth2Client `#[pymethods]` rustdoc private_intra_doc_links because PyO3 methods are private-by-default, fixed in same shard via plain-backticks (PR #736 commit 729630cd); (c) PyNexus EventBus #679 Wave-2 implementation following Wave-1's premature deferral — the deferred-shard-was-actually-fittable signal that triggered same-shard fix-immediately. Three evidence points across two distinct rule-violation classes (rustdoc broken-link feature-gated, rustdoc private_intra_doc_links on PyO3) confirm Rule 4 generalizes beyond null-bind sibling sweeps.

Additional cross-class evidence — kailash-kaizen 2.20.0 release cycle 2026-05-06: security-reviewer flagged 1 HIGH (prompt-injection via output-rendered traits) + 2 MEDIUM (raw-role logging, unbounded cache DoS) findings against PR #836; all three fit within the shard's remaining budget (each <30 LOC, 4 invariants total); all three landed in the same commit `ba476b88`; security-reviewer re-approved on the post-fix diff. Confirms Rule 4 generalizes from code-reviewer surfacings to security-reviewer surfacings — same gate-level review pattern.
