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

**This one now has teeth.** Recurring three more times on 2026-09-06 (two in a single lane) bought
it a structural detector: `hooks/lib/violation-patterns.js::detectExitCodeLaundering`, fired from
`detect-violations.js`'s **`PostToolUse`** Bash matcher, which parses the command into pipeline
stages and flags a pipeline whose FIRST stage invokes a VERDICT command and whose LAST stage is
status-opaque. An earlier revision of this paragraph said `PreToolUse`; that was FALSE when
written and is corrected rather than left, because a reader checking the wrong event finds nothing
and reads the silence as "no detector". MEASURED on `settings.json`: the only `PreToolUse`
registration of that hook carries matcher `Read`, which never carries a Bash command; the Bash
branch is `PostToolUse`, and the dispatch site says so in its own comment. Widened 2026-09-11 after
the recogniser was measured SILENT on three of four instances from one day — `gh pr checks | head`,
`pytest | tail`, `cargo test | head` all walked through a set scoped to this repo's own gate
scripts. The verdict set is now a CLOSED table matched at argv position (repo gates, `node --test`,
test runners, linters/typecheckers, `cargo`/`go`/`npm` subcommand paths, `gh pr checks`, and
`git diff` only with `--exit-code`/`--quiet`), and the sink set is the status-opaque family
(`head`/`tail`/`wc`/`cut`/`tee`/`sort`/`sed`/… ) rather than `head`/`tail` alone. `grep`, `jq`,
`awk`, `diff` and `xargs` are deliberately EXCLUDED as sinks — each has a meaningful status of its
own — and `make` is excluded as a verdict, because `make -n | head` is a dry-run listing nobody
reads a status from and the parse cannot tell it from `make test`. It is `halt-and-report`, NOT
`block`: the pipeline shape is structural and so
`hook-output-discipline.md` MUST-2 leaves `block` available, but the shape is only NECESSARY —
the violation completes when the laundered status is READ as a verdict, which is not observable at
tool-call time, and blocking would refuse a legitimate `| head -50` issued merely to look at
output. It stays silent on `pipefail`/`PIPESTATUS`, on a first stage that is not a gate, and on a
last stage that propagates a real status. Bipolar fixtures:
`.claude/audit-fixtures/violation-patterns/detectExitCodeLaundering/`; executing suite:
`.claude/test-harness/tests/exit-code-laundering.test.mjs`.

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

## The harness you built to test the instrument is itself an instrument

When a check cannot be run against the real tree — because the tree is protected, because the
change is not applied yet, because you need a mutated copy — the usual move is to construct a
harness: a mirror directory, a symlink farm, a temp tree, a copy of one file. **That harness is an
untested instrument, and MUST-3 applies to it before any result read through it is evidence.**

The step, in order, every time:

> **Run the UNMODIFIED baseline inside your constructed harness and confirm it reproduces a
> verdict you ALREADY KNOW from the real tree. Only then read anything else the harness tells you.**

If the baseline does not reproduce, you have measured your harness, not your change — and every
subsequent result is uninterpretable. Stop and fix the harness.

```bash
# DO — the known-answer run comes first, and its verdict is compared to the real tree's
cp -R "$REPO/.claude/bin" "$H/.claude/bin"
node "$H/.claude/bin/<gate>.mjs" > /tmp/base.txt 2>&1; echo "harness_baseline=$?"   # must match the real-tree verdict
<only now: apply the change / mutation and re-run>
# DO NOT — construct the harness and read the first result as a finding
<build mirror>; <run modified gate>   # 0 findings → "pre-existing defect"  ← measured the harness
```

**The recurring shape: a mirror that is structurally different from what the code inspects.** A
symlinked directory entry is not a file, so a walker testing `isFile()` — `measureTree` is the
local instance — silently reports an EMPTY surface for a symlink-mirrored tree. The whole `bin`
surface reads as absent, exit 0, no error. Three separate agents hit this in one session
(2026-09-06) and all three read it as a PRE-EXISTING defect in the code under test rather than as
a property of the harness they had just built. The tell was available and cheap in every case: the
unmodified baseline would have reported the same empty surface, which the real tree does not.

**Two more instances from the session that authored this section**, both caught only by the
known-answer step:

- A mutant copy of a scanner was placed at the scratch root instead of at `<harness>/.claude/bin/`,
  so its `REPO_ROOT` — derived from `import.meta.url` — resolved elsewhere and it scanned **zero
  files**, exiting 0 with an empty result. Read naively that is "the mutation changed nothing,
  therefore the mutation is inert" — an empty red-set banked as a vacuity verdict, the exact
  MUST-5(b) failure two sections above. The mutated file's own reach marker never printed, which
  is what exposed it.
- A patched `violation-patterns.js` was copied to a bare directory without its sibling modules, so
  `require` threw `MODULE_NOT_FOUND` before the detector was ever reached. That one is benign only
  because it errors loudly; the previous one does not.

**Cheap fidelity controls, in rough order of strength.** Prefer a verdict; fall back to a surface
count; never settle for "the command ran".

| Control | What it catches |
| --- | --- |
| Unmodified baseline reproduces the real tree's **verdict** | everything below, and semantics too |
| Harness **surface count** equals the real tree's (`find … \| wc -l`, files scanned) | empty/partial mirrors, the `isFile()` symlink class |
| The symbol under test is **absent** from the baseline and present after the patch | patched the wrong copy |
| A **reach marker** at the mutated line prints | the mutation never executed |

Use `cp -R`, not a symlink farm, whenever the code under test walks the tree — the copy costs
seconds and removes the entire class.

**BLOCKED rationalizations:** "the mirror is just a copy, it behaves the same" / "the gate ran and
exited 0" / "0 findings means my change fixed it" / "this must be a pre-existing defect" / "the
mutation didn't change anything, so it's inert" / "building a control for a directory copy is
ceremony" / "symlinks are transparent to everything that matters".

**Why:** a constructed harness fails SILENTLY and in the reassuring direction — an empty surface,
a clean exit, zero findings — so its failure is byte-identical to the good news you were hoping
for. The known-answer run is the only step that separates them, and it costs one command.

## The subject test — a measurement describes an ARTIFACT, and it must be the one under test

Every other clause in this file asks whether the instrument could have said something else, or said
it about a different question. This one asks a smaller question that the others structurally miss:

> **What artifact does this number describe? Name it — and show it is the one under test.**

**The instrument WORKED.** It ran, it exited, it printed a plausible value — and the value
described an artifact other than the subject. That is what makes the class hard: the same exit code,
the same shape of number, often a magnitude that matches expectation, so **nothing in the output
distinguishes the two cases**. Every form below was caught by a human or an agent asking what the
number was actually ABOUT. Not one was caught by a tool.

**Four axes, four clauses — do NOT fold them together.** MUST-4 governs the QUESTION (soundness for
A read as a verdict for B); `evidence-first-claims.md` MUST-6 governs the CLASS (an instrument
blind to the class under review); this rule's MUST-6 governs TIME (a figure that outlived its
subject's state); **this section governs SUBJECT IDENTITY** — the right question, asked of the
wrong artifact. The remedies differ, which is the practical reason to keep them apart:
re-instrument · establish scope · re-derive · **pin the subject**.

### The forms it has taken, measured

- **The instrument materialised the wrong TREE.** `buildClientTemplateTree()` materializes from
  `git archive HEAD`, so every projection residual reported in one session (431, 34, 51) described
  the **COMMITTED tip** and was structurally blind to the uncommitted work that **was** the
  deliverable. A figure was then hand-adjusted by subtracting four findings — arithmetic over a
  number that was about something else. The remedy named there is the one here: materialize the
  REAL tree, then re-derive. (The operator's session notes, 2026-09-30.)
- **…and its second form, worse.** The first fix overlaid *modified tracked files* — still blind to
  **(a) untracked new files, (b) deletions, (c) renames** — and so returned **a clean verdict about
  a file it never opened**, the most dangerous output an instrument can produce
  (`conservation-gate.md` MUST-3 requires naming the blind classes).
- **A verification that passed its own class.** `c391e3ca2` moved a `slot:examples` body out of
  `.claude/rules/agents.md` into its paired extract and deleted the CLOSER with the content; the
  file read three openers to two closers and the repo's own instrument red (`check-xref-post-overlay.mjs`,
  exit 3 INCOMPLETE). The author's check had diffed **obligation tokens** — every removed line really
  was a cross-reference or a census line, **true as stated** — while the defect was in **slot
  markers**, a class it could not see. The corpus had already learned this once (`9121b361c`). **A
  check that passes its own class is not evidence about a different class.**
