# git-invocation-scope

Regression lock for the **git-verb SCOPE** defect in
`hooks/lib/git-command-parse.js::parseGitInvocation` (loom#1594) — the parser
marked segments `unresolvable: "subcommand"` when they contained **no git token
at all**, and `"subcommand"` is the member of `UNRESOLVABLE_COMMAND_IDENTITY`
that every fail-closed lane ranks TIGHTEST.

Runner: `run.mjs` (37 cases, pure parse except ARM 5). **Not yet registered** in
`.claude/test-harness/ci-audit-fixtures.json` — the orchestrator owns that file
and must add the entry with `mode: run`, `min_cases: 37`. The floor rises WITH
the suite: `run-audit-fixtures.mjs` warns the anti-vacuity check goes INERT when
a floor drops, so a stale-low floor silently stops covering the cases it names.

## What it locks

| Surface                                                        | Where                                   |
| -------------------------------------------------------------- | --------------------------------------- |
| the `unresolvable` mark's git-evidence precondition (two sites) | `hooks/lib/git-command-parse.js`        |
| the `"command"` vs `"subcommand"` boundary                      | same file, `UNRESOLVABLE_COMMAND_IDENTITY` |
| the rendered halt-and-report the mark drives                    | `hooks/validate-bash-command.js`        |

## The defect, as measured before the fix

Probed directly through `parseGitInvocation`. The `NO-GIT-TOKEN` column is an
independent regex over the raw segment, so it is not the parser vouching for
itself:

```
subcommand | NO-GIT-TOKEN | sub=$(date)   | $(which foo) --bar $(date)
subcommand | NO-GIT-TOKEN | sub=$(date)   | "$PWD/x.js" $(date)
subcommand | NO-GIT-TOKEN | sub=$(cat f)  | "$PWD/.claude/hooks/auto-format.js" $(cat f)
subcommand | NO-GIT-TOKEN | sub=$(echo y) | command -v "$1" $(echo y)
subcommand | NO-GIT-TOKEN | sub=$(cat s)  | $(echo node) -e $(cat s)
```

Each drove a live halt-and-report through the real hook:

```
WHAT HAPPENED: Bash invoked git with a subcommand this hook cannot resolve:
               command -v "$1" $(echo y)
```

The class is not hypothetical. While building this suite, the command that ran
its own hook probe — `command node <script> "$PWD/.claude/hooks/..." "$PWD"` —
tripped the same fence. That segment is case `SILENT/self-referential-probe`.

**Controls that correctly marked `"subcommand"` before the fix and still do**
(these are what make the result a real gap rather than a parser that never
marks anything): `git $(echo status) --porcelain` and the fused `git$IFS clean`.

## The fix

`gitFound` records whether a literal/fused git token was actually seen. Two
return sites decided the mark without consulting it:

1. the `i >= toks.length` branch, gated only on `sawUnexpandable`;
2. the final precedence ladder, `toks[i].unexpandable ? "subcommand" : …`.

When no git token is found, the function only gets past its early `return null`
because the COMMAND NAME is opaque — so the word in the "subcommand slot" is the
second word of an UNKNOWN command, and calling it a hidden git VERB asserts
evidence that does not exist. The fix applies the disposition the file already
ratified for this state at its `UNRESOLVABLE_COMMAND_IDENTITY` declaration:
`"command"`, deliberately NOT a member of that set. Every shape where git IS
implicated — literal, path-qualified, backslash-escaped, fused `git$IFS` — keeps
`"subcommand"` unchanged.

## The measured mutation run

Each mutation was proven to REACH the code before its result was read, via a
`console.error` marker at the mutated line (`DP_REACH_A` / `DP_REACH_B`). The
markers were removed afterwards; `grep -c DP_REACH` over the module returns 0
(rc=1, no-match — the discriminating answer, not a missing file).

| Mutation                                                            | Reached? | Red-set |
| ------------------------------------------------------------------- | -------- | ------- |
| **A** — re-gate site 1: `if (commandSlotUnresolved && !sawUnexpandable)` | yes, 7 inputs | **3** |
| **B** — drop `&& !commandSlotUnresolved` from the ladder            | yes, 20 inputs | **8** |
| **A+B** — both, i.e. the exact pre-fix state                        | yes      | **11**  |

`8 + 3 = 11`, a disjoint union: the two sites are independently covered and
neither is absorbed by the other. **Every FIRING pole stayed green under all
three mutations** — the suite is not one that simply fires on everything.

### Mutation A initially produced an EMPTY red-set, and that is why ARM 1b exists

The first version of this suite went **34/34 green under Mutation A even though
the marker proved the mutation executed**. An empty red-set is not a vacuity
verdict (`instrument-discipline.md` MUST-5(b)), so it was resolved rather than
banked: the four inputs that reached site 1 all had `sawUnexpandable` false, so
the mutation was INERT for them. Every other case routed through the precedence
ladder instead — ARM 1 covered site 2 twice and site 1 not at all.

Reaching site 1 needs all three of: no git token, an opaque COMMAND NAME, and an
opaque construct consumed by the `-C`/`--work-tree` option loop so no verb token
remains. ARM 1b is those cases. Its paired firing pole is
`FIRING/no-verb-token-left` — the identical branch reached with a real git
token, which must keep marking `"subcommand"`.

## Bipolarity

A fixture set that only proved the guard went quiet would have proved the guard
was disabled, so the firing poles are the load-bearing half.

- **SILENT poles** assert the mark's exact VALUE (`"command"` / `"dir"` /
  no-invocation) — never "did not throw", and never merely "not subcommand",
  which a parser returning garbage would satisfy.
- **FIRING poles** assert `"subcommand"` survives for literal, backslashed,
  absolute- and relative-path-qualified, both fused `git$IFS` spellings, the
  verb-and-dir-both-opaque case, and the no-verb-token-left branch. Membership
  is tested through the **exported** `UNRESOLVABLE_COMMAND_IDENTITY` set rather
  than a local literal (`security.md` § Enforcement-Surface Parity), so removing
  `"subcommand"` from the set reds here instead of silently disarming consumers.
- **Anti-vacuity precondition**: the suite asserts `"subcommand"` IS in that set
  and `"command"` is NOT, before any pole is read. Without the first, every
  firing assertion would pass for the wrong reason; without the second, the
  "silent" poles would be asserting a mark that still halts.

## One recorded behaviour change beyond the five defect rows

`$(echo git) $(echo commit)` moves from `"subcommand"` to `"command"`
(`BOUNDARY/opaque-name-opaque-verb-is-command-not-subcommand`). This is recorded
rather than hidden. Pre-fix, `$(echo git) commit` marked `"command"` while
`$(echo git) $(echo commit)` marked `"subcommand"` — the same opaque command
name answered two different ways depending only on whether the verb happened to
be literal. It does **not** widen the accepted residual: `"command"` is already,
by the ratified boundary, a mark no consumer fences on, and the literal-verb
spelling has carried it since loom#1589.

## ARM 5 and machine load

ARM 5 drives the real hook because the parse mark is the MECHANISM and the
rendered halt-and-report is the HARM. It uses exactly three invocations, none on
a segment whose lane calls the working-tree status helper — that helper spawns
`git status` under a hard time budget and flaps under load, which would make the
arm non-deterministic for a reason unrelated to the behaviour under test. A hook
that fails to return is reported INDETERMINATE, never read as clean.
