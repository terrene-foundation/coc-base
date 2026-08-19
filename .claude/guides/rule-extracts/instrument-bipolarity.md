# `instrument-bipolarity.md` — extract

Depth companion to `.claude/rules/instrument-bipolarity.md`, extracted per
`rule-authoring.md` Rule 10 path (a). The rule carries the four MUST clauses, their
`**Why:**` lines and the Trust-Posture Wiring; everything below — worked DO/DO-NOT blocks,
BLOCKED-rationalization corpora, the per-clause reasoning, the cost analysis and the full
origin narrative — lives here, where it is not injected into any path-scoped profile.

**Extraction was forced, and by the rule's own subject.** The first draft carried this depth
inline at 12,989 B and reddened `check-rule-injection-budget.mjs` on three profiles. The
local gate that had been run was `validate-proximity-band.mjs`, which returned exit 0 —
correctly, because `rule-authoring.md` Rule 10's proximity band is scoped to `priority: 0`
baseline rules and this rule is `priority: 10` path-scoped. A green from the gate that does
not apply is not evidence about the gate that does; that is `instrument-discipline.md`
MUST-4 at the process layer. Recorded here rather than smoothed over, because it is the
third instance this rule's own authorship produced.

## Definitions — the full form

A check **CAN GATE** if its result may block a merge, fail CI, halt a `/redteam` or
`/codify` gate, or be cited as a convergence signal. A one-off diagnostic in a session
transcript is NOT a gating check — `instrument-discipline.md` MUST-1 already governs those
at citation time, and extending this rule to them would swallow every assertion in every
suite and make the rule expensive enough to route around.

**The "can gate" boundary is the clause to watch in practice.** The whole cost argument
rests on it, and it is prose. Read narrowly it costs almost nothing; read broadly it becomes
a tax on every test. If the rule ever produces friction, this definition is where to look
first, not the pole mandate.

A **POLE PAIR** is two executable inputs plus their expected verdicts: a **RED pole** the
check MUST reject and a **GREEN pole** it MUST accept.

## MUST-1 — worked example

```text
# DO — the pair is executable and the harness compares the two verdicts
red:   fixture with the boundary VIOLATED   → expect FAIL, reason `path-escape`
green: fixture with the boundary HELD       → expect PASS
harness asserts red.verdict !== green.verdict

# DO NOT — assert only that the check passes on good input
assert(check(goodInput) === 0)   # a check hardwired to 0 passes this forever
```

**BLOCKED rationalizations:** "the check obviously works, look at the code" / "we have a
test, it passes" / "the red case is what the check is FOR, we don't need to prove it" / "a
negative fixture is just noise in the suite" / "CI would catch it if it broke" / "the review
already read the logic".

### Why the regress terminates at depth 1

The natural objection is that a pole pair is itself an instrument, so it needs its own pole
pair, and so on forever. It does not, and the reason is structural: **a pole pair is not
another CLAIM about the instrument, it is a MEASUREMENT.** If the check's verdict on the red
input equals its verdict on the green input, the pair is vacuous BY CONSTRUCTION — detectable
by comparison, needing no judgment and no further instrument. "red ≠ green" bottoms out.

What the comparison does NOT establish is that the instrument is sensitive to the RIGHT
thing. That is the hole MUST-2 closes, and it is where the three vacuous repairs of session
39 fell.

## MUST-2 — worked example, and why it carries the rule

```text
# DO — the identity is declared and matched
red: expect exit 1 AND finding id `boundary-escape`

# DO NOT — every one of these passes while the check is broken
expect(exit).not.toBe(0)          # [undeclared-failure] satisfies it
expect(findings.length).toBe(1)   # one finding, wrong finding
expect(`${pass}/${pass}`)         # same variable both sides: 39/39 is a tautology
expect(new Set(x).size).toBe(5)   # five DISTINCT values, all wrong
```

**BLOCKED rationalizations:** "it exits non-zero, that IS the red" / "the pole already reds,
naming the code is ceremony" / "we assert the finding count, which is close enough" / "any
failure here can only be this failure" / "the identity would just duplicate the message
string" / "the mutation test already proves the pole is load-bearing".

### The evidence: the repair is the same error one layer down

Three for three, measured in session 39. Each was authored by someone who had *just been
told* the original assertion was wrong:

