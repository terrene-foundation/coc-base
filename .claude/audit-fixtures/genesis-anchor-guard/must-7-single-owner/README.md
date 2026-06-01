# MUST-7 single-owner N=1 audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4 +
`multi-operator-coordination.md` MUST-7 (F86 acceptance criterion 8).

One fixture per scope-restriction predicate of the F86 helper +
fold-rule-9c amendment. Each `.json` fixture pins a candidate
`genesis-migration` record shape; the `.expected.txt` sibling names the
fold-time disposition class the predicate produces.

End-to-end behavioral coverage lives in
`tests/integration/multi-operator/f86-must-7-single-owner.test.js`. The
fixtures below are the structural-payload snapshots that future
`/redteam` mechanical sweeps + the paired-landing hook
(`fold-amendment-paired-with-helper.js`) can diff against without
re-deriving payload shapes.

## Predicate matrix

| Fixture                                   | Predicate locked                                                           | Expected verdict          |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `n1-org-admin-canonical-pass.json`        | well-formed N=1 record passes the fold predicate's N=1 branch              | accepted                  |
| `n1-org-admin-stale-capture.json`         | gh_api_org_membership_capture older than MIGRATION_LIVENESS_TTL            | rejected (stale)          |
| `n1-org-admin-user-owned-kind.json`       | new_repo_owner_kind="user" with the org-admin discriminator                | rejected (user-owned)     |
| `n1-org-admin-populated-co-signers.json`  | discriminator present AND co_signers populated (malformed mix)             | rejected (mix)            |
| `n1-org-admin-missing-discriminator.json` | co_signers:[] but no co_sign_anchor_kind                                   | rejected (R6-S-04 2-of-N) |
| `n1-org-admin-mismatched-user-login.json` | gh_api_org_membership_capture user.login ≠ sole owner's bound github_login | rejected (login mismatch) |
| `n1-org-admin-pending-role.json`          | gh_api_org_membership_capture role="member" (not admin)                    | rejected (not admin)      |
| `n1-org-admin-suspended-state.json`       | gh_api_org_membership_capture state="pending" (not active)                 | rejected (not active)     |

## Predicate ↔ rule-clause map

Each fixture pins a specific MUST-7 sub-clause:

- canonical-pass → entire (a)–(g) chain
- stale-capture → (c) freshness + MUST-7 fold-time verification (iii)
- user-owned-kind → MUST-7 § "User-owned + N=1 path (blocked)"
- populated-co-signers → MUST-7 (b)
- missing-discriminator → MUST-7 (e) discriminator presence requirement
- mismatched-user-login → MUST-7 (c) + (g)
- pending-role → MUST-7 (c) role=admin requirement
- suspended-state → MUST-7 (c) state=active requirement

## Runner contract

Each fixture is a JSON file the `tests/integration/multi-operator/f86-must-7-single-owner.test.js`
runner (or any future audit script) can load and pass to
`foldGenesisMigration` against a synthetic roster + foldState. The
`.expected.txt` sibling carries the structural-class identifier the
fold predicate must produce; the comparison is structural (verdict +
reason-class), NOT prose-equal (per `probe-driven-verification.md` MUST-3).
