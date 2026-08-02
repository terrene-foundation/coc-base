# Cross-repo authorization receipt (SYNTHETIC fixture — #1330 destination-completeness)

Every token below is invented for this fixture. `nimbus-labs/parts-store` is
a plain `slug/slug` that matches NO other disclosure shape (its repo segment
is not a repo-family `loom`/`kailash*`/`coc*`/`atelier`, it carries no
`-enterprise` suffix, and it sits in no `github`/`gh`/`--repo` context) — so
the pre-#1330 scanner would NOT have flagged it. It is caught HERE ONLY by the
`cross-repo-authz-receipt-payload` content shape, proving that shape closes the
arbitrary-client-org destination-detection gap (#1330). This fixture's root has
an `ecosystem.json` whose own orgs are `harbor-co` / `harborreg`; `nimbus-labs`
is NOT among them → FOREIGN → flags.

cross-repo-authorized: nimbus-labs/parts-store write

- **Target repo:** nimbus-labs/parts-store
- **Mode:** write
- **Instruction:** file a bounded issue on nimbus-labs/parts-store
- Conditions 1–5 attested; receipt written before acting.
