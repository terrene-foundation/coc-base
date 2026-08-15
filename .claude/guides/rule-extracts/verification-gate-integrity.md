# `verification-gate-integrity.md` — depth extract

Paired depth for `.claude/rules/verification-gate-integrity.md` (Rule-10 path (a) extraction,
performed at loom Gate-1 placement 2026-08-11). The rule body carries the four MUST clauses and
their `**Why:**` lines; everything below — DO/DO-NOT blocks, BLOCKED corpora, MUST-2's carve-out
in full, and the Origin narrative — lives here.

The extraction was NOT stylistic. Measured at placement: the rule fires on exactly one injection
profile, `consumer-test`, which ran 208,450 B without it against a 213,112 B ceiling. The rule's
33,982 B took that profile to 242,432 B and `check-rule-injection-budget.mjs` to exit 1. Every
other profile's delta was 0 B. See § Placement accounting.

---

## MUST-1 — a gate ships a negative control that runs where the gate runs

```text
# DO — the self-test runs as a step BEFORE the scan it validates, in the same job
- run: python3 tools/check-workflow-injection.py --selftest   # asserts it still trips on known-bad
- run: python3 tools/check-workflow-injection.py              # the real scan

# DO NOT — a gate whose only evidence is that it passes
- run: python3 tools/check-workflow-injection.py   # green. capable of red? unknown.
```

**BLOCKED rationalizations:**

