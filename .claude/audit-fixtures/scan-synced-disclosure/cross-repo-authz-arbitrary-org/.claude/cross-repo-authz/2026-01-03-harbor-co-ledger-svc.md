# Cross-repo authorization receipt (SYNTHETIC fixture — #1330 own-org allowlist)

Every token below is invented for this fixture. `harbor-co` is THIS fixture
ecosystem's OWN org (declared in `.claude/bin/ecosystem.json` remote_links).
The `cross-repo-authz-receipt-payload` shape derives the own-org set from that
registry and ALLOWLISTS it, so this legitimate own-ecosystem receipt does NOT
flag — while the sibling `nimbus-labs/parts-store` (foreign) does. The repo
segment `ledger-svc` is deliberately NOT a repo-family name, so the pre-#1330
`nonfoundation-org-slug` shape stays silent here too: a receipt-payload finding
on THIS file would mean the own-org allowlist regressed (the count lock catches
it).

cross-repo-authorized: harbor-co/ledger-svc write

- **Target repo:** harbor-co/ledger-svc
- **Mode:** write
- **Instruction:** file a bounded issue on harbor-co/ledger-svc
- Conditions 1–5 attested; receipt written before acting.
