# `wave-loop` audit fixtures — Phase-2-pending

`rules/wave-loop.md` § Trust Posture Wiring (Detection mechanism) references this directory as the
home for the **Phase-2** detector's audit fixtures:

> Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real wave-loop
> projects): a `.claude/hooks/lib/violation-patterns.js` Stop-event detector (advisory) + audit
> fixtures at `.claude/audit-fixtures/wave-loop/` per `rules/cc-artifacts.md` Rule 9.

**Phase 1 (current):** detection is a manual cc-architect / reviewer mechanical sweep at `/todos`

- `/codify` + `/redteam` — the declaration check (every `/todos` plan carries an explicit
  wave-sequence declaration), the per-non-final-wave convergence receipt (MUST-5), the
  re-value-rank receipt per boundary (G4), and the MUST-1 bound-B invariant-ceiling check.

**Phase 2 (deferred):** the Stop-event detector lands together with one fixture per
scope-restriction predicate it relies on, in this directory, per `cc-artifacts.md` Rule 9. No
Phase-2 STRUCTURAL fixture exists yet, because the detector does not.

**Two tiers live here, and they are not the same tier.** The `flag-*` / `clean-*` transcripts and
the `meta-*` rule files in this directory are the SEMANTIC tier: candidate fixtures and their
`.expected` answer-key sidecars for `.claude/test-harness/probes/wave-loop.probes.json`, which an
orchestrator dispatches at gate-review via `/test-harness-probe --artifacts`. They are read by an
LLM judge, never by a hook. An earlier revision of this README said "there is no hook detector
yet, so there are no fixtures to commit"; that was true of the Phase-2 structural tier and is now
misleading about this directory as a whole, so it is corrected rather than left. The Phase-2
detector's own per-predicate fixtures land alongside it and do not replace these.
