# R3 must-fix #B fixture — operator.local companion under variants MUST stay excluded

All tokens SYNTHETIC and invented for this fixture.

R3 must-fix #B (issue #263): with the blanket `variants/` exclusion
REMOVED, the genuinely-non-synced variant companions
(`*.operator.local.md`, `*.local.json`, `*.local.md`) MUST still be
excluded — but via the gitignored-companion SUFFIX rule in isExcluded()
(`/\.operator\.local\.md$/`), which runs BEFORE isNeverSynced(), NOT via
a blanket variants/ exclusion. This file sits under
`variants/rs/rules/` and carries synthetic real-operator-style values;
it MUST produce ZERO findings because the `*.operator.local.md` suffix
rule excludes it from the walk entirely:

Self-hosted runner: Fakehost-MacStudio (synthetic operator hostname).
Operator checkout: /Users/fakeoperator/repos/kailash-rs (synthetic).
Service label: com.fakeco.actions.runner.alpha (synthetic).

If this file's tokens ever appear as findings, the suffix-exclusion
regressed and the never-synced companion is being scanned.
