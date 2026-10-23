# sync-preserve-yaml-scanned — scenario-11 narrowness proof (complement)

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. The
complement of `sync-preserve-local-skipped`: proves the `isNeverSynced` scenario-11
predicate is NARROW. The template-carried carrier `.claude/sync-preserve.yaml`
(NO `.local`) IS synced template→consumer (`sync-flow.md` § Downstream Sync step 5b

- § Exclusions), so it MUST be scanned. The planted `operator-home-path` token
  MUST flag.

| Predicate locked                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-preserve.yaml` (template-carried, no `.local`) is NOT excluded by `isNeverSynced`: a planted `operator-home-path` token flags → exit 1. A 0-finding result = the skip predicate over-broadened to swallow the synced carrier. |

Synthetic content per the dir's README convention: invented home paths only
(`<operator-home>/fake-repos`) — NO real operator coordinates.
