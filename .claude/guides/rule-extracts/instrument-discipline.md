# Instrument Discipline — Depth

On-demand depth for the `priority: 0` baseline rule `.claude/rules/instrument-discipline.md`. The rule body carries the operative test and the MUST clauses; this file carries the canonical-instrument table, the worked non-discriminating cases, the full BLOCKED corpus, and the cross-reference map. Receipt: `journal/0569`.

## The one operative test

> **Would this instrument produce a DIFFERENT result if the proposition were false?**

If not, it is not evidence — whatever it printed. The test is falsifiability applied to the measuring device rather than to the claim: an instrument whose output is fixed across both branches of the hypothesis has zero mutual information with the thing it is cited for.

The failure is not that such a check is _wrong_. It usually returns a true statement. The failure is that the true statement it returns is **the same statement it would have returned had the world been otherwise**, so reading an answer out of it is reading an answer out of noise.

## Canonical instruments for recurring questions

Each row pairs the question with an instrument that CAN return the other answer, and the improvised check that cannot. Sourced from `journal/0568` (five improvised orchestration checks, one root cause) plus the fixture-layer cases below.

| Question                         | Canonical instrument                                                             | Non-discriminating improvisation             | Why it cannot answer                                     |
| -------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| Is that lane still working?      | Its own progress signal (commit count, heartbeat, declared status)               | file mtimes                                  | identical for still-working and committed-and-finished   |
| Has the lane produced anything?  | `git log --oneline <base>..<head>` on the lane's branch                          | clean `git status`                           | empty for nothing-done AND for all-committed             |
| Did the review post?             | comment **body/marker** match on the PR                                          | comment **author**                           | constant — every comment is the same GitHub account      |
| Is CI green on this commit?      | `gh pr checks --json name,state` filtered to `state!="SUCCESS"`, head SHA pinned | `awk '{print $2}'` over `gh pr checks` text  | splits on spaces → returns a word from the check NAME    |
| Is baseline headroom clear?      | `emit.mjs --all --dry-run` → per-CLI `headroom_pct`                              | `emit.mjs --all` read as covering every lane | `--all` = all CLIs at **base lang only**; blind per-lang |
| Is path-scoped injection clear?  | `check-rule-injection-budget.mjs` (snapshot + 5% tolerance)                      | the baseline/per-language guard              | blind to path-scoped injection **by construction**       |
| Does this test cover behavior X? | a mutation **shown to execute**, then observed to red                            | the suite being green                        | green is identical whether X is asserted or unasserted   |
| Is this artifact reachable?      | the loader's own glob evaluated against the real path                            | "the rule mentions that surface"             | mention is not load; `paths:` decides                    |
| Did that runner succeed?         | the runner's OWN status — `${PIPESTATUS[0]}`, or invoke it un-piped un-wrapped  | `$?` after a pipeline, or a wrapper's exit   | a pipeline's `$?` is the LAST stage's; a wrapper exits 0 whether or not the runner did |
| Is CI green, or did nothing run? | the check ROWS, or the failing count **beside the total**                       | `select(.state!="SUCCESS") \| length`         | `0` reads identically for all-green and for zero-checks-ran |
| Is this worktree's base current? | `git rev-list --left-right --count refs/heads/<r>...refs/remotes/origin/<r>`     | that the `worktree add` succeeded            | it succeeds identically from a current ref and a 182-behind one |

**Three of these rows have a STRUCTURAL fence; the rest are review-layer only — do not read the table as uniformly enforced.** The `--lang` row is fenced at the tool (`emit.mjs` now exits 2 on a `--lang` that names no DECLARED lane — `emit.mjs::EMIT_LANGS`, not the contents of `.claude/variants/` on disk, which is neither necessary nor sufficient — closing the unquoted-empty-variable form that silently shifts the run to the base lane). The worktree row is fenced at the Bash boundary (`violation-patterns.js::detectWorktreeStaleBaseRef`, halt-and-report, `worktree-orchestration.md` Rule 7 § Structural enforcement). Both were adjudicated hook/rule/skill in loom#1501 (L4) and land where the discriminating signal actually exists — the `--lang` one at the tool rather than in a hook, because a `PreToolUse` hook reads `tool_input.command` PRE-EXPANSION and so cannot tell a set variable from an empty one (`hook-output-discipline.md` MUST-3 requires it to SKIP the operand rather than guess).

