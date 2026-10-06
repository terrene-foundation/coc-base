# `stripHeredocBodies` audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each
fixture is a Bash command string; the live lock is
`.claude/test-harness/tests/heredoc-argv-separation.test.mjs` (registered in
`ci-suites.json`, `min_cases` 22).

## What these pin

A heredoc BODY is data; only the command that opens it is an action. Every
Bash-surface segmenter in this repo splits on newlines and was not heredoc-aware,
so a body line sat at start-of-line and read as COMMAND POSITION. Three detectors,
one cause, all MEASURED before the fix — in each the command actually being run was
`cat > fixture.txt <<'EOF'`, which writes a file and nothing else:

| detector                             | fired on a body carrying   |
| ------------------------------------ | -------------------------- |
| `detectRepoScopeDriftBash`           | `gh … --repo owner/repo`   |
| `detectStrandingDestructiveCommand`  | `git worktree remove . -f` |
| `findGhSubcommand("pr","merge")`     | `gh pr merge`              |

## The scope fence — what is stripped, what is deliberately still matched

The policy is bash's own expansion rule, not a heuristic, and it is the same one
`maskHeredocBodies` already applies (loom#1703/#1704) so the two surfaces cannot
drift:

- **STRIPPED** — a QUOTED delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<$'EOF'`,
  `<<'EO'F`, `<<EOF''`, and the `<<-` variants). Bash performs NO expansion, so the
  body is provably inert bytes.
- **STRIPPED** — an UNQUOTED `<<EOF` whose body contains neither `$` nor a
  backtick. Nothing to expand, inert for the same reason.
- **RETAINED** — an UNQUOTED `<<EOF` whose body contains `$` or a backtick. Bash
  runs `$(…)` / `` `…` `` / `${…}` while BUILDING that body, so a real destructive
  command can be constructed through one. Stripping it would be a fail-OPEN.

A guard made quiet is worse than a guard made noisy; every branch above is chosen
so the quiet one is the one bash itself proves cannot act.

## Fixtures

| Fixture                                                    | Expects                             | Predicate locked                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `clean-quoted-body-gh-crossrepo.txt`                        | `detectRepoScopeDriftBash` → `null` | A quoted body carrying a cross-repo `gh` is data.                                                                              |
| `flag-real-gh-crossrepo-after-heredoc.txt`                  | `halt-and-report`                   | Its twin — the SAME body plus a real `gh … --repo` AFTER the close line still flags. Stripping too much reds here.             |
| `clean-unquoted-inert-body-worktree-remove.txt`             | stranding → `null`                  | An UNQUOTED body with no `$`/backtick is inert and stripped.                                                                   |
| `flag-real-worktree-remove-after-heredoc.txt`               | `worktree-remove`                   | Its twin — a live removal after the close still flags.                                                                         |
| `flag-unquoted-expandable-body-retained.txt`                | body text RETAINED                  | THE SCOPE FENCE. `$(…)` in an unquoted body is a command bash runs; the body stays visible.                                    |
| `flag-unquoted-backtick-body-retained.txt`                  | body text RETAINED                  | Same, via a backtick.                                                                                                          |
| `clean-quoted-expandable-body-stripped.txt`                 | body text STRIPPED                  | The discriminator for the two above: the IDENTICAL bytes under `<<'EOF'` are literal, so they ARE stripped.                     |
| `clean-dash-heredoc-tab-close-body.txt`                     | stranding → `null`                  | `<<-` closes on a TAB-indented delimiter.                                                                                      |
| `clean-space-indented-line-does-not-close-plain-heredoc.txt`| stranding → `null`                  | A SPACE-indented line closes nothing, so the text after it is still BODY. Verified by running it: bash wrote that text to the file. |
| `flag-dash-heredoc-space-indented-decoy-close.txt`          | target `feat/really-deleted`        | The fail-OPEN twin. The superseded `^[ \t]*DELIM\s*$` closed on the SPACE-indented line, surfacing the DECOY and hiding the real command. Asserting only "fired" would score the decoy as a pass, so the test pins the target NAME. |
| `clean-two-heredocs-one-command.txt`                        | `null` (gh + stranding)             | Two heredocs in one command, both bodies stripped.                                                                             |
| `flag-real-command-between-two-heredocs.txt`                | target `feat/really-deleted`        | Its twin — the second heredoc must not swallow the command before it.                                                          |
| `clean-delimiter-substring-in-body.txt`                     | stranding → `null`                  | `EOF_MARKER` / `xEOF` / `EOFx` are prose; only an EXACT line terminates.                                                        |
| `clean-backslash-delimiter-body.txt`                        | stranding → `null`                  | `<<\EOF` is a QUOTED delimiter. The superseded `['"]?WORD` regex could not see this form at all, so its body stayed firing.     |
| `clean-ansic-delimiter-body.txt`                            | stranding → `null`                  | `<<$'EOF'` — same class.                                                                                                        |
| `clean-partial-quoted-delimiter-body.txt`                   | stranding → `null`                  | `<<'EO'F` — bash's quoted-ANYWHERE rule; same class.                                                                            |

## Anti-vacuity

`LEG0` in the live lock fires every detector at a bare command carrying no heredoc,
so the `null` expectations above cannot be satisfied by an inert detector. Each
`clean-` pole has a `flag-` twin planting the same token at a REAL command position
in the SAME command, so a stripper widened until it swallows commands reds a twin
rather than passing quietly. The red was established by MUTATION, not by reading the
diff: stripping NOTHING reds 11 legs; stripping the unquoted expansion-bearing
bodies too reds exactly the three scope-fence legs.
