# R3 must-fix #B fixture — committed variant overlay IS synced (MUST flag)

All tokens SYNTHETIC and invented for this fixture.

R3 must-fix #B (issue #263): the prior scanner blanket-excluded
`variants/**` as never-synced. WRONG — `.claude/variants/{py,rs,rb,
prism}/**` are the language overlays that COMPOSE INTO the USE-template
synced surface at emit time, so they ARE downstream-shipped. A real
operator token in a committed variant overlay reaches every consumer of
that language template (the #252 class). The blanket `variants/`
exclusion was scope-evasion. This file is a committed `.md` under
`variants/rs/rules/` — it MUST now be scanned and its synthetic leak
MUST flag:

Self-hosted runner: acme-corp-linux-arm64 (invented).
Clone path: github.com/acme-corp/kailash-rs (invented org slug).