The **runner-exit** and **denominatorless-count** rows were adjudicated in the same pass and are DELIBERATELY NOT hooks. For the runner-exit row, each Bash call is a fresh shell (so a cross-call `$?` reads nothing) and the recorded failure was a wrapper SCRIPT's exit 0 masking its runner's exit 1 — invisible at the tool boundary entirely. For the count row, the same command is correct when the total is also fetched, so a command-shape match does not discriminate on the proposition that matters (whether a `0` is about to be READ as green) — that reading happens in prose, not in argv. Both stay review-layer, which is what these rows are for.

**The budget row is the live example.** `check-rule-injection-budget.mjs` prints `✓ within budget` while individual profiles show byte counts above their stated budget — because "budget" there is a **snapshot with a 5% tolerance ceiling**, not an absolute cap. Reading its `✓` as clearance for a _baseline-emission_ question is the archetype: its verdict cannot change when baseline headroom moves, so it carries no information about baseline headroom. Rule-10 compliance is judged on `emit.mjs`'s `headroom_pct`; the injection guard is reported as a regression check on the surface it does cover. Two instruments, two questions — neither substitutes for the other.

## The shell reports the LAST stage, not the one you meant

`$?` after a pipeline is the exit status of its FINAL command. So `cmd | tail -3` followed by
`echo "EXIT=$?"` reports **tail's** status — which is 0 essentially always, including when `cmd`
exited non-zero. The printed `EXIT=0` is then a measurement of nothing, and it reads exactly like
a passing gate.

This is the MUST-1 failure in its cheapest form: the instrument's output is CONSTANT across the
hypothesis. A gate that failed and a gate that passed both print `EXIT=0`.

```bash
# DO — capture the real status, or let the command's own output be the signal
cmd >/tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "EXIT=$rc"
set -o pipefail; cmd | tail -3; echo "EXIT=$?"      # or: pipefail makes the pipe report the failure
# DO NOT — read $? through a pipe and call it the gate's verdict
cmd | tail -3; echo "EXIT=$?"                        # tail's status; 0 even when cmd failed
```

**BLOCKED rationalizations:** "the command clearly failed, the exit code is a formality" / "I only
piped it to trim the output" / "it printed EXIT=0 so the gate passed" / "pipefail is shell trivia".

**Why:** the whole point of reading an exit code is to get a verdict the prose output might not
make obvious; routing it through a pipe converts the verdict into a constant and hands back a
confident `0`. When this fires, the FAIL lines are usually sitting in the output that was just
printed — which is why it survives review: the evidence contradicting the reported verdict is
visible in the same block. Observed twice in one session (2026-08-02), both times on a
distribution gate, both times with the real `FAIL` rows on screen beneath the false `EXIT=0`.

## The fixture layer — a passing test is an instrument

`probe-driven-verification.md` blocks the bag-of-words probe. One layer down sits the same defect wearing a lab coat: **the test itself**.

A green test asserts a proposition about the behavior it names. It is evidence for that proposition only if it would have RED in that behavior's absence. Until that is shown, "the tests pass" is a statement about the test runner, not about the system.

```bash
# DO — establish the red first; the green then carries information
git stash                       # remove the fix
pytest -k revocation            # MUST fail — proves the test binds to the behavior
git stash pop
pytest -k revocation            # now the green means something

# DO NOT — cite the green alone
pytest -q    # "412 passed" — silent on whether ANY would fail if the behavior vanished
```

### The mutation trap — two hypotheses, not a verdict

Mutation testing is the standard remedy for the above. It has its own non-discriminating mode, and it is subtle enough that it caught this corpus: a session recorded two mutations that "looked like a vacuous test" and both were **INERT** (`3a0dede7`).

When a mutation does NOT red the test, exactly two hypotheses remain live:

1. The test is vacuous (it never asserted the behavior), OR
2. The mutation was inert — unreachable, shadowed by a later write, optimized out, on a different code path than the test exercises, or in a file the test binary did not rebuild.

**The green cannot separate them.** Recording "test proven vacuous" is therefore a verdict drawn from an instrument that cannot distinguish the answers — the exact prohibition of MUST-1, now producing _false accusations against working tests_, which is worse than the silence it replaced.

```bash
# DO — prove the mutation executes before reading its result
<apply mutation>
<insert an unmistakable execution marker at the mutated line: panic!/abort()/log>
<run the test>            # marker fires ⇒ mutation is live ⇒ the green is now readable
<remove marker; read the real result>

# DO NOT — read a non-reddening mutation as a verdict
<apply mutation>; <run test>    # still green → "the test is vacuous"
#                                 ← equally consistent with an INERT mutation
```

