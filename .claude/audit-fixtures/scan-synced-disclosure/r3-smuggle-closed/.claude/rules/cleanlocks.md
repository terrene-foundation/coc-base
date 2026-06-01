# R3 must-fix #D fixture — smuggle-close does NOT flood (MUST stay clean)

All tokens SYNTHETIC and invented for this fixture.

R3 must-fix #D (issue #263): the 5th alternative that closes the
branch/scheme smuggle MUST NOT flood on legitimate prose paths. The
closed-set branch-prefix anchor + the SAME internal-dir / repo-family
negative-lookahead the 4th alt uses keeps all of these clean. ZERO
findings expected on this file:

Real branch: chore/coc-telemetry-auto (coc\* is repo-family-excluded).
Real branch: feat/issue-263-disclosure-scanner (2nd seg not a family).
Internal path: src/kailash/core (no branch/scheme prefix).
Internal path: repos/loom checkout (no branch/scheme prefix).
Generic: path/to/file (no repo-family 2nd segment).
DB string: postgresql://user:pass@localhost/kailash (localhost excluded).
Public SDK URL: https://github.com/openai/openai-python (2nd seg not a family).
Release branch: release/v3.23.0 (no org/repo-family shape).
Own branch: chore/loom/cleanup (loom is repo-family-excluded as <org>).

If any line here flags, the smuggle-close over-extended into a flood.