| original | repair | why the repair is also vacuous |
| --- | --- | --- |
| a count that admitted duplicates | `new Set(x).size === 5` | still admits five DISTINCT-but-wrong values |
| a single containment check | a second containment check | it DERIVES its answer from the first — an alias of the lever, not a second lever |
| an unreadable summary | `${pass}/${pass}` | same variable both sides; `39/39` is a tautology, and `passed === total` would have passed at `2/2` |

This is the argument for MUST-2 and against the mandate as first proposed. If the intuitive
repair is vacuous that reliably, a rule saying only "ship a red pole" hands the same reflex a
new form to fill in.

### The limit MUST-2 does NOT close

Stated plainly because the rule should not be sold as more than it is: **a named failure
identity can still be the WRONG identity.** An author may name `boundary-escape` and build a
red pole that triggers it through a path unrelated to the boundary. The pole reds, under the
declared name, and tests nothing.

What MUST-2 buys is that the failure must be SPECIFIC and NAMED, which is far harder to
satisfy by accident than "exit non-zero". It converts a silent accident into a deliberate
misnaming — a smaller population, and one an adversarial reviewer can actually see. A real
reduction, not a solution. A third layer would have to ask whether the identity is the RIGHT
one, and that is not mechanizable, which is why no MUST-5 was invented to pretend otherwise.

## MUST-3 — worked example, and why "may not gate" beats "fails"

```text
# DO — name the infeasibility, drop the teeth, keep the signal
advisory: true  # red pole needs a live 503 from the provider; cannot be fabricated here

# DO NOT — keep the teeth and skip the pole
# "we know it works, the pole is just ceremony here"
```

**BLOCKED rationalizations:** "we'll add the pole when the harness supports it" / "it's
required in CI already, removing that is a regression" / "an advisory check nobody reads is
worse than a gate" / "the pole is infeasible TODAY, so the requirement doesn't apply" / "we
can waive this one, it's obviously correct".

The directed form of this clause was "a check whose red pole stops redding is DISARMED and
FAILS." Fails is the wrong lever. **A failing gate gets waived under delivery pressure, and
the waiver is where the exemption hardens** — this corpus shows exactly where those go:
`_deferred_probes`, `phase2-deferrals`, grandfather cutoffs, `expires:` fields, each of which
began as a reasonable exception. "May not GATE" needs no waiver machinery at all: the check
keeps informing and simply stops being load-bearing, and nobody has to remember to withhold
the teeth because they were never granted.

## MUST-4 — worked example, and its separable reach

```text
# DO — the claim names its implementation and the path fires for the claimed inputs
// fails CLOSED: `resolve()` throws on a non-existent root (see L212; red pole `bad-root`)

# DO NOT — prose asserting a guarantee no line delivers
// fails CLOSED: a resolver that raises refuses the write   ← resolver never throws for a string
// count asserted by the helper itself                      ← the helper asserts no count
```

**BLOCKED rationalizations:** "the comment describes the intent, not the implementation" /
"it's aspirational, the code will catch up" / "everyone knows comments drift" / "the reviewer
can read the code" / "removing the claim makes the function look unsafe".

**Reach, stated so the clause is not oversold.** MUST-4 reaches a DIFFERENT population from
MUST-1–3 and is separable from them: prose-vs-code catches the instrument that **LIES**, the
pole pair catches the instrument that is **SILENT**. Of the eighteen known instances in the
originating corpus, MUST-4 reaches two and the pole clauses reach sixteen. It is also the
cheaper half to enforce, because reachability is decidable — "does this resolver throw for
this input class" has an answer, where "is this pole discriminating?" does not. Ship both;
if only one, ship the pole mandate, because the silent failures are the majority and the
dangerous ones.

## MUST NOT — extended rationale

**No lexical detector over these shapes.** A regex asking "does this assertion's name match
what it measures" cannot distinguish a sound assertion from an unsound one. Deployed to catch
assertions that cannot distinguish, it is the failure class wearing a fix's clothing — and
carrying `block` on a lexical signal is separately barred by `hook-output-discipline.md`
MUST-2.

**No alias counted as a second lever.** A second check that derives its answer from the first
moves with the thing it was meant to cross-check, and reads as defense-in-depth in review.

