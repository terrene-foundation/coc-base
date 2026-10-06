# `verify-claims-before-write.md` — depth extract

Depth companion to `.claude/rules/verify-claims-before-write.md`. Created 2026-09-07 (loom budget-residual lane) to hold Origin narrative moved out of the rule body; ZERO de-scoping — no MUST, MUST NOT, BLOCKED or `**Why:**` token left the rule.

## Origin

2026-05-27 release cycle, two incidents — both caught before consumer impact, each costing an extra correction PR: (1) a CHANGELOG Added section (commit b9b0a71ed) listed 5 `kailash.workflow` functions carried verbatim from a compaction-summary "5 entrypoints" framing; four did not exist anywhere in the package (the "5 surfaces" were 5 frameworks, not 5 functions); caught by TestPyPI clean-venv import, corrected in PR #1187 (commit ec2c99163). (2) The correction PR then documented a denylist as "8 types" (and asserted a member was absent) because a `tail -8` silently dropped the count line + the first 4 alphabetical entries; real floor 12, member present; caught at post-publish verify, corrected in PR #1188 (commit 1a3dab318). Authored path-scoped (durable-write surfaces) per the verify-resource-existence.md scoping precedent; Codex/Gemini delivery defaults to the skill channel per `rule-authoring.md` Rule 7.