- **A truncated enumeration read as a total.** A sweep reported **8** `COC_OPERATOR_KEY_PATH` sites
  where there are **9**; the miss was the reporter's own `| head -8` cut, and the tally was published
  as the census ((loom-internal reference)). The
  instrument was sound and the number described a **prefix of the file**.
- **The probe selected by its LABEL.** A contrast harness picked its probe file by
  substring-matching its own **label** (the label said `gains`, the probe said `gained`) and so
  printed **PASS for a pole that had actually FAILED** — a 1/3 contrast reported as 3/3.
  *"A label is prose; the probe is the measurement."*
- **The fixture that measured the caller's environment.** A fixture runner's env-key allowlist
  omitted the session-id variables, so its spread of `process.env` **leaked the ambient session id
  into the child**, and the suite's green depended on who ran it. Measured A/B, one host, one tree,
  one commit, variable exported versus unset: **darwin 53p/1f WITH vs 54p/0f WITHOUT** (Linux
  51p/1f vs 52p/0f). The suite was RED exactly where the guard runs. (`fd62c1283`.)
- **A green suite over live bypasses.** A guard's suite read **71/0** while the guard's bypasses were
  demonstrably live — three consecutive rounds of it — and the handover's instruction is explicit:
  *"Do not land on the green; land on the reform."*
- **An A/B whose arms shared the instrument.** Two arms run on the SAME host cannot separate
  "pre-existing" from "host-sensitive": the same 12 failures were produced by one host that had
  returned the same suite green earlier that day. And an A/B whose arms share the CODE under test
  cannot separate code-caused from content-caused effects — a regression laundered into a baseline
  by the instrument rather than by the analyst.

```bash
# DO — pin the subject, and print the pin INSIDE the run whose result you will cite
node -e 'const c=require("crypto"),f=require("fs");/* hash every file the verdict READS */' <files>
git hash-object <artifact>      # the same hash before AND after: mutant and subject are one object
pwd -P                          # which TREE this ran in — the footer is not always there to say
# DO NOT — cite a number whose subject was never named
"the suite is green"            # green over a copy from HEAD, over a leaked env, over a truncated list
"8 sites"                       # the number is real and describes the first 8 lines
```

**BLOCKED rationalizations:** "the tool ran and printed a number" / "the count is plausible for the
artifact I meant" / "it's the same file name" / "the path is right, so the bytes are right" / "the
mutant is a copy of the file under test, close enough" / "the same command worked last time" / "the
label says what it measures" / "the harness is a copy, it behaves the same" / "the fixture is close
enough" / "the environment doesn't matter for this assertion" / "I read the output and it looked
right" / "the file is still there, so nothing was lost".

**Why:** a measurement of the wrong artifact is INDISTINGUISHABLE at read time from a measurement of
the right one — same exit code, same shape, often the expected magnitude — so no amount of care in
reading the output can separate them, and only naming and pinning the subject can.

**Binding.** This section is DEPTH for the rule above (no new clause is claimed, so no new
per-clause Wiring block or probe pair is owed — the wiring file's own contract is that it restates
clauses that live in the rule). The promotion gate — a clause is owed once the emission lanes are
back above their floors — is recorded at `journal/0642`.

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
which is the numbering collision the second names explicitly. Landing MUST-4 standalone here fixed
the ordering deliberately, and at the time this paragraph was written the sibling was expected to
land as **MUST-5**. **That is no longer true and the sentence is corrected rather than left to
mislead:** the MUST-5 slot was taken on 2026-09-01 by the mutate-the-behaviour-change clause. The
relayed sibling is STILL NOT PLACED and takes the next free slot when it lands — see the Gate-1
placement PR for the lane-headroom measurement that deferred it.


## MUST-3 — the illustration enumeration, extracted

MUST-3's `**Why:**` used to enumerate three ways a sound check is physically unable to emit its
falsifying result HERE. The claim is the rule's; the examples are depth, and live here:

- **An unimplemented regex dialect.** The pattern is valid PCRE and the local `grep`/`ugrep` build
  never implements that construct, so it matches nothing and says nothing about why.
- **A shell that will not word-split.** The loop is correct and the array never expands, so the
  body runs zero times and exits 0.
- **A case-insensitive filesystem.** `git ls-files --error-unmatch <WRONGCASE>` errors identically
  to "untracked", and `ls` / `head` corroborate the wrong reading.

## MUST-5 — depth

### The parent evidence, measured

