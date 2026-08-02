# Rule Whose Detection Block Quotes Shell Commands

## Trust Posture Wiring

- **Detection mechanism:** run `node .claude/bin/real-check.mjs --json --root . --strict`
  over the corpus, then sweep with `grep -rn 'detectFoo' .claude/hooks/` and diff the
  result against `.claude/test-harness/probes/shellish.probes.json`. The hook entry point is
  `.claude/hooks/lib/violation-patterns.js::detectShellish`.
- **Violation scope:** MUST-1.
