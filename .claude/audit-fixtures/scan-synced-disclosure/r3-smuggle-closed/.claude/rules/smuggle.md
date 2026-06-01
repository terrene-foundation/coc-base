# R3 must-fix #D fixture — bare-org-slug smuggle CLOSED (MUST flag)

All tokens SYNTHETIC and invented for this fixture.

R3 must-fix #D (issue #263): the 4th-alt anti-flood
negative-lookbehind `(?<![\w./-])` let a genuine 3rd-party org ride a
`/` after a git-branch prefix or a URL scheme past detection. The 5th
alternative CLOSES this: a closed-set branch prefix
(`chore/`,`feat/`,`fix/`,`release/`,`docs/`,`test/`,`refactor/`,
`style/`) OR a `<scheme>://` immediately before `<org>/<repo-family>`
now flags. These four smuggle forms MUST flag:

Branch: chore/acme-corp/loom (invented org).
URL: postgres://acme-corp/loom (invented org on a scheme prefix).
Branch: feat/globex/kailash-rs (invented org).
Branch: fix/initech/coc-sync (invented org).

Disposition: CLOSED. Empirically gated — the scanner exits 0 on the
loom branch tree WITH this 5th alt live (no flood on legit prose
paths). The clean-locks fixture (sibling file) proves the closed-set
prefix + internal-dir negative-lookahead does NOT flood real branch
names / internal paths / public SDK URLs / DB connection strings.