Three separate behaviour changes on ONE branch each left their fixture suite fully green — 95/95,
then 99/99, then 99/99 — until cases were written specifically for them. A fourth was surfaced by
the final review round at 193/193. Every one of the four was caught by MUTATION. None was caught by
reading the diff against the case list, and the case lists were read each time.

The mechanism is not carelessness. A case is written against the behaviour that existed when it was
written. New behaviour is therefore un-covered BY DEFAULT, and the suite is green for exactly that
reason — the green measures the age of the case set, not the coverage of the change. That is why the
green is not weak evidence but ZERO evidence, and why MUST-5 states the suite's green across a real
behaviour change IS the finding rather than a reassurance to be weighed.

### Why an OBLIGATION clause rather than an extension of MUST-2

MUST-2 governs how a mutation is READ once you have run one. It carries no requirement to run one.
The three green suites walked through exactly that gap: nothing in the corpus said "you must mutate
this", so nothing was mutated, so MUST-2 never became reachable. MUST-5 is the obligation half;
MUST-2(b) was shortened to delegate the resolution here rather than state it twice.

### (a) The reach proof, and the failure it is written from

One mutation in the parent session reported 3 reds before and 3 reds after. Read naively that is an
inert mutation — a clean, plausible, WRONG reading. The replacement text still contained the token
the cases matched, so the mutation had not changed what any case saw. Nothing about the result
distinguished "this code is redundantly defended" from "I did not actually mutate anything", which
is MUST-1's test applied to the mutation itself. Hence: show the mutation REACHED the code before
reading its result, never after.

### (b) The double mutation, and why an empty red-set is not a vacuity verdict

Several mutations in the same session were genuinely inert: a defense-in-depth SIBLING absorbed
them, so the observable behaviour never moved and no case could red. An empty red-set is therefore
consistent with two live hypotheses at once — the cases are vacuous, OR the mutation was absorbed —
and picking either is a guess wearing the grammar of a verdict.

The resolution is a DOUBLE mutation: drop the sibling as well. If the pair reds, the sibling was the
absorber and the cases were never vacuous. If the pair still does not red, the vacuity hypothesis
survives its first real test. The runner headers on this branch record both shapes explicitly —
`M-H2` reddened NOTHING and is annotated "NOT A VACUITY VERDICT", with `M-H2b` dropping both prose
mentions and reddening case 140.

### BLOCKED corpus — MUST-5

- "the suite is green"
- "it's a small change"
- "the existing cases cover it"
- "I'll add a test if it breaks"
- "the change is obviously covered by what's already there"
- "the mutation didn't red, so the test is vacuous"
- "writing a case for it now is teaching to the test"
- "the review round will catch it"
- "I read the diff and the cases, they line up"
- "the behaviour didn't really change, it was a refactor"
- "mutating it would take longer than the change did"

### Rule-10 budget disposition — measured, and PARTIAL

Recorded here because a Rule-10 shortfall stated only in a lane report is a shortfall nobody
inherits. At authoring time both BASE lanes sat at 11.82% headroom, inside the 15% proximity band,
so Rule 10 fired. MUST-5's abridged emission cost is **826 B**. Paired extraction within the SAME
rule recovered **532 B** across six edits — MUST-2(b) shortened to delegate the resolution here;
MUST-2's heading corrected once its second half moved; MUST-2's `**Why:**` reduced to the claim that
survives now that (b) is delegated; MUST-3's illustration enumeration extracted to the section
above; and the H1 depth pointer rewritten into the whole-line form `abridgeV6` recognises and
strips. Net **+294 B** on the rule's abridged emission (3418 B → 3712 B).

**Lane effect, measured on both CLIs, both lanes.** BASE codex/gemini 11.82% → **11.37%** (floor
10%). The `rs` lane is the binding one and it went 9.12% → **8.67%** against an **8.5%** floor that
is itself a declared, EXPIRING exception (`sync-manifest.yaml`, issue #1355, expires 2026-10-31;
on expiry the lane reverts to a 10% floor it ALREADY fails at 9.12%). **That waiver is SUPERSEDED**
— #1355's 8.5% rs floor was replaced 2026-08-30 by the #2018 6.2% grant expiring 2026-11-24, and
#1355's separate PER-RULE `security.md` ceiling was retired 2026-09-02. The measurement above is
kept as the clause-landing history; the floor it is scored against is not current, so re-derive
from `emit.mjs --cli codex --lang rs --dry-run` rather than quoting the 8.5%/2026-10-31 pair. An intermediate draft of this
clause put that lane at 8.31% — a hard `headroom-floor BLOCK`, 123 B under — which is how the
binding constraint was found; it was measured, not predicted, and the clause was cut to fit.

