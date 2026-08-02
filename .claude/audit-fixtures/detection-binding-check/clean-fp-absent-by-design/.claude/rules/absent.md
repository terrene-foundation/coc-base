# Rule Citing Paths Precisely Because They Must NOT Exist

An aggregate `.claude/team-memory/team-memory.md` is BLOCKED — the split rule is
one fact per file. A detection TARGET is not a MUST-4 harness binding, so it is
never a binding candidate; no declaration is needed for it.

<!-- detection-binding-check: absent-by-design .claude/audit-fixtures/must-stay-empty/ — the Phase-2 detector is intentionally never built; this rule is review-layer-only by design -->

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 — cc-architect greps for (a) writes bypassing the
  helper and (b) `.claude/team-memory/team-memory.md` existence, which is itself the
  violation. The in-namespace directory `.claude/audit-fixtures/must-stay-empty/` is
  declared absent-by-design above. Live binding: `.claude/bin/absent-check.mjs`.
- **Violation scope:** MUST-1.
