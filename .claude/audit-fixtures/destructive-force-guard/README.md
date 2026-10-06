# destructive-force-guard

Regression lock for **loom s60, Orchestration Integrity component 4** — the
destructive `--force` hole at the Bash boundary — extended at **s67** with ARM 7,
the PATH-DANGER dimension (`classifyPathDanger`): the question
`assessTarget` does NOT answer; and again with **ARM 11**, shell redirections as
phantom deletion targets — `selectRmForce` called the shared `tokenize` but not
its redirection filter, so `rm -rf <path> >/dev/null 2>&1` reported THREE targets,
two of them plumbing that resolves to nothing.

Runner: `run.mjs` (67 cases). Registered `mode: run`, `min_cases: 67` in
`.claude/test-harness/ci-audit-fixtures.json`. The floor rises WITH the suite —
`run-audit-fixtures.mjs:221` warns the anti-vacuity check goes INERT when a floor
drops, so a stale-low floor silently stops covering the cases it names.

## What it locks

| Surface                                          | Where                                        |
| ------------------------------------------------ | -------------------------------------------- |
| `git worktree remove --force` / `-f` / `-fq`     | `hooks/lib/destructive-force-target.js`      |
| `rm -rf <path>` (short **and** long flags)       | same module (one predicate, not two lineages) |
| shell-grouping normalization `(…)` / `{ …; }`    | `hooks/lib/git-command-parse.js`              |
| the lane wiring + deferral ordering              | `hooks/validate-bash-command.js`              |

## The three defects, as measured before the fix

Driven against a synthetic sandbox carrying one modified tracked file and one
untracked file. `git reset --hard` / `git clean -fd` on the **same tree** exited
`2 BLOCK` throughout — the positive control proving the hook *could* speak about
that tree, so the silences below are real gaps and not an inert instrument
(`instrument-discipline.md` MUST-3(a)).

```
git worktree remove --force <dirty>            -> exit 0 SILENT
git worktree remove -f <dirty>                 -> exit 0 SILENT
git worktree remove -fq <dirty>                -> exit 0 SILENT
git worktree remove <dirty> --force            -> exit 0 SILENT
git status && git worktree remove --force <d>  -> exit 0 SILENT
bash -c "git worktree remove --force <dirty>"  -> exit 0 SILENT
rm -rf <dirty>                                 -> exit 0 SILENT
sudo rm -rf <dirty>                            -> exit 0 SILENT
rm --recursive --force <dirty>                 -> exit 2 BLOCK   (long flags only)
```

1. **`git worktree remove --force` reached no fence at all.** A bare
   `git worktree remove` REFUSES a dirty tree, and that refusal IS the safety
   mechanism (`worktree-isolation.md` Rule 8); `--force` exists to defeat it.
2. **`rm -rf` reached no fence either.** Only the LONG-flag spelling was
   matched, so the short form every operator actually types went through.
3. **Shell grouping disarmed the fences that DID ship.** `splitShellSegments`
   never treats `(`/`{` as separators, so a grouped command stayed one segment
   whose leading token was `(git` — unrecognised by `parseGitInvocation`:

```
git -C <dirty> reset --hard HEAD     (alone)   -> exit 2 BLOCK
(git -C <dirty> reset --hard HEAD)   (grouped) -> exit 0 SILENT
git -C <dirty> clean -fd             (alone)   -> exit 2 BLOCK
(git -C <dirty> clean -fd)           (grouped) -> exit 0 SILENT
{ git -C <dirty> reset --hard HEAD; }(grouped) -> exit 0 SILENT
```

One added keystroke disarmed a guard over work that has **no reflog**. Fixed in
the shared parse lib, not in one lane, per `security.md` § Enforcement-Surface
Parity.

## Severity: `halt-and-report`, not `block`

