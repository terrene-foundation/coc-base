# no-verify-position

Regression lock for the `--no-verify` fence's **argv-position** predicate at
`.claude/hooks/validate-bash-command.js`.

Runner: `run.mjs`. Executed totals come from
`.claude/audit-fixtures/no-verify-position/run.mjs:729-735`.
The registered floor and dated producing-state receipt belong to the
`no-verify-position` row in `.claude/test-harness/ci-audit-fixtures.json`,
maintained by the landing orchestrator after its actual run. A past green is not
current evidence when its input bytes have changed.

## What it locks

| Surface                                                | Where                                     |
| ------------------------------------------------------ | ----------------------------------------- |
| the `--no-verify` fence + `carriesNoVerifyFlag`         | `hooks/validate-bash-command.js`          |
| `NO_VERIFY_SUBCOMMANDS` (which verbs take the flag)     | same file, module scope                   |
| `NO_VERIFY_VALUE_FLAGS` (which flags eat the next word) | same file, module scope                   |
| `parseGitInvocation`'s `argv` (tokens, not a string)    | `hooks/lib/git-command-parse.js`          |
| the fence's PLACEMENT after the destructive-op lanes    | `hooks/validate-bash-command.js`          |

## Parsed config and environment bypasses

The hook reports parsed `core.hooksPath` overrides from separated/attached
`-c` and `--config-env`, effective `HUSKY=0`, and indexed Git config
environment overrides on commit, push and merge. Unresolved effective HUSKY,
config keys or indexed environment metadata produce a distinct NOT RUN/UNKNOWN
finding, retaining halt-and-report severity and `git.md § Discipline` by name
(`.claude/hooks/validate-bash-command.js:2671-2694`;
`.claude/hooks/lib/git-command-parse.js:3882-3929`). Substitutions are never
executed to resolve these controls.

Tokenizer expansion provenance and effective prefix operations remain private
metadata; enumerable invocation fields retain their existing shape. Prefix
metadata distinguishes real assignments from launcher command operands, records
exec environment clearing and command lookup-only modes, and supports later
literal overwrites or env clearing/unsetting
(`.claude/hooks/lib/git-command-parse.js:1671-1709`, `:2187-2259`, `:3425-3435`).
Shell prefix `+=` concatenates known prior values; explicit clearing/unsetting
establishes known absence, while ambient or opaque prior values retain UNKNOWN.
Env/sudo assignment operands do not acquire shell append semantics. Sudo setters
require a known wrapper prefix position; ambiguous wrapper transitions retain
UNKNOWN, while proven command/nice executable operands remain quiet. Exec flags
are interpreted only before the value-taking `-a` operand boundary
(`.claude/hooks/lib/git-command-parse.js:2101-2125`, `:2187-2259`, `:3882-3907`).
Hook-surface mode retains group/stdin receiver handling, while ordinary parser
callers retain their default mode
(`.claude/hooks/lib/git-command-parse.js:621-641`, `:3931-3971`).

Named firing/quiet controls cover unresolved states, literal discharges,
launcher modes and indexed config environment inputs. Current mutation controls
compile in-memory copies, prove each changed branch ran, and observe named
assertion failures; they never replace tracked source
(`.claude/audit-fixtures/no-verify-position/run.mjs:389-723`). The older
in-place mutation account below is historical.

Scope: deterministic decisions over parsed candidate commands, not live hook
efficacy or full shell parity. Indexed config traversal is bounded; opaque
controls, malformed COUNT, empty KEY and incomplete indexed inputs report UNKNOWN.
This does not validate other raw config-key grammar. Ambient environment,
persistent shell exports, additional hook-framework variable families and
unknown producer output are outside this change
(`.claude/hooks/lib/git-command-parse.js:585-620`, `:3909-3925`).

## Cheap input freshness check

Pass the exact producing source commit recorded in the registered receipt,
not a newly chosen HEAD. This compares committed expected bytes with the four
direct input files and emits CURRENT or STALE per file; errors emit NOT RUN.
It does not certify transitive dependencies or native efficacy. The README
contains no expected self-hash, avoiding a circular receipt.

