# R4 kailash-sdk allowlist-anchor fixture (MUST flag, exit 1)

Locks the R4 single-HIGH fix (issue #263 Round-4): the R3-added
`kailash-sdk` allowlist entry was LEFT-UNANCHORED (only `\b`), so a
genuine 3rd-party disclosure `github.com/<org>/kailash-sdk` (or bare
`<org>/kailash-sdk`) had its inner `kailash-sdk` token match the WHOLE
org-slug span via `allowlistCovers()` — SUPPRESSING the `<org>` leak
(false clean). Same failure class as R2 must-fix #2, reintroduced by
the R3 broadener. The fix makes the entry POSITION-AWARE: `kailash-sdk`
as the Foundation Go ORG (`github.com[:/]kailash-sdk/<repo>`, first
segment) stays covered; `kailash-sdk` as a 3rd-party REPO
(`<org>/kailash-sdk`, last segment) is flagged.

All tokens SYNTHETIC except the Foundation-public Go-module org
`kailash-sdk` (Foundation-owned, documented in the rs core-sdk/ffi
skills) and `terrene-foundation` (the Foundation GitHub org) — both
legitimately Foundation-public, not client/3rd-party disclosures.

3rd-party org with a `kailash-sdk`-named repo — MUST flag (no longer
swallowed by the unanchored allowlist entry):
github.com/acme-corp/kailash-sdk is a synthetic 3rd-party reference.
bare acme-corp/kailash-sdk is a synthetic 3rd-party reference.

The Foundation Go-module ORG-path forms + the Foundation GitHub
compound + the bare token MUST stay clean (NOT in this fixture's
expected findings — covered by the position-aware allowlist entry and
the anchored Foundation entry):
go get github.com/kailash-sdk/kailash-go is the canonical install line.
git@github.com:kailash-sdk/kailash-go.git is the ssh clone form.
terrene-foundation/kailash-sdk is the Foundation GitHub compound.
the kailash-sdk module is referenced bare in this prose.