Whether a specific tree *should* be force-removed is the operator's judgment.
This fence makes the cost visible before the keystroke; it does not refuse work
the agent was instructed to perform (`hook-output-discipline.md` MUST NOT). It
differs from the `clean -f` fence, which blocks: there the operation is
unconditionally lossy, whereas here the operator may be discarding a tree they
deliberately finished with. The finding therefore **names the resolved target
path** and lists what would be destroyed, so the halt is actionable.

**Inherited residual, stated not papered over:** the rendered head reads "the
action ALREADY RAN", which is false for every finding this PreToolUse hook
emits. That mis-registration is pre-existing and documented at
`validate-bash-command.js`'s `withDeferred` (loom#1715 H-1); repairing it
repository-wide is a wider blast radius than this component carries.

## Two properties the cases are built around

**TARGET, never `HEAD`.** The fence assesses the command's OPERAND. A prior
instance swept `HEAD` while the command named another target and returned 18
bytes of silence while 11 unlanded artifacts were destroyed. `WT/target-not-cwd`
pins this: the operand names a DIRTY tree while the session cwd is a CLEAN one,
so a cwd- or HEAD-sweeping implementation reds.

**EMPTY is not DIRTY.** A `--no-checkout` worktree has no index, so
`git status --porcelain` reports a staged deletion for every path in HEAD:

```
tree            porcelain            ls-files  HEAD tree
wt-dirty        " M …" + "?? …"      1         1
wt-clean        (empty)              1         1
wt-nocheckout   "D  tracked.txt"     0         1
```

An empty index against a non-empty HEAD is the no-checkout signature; under it
the staged-deletion rows are phantoms and are NOT counted as work. The runner
asserts this signature as a **sandbox precondition** and refuses to report green
if it does not hold — otherwise `WT/nocheckout-empty-silent` would be vacuous.

## Fail open, loudly

Anything unassessable — an unresolvable path, a shell substitution, git failing
to answer — returns `INDETERMINATE` and is REPORTED as such, never as clean:
"I could not look" and "I looked and it was empty" are opposite meanings with
identical-looking output (`evidence-first-claims.md` MUST-3).

The converse is also enforced: git **answering** "not a repo" is a verdict, not
a failure to answer. Collapsing the two made `rm -rf /tmp/plain-dir` report
INDETERMINATE and halt. A fence that halts on every build-directory cleanup is
noise, and noise is how a guard gets switched off. `RM/non-repo-dir-silent` is
that anti-noise pole.

## Measured mutation run

Each predicate neutered in turn; the tree restored from a `cp` backup between
runs and re-verified green at the end (`instrument-discipline.md` MUST-2(b) —
a mutation must be shown to reach the code under test).

| Mutation                                            | Result       | Arm that red                     |
| ---------------------------------------------------- | ------------ | -------------------------------- |
| baseline (unmutated)                                | **38/38**    | —                                |
| `selectWorktreeRemoveForce` → always `null`         | **22/38**    | all WT + worktree EMB + GRP      |
| `selectRmForce` → always `null`                     | **30/38**    | all RM + rm EMB + GRP + DEFER    |
| `stripShellGroupDelimiters` → identity              | **31/38**    | all 7 GRP (incl. both parity locks) |
| `assessTarget` → always `CLEAN`                     | **14/38**    | every firing pole, both verbs    |
| restored                                            | **38/38**    | —                                |

Mutation 3 is the one worth reading twice: with the stripper neutered,
`GRP/subshell-reset-hard-still-blocks` and `GRP/subshell-clean-still-blocks`
return `exit 0` — i.e. the mutation reproduces the pre-existing bypass of two
ALREADY-SHIPPED fences, which is what those two parity locks exist to prevent
regressing.

## Nothing destructive ever runs

Every case drives the hook as a **decision function**: the candidate command
string is delivered on stdin as data and is never executed. The sandbox is a
fresh `mkdtemp` repo with three linked worktrees, removed with `fs.rmSync` at
the end.