**Cheap execution markers, by ecosystem:** Rust `panic!("MUTATION REACHED")` / Python `raise AssertionError("MUTATION REACHED")` / JS `throw new Error("MUTATION REACHED")` / any language: `process::abort()`. If the marker does NOT fire, the mutation never ran and the experiment produced nothing — re-site the mutation; do not record a result.

## BLOCKED corpus

**MUST-1 — citing a check with no nameable falsifying result:**

- "the command ran clean"
- "it exited 0"
- "the number looked right"
- "that's how we always check it"
- "it's a sanity check, not proof"
- "the output was non-empty, so it found something"
- "I eyeballed it and it matched"
- "the tool would have errored if it were wrong"

**MUST-2(a) — citing a green as verification:**

- "the suite is green"
- "CI passed"
- "coverage is high"
- "the test is named for that behavior"
- "it would have failed if it were broken"
- "there's a test for that"
- "the assertion count went up"

**MUST-2(b) — reading a non-reddening mutation as a verdict:**

- "I changed the code and nothing failed"
- "the mutation was obviously reachable"
- "close enough to a mutation test"
- "the test must be vacuous then"
- "I deleted the whole function body and it still passed" (a build that did not recompile produces exactly this)

## Distinct from / cross-references

- **Generalizes `probe-driven-verification.md`.** That rule owns the PROBE shape and is authoritative on test-authoring surfaces. Its `paths:` are `**/test-harness/**`, `**/audit-fixtures/**`, `.claude/hooks/**`, `tests/**`, `**/*test*`, `**/*spec*`, `**/04-validate/**`, `**/suites/**` — **none** of which match `.claude/rules/**`, `.claude/commands/**`, `.claude/agents/**`, or `.claude/skills/**`. It therefore does not load while artifacts are being authored, and its own body states the orchestration surfaces are deliberately excluded ("Do not read the table's presence as coverage"). That measured reachability gap is why `instrument-discipline.md` is baseline rather than path-scoped: the failure fires when composing ANY check, which is not a path-shaped surface.
- **Same epistemic family as `evidence-first-claims.md` MUST-3** (an errored/empty command is zero evidence). That governs a command that did NOT RUN; this governs one that ran and could not have said anything else. Both refuse to let absence-of-signal masquerade as confirmation.
- **Supplies the test `user-flow-validation.md` MUST-1 applies** ("passing tests are necessary but insufficient") and that `verify-resource-existence.md` MUST-4 applies to convergence receipts.
- **Complements `orphan-detection.md`.** A mechanical sweep is a discriminating instrument for the question "is this symbol referenced?" — it is the positive example of the pattern, and the reason `agents.md` mandates mechanical sweeps in reviewer prompts.

## Applying this to review itself

Gate-review of this rule is a human reading prose for whether a check discriminates — which is itself an instrument, and owes the same question. The honest answer today is that Phase-1 coverage is judgment, not measurement; the probe set that would make it measurable is the declared, expiring deferral recorded in `journal/0569`. That limitation is stated rather than papered over, because the alternative — asserting the review discriminates without being able to name what would falsify it — is the failure this file exists to name.

## Why this rule is baseline — and why the reachability argument for it is BLOCKED

The scope argument is a CONTENT argument, not a reach argument. It is recorded here at length
because the reach version is seductive, was in fact written first, and is an instance of the very
class this rule blocks.

**The argument that holds.** No already-loaded rule carries this obligation.
`evidence-first-claims.md` is `priority: 0` — always loaded — and its MUST-4 governs claim
GRAMMAR: how a conclusion is stated once reached ("I see X" is a fact; "this suggests Y" is an
inference and must be marked as one). This rule governs instrument SELECTION: whether the check
could have produced a different result at all. Those are different obligations at different
moments. Six of the eight originating instances had `evidence-first-claims.md` in context and
violated nothing in it — each claim was reported accurately, and the instrument was incapable.
A selection-time obligation has to be in context when a check is composed, and "composing a
check" is not a path-shaped surface: it happens while editing rules, commands, agents, skills,
hooks, tests, and probes alike.

