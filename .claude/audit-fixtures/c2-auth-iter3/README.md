# c2-auth-iter3 audit fixtures

Scope: structural-sweep predicates for F14 C2-auth-hardening iter-3.

The CRITICAL structural sweeps for this shard are:

1. `grep -rn 'tool === "Edit" || tool === "Write"' .claude/hooks/` MUST be empty
2. `grep -rnE '\.(github_login|login)\s*[!=]==\s*[^"]' .claude/hooks/` MUST be empty
   (with type-guard `typeof X === "string"` filter)

These are enforced as structural tests in
`tests/integration/multi-operator/c2-auth-hardening-iter3.test.js` and
serve as the regression lock for the bug class that iter-1, iter-2,
iter-3 successively swept per-site.

The fixtures themselves are encoded as the SOURCE TREE state: post-merge,
the source MUST satisfy both sweeps. The tests run the sweeps directly
against `.claude/hooks/`; no fixture files are needed since the source
tree IS the fixture.

Future iter-N: if any new hook ships with the same bug class, the
structural sweep test will fail loudly. That IS the contract.
