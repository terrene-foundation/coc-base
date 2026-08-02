---
type: cross-repo-authorization-receipt
target: vertex-systems/payments-core
mode: write
---

# Cross-repo authorization receipt (SYNTHETIC fixture — #1330 L1 frontmatter target:)

Every token below is invented for this fixture. This case proves the L1
frontmatter marker: the BODY markers have been GENERICIZED to metavariables
(the partial-scrub evasion — a genericized body but a still-concrete
frontmatter), so they do NOT flag:

cross-repo-authorized: <org>/<repo> write

- **Target repo:** <org>/<repo>

Only the frontmatter `target: vertex-systems/payments-core` retains the
concrete FOREIGN org (`vertex-systems` is NOT among the fixture ecosystem's
own orgs `harbor-co`/`harborreg`, and matches NO other disclosure shape) →
MUST flag via the `target:` frontmatter marker ONLY (1 finding). Drop the
`target:` alternative from the shape and this file goes silent — the count
lock catches that regression.