**The argument that does NOT hold, and must not be revived.** It is TRUE that
`probe-driven-verification.md` — which owns instrument validity — carries `paths:` globs that
match none of `.claude/rules/**`, `commands/**`, `agents/**`, or `skills/**`. It is tempting to
conclude "therefore the rule governing measurement-validity never loads while you work on
artifacts, therefore this rule must be baseline." That inference is unsound, and loom already
refuted it in this rule's own branch history. Commit `93e47705` reverted a `paths:` widening on
exactly this ground:

> "`evidence-first-claims.md` is `priority: 0` / `scope: baseline`, so it was always loaded and
> its MUST-4 already covers stating an inference as fact… Both rules were in context when the
> checks were authored. **Nothing was unreachable, so widening bought no coverage.**"

Reading one rule's globs cannot distinguish **"no governing rule was loaded"** from **"a
different governing rule was loaded."** Those are the two hypotheses that matter, and the grep
returns the same answer under both — which is precisely MUST-1's definition of an instrument
that is not evidence. The check was real, the reading was careful, and the conclusion was
unsupported.

**Why this is recorded rather than quietly deleted.** The rule's first draft justified its own
existence with an instrument that could not discriminate. That is not an embarrassment to bury;
it is the strongest available evidence that the class is hard to see from the inside, including
for an author who has just finished writing the rule against it. If a future edit re-introduces
the reachability framing — it reads well, and it is nearly true — this section is the receipt
showing it was considered and refuted on evidence.

## MUST-4 — depth

MUST-4 landed 2026-08-11 via `/sync-from-use` Gate-1 placement of a DOWNSTREAM-relayed upflow
entry. Provenance is **hop-level only** (`origin: downstream`, relayed through a USE template): the
originating consumer is deliberately not identified, and no consumer name, workspace id, internal
path, finding tag, or session identifier is carried into the cascading copy, per
`upstream-issue-hygiene.md` MUST-2 + `knowledge-cascade-routing.md` MUST-3. Classified **GLOBAL on
both axes** — the clause references no language runtime and no CLI-native primitive, so neither a
py/rs overlay nor a per-CLI overlay is warranted.

### Why MUST-4 is standalone rather than a MUST-3(b) extension

The relaying entry deliberately left this open for Gate-1. It was resolved standalone:

- MUST-3(b) governs how a **firing** instrument's output is READ — hits versus tally, and what a
  count counts. Its trigger is "you have a result in hand".
- MUST-4 governs the **re-use** of an already-sound instrument against a SECOND proposition. Its
  trigger is "you are about to ask this thing a different question", which fires at a different
  moment, before any result exists.
- Folding the second into the first would bury that trigger under a clause a reader consults only
  once they are already reading output.

The portion of the offer that genuinely DOES overlap MUST-3(b) — count-semantics, where the unit a
number counts is not the unit the reader assumes — is left there rather than restated, which is why
MUST-4's body carries the producer-semantics corollary but no second tally example.

### Originating evidence (generic)

One session published, then retracted, two recommendations produced by this single pattern, plus two
same-class near-misses caught before publication. Both retracted claims had survived a "does this
check discriminate?" self-review — because for the question each instrument was built for, it did.
That is the property that makes the class hard to see from the inside: the self-review asks the right
question against the wrong proposition.

### Worked cases

**A simulator read past its scope.** A tool built to PARTITION open PRs into groups with disjoint
changed-file sets was cited for "these PRs do not conflict". Disjoint file sets are neither necessary
nor sufficient for absence of conflict — a rename or a delete conflicts across disjoint sets — and the
simulator never opens a diff or a merge base, so no output it could produce would show a conflict.
The conflict question needs its own instrument (`git merge-tree` marker count), with its own named
falsifying result.

**A field read under the reader's meaning.** A CI job's `labels` array records the labels the job
REQUESTED for runner matching, not the architecture of the host that served it. Read for "did this
run on arm64 hardware?", it returns "arm64" under both branches of the hypothesis. The producer fixes
the semantics; the reader's question does not.

### The sibling clause this ordering unblocks

A second relayed entry, evaluated in the SAME pass, proposes that a gate's self-test pin THREE
outcomes — holds, does not hold, and CANNOT-MEASURE — and that a gate depending on an external
oracle prove that oracle's capability before scoring. Both entries claimed the same free MUST slot,
which is the numbering collision the second names explicitly. Landing MUST-4 standalone here fixes
the ordering deliberately: the sibling lands as **MUST-5**, unambiguously. It is NOT yet placed —
see the Gate-1 placement PR for the lane-headroom measurement that deferred it.
