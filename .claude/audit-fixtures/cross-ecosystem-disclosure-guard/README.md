# cross-ecosystem (canon<->fork) disclosure-isolation guard fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One fixture
per scope-restriction predicate of `.claude/hooks/lib/cross-ecosystem-disclosure-guard.js`
(issue #584 AC-1). Each `.json` fixture is a `guardForkToCanonWrite(opts)` input
payload (the `_predicate` field names the predicate it locks); the
`.expected.txt` sibling names the decision class the guard returns.

End-to-end behavioral coverage lives in
`tests/integration/multi-operator/eco-cross-ecosystem-disclosure-guard.test.js`.
These fixtures are structural snapshots a `/redteam` mechanical sweep can diff
against without re-deriving payload shapes.

## Predicate matrix

| Fixture                                  | Predicate locked                                                                                                                                                                                      | Expected decision                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `canon-side-write.json`                  | boundary-recognition: canon (upstream_canon=null) has no upstream to cross                                                                                                                            | allow (not-fork-to-canon)          |
| `fork-own-surface-write.json`            | boundary-recognition: fork editing its OWN surface (no canon-target) is intra-ecosystem, unaffected                                                                                                   | allow (not-fork-to-canon)          |
| `fork-to-canon-identifying.json`         | fork-identifying-content: fork->canon write carrying tenant identity is BLOCKED                                                                                                                       | block (fork-identifying-content)   |
| `fork-to-canon-grant-present.json`       | envelope-expansion close: the repo-scope-discipline.md:30 grant does NOT bypass the guard                                                                                                             | block (grant present, not honored) |
| `fork-to-canon-unverified.json`          | fail-closed: a fork->canon surface with no clean scan verdict is UNVERIFIED and BLOCKS (MUST-3)                                                                                                       | block (disclosure-unverified)      |
| `fork-to-canon-public-o1.json`           | public-authority-O1 carve-out: a public ISO/SOC2/GDPR O1 artifact is ecosystem-neutral and crosses                                                                                                    | allow (public-authority-o1)        |
| `fork-to-canon-tenant-authority-o1.json` | public-authority-O1 NEGATIVE: a tenant-specific authority O1 is NOT carved out; falls to disclosure                                                                                                   | block (fork-identifying-content)   |
| `fork-to-canon-prefix-collision.json`    | public-authority-O1 word-boundary (#584 R2): an authority that prefix-collides a public token ("ISO-Acme-…") is NOT carved out — `_tokenBoundaryOk` refuses the "-" continuation; falls to disclosure | block (fork-identifying-content)   |
| `fork-to-canon-clean.json`               | fork-identifying-content NEGATIVE: a fork->canon write whose scan ran CLEAN is allowed                                                                                                                | allow (fork-to-canon-clean)        |

## AC-2 deferred

The sync-from-canon INTAKE wiring (#584 AC-2) depends on #576 (the
sync-from-canon driver, UNBUILT) and is DEFERRED. The deferred contract is
pinned by the strict-xfail (`todo`-marked) test (5) in the suite above; no
intake-path fixture ships until #576 lands the driver.