- "It fails by construction if the input is bad" (that is the claim under test, not evidence for it)
- "It was passing when I wrote it"
- "The test suite covers the checker" (covering the checker's units ≠ proving the wired invocation is armed)
- "Adding a canary is over-engineering for a lint"

## MUST-2 in full — absence of a result is not a pass

**The discriminator is whether the context REPORTED, not whether its condition was declared.**
Declaredness does not separate the legitimate case from the failure: a workflow-level `paths:`
filter is declared YAML, reviewable in a diff, and it produced the originating incident. A
job-level `if:` evaluating false still emits a check run whose conclusion is `skipped` — the name
is present and attributable. A `paths:` miss emits _no check run at all_, and the context sits
"Expected — Waiting for status to be reported" forever.

So a `skipped` conclusion MAY satisfy a required check, but only when **all three** hold:

1. **It REPORTED** — a check run exists with a terminal conclusion. This alone excludes
   never-triggered workflows, never-registered contexts, and path-filter misses, which emit nothing.
2. **The skip came from the job's OWN condition evaluating false** — not from an interrupted run
   (`cancelled`), and not from a skipped-or-failed `needs:` dependency. A dependency skip also
   reports `skipped` but is inherited absence, not a declared carve-out.
3. **That context is enumerated as legitimately skippable, together with the condition that skips
   it, in a declaration a reviewer approves.** GitHub's `required_status_checks.contexts` is a flat
   string array with nowhere to record this, so the enumeration needs a repo-side home and **each
   repo adopting the rule MUST name its own**. A rule requiring an enumeration with no place to
   live would itself be a gate that cannot fire, so an unnamed home makes the condition
   unsatisfiable. Worked exemplar from the originating BUILD repo, cited as a shape to copy and
   NOT as a path that resolves everywhere: a `_skippable` block in that repo's CI negative-control
   inventory, alongside the per-workflow paths-filter declarations the same audit cross-checks. A
   repo that has not yet named a home satisfies part 3 by review-approved declaration in the PR
   that introduces the skip, and owes the mechanical home before relying on the carve-out.

Part 3 is what closes the "just add `if: false` and your gate is exempt" bypass: making a required
context newly skippable costs an edit to the enumeration, in a diff a reviewer sees. `cancelled`,
`neutral`, a never-triggered workflow, and a never-registered context are undeclared absence and
never satisfy a gate.

**Note the deliberate divergence from the platform.** GitHub branch protection counts a `skipped`
required context as SATISFIED; this rule classifies an undeclared skip as absence. The gap is
intentional — the platform cannot tell a reasoned carve-out from an accident, and this clause is
where that judgment lives. The remediation shape keeps the divergence from becoming the bypass:
**put the relevance decision INSIDE the job** (a step-level `if:` gating the expensive steps, so
the context always reports a real terminal state), and reserve a **job-level `if:` on a required
context for a declared carve-out**.

**Mechanical enforcement is repo-dependent.** The originating BUILD repo's inventory audit is a
reference implementation, described here as a SPEC for what such a check must do — not as a check
that exists in every repo receiving this rule (measured ABSENT at loom at placement). A conforming
implementation cross-checks the declaration against the tree in BOTH directions: a job rendering a
required context with an undeclared job-level `if:` fails; so does a declared condition that has
drifted from the tree, a declaration whose workflow no longer produces the context, and a stale
entry whose carve-out no longer exists (leaving one standing pre-approves the next `if:` added
there). It additionally fails when a required context is rendered by NO job at all — that context
can never report, so every PR blocks on it forever, which is what renaming a required job's `name:`
causes. Conditions are compared after normalization, so `${{ X }}` and `X` are one condition.

Such a check reads a CACHED required-context list, because the audit runs offline and reading
branch protection needs admin rights the PR job's token does not have. That cache is a restatement,
so it MUST itself be checked against the authority by a verify mode that is **fail-closed** — being
unable to read the API exits non-zero with freshness reported UNKNOWN rather than confirmed.
Without that mode the cache and the check it feeds are the self-certifying pair MUST-3(a) forbids.

```text
# DO — per-name assertion over the required set
for name in "${REQUIRED[@]}"; do assert conclusion(name) == "success"; done

# DO NOT — any of these read an absent verdict as a pass
[ "$(count failures)" -eq 0 ]          # a cancelled/never-run check has no failure
gh pr checks | grep -q fail || merge   # same shape, same hole
```

**BLOCKED rationalizations:**

- "Nothing is red, so we're good"
- "It was cancelled by concurrency, that's not a real failure" (correct — and also not a real pass)
- "The rollup API says the PR is green" (rollups omit checks; read the per-check API)
- "If it mattered, it would have run"

## MUST-3 — coverage, both scope and invocation

```text
# DO — verify BOTH halves against the authority
cargo metadata --no-deps          # (a) authoritative members -> assert the classifier covers every one
git ls-tree ... crates/*/tests/   # (b) authoritative targets -> assert each is named by a CI invocation

# DO NOT — a prefix list plus a self-test built from the same prefixes
SCOPE='^(crates/|bindings/)'    # "these cover the workspace" — an assumption
CASES=("crates/a|true" "bindings/b|true")   # every case restates the assumption; none can refute it
# DO NOT — add a test target and assume something runs it
crates/foo/tests/bar.rs   # behind a non-default feature, named by no workflow -> never executed
```

**BLOCKED rationalizations:**

- "The prefixes cover everything today" (an unverified claim about a set that grows)
- "The self-test passes" (it was written from the same premise it would need to falsify)
- "Deriving it at runtime is too slow for a cheap pre-check" (verify it in the self-test instead)
- "I'll add the new location to the list when someone adds one there"
- "The test exists, so it runs" (existence is not invocation)

## MUST-4 — deletion blindness

```text
# DO — answer the removal question with an instrument that can see removal
rows_before(A) ∪ rows_before(B) ⊆ rows_after   # per key AND field-wise, not key-presence alone
drop one known row      -> the check reports it   # MUST-1 control on the check itself
mangle one row's status -> the check reports it   # the field-wise half needs its own arm
# DO NOT — re-run the gate and read its green as "nothing was lost"
check-deprecation-windows.py -> [PASS]         # a row that does not exist cannot be overdue
# DO NOT — compare key sets only
diff <(keys A ∪ B) <(keys after)               # a row surviving with status flipped passes this
```

**BLOCKED rationalizations:** "the gate passed after the merge" / "the checker would have caught a
missing row" / "the counts look right" (a count is not a set, and a row can survive with a mangled
field) / "git would have shown a conflict" (a modify/delete resolves silently in one direction).

**MUST-4 is distinct from MUST-3, not a restatement.** Both verify coverage against an authority,
so they read alike — the difference is the authority's availability. MUST-3's authority is a LIVE
enumeration re-derivable on demand (`cargo metadata`, `git ls-tree`), so the check can be built at
any time. MUST-4's authority is the PRE-OPERATION state, which the operation DESTROYS — so the
union-reconstruction must be captured BEFORE the merge, and a check built afterwards has nothing
left to compare against.

## Distinct From / Cross-References

- **Extends** `probe-driven-verification.md` from probe design to the WIRING and SCOPE of any
  verification mechanism — that rule governs how a probe is built, this one whether it is armed
  and whether it covers what it claims.
