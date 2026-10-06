# Security — cites a DIRECTORY whose members reach none of this rule's lanes

Exercises the directory branch (`enumerateMembers` / `detectorLanes`), which
carries roughly a third of the live corpus's claims. A directory has no
disposition of its own — the manifest classifies FILES — so it ships to a lane
only if some MEMBER does. Here the members are `.claude/test-harness/**`, which
reaches no lane, so the trailing-slash token must produce the same finding a
file token would.

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 — probe suites under `.claude/test-harness/probes/`.
- **Violation scope:** MUST-1.
