# Security — detector ships to every lane this rule reaches

Named `security.md` deliberately: the `rules` tier is a per-file ALLOWLIST, not a
`rules/**` glob, so a rule invented for the fixture would ship NOWHERE and the
claim would be vacuously satisfied. The fixture must use a rule the manifest
actually distributes for the shipping axis to be exercised at all.

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 (structural) — hook `.claude/hooks/demo-guard.js`.
- **Violation scope:** MUST-1.