- **Generalizes** the test-only / canary-export-greps-to-a-CI-invocation clause `testing.md`
  carries in the originating BUILD repo. **That clause is NOT present in every repo this rule
  ships to** (measured at Gate-1 placement: absent from loom's `testing.md`), so MUST-3(b) is the
  load-bearing statement of the invocation half and does not depend on it.
- **Generalizes** `coc-artifact-eval-coverage.md` MUST-1's requirement that every probe property
  ship BOTH a `violation` and a `compliant` scenario — that pair IS a negative control.
- **MUST-4's prose-surface analogue is** `zero-tolerance.md` Rule 3e — a claim about what a set
  now contains must be anchored to what it contained before.
- **Same epistemic family as** `evidence-first-claims.md` MUST-3 — MUST-2 is that principle
  applied to a CI verdict rather than a shell result.
- **Composes with** `zero-tolerance.md` Rule 1 — a chronically-red gate is a pre-existing failure.
- **Distinct from** `user-flow-validation.md` — that governs whether the deliverable works; this
  governs whether the mechanism that would have caught it can fire at all.

## Origin

**2026-08-03, Rust SDK wave S14** — six instances of one class across five independent tracks, none
of which was looking for it:

1. `Cargo Deny`, a REQUIRED status check, was defined in a path-filtered workflow; any PR touching
   none of those paths never fired it, so the context never reported and the PR could never reach a
   full required set (#2396 stuck; #2401/#2402 admin-merged at 8/9). Fixed in #2404 by extraction
   to an unconditional workflow with a job-internal relevance step.
2. `rag_retrieval_span_correlation`, added by #2368, was named by NO workflow invocation and had
   never executed once — its `otel` feature is non-default, so it compiled to nothing. Wired in #2400.
3. The script-injection guard was green over **35 findings across 7 files (28 distinct sites)**
   while its `ALLOWED` list exempted `github.ref`/`ref_name`/`base_ref`/`inputs.*` on a PROVENANCE
   test where its own docstring specifies a CHARSET test. **This instance SATISFIES MUST-1 and
   violates only MUST-3** — the load-bearing evidence that the two clauses are distinct. Its
   negative control was wired exactly as MUST-1 prescribes (`workflow-lint.yml:188` selftest, `:190`
   scan, same job) and PASSED (`self-test OK (32 fixtures)`, exit 0) while the gate sat inert over
   35 real findings — because the fixtures were built from the same allowlist assumption the scope
   carried. Two `_GOOD_FIXTURES` additionally pinned the vulnerable pattern as must-not-fire, so the
   corpus reinforced the blind spot. Fixed in #2402.
4. The deadlock watchdog wrote diagnostic stacks to a default directory, but **no CI step collected
   them** — a 90s watchdog kill produced zero diagnosis. Scoped honestly: the gate DID fire, so this
   is a **diagnosability** gap, not a gate-integrity one — the weakest of the six, retained only
   because an undiagnosable red is the state in which a real gate gets rationalized into a flake.
   Fixed in #2401.
5. `cancel-in-progress` made a **cancelled** check indistinguishable from a pass to any gate asking
   "were there failures?" — hit three times in one day (#2372, #2373, #2397 twice), each time
   nearly merged over.
6. The #2404 fix itself shipped with the same class inside it: its relevance classifier matched
   crate manifests only under `crates/**|bindings/**`, while `cargo metadata --no-deps` reports five
   workspace members outside both. With no `[licenses.private]` in `deny.toml` those members ARE
   license-checked, so a `license`-field edit there moves the verdict while leaving `Cargo.lock`
   byte-identical — a silently skipped gate. Its 17-case classifier self-test was written from the
   same prefix assumption and was structurally unable to surface it. Caught only because a security
   review examined the FIX rather than trusting it.

MUST-3 exists because of instance 6 specifically: the pattern is not merely "gates go stale" but
"a gate and its self-test written from one assumption form a self-certifying pair."

**MUST-4 — 2026-08-10, Rust SDK wave S24.** Wave S24 folded eleven branches into one integration.
`#2567` DELETED two registry monoliths and sharded them; three sibling branches edited those same
files, so each collision was a modify/delete. Resolving the deprecation-registry conflict by taking
`#2567`'s side **deletes five `status=executed` rows — the record that a deprecation was actually
carried out — and `check-deprecation-windows.py` STILL PASSES**, because a row that does not exist
cannot be overdue. `removals-verified` drops **8 → 3** and still prints `[PASS]`. Caught only by a
DRY RUN of the merge, not by any gate.

Two corroborating details that make the clause's shape precise. First, **counts are not contents**:
a count check reported `20 → 20` rows and `8 → 8` executed rows preserved, but could not have seen a
row surviving with a mangled `status`, `due_in`, or evidence citation. Second, **the union check
needs its own control**: its first version over-collected a fixtures directory and reported three
phantom losses, so a union-reconstruction not shown to go red on a deliberately dropped row is
itself an unverified instrument. Sibling instance in the same wave, same absence-shape on a
different axis: an inventory that loaded successfully with ZERO entries counted as a pass until an
anti-vacuity floor was added.

## Placement accounting (loom Gate-1, 2026-08-11)

Ingested from `kailash-rs` proposal `GATE-DELETION-BLINDNESS-MUST4-2026-08-10` plus the S14 rule it
amends. Classified **GLOBAL on both axes**, tier `coc-core`: the four clauses reference no language
runtime and no CLI-native delegation primitive.

Four defects were found in the never-reviewed draft and fixed at placement:

1. A `testing.md §` cross-reference resolving at BUILD (grep 1) and NOT at loom (grep 0, exit 1,
   against a positive control returning 16) — a phantom citation.
2. MUST-2 part 3 and the Detection block asserted "in this repo" for a CI negative-control audit
   MEASURED ABSENT at loom — restated as a per-repo requirement with the BUILD instance as exemplar.
3. The meta-compliance probe asserted the body is "under the 200-line guidance" while the rule
   carried a named length rationale for being over — it would have judged its own rule
   non-conformant on a criterion the rule explicitly excepts.
4. **The probe suite was not dispatchable.** Every row carried an inline `scenario`, a field
   `artifact-probe-adapter.mjs` does not read (measured: 0 occurrences vs 11 for
   `candidate_fixture`); the adapter REFUSES such rows. Registered as drafted, the suite would have
   been a green, pinned, registered coverage claim that ran nothing — the exact failure this rule
   names. Eight candidate fixtures + `.expected` sidecars were authored to close it.

**Rule-10 path (a) byte accounting.** The rule fires on exactly ONE injection profile. Measured
both poles on the rebased tree (`445bb7d1` base), by removing the rule file and re-running:

| profile          | without | with    | delta       | ceiling (+5%) |
| ---------------- | ------- | ------- | ----------- | ------------- |
| consumer-test    | 208,450 | 242,432 | **+33,982** | 213,112       |
| all seven others | —       | —       | **0**       | —             |

`check-rule-injection-budget.mjs` exited 0 without the rule and 1 with it, so the rule was solely
responsible for the only breach. `guides/rule-extracts/**` is a registered tier glob and is not an
injected rule, so this extract carries no injection cost.

**The extraction alone did NOT clear the ceiling, and it is worth recording why rather than
implying it did.** Measured in sequence: 33,982 B → 11,640 B → 9,461 B of rule body took
`consumer-test` from 242,432 to 217,911, still above the 213,112 ceiling. To fit, the body would
have to reach ~4,662 B, which is not achievable while carrying four MUST clauses AND the canonical
8-field Trust-Posture Wiring `trust-posture.md` MUST-8 mandates — the Wiring alone is roughly that
size. Compression was necessary and not sufficient.

**What actually cleared it was narrowing the `paths:` globs from seven to five**, dropping
`**/tests/**` and `**/*test*`. The `consumer-test` profile probes exactly one path
(`tests/integration/test_runtime.py`), which both dropped globs matched and none of the remaining
five do.

That narrowing is defensible on its own merits, and it was also found while trying to fit a number;
both are true and neither should be suppressed. **For it:** all four clauses govern the GATE and
its WIRING — where a control is invoked, how a merge gate reads verdicts, how a gate's scope and
invocation are derived, how a removal is verified. Those decisions are authored in workflows, CI
scripts, tools and audit-fixtures, all still in scope; none is made while editing a test body.
**Against it:** Origin instance 2 was a test target behind a non-default feature that no workflow
named, and its author now does not load this rule by glob. That is a real partial reachability loss.
Two things bound it — the obligation it carries (MUST-3(b), every target named by an invocation) is
discharged at the workflow, which remains in scope; and `cli_delivery: skill-channel` means the rule
is also delivered through the rules-index skill, which is loaded by relevance rather than by path.

**A corpus-level signal, recorded for `rule-authoring.md` Rule 11 disposition (a').** The
`consumer-test` profile was ALREADY at 208,450 B against a 202,964 B budget BEFORE this rule — over
nominal, surviving only on the +5% tolerance. Seven of eight profiles are in that state. The next
rule that legitimately needs the test surface will hit this same wall and will not have a glob it
can honestly drop, so the disposition then is corpus-level pruning, not another local compression.
