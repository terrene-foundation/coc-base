# `artifact-stranding.md` — depth extract

Depth for `.claude/rules/artifact-stranding.md`. This file is NOT baseline-emitted and NOT injected with the rule; the rule body carries the load-bearing clauses, and everything that would only be read once lives here.

## The failure class in one sentence

**AUTHORED is not IN FORCE, and nothing measured the difference.**

An artifact is authored, committed, and left on a branch that never reaches the default branch. It exists. It is reflog-safe. Its tests pass. It governs nothing outside the one working tree that holds it — and every instrument anyone points at it returns the same green it would return if it governed the whole repo. That last property is what makes the class survive review: the failure is not IN the artifact, it is in the artifact's REACHABILITY, and no check that reads the artifact can see it.

## The three measured instances (2026-08-20, one session, none found by review)

### Instance 1 — a guard at 27/27 that protected nothing

A hook shipped with 27 passing fixtures, each genuinely discriminating: red poles red, green poles green, identities asserted. The guard was correct. It sat on an unmerged branch, so no session outside that worktree ever loaded it, and the class it defended against went on happening in every other tree. The fixture run was cited as evidence the repo was protected. It was evidence the CODE was correct — a different proposition, and `instrument-discipline.md` MUST-4 (an instrument is scoped to the question it was BUILT for) names the substitution.

Falsifying result that was never named: `git merge-base --is-ancestor HEAD origin/main` exiting 1.

### Instance 2 — Rule 4a, and two parties who were both right

`worktree-isolation.md` Rule 4a was authored AND committed on 2026-08-20. A lane reported "there is no Rule 4a." The orchestrator reported having written it. Both claims were true, of different trees.

The measurement that settled it, with a control (`### 3a.`, a rule section known to be present everywhere):

| tree          | `### 4a.` | `### 3a.` (control) |
| ------------- | --------- | ------------------- |
| codify branch | 1         | present             |
| `origin/main` | 0         | present             |
| lane worktree | 0         | present             |

The control is load-bearing. Without it, `0` is ambiguous between "absent" and "the grep did not fire here" — `instrument-discipline.md` MUST-3(a). With it, `0` is a fact.

The cost of the class here is not the lost work; it is the ARGUMENT. Two honest agents produced contradictory reports, and with neither claim carrying its tree, the only available tiebreaker was insistence. MUST-2 exists so the tiebreaker is a ref.

### Instance 3 — a correct mechanism with no producer

A worktree-lifecycle mechanism shipped `open`, `retire`, `gate` and `invariant`. Every arm discriminated. Every arm was fixture-covered. Nothing in the repo called any of them. The mechanism was in force nowhere, and the shape of the evidence was inverted: the fuller the test coverage, the more confident the report that it worked.

