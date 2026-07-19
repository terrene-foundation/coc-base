# SYNTHETIC fixture — `*.operator.local.md` destination-mode #352 parity proof

All tokens below are SYNTHETIC and invented for this fixture — no real
operator coordinates anywhere.

This file mirrors the `destination-local-json` / `test-mjs-destination-flip`
fixtures for the `*.operator.local.md` companion. At loom-source the
`*.operator.local.md` suffix is gitignored + skipped; but a committed
`*.operator.local.md` that shipped to a consumer IS the disclosure event, so
a destination scan (`--root <dir>`, where `REPO_ROOT_ACTIVE !== REPO_ROOT`)
MUST flag it. If the skip ever becomes unconditional again, this case flips to
exit 0 and the suite goes red.

Operator checkout: /Users/fakeuser/fake-repos/kailash-rs (synthetic operator-home-path).