**No blind-spot mutation read as a vacuity verdict.** "I mutated the guard, not its scope, so
every mutation stayed inside the blind spot" is how author-run mutation testing returns a
clean bill on a genuinely blind instrument. Mutate the SCOPE, not only the guard.

## Trust-Posture Wiring — the reasoning behind the fields

The rule carries the canonical eight fields compactly. The reasoning is here.

**Severity — why `advisory` at the hook layer.** Whether a pole discriminates is a semantic
judgment over the check's meaning, so `hook-output-discipline.md` MUST-2 caps the hook layer at
advisory. This is not a gap to be closed later: per the rule's own MUST NOT, a lexical detector
for this class is BLOCKED by construction, so the hook layer will never rise above advisory.
Gate-review at `/codify` (cc-architect) and `/implement` (reviewer) is the enforcement surface.

**Regression-within-grace — why no dedicated key.** Minting a per-clause instant-drop trigger
would require editing `trust-posture.md`, which is on the `self-referential-codify.md`
allowlist, turning a routine landing into a self-referential edit. The generic
`regression_within_grace` trigger already covers the class, and a review-layer judgment does not
warrant an instant drop. Same disposition `instrument-discipline.md`, `security.md`
§ Enforcement-Surface Parity and `git.md` § CI-check/merge each took.

**Detection — why the split is the honest form.** The two halves have genuinely different
tractability and collapsing them would misreport one of them:

- **(a) STRUCTURAL is feasible.** Whether a registered gating check HAS a declared pole pair,
  whether the harness ran BOTH poles, whether the two verdicts DIFFERED, and whether the red
  pole declares an identity rather than an exit code are all decidable from the harness's own
  output. This is the same shape `run-audit-fixtures.mjs` already enforces for `min_cases`. It
  is OWED, and the rule states it does not exist yet — a claim that can be checked and
  falsified, which is the point.
- **(b) SEMANTIC is not deferred, it is RETIRED.** Whether a pole discriminates for the RIGHT
  reason, whether a second check is an alias of the first, and whether a mutation escaped the
  blind spot are judgments over meaning. Filing them as `Phase 2 (deferred)` would book teeth
  that cannot arrive, which `rule-authoring.md` names as a defect in its own right, and would
  additionally hit `checkAcceptanceGate` — a `probe_authorship_deferrals` row needs a
  `.claude/deferral-acceptance/` receipt with `requested_by != accepted_by`, and
  `completion-criterion.md` MUST-6 forbids self-acceptance, so there is no self-serviceable
  deferral path anyway.

**Probes — what registration does and does not buy.** The suite is REGISTERED and PINNED, which
buys DISPATCHABILITY. It does not buy execution: no workflow invokes the probe dispatcher, and
the loom↔csq boundary keeps CI LLM-free, so **a green CI run is never evidence these probes
passed.** They execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at
gate-review. The rule states this inline because the opposite reading — "registered, therefore
covered" — is the same absence-reads-as-success shape the rule exists to name.

## OPEN PROBLEM (recorded 2026-08-18) — no mechanism fires when an instrument is read for a SECOND question

**This is a named gap, NOT a proposed clause, and it MUST NOT be turned into one without a
mechanism behind it.**

`instrument-discipline.md` MUST-4 already states the contract: an instrument is scoped to the
question it was BUILT for, and re-reading it for a second question re-triggers MUST-1. That rule
is `priority: 0` baseline. It was loaded, in context, for every instance below — and did not
fire in any of them.

Three instances from the authoring and landing of THIS rule alone:

| # | instrument | built to answer | read as answering |
| --- | --- | --- | --- |
| 1 | `buildPlan` plan rows | "does the tier glob match this path?" | "is the distribution fate DECLARED?" (`journal/0582`) |
| 2 | a mutated registered sibling | "does a path CITED IN RULE PROSE resolve?" | "does `eval-manifest.json` registration end `detection-binding-check`'s blindness?" |
| 3 | `validate-proximity-band.mjs` | "does a `priority: 0` baseline addition breach the emission band?" | "does this change fit the rule-injection BUDGET?" |

Instance 3 is the sharpest, because **the gate returned exit 0 CORRECTLY.** `rule-authoring.md`
Rule 10's proximity band is scoped to `priority: 0` + `scope: baseline` rules; this rule is
`priority: 10` path-scoped, and its own Origin says so. The instrument was sound. The reading was
not. `check-rule-injection-budget.mjs` is a different gate asking a different question, and it
red.

