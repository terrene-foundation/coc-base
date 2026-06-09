# `wave-loop` audit fixtures — Phase-2-pending

`rules/wave-loop.md` § Trust Posture Wiring (Detection mechanism) references this directory as the
home for the **Phase-2** detector's audit fixtures:

> Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real wave-loop
> projects): a `.claude/hooks/lib/violation-patterns.js` Stop-event detector (advisory) + audit
> fixtures at `.claude/audit-fixtures/wave-loop/` per `rules/cc-artifacts.md` Rule 9.

**Phase 1 (current):** detection is a manual cc-architect / reviewer mechanical sweep at `/todos`

- `/codify` + `/redteam` — the declaration check (every `/todos` plan carries an explicit
  wave-sequence declaration), the per-non-final-wave convergence receipt (MUST-5), the
  re-value-rank receipt per boundary (G4), and the MUST-1 bound-B invariant-ceiling check. There is
  no hook detector yet, so there are no fixtures to commit.

**Phase 2 (deferred):** the Stop-event detector lands together with one fixture per
scope-restriction predicate it relies on, in this directory, per `cc-artifacts.md` Rule 9.

This README is the directory's interim content so the rule's forward-reference resolves; it is
replaced by the per-predicate fixtures when the Phase-2 detector lands.
