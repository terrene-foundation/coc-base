# multi-operator-sessionstart audit fixtures

Mechanical regression locks for the 11 surfaces in
`.claude/hooks/multi-operator-sessionstart.js`. Per
`rules/cc-artifacts.md` Rule 9, one fixture per scope-restriction
predicate.

| Fixture                         | Surface                                                  | Expected behavior                                                            |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 01-clean-identity               | §4.3 Surface 1 (own identity, rostered key)              | additionalContext cites display_id + role                                    |
| 02-sibling-active               | §4.3 Surface 2 (sibling claims grouped by display_id)    | sibling display_id appears under "Sibling active claims"                     |
| 03-partition-detected           | §4.3 Surface 3+6 (operative posture capped at L3)        | additionalContext cites L3_SHARED_PLANNING + partition reason                |
| 04-revocation-contest           | §4.3 Surface 7 (rule-10 contest names forging signer)    | additionalContext cites contested + forging_signer                           |
| 05-drift-own-wip                | §4.3 Surface 9 (drift attribution; F13 closure)          | .claude/learning/*.jsonl MUST NOT surface as cross-operator drift            |
| 06-gate-approval-pending        | §4.3 Surface 11 (pending gate-approvals as approver)     | additionalContext cites requester display_id + target_tool                   |

Each fixture is exercised by the corresponding test in
`tests/integration/multi-operator/m5-b2-lifecycle-hooks.test.js`. The test
file is the executable specification; the fixtures below are the
input-payload artifact for manual replay and `/cc-audit` mechanical
sweeps.
