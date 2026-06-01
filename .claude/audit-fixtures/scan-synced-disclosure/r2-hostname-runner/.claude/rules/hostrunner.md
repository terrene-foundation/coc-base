# R2 hostname + runner-label fixture (MUST flag, exit 1)

Locks must-fix #3 (runner-label arch suffixes) and must-fix #4
(lowercase `<op>-mini` + the `-Mac` Proc-Macro false-positive fix).
All tokens SYNTHETIC.

must-fix #3 — runner-label arch suffixes (prior shape only had
`arm|x64`, so `*-linux-arm64` evaded):
Self-hosted: initech-linux-arm64 (invented).
Also: globex-linux-aarch64 and acme-linux-x86_64.

must-fix #4a — lowercase `<op>-mini` (prior shape required
`[A-Z][a-z]+-Mini`):
The arm leg ran on bar-mini overnight.

must-fix #4 — real Mac-product hostnames still flag:
Built on Foo-MacStudio and Bar-MacBookPro.
Local box: Baz-Mac.local handled the rest.

R3 must-fix #A — single-uppercase / all-caps operator-name stem on
the `-Mac` arms (prior stem `[A-Z][a-z]+s?` required ≥1 lowercase, so
a 1-char stem evaded ALL three `-Mac` arms):
Provisioned on X-MacBook-Pro (invented, single-uppercase stem).

must-fix #4b — NEGATIVE: `Proc-Macro` (rust proc-macro) MUST NOT flag.
The crate uses a Proc-Macro derive. (must NOT appear as a finding —
the runner has no expectShapes entry for this, so a stray
operator-hostname here from `Proc-Macro` would surface as an
unexpected shape only if it were the SOLE finding; this line is a
guard that the -Mac arm requires a real product boundary.)
