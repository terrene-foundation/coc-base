# Enrolment By Default — Discovery By Glob, And A Missing Marker Is A FAILURE

Depth companion to `SKILL.md` §3. Read before writing, or maintaining, any list of "the checks we run".

Reference implementation: csq `scripts/run-ci-gates.sh` + `ci-gate-registry.txt`. **Cited, not vendored** — those files belong to that repo, are not distributed by loom's manifest, and are named so the prior art is findable, not liftable.

## 1. The failure this exists to close

A gate has two independent properties, and every gate suite instruments only the first:

- **Does it DISCRIMINATE?** Given a violation, does it go red? Self-tests answer this.
- **Is it ever ASKED?** Does anything invoke it, where the suite actually runs? Nothing answers this by default.

A gate that discriminates perfectly and is never invoked renders identically to a gate that ran and found nothing — green, and unexamined. The reference implementation's header records the discovery, on 2026-08-08:

> "On 2026-08-08 both gates written the previous session to prevent recurrence were found to be UNWIRED... The self-tests pass because they construct a synthetic fixture tree... They prove the gate DISCRIMINATES. They say nothing about whether it is ever ASKED... This is the fourth instance of one class in two sessions."

That is `rules/verification-gate-integrity.md` MUST-3(b) — invocation coverage checked against an authoritative target list — reached independently, in bash, from a repo that had never read the rule.

**The convergence is the argument.** loom hit the same class seven times in one session and shipped two mechanisms for it: `check-clause-coverage.mjs` (a clause added to an already-covered rule ships zero probe rows and every gate reports green — its "lever L5", the only one of five committed by writing a RULE rather than by editing the test surface) and `.claude/audit-fixtures/_lib/arm-coverage.mjs` (six of seven defects in one branch review shared one shape: a control proved the matcher FIRES, never that it COVERS). Three repos, three languages, one defect class, three independent fixes. **Consumer note:** `check-clause-coverage.mjs` lives under `.claude/bin/`, which is `loom_only` — MEASURED `skip` on all six distribution lanes — so this is a description of a tool a consumer does not receive. `.claude/audit-fixtures/_lib/arm-coverage.mjs` DOES ship (`copy` on all six) and is directly usable.

## 2. The mechanism

1. **Discover by glob.** The runner asks the filesystem which gates exist. No hand-maintained list is consulted, because a hand-maintained list is a second source of truth that drifts in exactly one direction — toward omission.
2. **Every discovered file carries a machine-readable enrolment marker** (`# ci-gate:` in the reference).
3. **A discovered file with no marker is a FAILURE, not a skip.** This is the entire pattern. Steps 1, 2 and 4 are plumbing around this one inversion.
4. **Opting out is an explicit declaration** — greppable, reviewable, and visible in a diff.

### Why "failure, not skip" is the load-bearing half

Under hand-enumeration, a new gate's default state is *unwired*, and wiring it is something a person must remember at the end of a long session. Under enrolment-by-default, a new gate's default state is *wired*, and un-wiring it is something a person must justify in a diff a reviewer reads.

Nothing about the gates changed. What changed is which outcome requires an act of attention — and attention is the resource that was demonstrably absent in every instance of the failure above.

```text
# DO — the runner asks the filesystem; an unmarked gate fails the run
for f in $(glob 'scripts/ci/gates/*'); do grep -q '# ci-gate:' "$f" || fail "$f unenrolled"; done
# DO NOT — a list somebody maintains
GATES="lint.sh types.sh audit.sh"        # the gate written yesterday is not in it
```

## 3. The blind spot — enrolment is only as sound as its population

Enrolment-by-default converts a silent skip into a loud failure. That is a strict improvement **only when the glob's population is itself checkable.**

If the glob can miss a gate, the loud failure never fires for the gate that most needed it — and the situation is now WORSE than hand-enumeration, because the mechanism looks exhaustive and its green therefore carries more authority than it earns. This is `rules/instrument-discipline.md` MUST-3(a) applied to the discovery step: an instrument never shown to fire HERE is blocked as evidence, however sound its logic.

Ways the population silently shrinks:

| cause | what the runner sees |
| --- | --- |
| a gate written in a different language / extension than the glob matches | nothing |
| a gate placed one directory outside the scanned root | nothing |
| a case-insensitive filesystem masking a wrong-case path | a plausible-looking absence |
| a glob evaluated by a shell that does not expand it as assumed | an empty set, exit 0 |
| a gate inside an ignored / excluded subtree | nothing |

Each renders as an empty or short result and none renders as an error.

### The population control

The discovery step needs its own negative control, running where the runner runs and on the same cadence (`rules/verification-gate-integrity.md` MUST-1):

1. **A planted file the glob MUST discover** — an enrolled no-op gate committed to the scanned tree, asserted present in the discovered set on every run. Its absence fails the run. This is the positive pole.
2. **A planted UNMARKED file the runner MUST reject** — asserting the failure path is reachable, not merely written. Without it, "a missing marker is a failure" is a claim about code nobody has ever executed. This is the negative pole.
3. **Assert the discovered COUNT against an authority**, not against a remembered number: a census derived from the same tree by a different means. A count is not the hits (`rules/instrument-discipline.md` MUST-3(b)) — but a count that MOVED without an accompanying diff is a signal worth failing on.

Read the hits at least once when the population changes. A tally of gates is consistent with the right gates and the wrong ones.

## 4. What this pattern does NOT give you

Stated so a green is not over-read:

- **It proves each discovered gate is ASKED. It does not prove any of them DISCRIMINATE.** That is the other half, and it is what self-tests and negative controls are for. Enrolment and discrimination are orthogonal; a suite needs both, and either alone renders green.
- **It bounds the suite to what the glob can see.** A gate nobody wrote is not a gate the census can miss, and a gate outside the scanned root is invisible to it — §3.
- **It says nothing about whether a gate is REQUIRED.** A discovered, enrolled, discriminating gate whose red cannot block a merge is still advisory and still gets normalised (`rules/ci-job-budget.md` MUST-1).

## 5. Interaction with diff-scoped selection

Run the census **outside** the narrowing, unconditionally. Scoping the census is self-defeating: the census is the mechanism that notices a gate stopped being asked, and the most common reason a gate stops being asked is a selection rule that quietly stopped selecting it.

```text
# DO
enrolment census (unconditional) → diff-scoped selection over the discovered set (fail-open)
# DO NOT
"the diff didn't touch scripts/ci/, so skip the census"
```

If the census is too expensive to run unconditionally, that is a defect in the census, not a reason to gate it. A census that reads a directory and greps for a marker is cheap by construction; one that is not has usually absorbed work belonging to the gates themselves.
