# test-mjs-destination-flip — destination-mode `*.test.mjs` scan-on

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Pins the source-only `*.test.mjs` skip in `scan-synced-disclosure.mjs::isExcluded` — the skip scopes to `REPO_ROOT_ACTIVE === REPO_ROOT` (loom-source scan only), mirroring the sibling `*.local.json` / `ecosystem.json` source-only flips.

loom's own `bin/*.test.mjs` unit tests legitimately embed synthetic disclosure shapes to exercise the scrubber; at loom-source they are skipped (and are never-synced per the `**/*.test.mjs` manifest exclude) so the Gate-2 `--check` preflight stays clean. But a `*.test.mjs` that ever leaks to a consumer is a live disclosure event — so a destination scan (`--root <consumer>`) MUST flip the skip OFF and flag it.

| Predicate locked                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination scan via `--root <dir>` flips the `*.test.mjs` exclusion OFF. A committed `bin/*.test.mjs` at the destination embeds operator-home-path shapes → flag (exit 1). |

If a future edit makes the skip unconditional (e.g. moves it to `isNeverSynced` or drops the `&& REPO_ROOT_ACTIVE === REPO_ROOT` half), this fixture flips to a clean exit and the suite goes red — the regression lock.

Synthetic content only: invented home path (`/Users/fakeuser/...`) — NO real operator coordinates.
