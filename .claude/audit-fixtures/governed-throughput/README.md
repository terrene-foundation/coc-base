# `governed-throughput` audit fixtures — Phase-2-pending

`rules/governed-throughput.md` § Trust Posture Wiring references this directory as the home for
the **Phase-2** detector's audit fixtures:

> Audit fixtures land WITH that Phase-2 detector at `.claude/audit-fixtures/governed-throughput/`
> per `rules/cc-artifacts.md` Rule 9 (Phase 1 is a manual review-layer sweep — no hook detector yet
> to fixture-test).

**Phase 1 (current):** detection is a manual review-layer sweep at `/codify` + `/implement`
(cc-architect / reviewer confirms each governed-path shard carried a curated rule-slice and the
merge gate ran full-context). There is no hook detector yet, so there are no fixtures to commit.

**Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real
governed-throughput delegations exercise Phase 1):** a `.claude/hooks/lib/violation-patterns.js`
detector on delegation-prompt construction lands together with one fixture per scope-restriction
predicate it relies on, in this directory, per `cc-artifacts.md` Rule 9.

This README is the directory's interim content so the rule's forward-reference resolves; it is
replaced by the per-predicate fixtures when the Phase-2 detector lands.