**Disposition — DELETED, not wired (2026-08-22).** The finding was re-measured with a control that fires (74 files carry the sibling token `worktree-reap`, against ONE reference to the mechanism's own bin path — its `--help` text), and the mechanism was removed: the tool (792 lines), its pure core under bin/lib (755) and its test file (715), plus its `ci-suites-bin.json` row and its `git-env-regrowth-guard-1471.test.mjs` un-helpered-git-site pin. Wiring was rejected over deleting because a producer would have had to be INVENTED for it — no command, hook or rule asked for the transaction it offered, and authoring a caller to justify an existing mechanism is this rule's class wearing a fix's clothes.

**The three paths are deliberately NOT restated as live tokens.** They no longer resolve, and a backticked dead path is the `cc-artifacts.md` MUST NOT § No Dangling Cross-References defect this rule's own Origin was written to close — the evidence is read at the last SHA that carried it: `git show d0c3d64d:.claude/bin/worktree-lifecycle.mjs` (its siblings are the `lib/` and `.test.mjs` neighbours in the same tree). Teardown of transient worktrees is served by `.claude/bin/worktree-reap.mjs`, which the deleted mechanism's own help text already routed to.

This is the same shape as instance 1 with the reachability question moved from git to the call graph. `orphan-detection.md` Rule 1 owns it in SDK code; its globs (`packages/**`, `src/**`, `crates/**`, `**/src/**`, `**/tests/**`) do not reach `.claude/**`, which is why the rule's MUST-3 exists rather than a cross-reference.

## Why the detector reports and does not block

The signal is structural end to end: `merge-base --is-ancestor` is reachability, `diff --name-only base...HEAD` is a three-dot git-object fact, and artifact classification is a positive path allowlist. `hook-output-discipline.md` MUST-2 would therefore PERMIT `block`.

It is refused, and the reason is that rule's own MUST NOT — "detectors that block work the agent has been instructed to perform". Two legitimate, common cases sit directly under the predicate:

- an operator deliberately abandoning a branch whose artifacts were experiments;
- an artifact deliberately held unlanded pending review, a paired suite, or a sibling lane.

Whether THIS branch should land is a judgment about the operator's plan, not a fact about the repo. A block would be wrong in both cases, and being wrong at a block is far more expensive than being wrong at a report. What the structural signal buys instead is CONFIDENCE IN THE NAMES: the report states artifact paths as fact, not as suspicion, so the operator spends no turn verifying the finding before acting on it.

The complementary error is worth naming, and it is NOT about volume. `advisory` at the destructive surface would render "the action proceeded" over a command that has not run — false, and false in the direction that matters, since the whole point of firing at `PreToolUse` is that a decision is still open. `pre-action` is the register for that moment: "the action has NOT run yet. Read this, then decide." At session close the opposite holds — the tool calls are done, "the action proceeded" is true, and `advisory` is right.

So the two surfaces differ by the ACTION'S FATE, not by how much the finding matters. The finding is identical at both: same rule_id, same paths, same count. Only the head changes, and the head is a claim about the world that can be true or false independently of the finding. Reading the lower rank (`severity-rank.js` puts `pre-action` alongside `advisory`, not below `halt-and-report` in some softness ordering) as "this matters less at the destructive boundary" inverts the design. It matters MORE there; what it does not do is lie about whether the branch is already gone.

An earlier revision of this paragraph argued the destructive surface needed `halt-and-report` so the report would not "arrive as one line among many". That is an IMPORTANCE argument for a register that encodes FATE, and it produced exactly the false head above. It is recorded here rather than deleted because the mistake is the easy one to make twice.

## Why the two-dot diff is BLOCKED in the predicate

On a branch BEHIND its base, `git diff --name-only base..HEAD` renders base's newer commits as REVERSIONS — so an artifact that landed on `main` and was never touched on this branch is reported as this branch's stranded artifact. The three-dot form `base...HEAD` diffs against the merge-base and reports only what this branch actually authored. `evidence-first-claims.md` MUST-5 names the class; fixture pair 3 pins it with an ARTIFACT file on base (an earlier version of that pole advanced base with a non-artifact file and passed under a deliberate two-dot mutation — vacuous for the trap it was written to catch).

## Fail-open, and why an unanswerable question reports nothing

`isAncestor()` returns `true` / `false` / `null`, and the third value is load-bearing. `null` means git could not answer — unknown ref, no remote, renamed default branch. The caller treats it as "report nothing", never as "reachable" and never as "stranded". A reachability question that defaulted either way would be a non-discriminating instrument in `instrument-discipline.md` MUST-1's sense: the same output whether the proposition holds or not.

## Recording a HOLD

MUST-1 is satisfied by landing OR by a recorded hold. A hold record is durable (a PR description, a journal entry, a session-notes row, a forest-ledger row — not a chat message) and answers two questions: WHY it is held, and WHAT will land it. "Held pending review" alone is not a hold record; it names no lander and expires into silence, which is the state the rule exists to end.

## MUST-1 fixture-count narrative

Relocated from the rule's `**Detection mechanism:**` bullet 2026-09-13 (citation-restoration
paired extraction). The rule body keeps the measured counts; what follows is what the second
figure means. The 32 pass / 0 fail is this branch alone; the 34 arrives once loom#1868 lands,
which adds a seventh pair driving the REAL emitter end-to-end, so the destructive HEAD is
asserted rather than the severity constant proxied.

## Probe-tier registration narrative

Moved verbatim from the rule's `**Detection mechanism:**` bullet 2026-09-13 (rule-injection-budget
paired extraction, `rule-authoring.md` Rule 10 path (a)). The rule body keeps the registered probe
path, the pair count and the dispatchability caveat; what follows is the provenance around them.

**Probes: REGISTERED — the suite landed, and the owed tier is DISCHARGED.** `.claude/test-harness/probes/artifact-stranding.probes.json` resolves: **8 rows in 4 bipolar `pair_id` pairs** (`destructive-boundary`, `hook-meta-conformance`, `landed-branch-silence`, `stranded-naming`), registered in `eval-manifest.json` as a probe-only entry (`type: hook`, `scanner: null`, `fixturesDir .claude/audit-fixtures/artifact-stranding`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`.

The gap was carried as UNCOVERED-and-OWED for the hours it was real, then closed by the suite landing — not laundered into a deferral that would have outlived it.

**Registration buys DISPATCHABILITY, never automatic execution:** no workflow invokes the probe dispatcher and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed; they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.

Counts above are MEASURED at landing and go stale — re-derive rather than citing this line.

**Consumer note:** `.claude/test-harness/probes/artifact-stranding.probes.json` does not ship to use/base, build/base, use/py, build/py, use/rs, build/rs (MEASURED: `skip` on 6 of this rule's 6 lanes), so no consumer on those lanes receives it; at those targets this SEMANTIC tier is not a live gate.

The gap is declared in the detector-distribution baseline registry, deliberately named here in prose rather than as a path token: citing it as one makes it a detector claim in its own right, which then needs its own declaration — a recursion this sentence exists on the far side of.

## Cross-references

- `orphan-detection.md` Rule 1 — the same class in SDK code.
- `instrument-discipline.md` MUST-1 / MUST-3(a) / MUST-4 — the green that cannot discriminate, the instrument never shown to fire here, the instrument re-read for a second question.
- `evidence-first-claims.md` MUST-5 — the wrong-question instrument, including the two-dot diff.
- `instrument-bipolarity.md` MUST-1 / MUST-2 — the pole-pair and failure-identity contract the fixtures satisfy.
- `worktree-isolation.md` — where parallel work RUNS; this rule governs whether its output lands.
