# destination-local-json — destination-mode `.local.json` scan-on

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Pins the issue #352 fix in `scan-synced-disclosure.mjs:226-228` — the `.local.json` exclusion now scopes to `REPO_ROOT_ACTIVE === REPO_ROOT` (loom-source scan only). When `--root` points at a destination tree, committed `.local.json` files ARE scanned because their presence at a sync destination IS the disclosure event the scanner exists to catch.

| Predicate locked                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Destination scan via `--root <dir>` flips `.local.json` exclusion OFF. A committed `.local.json` at the destination embeds operator-home-path shapes → flag. |

Synthetic content per the dir's `README.md` convention: invented home paths only (`/Users/fakeuser/...`, `~/fake-repos/...`) — NO real operator coordinates.
