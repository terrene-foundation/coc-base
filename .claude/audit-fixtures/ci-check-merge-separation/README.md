# ci-check-merge-separation audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. These fixtures land
WITH the detector they pin — `.claude/hooks/lib/check-merge-separation.js`, enforced at
`PreToolUse:Bash` by `.claude/hooks/check-merge-separation-guard.js`.

The contract is `rules/git.md` § Discipline: **(1) READ** — pin the head SHA
(`gh pr view <N> --json headRefOid`) and confirm every REQUIRED check is `SUCCESS` on THAT SHA;
**(2) MERGE** — only then `gh pr merge <N>`. Bundling them (`&&`, or `--watch` then merge) is
BLOCKED.

Each fixture is ONE Bash command string. `run.mjs` drives `classifyCommand` +
`detectBundledCheckAndMerge` over every file and asserts the verdict **and its cause** — the
reader/merge counts — so a silence produced by the parser missing the merge can never masquerade
as the scope restriction under test.

| Fixture                                     | Expects  | Predicate locked                                                                                                                                                               |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flag-watch-then-merge.txt`                 | `flag`   | The rule's NAMED worst case: `gh pr checks --watch && gh pr merge`. Carries the distinct blocking-watch evidence line.                                                          |
| `flag-checks-and-merge-bundled.txt`         | `flag`   | CO-OCCURRENCE, not the separator: a non-blocking `gh pr checks --json` and the merge in one call split by `;`. Proves the detector is keyed on neither `&&` nor `--watch`.       |
| `flag-run-watch-then-merge.txt`             | `flag`   | The run-surface reader verb, `gh run watch <id> && gh pr merge` — same race, no `--watch` flag to key on. `hasWatchFlag` reads the VERB so it gets the blocking-watch line too.  |
| `clean-merge-alone.txt`                     | `silent` | **The most important clean pole.** A bare `gh pr merge` is the COMPLIANT shape once the pinned read happened in its own earlier call. A detector firing on every merge is worse than none. `merges=1` pins that the merge was SEEN and the silence is the absent reader. |
| `clean-checks-alone.txt`                    | `silent` | The mirror: a bare `gh pr checks --watch` is the (1) READ done properly. `readers=1` pins the cause.                                                                             |
| `clean-pinned-read-then-separate-merge.txt` | `silent` | The rule's own DO form. `gh pr view --json headRefOid` is a PIN read, not a CI-state read, so it is outside the reader class and this shape stays silent with a merge present.   |
| `clean-merge-help-withdrawn.txt`            | `silent` | The WITHDRAW arm: `gh pr merge --help` parses as `pr merge` but runs no merge. Firing here would be a false positive on the command run while LEARNING the correct form.        |
| `skip-embedded-in-heredoc.txt`              | `silent` | Segment anchoring via `violation-patterns.js::stripHeredocBodies` — the bundled form inside a `<<'EOF'` body is a runbook being written, not a command.                          |
| `skip-embedded-in-comment.txt`              | `silent` | `stripShellComments` — the bundled form after a `#`; the live line beneath is a lone `gh pr view`.                                                                              |
| `skip-quoted-example.txt`                   | `silent` | Quoted ARGUMENT — `echo "gh pr checks … && gh pr merge …"` stays one `echo` segment under quote-aware segmentation, so no gh invocation parses.                                 |
| `clean-unresolvable-substitution.txt`       | `silent` | FAIL-OPEN on an unresolved subcommand (`gh pr $(cat /tmp/verb2)`): `merges=0`, so the detector declines to guess (`cc-artifacts.md` Rule 7).                                    |

`run.mjs` adds two non-file groups the `.txt` corpus cannot express:

- **the fail-open pole** — six malformed/off-matcher payloads through `inspectBashCommand`, each
  required to return `[]` (absent `tool_input`, `null`, no `command` key, non-string command, empty
  command, a non-Bash tool carrying the bundled text);
- **a positive control** — the SAME entry point must FIRE on a well-formed bundled payload.
  Without it an entirely inert module passes every fail-open row above
  (`instrument-discipline.md` MUST-3(a)).

## Running

```bash
node .claude/audit-fixtures/ci-check-merge-separation/run.mjs; rc=$?; echo "rc=$rc"
# rc=0 = all green. Baseline at landing: 18 cases.
```

To RED the suite against a mutant without touching the shipped module:

```bash
LIB=/abs/path/to/mutant.js node .claude/audit-fixtures/ci-check-merge-separation/run.mjs
```

## Severity, and why the set is bipolar on every predicate

The guard is capped at `halt-and-report` (rendered `pre-action` at `PreToolUse`) and can never
block — the verdict rests on the ABSENCE of a pinned READ a `PreToolUse` hook cannot see, since it
may have happened in an earlier call. An advisory-tier detector that goes INERT is
indistinguishable from a clean session, which is exactly why the silence poles matter as much as
the firing ones: a one-poled set passes identically against a detector that fires on everything, or
one that fires on nothing.
