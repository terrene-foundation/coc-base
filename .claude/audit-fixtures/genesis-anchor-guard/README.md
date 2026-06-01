# genesis-anchor-guard audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.
Each fixture pins one scope-restriction predicate the
`.claude/hooks/genesis-anchor-guard.js` hook relies on. Each `.json`
fixture is a CC PreToolUse-style payload that the hook reads from stdin;
the `.expected.txt` sibling names the exit code + behavior class.

The end-to-end behavioral coverage lives in
`tests/integration/genesis-anchor.test.js` — those tests construct
ephemeral SSH keys + real rosters + real coordination logs and exercise
the hook via `spawnSync`. The fixtures below are the structural-payload
snapshots that the test suite + future `/redteam` mechanical sweeps can
diff against without re-deriving payload shapes.

| Fixture                                      | Tool | Expected            | Predicate locked                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pretooluse-bash-git-commit.json`            | Bash | watched             | git commit is a watched tool (gates the hook)                                                                                                                                                                                                                             |
| `pretooluse-bash-git-push.json`              | Bash | watched             | git push is a watched tool                                                                                                                                                                                                                                                |
| `pretooluse-bash-ssh-keygen-sign.json`       | Bash | watched             | ssh-keygen -Y sign is a watched tool                                                                                                                                                                                                                                      |
| `pretooluse-bash-shell-variable-skip.json`   | Bash | not-watched         | `$GITCMD commit` is NOT a literal git command — hook-output-discipline.md MUST-3 (pre-expansion shell variable; lexical detection MUST NOT block)                                                                                                                         |
| `pretooluse-bash-read-only-passthrough.json` | Bash | not-watched         | `git status` is read-only, NOT in the watched-tool allowlist (passthrough)                                                                                                                                                                                                |
| `pretooluse-edit-roster.json`                | Edit | watched             | editing operators.roster.json IS a watched roster op                                                                                                                                                                                                                      |
| `pretooluse-edit-unrelated.json`             | Edit | not-watched         | editing a non-roster file passes through                                                                                                                                                                                                                                  |
| `malformed-log-line-structural-null.txt`     | n/a  | passes through fold | a malformed JSONL line in the coordination log is the structural-NULL negative; the fold skips it (it cannot contribute to trust-root computation) instead of crashing — `rules/cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4's structural-NULL discipline |

## Notes

- The hook NEVER carries `severity: "block"` from a lexical regex match
  (per `hook-output-discipline.md` MUST-2). The single `block` branch is
  grounded in deterministic cryptographic signature verification — a
  structural fact (verify() either succeeds or doesn't; surface rewrites
  cannot evade it).
- Shell-variable detection (MUST-3) is enforced by the watched-tool
  predicate's positive allowlist: it only fires on LITERAL `git commit`
  / `git push` / `ssh-keygen -Y sign` / `gpg --sign`. Any variable
  expansion (`$VAR`, `${VAR}`, `$(...)`) breaks the literal match and
  passes through — the structural-NULL discipline.
- The trust-root absence check + the genesis-generation peer-high-water
  check both depend on signature-verifying records in the log; a log
  with no records OR only malformed lines OR only non-verifying records
  IS the "no verifying owner-bound anchor" case → hard block (unless
  enrollment-in-progress).