The residual shortfall is the finding, not an accounting nuisance. This rule's emitted surface is
now MUST clauses and `**Why:**` lines with no extractable depth left, so path (a) cannot be fully
satisfied from inside it at any future addition either — and the `rs` lane is living on a waiver
that expires. That pair is the cumulative-pattern signal `rule-authoring.md` Rule 11 exists to
catch, and the disposition it names is corpus-level (demote a baseline rule to path-scoped, split,
or change the per-CLI emission strategy), not addition-local.

**The +294 B residual is covered by path (b), not left uncovered.** `check-baseline-delta.mjs` is
the accounting half of Rule 10, and it scans THREE exception sources: commit bodies in the proposal
range, lines ADDED to `journal/`, and `--pr-body`. The declaration therefore ships in this change's
commit body as `Rule-10-exception: instrument-discipline.md` followed by all five mandatory
sub-fields from `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md`.

An earlier revision of this section asserted that path (b) was unavailable because its named
rationale "lives in a receipt journal the authoring lane did not own." **That was FALSE and is
withdrawn**, not softened: the gate's own `--help` names commit bodies as the first source scanned,
so the claim was refutable by reading the instrument that enforces it — which is this rule's own
MUST-3(a) failure, committed inside the rule it was written into. It is recorded here rather than
quietly deleted because the corpus treats a withdrawn claim as evidence, not as embarrassment.

### AMENDED 2026-09-01 — re-measured on the merged branch

The numbers above are the clause-LANDING measurement. They are kept as history and are NO LONGER
current, because the branch that carried MUST-5 to `main` also carried a `git.md` clause, and the
`rs` lane went RED at **7.54%** — 627 B under the 8.5% waiver floor THEN IN FORCE.
**That floor is SUPERSEDED, and the RED verdict does not survive it:** the live rs floor is
#2018's 6.2% (expires 2026-11-24), and 7.54% is ABOVE 6.2%, so the same measurement on
today's floor is GREEN. The figure is kept because it was TRUE on its own tree — `git log -S`
places it at a commit whose manifest still declared 8.5% — so this is the went-stale-at-merge
class, NOT the false-when-written class corrected above. Do not size future headroom work
against this breach: it did not occur under the current floor. What actually grew the emitted
baseline on that branch, measured per rule through the emitter's own
`stripRuleFrontmatter → abridgeV6 → stripSlotMarkers`, was **git.md +736 B** and
**instrument-discipline +294 B** — the opposite of the source-byte reading, on which `git.md` is
207 B SMALLER (10690 B → 10483 B). A source-size instrument re-read for the emission question is
exactly the MUST-4 failure this rule names: the source figure is sound for "did the file shrink"
and carries NO information about "did the emission shrink", and nothing in its output would have
looked different had the emission grown.

MUST-5 itself was then tightened in place — the (a) illustration moved to § "(a) The reach proof",
the `**Why:**` shortened — taking its abridged cost **826 B → 689 B** and the rule's net over
`origin/main` **+294 B → +98 B** (3358 B → 3456 B). That is the honest ceiling for this clause:
what remains is the MUST sentence, (a), (b), the heading (cited verbatim by the `MUST-5-firing`
probe `rule_ref`, so not re-wordable for bytes) and the `**Why:**`. It is 137 B, not 627 B, and no
further byte comes out of MUST-5 without cutting obligation.

The rest of the 627 B came from the branch's OTHER emitted growth, none of it by removing a
governance obligation: a code fence in `git.md` that a source-tightening edit had shrunk from
>200 B to ≤200 B and thereby flipped from DROPPED to PRESERVED by `abridgeV6`'s
`isDoBlock && blockSize <= 200` rule (a 40 B source ADDITION bought 164 B of emission — the
non-monotonicity in its purest form); two inline "…: guide." navigation tails reshaped into the
whole-line `Depth — … lives in <the rule-extracts guide>.` form the abridger
recognises and strips; and word-level tightening of four `**Why:**` lines. Final: 60592 B → 59867 B,
`rs` 7.54% → **8.65%**, with BASE **12.04%**, py **11.35%**, prism **27.28%**.
