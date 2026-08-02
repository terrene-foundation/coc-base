---
type: cross-repo-authorization-receipt
target: harbor-co/settings-svc
mode: read
---

# Cross-repo authorization receipt (SYNTHETIC fixture — #1330 L1 own-org frontmatter)

Every token below is invented for this fixture. The frontmatter
`target: harbor-co/settings-svc` names the fixture ecosystem's OWN org
(`harbor-co`, declared in `.claude/bin/ecosystem.json`), so the L1 frontmatter
`target:` marker carries the SAME own-org negative-lookahead and SUPPRESSES it
— exactly like the body markers. The body markers here are genericized too.
This file MUST contribute 0 findings: a receipt-payload finding on it would
mean the L1 frontmatter marker forgot the own-org lookahead (a leak of the
suppression contract).

cross-repo-authorized: <org>/<repo> read

- **Target repo:** <org>/<repo>
