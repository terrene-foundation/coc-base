# MUST-7 single-owner N=1 ADO audit fixtures (F122)

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4 +
`multi-operator-coordination.md` MUST-7 § "Azure DevOps provider (F122 — LIVE)".

The Azure DevOps sibling of `../must-7-single-owner/` (GitHub). One fixture per
scope-restriction predicate of the `fold-rule-9c.js` ADO N=1 org-admin branch
(`_foldAdoN1OrgAdmin`, dispatched on `co_sign_anchor_kind ===
"ado_api_org_admin_capture"` / `CO_SIGN_ANCHOR_KIND_ORG_ADMIN_ADO`). Each
`.json` pins a candidate `genesis-migration` record shape; the `.expected.txt`
sibling names the fold-time disposition class the predicate produces.

End-to-end BEHAVIORAL coverage (with REAL ephemeral SSH keys + real signatures)
lives in `tests/integration/multi-operator/azure-migration-ceremony.test.js`.
The fixtures below are structural-payload SNAPSHOTS (stub sigs) that future
`/redteam` mechanical sweeps + the paired-landing hook
(`fold-amendment-paired-with-helper.js`) can diff against without re-deriving
payload shapes — identical contract to the GitHub `../must-7-single-owner/` set.

## ADO record shape (vs the GitHub sibling)

Only the attestation SOURCE differs; the N=1 org-admin STRUCTURE is neutral:

- `content.provider: "azure-devops"` (absent ⇒ github on the sibling set)
- `content.co_sign_anchor_kind: "ado_api_org_admin_capture"` (ADO discriminator;
  the GitHub value is `"gh_api_org_membership_capture"`)
- `content.ado_api_org_admin_capture` carries the ADO Graph Project Collection
  Administrators (PCA) attestation `{role, state, user:{login}, organization:{login}, capture_ts}`
  — the same canonical inner shape as gh's `gh_api_org_membership_capture`, with
  `user.login` carrying the Entra UPN (the operator's `principal`)
- the bound identity is the sole owner's `principal` (Entra UPN), not `github_login`

## Predicate matrix

| Fixture                                            | Predicate locked                                                    | Expected verdict              |
| -------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| `ado-n1-org-admin-canonical-pass.json`             | well-formed N=1 ADO record passes the fold predicate's ADO branch   | accepted                      |
| `ado-n1-org-admin-stale-capture.json`              | ado_api_org_admin_capture older than MIGRATION_LIVENESS_TTL         | rejected (stale)              |
| `ado-n1-org-admin-user-owned-kind.json`            | new_repo_owner_kind="user" with the ADO org-admin discriminator     | rejected (user-owned)         |
| `ado-n1-org-admin-populated-co-signers.json`       | ADO discriminator present AND co_signers populated (malformed mix)  | rejected (mix)                |
| `ado-n1-org-admin-missing-discriminator.json`      | co_signers:[] but no co_sign_anchor_kind                            | rejected (R6-S-04 2-of-N)     |
| `ado-n1-org-admin-mismatched-principal.json`       | ado_api_org_admin_capture user.login ≠ sole owner's bound principal | rejected (principal mismatch) |
| `ado-n1-org-admin-pending-role.json`               | ado_api_org_admin_capture role="member" (not admin)                 | rejected (not admin)          |
| `ado-n1-org-admin-suspended-state.json`            | ado_api_org_admin_capture state="pending" (not active)              | rejected (not active)         |
| `ado-n1-cross-provider-discriminator-forgery.json` | provider=azure-devops but gh discriminator + gh capture (forgery)   | rejected (cross-provider)     |

## Predicate ↔ rule-clause map

Each fixture pins a specific MUST-7 ADO sub-clause (the `_foldAdoN1OrgAdmin`
predicates at `fold-rule-9c.js`):

- canonical-pass → entire ADO (a)–(g) chain
- stale-capture → (c) freshness (`_isCaptureFresh`, MIGRATION_LIVENESS_TTL) at fold layer
- user-owned-kind → (b) new_repo_owner_kind==="org" requirement
- populated-co-signers → (a) co_signers===[] requirement
- missing-discriminator → (e) discriminator presence → falls through to 2-of-N (R6-S-04)
- mismatched-principal → (g) user.login==sole owner principal
- pending-role → (c) role==="admin" requirement
- suspended-state → (c) state==="active" requirement
- cross-provider-discriminator-forgery → the provider↔discriminator consistency guard

## Runner contract

Each `.json` is a candidate `genesis-migration` record an audit script can load
and diff against the live `_foldAdoN1OrgAdmin` field reads. The `.expected.txt`
sibling carries the structural-class identifier (`accepted: <bool>` + the
predicate); the comparison is structural (verdict class), NOT a re-execution of
the signature gate (the fixtures carry stub sigs; signature verification is
exercised by the behavioral suite). Authored F122 Shard 5 (R1 cc-architect MED-1
resolution); receipt: the F122-ADO-N1-FIXTURES forest item in
`multi-operator-coordination.md` § Origin registry.
