# sync-preserve-local-skipped — scenario-11 `isNeverSynced` skip proof

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Pins
the scenario-11 predicate added to `scan-synced-disclosure.mjs::isNeverSynced`
(`base === "sync-preserve.local.yaml"` → `return true`). The consumer-owned
half of the sanctioned-local-preserve pair (`sync-flow.md` § Downstream Sync
step 5b) is never synced — same class as `settings.local.json` — so the scanner
MUST skip it even though it embeds an operator-home-path token.

| Predicate locked                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-preserve.local.yaml` is skipped by `isNeverSynced` (unconditional, like `settings.local.json`): a planted `operator-home-path` token does NOT flag → exit 0, clean. |

Synthetic content per the dir's README convention: invented home paths only
(`/Users/fakeuser/fake-repos`) — NO real operator coordinates. The complement
fixture `sync-preserve-yaml-scanned` locks the narrowness (the template-carried
`sync-preserve.yaml`, no `.local`, IS scanned).
