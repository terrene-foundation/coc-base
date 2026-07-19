# `operator-local-md-destination-flip` fixture

Pins the `*.operator.local.md` destination-mode scan-on (the #352 parity applied
to the `.operator.local.md` skip; loom Gate-1 ingest of the kailash-py
re-convergence-#9 disclosure-hygiene flag).

The `*.operator.local.md` exclusion in `isExcluded()` is now scoped to
`REPO_ROOT_ACTIVE === REPO_ROOT` (loom-source-scan only), mirroring the
`*.local.json` and `*.test.mjs` flips. At loom-source these files are gitignored
(never committed); at a destination scan (`--root <dir>`) a committed
`*.operator.local.md` IS the disclosure event the scanner exists to catch. The
planted `ci-runners.operator.local.md` carries a synthetic
`/Users/fakeuser/...` home-path; it MUST flag at the destination scan.

If the skip ever becomes unconditional again — or the generic `*.local.md`
catch-all re-swallows the `*.operator.local.md` superset-suffix — this case
flips to exit 0 and the suite goes red.