```bash
check_no_verify_inputs() {
  if [ "$#" -ne 1 ]; then echo "NOT RUN: producing commit argument required"; return 2; fi
  local producer_commit="$1" probe_tmp expected_line current_line source_path
  probe_tmp=$(mktemp -d) || { echo "NOT RUN: scratch allocation failed"; return 2; }
  for source_path in .claude/hooks/validate-bash-command.js \
      .claude/hooks/lib/git-command-parse.js \
      .claude/audit-fixtures/no-verify-position/run.mjs \
      .claude/audit-fixtures/no-verify-position/README.md; do
    if ! git show "$producer_commit:$source_path" > "$probe_tmp/expected"; then
      echo "NOT RUN: missing committed input $source_path"; return 2
    fi
    expected_line=$(shasum -a 256 "$probe_tmp/expected") || { echo "NOT RUN: expected input unreadable"; return 2; }
    current_line=$(shasum -a 256 "$source_path") || { echo "NOT RUN: current input unreadable"; return 2; }
    if [ "${expected_line%% *}" = "${current_line%% *}" ]; then
      echo "CURRENT $source_path"
    else
      echo "STALE $source_path"
    fi
  done
  rm "$probe_tmp/expected"
  rmdir "$probe_tmp"
}
```

## The defect, as measured before the fix

The predicate was pure token presence against raw segment text:

```js
segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))
```

Driven as a decision function against the shipped hook. Every row is a **false
positive** — none is a git invocation that takes the flag, so none can bypass
any hook:

```
echo "we used --no-verify once"            -> exit 0 HALT-AND-REPORT
echo --no-verify                           -> exit 0 HALT-AND-REPORT
grep -rn -- --no-verify .claude/hooks      -> exit 0 HALT-AND-REPORT
git log --grep 'skip --no-verify here'     -> exit 0 HALT-AND-REPORT
cat /tmp/m.txt | grep -c ' --no-verify '   -> exit 0 HALT-AND-REPORT
```

The **positive control**, on the same tree in the same run, proving the fence
could both speak and stay quiet — so the rows above are real over-fires and not
an inert instrument (`instrument-discipline.md` MUST-3(a)):

```
git commit --no-verify -m x                        -> exit 0 HALT-AND-REPORT   (correct)
gh pr comment 5 --body "…used --no-verify"         -> exit 0 SILENT            (correct)
```

The class is loom#1714 MEDIUM-1, already recorded in the same file for a sibling
verb: `findPushInvocation`'s docstring notes that a raw `/git\s+push/` match
"fired on `git push` appearing as DATA — inside a JS string, a quoted argument, a
heredoc body or a comment". The remedy is that one, not a wider regex.

## The two properties the cases are built around

**Position, never presence.** `git commit -m "--no-verify"` carries the exact
token in argv and bypasses nothing — it is the commit *message*. So does
`git commit -m x -- --no-verify`, where the token is a pathspec.

**A value-flag table fails dangerously when wrong.** Skipping the word after a
flag is what makes the message case quiet — but listing a *boolean* flag as
value-taking makes the walk skip a real `--no-verify` right after it.
`posture-gate.js::VALUE_FLAGS` carries **six** such entries — `commit -S`,
`commit --gpg-sign`, `commit -u`, `commit --untracked-files`,
`push --force-with-lease` and `push --signed` — every one of which takes an
*optional* value in the attached form only and so consumes **nothing** when
written separated. (An earlier revision of this paragraph said "four" and omitted
the two `-u` spellings; the figure was wrong and is corrected here rather than
left, since an undercount in a note about a miscounted table is the same class of
error twice.) The table in the fix was therefore measured, not copied:
each flag was probed with `git <sub> <flag> --zzz-not-a-flag`, reading whether git
named `zzz-not-a-flag` as an unknown option, against known-boolean control poles
(`--quiet`, `--amend`, `--abort`, …) on every subcommand. The
`POS/boolean-*-fires` cases red for any implementation that copies that table.

The subcommand set was measured the same way (`git <sub> --no-verify
zzz-no-such-ref`, control `--zzz-not-a-flag`) on **git 2.54.0 (Apple Git-157)**:
taken by `commit`, `push`, `merge`, `rebase`, `am`, `pull`; not taken by `tag`,
`stash`, `worktree`; **unmeasured** for `cherry-pick` and `revert`, where the
control read the same as the subject because those verbs resolve the revision
before reporting an unknown option — a non-discriminating row, recorded as
unanswered rather than as acceptance.

The line is then drawn on what the measurement **said**, and the two halves are
consistent rather than opposed:

