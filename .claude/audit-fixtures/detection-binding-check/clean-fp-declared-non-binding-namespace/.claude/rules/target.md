# Rule Whose Detection Block Cites A TARGET, Not A Binding

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 — cc-architect greps for `.claude/team-memory/team-memory.md` existence, which is itself the violation, and reads `.claude/learning/posture.json` for the current level. Neither is a MUST-4 harness binding.
- **Violation scope:** MUST-1.
