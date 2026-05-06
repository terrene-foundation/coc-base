# Sample todo with neutral delegation prose (CLEAN)

- Reviewer approves the diff before merge.
- Dispatch reviewer + security-reviewer in parallel; both MUST approve before merge.
- Delegate to gold-standards-validator at /release.
- Per the project's baseline rules, every release MUST run /release through the gate.
- The session-start hook injects the active-workspace banner.
- Read the spec at specs/\_index.md before action.
- Run pytest tests/integration/ and capture failures.