- **measured NOT-TAKEN → QUIET.** `git tag --no-verify` and `git stash
  --no-verify` bypass nothing; git rejects the flag and the command fails on its
  own. Firing there is a false positive of exactly the class this suite exists to
  remove. An earlier revision fenced `tag` anyway, on the argument that some other
  git version might accept it — a version-skew claim with **no** measurement
  behind it, while `stash` got the opposite treatment from the identical probe
  and the identical verdict. That is two readings of one measurement, so the
  unsupported one was withdrawn. `POS/non-fenced-verb-tag-quiet` pins it.
- **UNMEASURED → FENCED.** For `cherry-pick` and `revert` acceptance is *unknown*,
  not known-negative, and an unknown resolves to the fail-closed side: over-listing
  costs one advisory on a command that fails anyway; omitting costs a silent hook
  bypass. These two are in the accepting set on that argument, **not** on a
  measurement, and the source comment says so at the point of declaration.

An unresolvable **verb** is a third case entirely and is handled in
`carriesNoVerifyFlag`, not by this set — see the `FC/*` poles.

## The historical measured mutation run

Run with a scratch harness (deliberately not named by path here — it is an
untracked session artefact, and a README citing a path that does not ship is a
phantom citation). Its method: mutate the hook **in place** (the hook's
`require("./lib/…")` calls resolve relative to its own directory, so a copy
elsewhere fails to load for a reason unrelated to the mutation), **prove the
mutated site executed** via a stderr sentinel *before* reading any result, run
this suite, then restore from a byte-for-byte backup and assert the restore.
Baseline before every mutation: `exit=0`, 0 reds.

| mutation                                             | reach  | red-set                                                                   |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| M1 restore the token-presence predicate              | proven | **11** — all 5 measured FPs, the JSON data-carrier, `TP/quoted-flag`, `POS/value-of-F`, `POS/after-double-dash`, both `POS/non-fenced-verb` |
| M2 `carriesNoVerifyFlag` always false                | proven | **suite exit 1, precondition red** (see below)                            |
| M3 drop the value-flag skip                          | proven | **2** — `POS/value-of-m`, `POS/value-of-F`                                |
| M4 copy posture-gate's table (**the bypass**)        | proven | **3** — all three `POS/boolean-*-fires`                                   |
| M5 drop the fail-closed unresolvable-verb tail       | proven | **1** — `FC/fused-git-token-fires`                                        |
| M6 drop the `--` stop                                | proven | **1** — `POS/after-double-dash-quiet`                                     |
| M7 drop the subcommand gate                          | proven | **2** — both `POS/non-fenced-verb-*-quiet` (measured before the `tag` pole was added) |
| M8 re-add `tag` to the accepting set                 | proven (by behaviour: the driving case is silent pristine and fires mutated) | **1** — `POS/non-fenced-verb-tag-quiet` |

Post-restore: hook byte-identical to pristine, suite `exit=0`, 0 reds.

**The battery mutates the hook IN PLACE, and that window is visible to anyone
else reading the tree.** While it ran, a reviewer sampling the suite saw
`33p/1f` on one run and 2 FAILs on another — `POS/non-fenced-verb-log-quiet` and
`POS/non-fenced-verb-stash-quiet`, which is precisely M7's red-set. Those were
readings of an applied mutation, not of a defect, and the differing counts are the
file changing between samples rather than flakiness. Anyone re-running this
harness should expect the same and should not commit from the tree while it is in
flight.

**M2 printed no per-case FAIL line, and that is not an empty red-set.** The first
revision of the harness counted `FAIL` lines only and reported `RED-SET (0):
EMPTY`, which would have read as a vacuous case set. The suite had in fact
hard-failed at `exit=1` on its anti-vacuity **precondition**, which aborts
*before* any per-case line is printed. So disabling the fence reds at the
earliest possible point, loudly. The harness was corrected to read the exit code
as part of the red-set; an instrument returning "EMPTY" for both "nothing broke"
and "everything broke" is not evidence.

**M3 first read NOT REACHED, and that was the harness's fault, not the
mutation's.** Revision 1 placed the sentinel inside the branch it was disabling
(`if (false) { write(SENTINEL) }`), so it could never execute. Moving it into the
loop body — which runs per argv token regardless — proved reach, and the red-set
is the two value-slot poles. Neither row needed a double mutation: in both cases
the *instrument* was blind, and that was shown rather than assumed.

## Severity

`halt-and-report`, unchanged. Moving the signal from lexical to structural (a
parsed argv slot) makes this lane block-*eligible* under
`hook-output-discipline.md` MUST-2; it is deliberately not escalated. The harm is
a skipped local hook, recoverable by re-running it, and this change's mandate was
precision, never new teeth. `SEV/fires-without-blocking` pins that.