**Why this is NOT drafted as MUST-5.** MUST-2 would catch none of the three — they are not
quantity-for-identity, they are scope errors. But a fourth restatement of a baseline rule that
was already loaded for all three instances changes nothing; that is precisely the ADDRESSING
argument this rule was built on, turned against a clause this rule might add. What is missing is
a MECHANISM that fires at the moment an instrument is read for a second question — the
authorship-time analogue of a pole pair. **Nobody has one.** Until someone does, this stays a
recorded open problem.

Adjacent instances outside this rule's authorship, for whoever picks it up: a disclosure scan
cited for source CURRENCY; `check-descoping.mjs` asked about a command when it reads only rules;
a `/tmp` vs `/private/tmp` string-prefix check that briefly cleared a live HIGH.

## Cost analysis

Low, IF the "can gate" scope holds. One-off session diagnostics are excluded outright. For a
trivial gating check — schema validation, a shape assertion — the red pole is one malformed
fixture, near-zero. The genuine cost case is the infeasible pole, and MUST-3 converts that
into a one-line declaration plus loss of teeth rather than a burden.

**Forward-only, and the consequence named:** new and modified checks only. The sixteen
existing instruments stay. A demand-driven bridge was considered and deliberately NOT
adopted — *an instrument's verdict may not be cited as GATE evidence until it has poles* —
because it widens scope beyond this codify's remit. It remains available as a decision.

## Origin — full narrative

Sixteen non-discriminating instruments landed in ONE session (39), across four agents, while
`instrument-discipline.md` — `priority: 0`, baseline, loaded by every agent involved — sat in
context. FOUR were committed by agents ACTIVELY HUNTING the class, three by the orchestrator.
The count reached twelve during the drafting of this very rule and its landing.

**Comprehension was therefore not the failure.** A rule that is read, understood, agreed with,
and still does not fire has an ADDRESSING problem, not a content problem — which is why this
rule adds a MECHANISM at authorship rather than more prose to the existing rule.

The six sub-classes, with instances:

| sub-class | instances |
| --- | --- |
| **Quantity-for-identity** | `fromSibling === 5` · `missing.length === 1` · `changed_count` · `tests 1 / pass 1` |
| **Scope mismatch** | a disclosure scan cited for source CURRENCY · a GraphQL cross-check blind to rulesets · `has()` read as answering "did the request succeed" · `check-descoping` asked about a command · a proximity-band gate read as covering the injection budget |
| **Alias-not-lever** | a second containment check deriving its answer from the first |
| **Blind-spot mutation** | "I mutated the guard, not its scope" |
| **Absence-reads-as-success** | a CI vacuum · `${PIPESTATUS[0]}` empty under zsh · `tests 1 / pass 1` when the tests vanished · REST `Not Found` for resources that exist |
| **A red for the wrong reason** | a floor proof whose red came from `[undeclared-failure]` at the same exit code |

The unifying line, from the lane that made the quantity-for-identity error twice: *"I asserted
a QUANTITY when the property was about IDENTITY. Counting is a proxy for identity in exactly
the direction a mutant exploits."*

**Not novel.** `coc-artifact-eval-coverage.md` MUST-1 already mandates this shape for
ARTIFACTS — "BOTH a `violation` scenario … AND a `compliant` scenario — no-false-positive is
half the efficacy test." This rule extends it one layer down to INSTRUMENTS, which is also the
reason to expect it to hold: every review lane that succeeded in session 39 built pole pairs
spontaneously, without being told to.

**Scope decision.** Path-scoped on REACHABILITY grounds, not budget: the obligation attaches to
a file the author is editing, and checks live in known places, so the globs fire at exactly the
moment of authorship. This is the opposite of `issue-triage-routing.md`, whose trigger matches
no glob. Baseline headroom measured 11.8% at drafting (band 15%, floor 10%), which corroborates
but is not the reason. **The `paths:` set was NOT narrowed to satisfy the injection budget** —
dropping `.claude/bin/**` or `**/tests/**` would have fixed the number by removing the rule from
the surfaces where checks are actually authored, which is the failure this rule exists to name.

Receipt-first provenance: `journal/0581` (DECISION, co-owner-directed origination) and
`journal/0582` (AMENDMENT, withdrawing 0581's distribution-fate claim).
