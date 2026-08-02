# Cross-repo authorization receipt (SYNTHETIC fixture — #1324 source-only guard)

Every token below is invented for this fixture. `acme-enterprise` is the
same synthetic enterprise org slug the `flag-each-shape` /
`nonfoundation-org-slug` fixtures use — chosen here BECAUSE it matches the
`nonfoundation-org-slug` shape's `*-enterprise` alternative.

WHAT THIS FIXTURE LOCKS: the `cross-repo-authz` exclusion is SOURCE-ONLY
(isExcluded, `&& REPO_ROOT_ACTIVE === REPO_ROOT`, mirroring `ecosystem.json`).
Driven via `--root <fixturedir>` this is a DESTINATION scan
(`REPO_ROOT_ACTIVE !== REPO_ROOT`), so the guard does NOT fire and the receipt
is SCANNED, not suppressed. Because `acme-enterprise` matches a disclosure
shape, it flags → exit 1. Making the guard UNCONDITIONAL prunes the dir even
at a destination scan → exit 1 → 0: that flip is the regression this fixture
guards (the R1 security MEDIUM — an unconditional exclusion blinds destination
scans entirely).

COVERAGE BOUND (do NOT read this as a complete leak-detector): the destination
scan flags a receipt ONLY when its target org matches an existing disclosure
shape (here `*-enterprise`). It does NOT flag an arbitrary client
`<org>/<repo>` whose org matches no shape — the receipt's structured
`cross-repo-authorized:`/`Target repo:` payload has no dedicated content shape.
Non-distribution is guaranteed by the THREE distribution fences
(`no_tier_match` + `CLIENT_TEMPLATE_REMOVE` + `EXCLUDE_WITHIN`), NOT by this
destination scan. A dedicated receipt-payload content shape (own-org
allowlisted) would make the destination detection complete — recommended
follow-up, out of #1324 scope.

cross-repo-authorized: acme-enterprise/widget-lib write

- **Target repo:** acme-enterprise/widget-lib
- **Mode:** write
- **Instruction:** file a bounded issue on acme-enterprise/widget-lib
- Conditions 1–5 attested; receipt written before acting.
