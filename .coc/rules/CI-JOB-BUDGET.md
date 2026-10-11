---
id: "CI-JOB-BUDGET"
paths: [".github/workflows/**", "scripts/ci/**", ".claude/hooks/ci-job-budget-guard.js", ".claude/bin/ci-job-budget-audit.mjs", ".github/job-budget.json", ".github/scripts/job-budget-audit.py"]
---

# CI Job Budget — A Per-PR Job Must Gate Something Or Be Declared, Never Silently Added

A CI job that runs on every pull request and cannot block a merge is the worst of
both states: it consumes a runner slot at full cost and enforces nothing. One such
job is unremarkable. Twenty of them, accreted one unremarkable decision at a time,
make a pull request cost more runners than the pool has — at which point CI stops
being a gate and becomes a queue.

This rule governs the SIZE and JUSTIFICATION of the per-PR fan-out. It is distinct
from whether each job is correct: a suite of perfectly-correct jobs that together
exceed the pool cannot validate anything, because the work is obsolete before it
finishes.

**Why this is a CASCADE rule, not a self-use rule.** loom itself has one
`pull_request` workflow and a three-job fan-out; it does not have the problem this
rule names. It is carried here because loom is the SPLITTER, and the repos it
distributes to contend for ONE SHARED runner pool — so a fan-out authored in any
one of them is charged to every other repo's queue time. The ratchet is worth
distributing precisely because no single repo can see the contention it creates.

CI jobs also accrete one unremarkable job at a time, and nothing says anything at
the moment each is added. No single addition is worth arguing about; the sum is, and
by the time the sum is visible nobody can say which job to remove or why it was
added. The upstream instance measured one PR fanning out to **33 runner-consuming
jobs against a pool of 24, of which only 12 gated anything**. Adding a job is
legitimate; the goal is that it becomes a *declared* act, not that it is refused.

**This file is a UNION (2026-10-06, Gate-1 intake).** It merges this rule with the
rs USE template's locally-authored copy — both trace to loom#1877 — and NOTHING from
either side was dropped. `## Union Provenance — Clause Attribution (2026-10-06)`
maps every clause to its side; the template-side Origin record sits under `## Origin`.

## MUST Rules

### 1. Every PR-Reachable Job Is Required, Relevance-Gated, Or Budgeted

Every job reachable from a `pull_request` trigger MUST be exactly one of:
**required** (it provides a branch-protection required context — it IS the gate),
**relevance-gated** (a per-job skip keyed on what the PR actually touches, or a
`paths:`-filtered workflow that provides no required context), or **budgeted**
(declared in the repo's job-budget declaration with a dated rationale — the entry
shape and its revisit-date requirement are MUST-5). A job in none of those states
is BLOCKED. Such a job is a **freeloader**: it runs on every PR and gates nothing,
and adding one without declaring it is BLOCKED.

```yaml
# DO — required, so it IS the gate
required-checks:
  name: Required checks # a branch-protection required context

# DO — relevance-gated: it does not run when the PR cannot have broken it
structural:
  if: needs.detect.outputs.relevant == 'true'

# DO — or gate the whole workflow on the paths it can act on
on:
  pull_request:
    paths: [".github/workflows/**"]

# DO NOT — runs on every docs PR, every proposal, every session note; gates nothing
on:
  pull_request:

# DO NOT — runs on every PR, gates nothing, declared nowhere
freeloader:
  name: Nice To Have
```

**BLOCKED rationalizations:** "it's only one job" / "it's cheap" / "it's fast, it
costs nothing" / "it's one more job, the matrix is already big" / "we might need
the signal one day" / "we'll gate it once it's stable" / "it's informational, not a
gate — that's why it isn't required" / "adding a `paths:` filter risks missing
something, better to always run" / "making it required would block merges" (that is
the decision, not a reason to skip it) / "it catches real bugs" (then it should be
required) / "the pool is usually free" / "it's a different repo's pool" (it is not
— the pool is shared) / "the budget file is bureaucracy for a two-minute job" / "CI
minutes are cheap on hosted runners".

**Why:** A job that gates nothing cannot fail a merge, so its red is advisory and
gets normalised; meanwhile it is charged to every PR forever. Forcing each one into
required, gated, or declared makes the cost a decision somebody made rather than a
default nobody chose. The cost of any single job is genuinely negligible, which is
exactly why no one objects to it; the mechanism that fails is *review*, not
arithmetic, and forcing the addition into a declaration converts an invisible
per-PR cost into a line in a diff a reviewer can see and question.

### 2. Narrowing A TRIGGER Cannot Make A Required Gate Run Sparingly — Only A Per-JOB Skip Can

A required context MUST NOT live in a `paths:`-filtered workflow. A required context
MUST instead use an UNCONDITIONAL trigger with a per-JOB relevance skip. This is the
one reduction that reads as obviously correct and is actively harmful, so the
mechanism is stated rather than assumed.

**The mechanism, stated so it survives paraphrase.** Branch protection waits for a
CHECK-RUN of that NAME to report a TERMINAL conclusion. A job that runs and is
SKIPPED still creates the check-run and reports `skipped`, and **a skipped check
SATISFIES the requirement**. A workflow whose TRIGGER did not match creates NO
check-run at all, and **a check-run that was never created can never report** — so
the PR wedges forever at "Expected — Waiting for status to be reported". The two
states are indistinguishable in the author's head ("it didn't run") and OPPOSITE at
the gate. That asymmetry is the whole clause: the reduction has to move DOWN one
level, out of the `on:` block and into the job's `if:`.

`paths-ignore:` is NOT a gate for budget purposes — a workflow ignoring `**/*.md`
still fires on every code-touching PR.

```yaml
# DO — unconditional trigger, per-job relevance skip; the context always reports
on: { pull_request: {} }
jobs: { heavy: { if: needs.detect.outputs.relevant == 'true' } }

# DO NOT — path-filter a workflow that provides a required context
on: { pull_request: { paths: ["src/**"] } } # PR wedges at "Expected"
```

**The sanctioned shape, measured at a BUILD sibling that runs it at scale.** 13 of
its 29 PR-triggered workflows carry NO `paths:` filter DELIBERATELY; in its heaviest
workflow the FIRST job re-derives the changed-path set into an output and every
downstream job gates on that output. The path set is still consulted — once, inside
the run — so the saving is kept and the context still reports. The two-state table
and why the failure reads as an infrastructure fault:
`skills/30-claude-code-patterns/ci-cost-discipline-evidence.md` §7e.

**BLOCKED rationalizations:** "the filter covers everything that matters" / "it has
always worked" / "we can add the path when someone hits it" / "a skipped check
satisfies branch protection anyway" (only when it REPORTED — that is the entire
distinction) / "narrowing the trigger is the cheapest reduction" (it is the one
reduction unavailable on a required context) / "it just won't run on those PRs,
same as a skip" (a skip REPORTS; a non-trigger does not) / "we can mark it
non-required until the filter settles" (that is MUST-1's decision, made silently).

**Why:** The originating repo shipped a `paths:` filter on a required context,
wedged PRs on it, and retracted it. A rule that told authors to reduce fan-out
without naming this exception would push them straight into it — and the wedge is
worse than the waste it was meant to cure, because a wedged PR consumes no runner
and also never merges.

### 3. Worst-Case Per-Pool Demand Is Declared And Ratcheted

Each runner pool MUST carry a declared capacity read from the LIVE runner API, and
the worst-case per-PR job count targeting that pool MUST be within
`capacity × oversubscribe`. `oversubscribe` defaults to 1.0 — one PR fits the pool.
A value above 1.0 MUST carry a written rationale AND a dated review trigger.
Raising it silently is BLOCKED.

```json
// DO — the ratchet is PINNED at today's measured value, so any ADDED job fails
"linux": { "capacity": 16, "oversubscribe": 2.125,
           "_oversubscribe_why": "floor(16 x 2.125) = 34 = today's worst case. REVIEW BY <date>." }

// DO NOT — raise the number to make the audit green
"linux": { "capacity": 16, "oversubscribe": 9 }

// DO NOT — raise it HONESTLY either. Re-deriving the sentence satisfies the
// rationale check and still buys free job slots, because a ceiling is not a pin.
"linux": { "capacity": 16, "oversubscribe": 9,
           "_oversubscribe_why": "floor(16 x 9) = 144 … REVIEW BY <date>." }
```

The ratchet is a PIN, not a ceiling: for any pool above 1.0,
`floor(capacity × oversubscribe)` MUST EQUAL that pool's worst-case census.
Headroom is not forbidden — it is *reviewed*: raise the ratio and restate its
arithmetic in the diff that needs it. The equality binds DOWNWARD too, which is the
half nothing watches: a census that SHRINKS leaves a stale-high ratchet, and the
allowance earned at 37 jobs is otherwise retained silently at 30 while the next
seven land free.

The ratchet is a measurement, so it MUST be re-derived whenever the CENSUS changes —
not only when jobs are added. A trigger-parser fix that makes previously-invisible
workflows countable moves the true worst case without a single job changing.

**When the ratchet binds, REDUCE demand — do not SPREAD it.** The pool is fixed, so
splitting one expensive pass into N parallel jobs makes nothing cheaper: it converts
one long runner claim into N simultaneous ones against the same bounded pool, and
FAN-OUT AGAINST A BOUNDED POOL IS THE ACTUAL SCARCITY. The reduction that works is
SCOPING — run the expensive pass over the units the PR changed rather than over the
whole workspace, which lowers the demand figure MUST-3 ratchets instead of
redistributing it. Measured at a BUILD sibling: a workspace-wide lint pass at 47.4
min, a feature-gated variant at 41.9, a posture matrix at 18.9, a subsystem pass at
9.2; one PR there fanned out to 16 workflow runs / 33 jobs against a pool of 24, of
which only 12 provided a required context. That repo's own recorded go-forward names
the fix in the right currency: scope the 47-minute workspace pass to the units a PR
actually changes, *"which REDUCES demand rather than spreading it."* Depth:
`skills/30-claude-code-patterns/ci-cost-discipline-evidence.md` §7d.

Scoping is the INPUT of the gate, never its OUTPUT: narrowing what an expensive pass
reads is expected, and deleting the pass, or moving it off the required set to make
the census fit, is the MUST-1 decision made silently.

**BLOCKED rationalizations:** "bump the ratio, we'll fix it later" / "the pool is
bigger than the spec says" (then update the declaration from the live API and say
so) / "jobs are gated so they won't all run" (worst case is the constraint; a PR
touching many paths fires them all) / "no jobs changed, so the ratchet still holds"
(the ratchet is computed over the census; if the census changed, re-derive it).

**Why:** Without a ceiling the fan-out only ever grows, one reasonable job at a
time, and nothing reports the moment it passed the pool. Pinning the ratchet at the
measured value makes today's state a declared position and any increase a failing
diff, while a ratio with no review date is a permanent excuse — the undated-promise
class `deferral-registry-locality.md` blocks.

### 4. Capacity Comes From The Live API, Not From The Spec

Pool capacities MUST be derived from a live query of the runner API. A capacity
copied from a spec, a README, or memory is BLOCKED, and where the two disagree the
divergence MUST be recorded rather than silently adopted.

```bash
# DO — read the authority, record any drift against the doc
gh api "orgs/<org>/actions/runners?per_page=100" --paginate
# DO NOT — copy the figure out of a CI-infrastructure spec
```

**Carve-out, named rather than left implicit:** a GITHUB-HOSTED pool does not appear
in the self-hosted runner API at all, so it MUST instead declare
`capacity_source: "github-hosted"` and name its authority (the runner-group /
billing surface). Leaving it silently exempt would make MUST-4 false about the very
declaration that ships with it. And where NO live read is available at all — no
credential, no API — the capacity MUST NOT be guessed: it is declared `null` /
`UNVERIFIED` and the audit renders UNKNOWN, never a pass. MUST-6 governs that state.

**BLOCKED rationalizations:** "the spec was verified recently" (in the originating
measurement the stale line carried a LATER verification date than a correct sibling
and was still wrong) / "the API needs a token this job doesn't have" (then declare
the figure with its verification date and let it go stale loudly) / "the doc is
maintained by the people who own the runners".

**Why:** A budget computed against a stale denominator is wrong in the direction
that hurts, and `verify-resource-existence.md` MUST-2 already holds that the live
surface is evidence and the doc is hearsay.

### 5. A Budgeted Exemption Carries A Revisit Date

An entry in the budgeted declaration MUST carry a rationale, an `added` date, and a
`revisit` date. An exemption with no revisit date is BLOCKED.

```json
// DO — the allowance has an end
{ "job": "smoke", "workflow": "x.yml", "rationale": "...", "added": "2026-08-21", "revisit": "2026-11-21" }

// DO NOT — a temporary allowance with no date is a permanent one
{ "job": "smoke", "workflow": "x.yml", "rationale": "temporarily always-on" }
```

The loom engine encodes the same requirement inside the budgeted entry's rationale:
an unexpired `REVIEW BY <YYYY-MM-DD>` is mandatory, and an entry whose rationale is
shorter than the schema's floor, carries no review date, carries a past date, or
carries one beyond the review horizon is a finding (schema:
`.claude/bin/ci-job-budget.local.example.json`, `_budgeted_why`).

**BLOCKED rationalizations:** "it's temporary, we'll remove it soon" / "a date we
won't honour is worse than none" / "the rationale explains it, the date is
redundant".

**Why:** Every exemption is added as a temporary allowance and none is revisited
unless something forces it; the date is what converts "we'll look at this later"
into a check that fails on a specific day. A stale exemption is separately flagged,
so a deleted job cannot leave its allowance behind.

### 6. An Unmeasured Capacity Reports UNKNOWN, Never A Pass

A pool's `capacity` MUST be either a positive finite integer with a
`capacity_source` naming how it was obtained, or `null` with
`capacity_source: "UNVERIFIED"`. When capacity is `null` the audit MUST report the
demand and an explicit UNKNOWN — never a pass. A non-finite or non-integer capacity
MUST fail closed.

```json
// DO — unmeasured, and says so; the audit renders no ceiling verdict
{ "capacity": null, "capacity_source": "UNVERIFIED" }

// DO NOT — a plausible number nobody measured; every later green is derived from it
{ "capacity": 20, "capacity_source": "probably the default plan limit" }
```

This is MUST-4's failure state made honest: where the live read MUST-4 mandates is
unavailable, `null` / UNVERIFIED is the only honest declaration, and the audit
renders UNKNOWN rather than deriving a green from a guess. The loom engine
implements it as a THIRD verdict — exit 2, "could not run" — and refuses an absent
declaration rather than rendering it green (`.claude/bin/ci-job-budget-audit.mjs`
usage: `Exit 0 = VALID, 1 = findings, 2 = the audit could not run`).

**BLOCKED rationalizations:** "20 is the documented default, close enough" / "a
number is more useful than null" / "we can refine it later, meanwhile it gates
something" / "Infinity means unlimited, which is true for hosted runners".

**Why:** A ceiling comparison against a guessed number is an instrument that cannot
discriminate — it renders a green "within capacity" for every input, including the
ones the check exists to catch. `Infinity` is the same failure wearing a numeric
type: a loose numeric test admits it and silently deletes the comparison for every
pool.

### 7. The Audit Is Shown Capable Of Failing Before Its Pass Is Read

`--selftest` MUST run before the audit in any automated invocation, and MUST
include, for every declared check, an input whose correct verdict is FAIL. A pass
from a gate never shown capable of failing is not evidence.

```yaml
# DO — control first, then the measurement
- run: node .claude/bin/ci-job-budget-audit.mjs --selftest
- run: node .claude/bin/ci-job-budget-audit.mjs
# DO NOT — read the green alone
- run: node .claude/bin/ci-job-budget-audit.mjs
```

**BLOCKED rationalizations:** "the audit is simple, it obviously works" / "the
selftest doubles the runtime" / "it passed on a tree we know is dirty once, that's
enough".

**Why:** An inert gate and a satisfied gate produce identical output; only an input
that SHOULD fail distinguishes them. This is `instrument-discipline.md` MUST-2
applied to the audit's own green.

## MUST NOT

- Add a job to a `pull_request` workflow without deciding which of the three states
  it is in.

  ```yaml
  # DO — decide in the same diff that adds the job
  my-check:
    if: needs.scope.outputs.relevant == 'true' # gated, or make it required,
  # DO NOT — add it and let the CI audit discover it later
  my-check: {} # unconditional, gates nothing
  ```

  **Why:** The audit fires after the diff is written and pushed; the decision is
  cheapest at authoring time, which is what the edit-time hook exists to surface.

- Ship a new workflow when a step in an existing job would do.

  ```yaml
  # DO — add a step to a job that already runs
  jobs: { existing-gate: { steps: [{ run: node scripts/ci/my-new-check.mjs }] } }
  # DO NOT — a new workflow, and therefore a new job, for one more check
  ```

  **Why:** Workflow count is the unit that multiplies: each new one adds at least
  one job to every PR forever.

- Relieve a binding pool ratchet by SPLITTING the expensive pass across more jobs, or
  by narrowing the TRIGGER of a workflow that provides a required context.

  ```text
  # DO — reduce the demand: scope the expensive pass to the units the PR changed
  # DO NOT — spread it: shard one 47-min pass into 6 jobs against the same 24-runner pool
  # DO NOT — narrow its trigger: the context stops REPORTING and the PR wedges
  ```

  **Why:** The pool is the constraint, so N shorter jobs is the same demand arriving
  at once; and a trigger narrowed on a required context replaces a slow gate with a
  PR that never merges, which is the more expensive failure.

- Report a green job-budget audit as evidence that CI is efficient.

  ```text
  # DO — report the figure and the ceiling together
  "job-budget VALID; linux worst-case 34 against a ratchet of 34 (target 1.0 = 16)"
  # DO NOT — report the colour and drop the number
  "job-budget audit green -> CI fan-out is fine"
  ```

  **Why:** The audit proves the fan-out is DECLARED, not that it is small. A pinned
  ratchet above 1.0 is a recorded problem, not a solved one.

- Remove a `paths:` filter to "be safe" without declaring the job as required or
  budgeted.

  **Why:** Removing the filter converts a relevance-gated job into a freeloader; the
  audit will fail, which is the intended feedback rather than an obstacle to route
  around.

- Add a `push`-arm filter and assume it covers the `pull_request` arm.

  **Why:** The arms are independent. A `paths:` filter on `push:` alone leaves the
  PR arm unfiltered, which is the easiest way to reintroduce a freeloader while
  believing it is gated. (The template-side copy records that its repo already
  carried exactly this shape elsewhere — see the template-side Origin record.)

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` +
  cc-architect at `/codify` confirm any diff touching `.github/workflows/**` leaves
  every PR-reachable job required, gated, or budgeted, and does not raise
  `oversubscribe` without a rationale and a review date); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — the planned edit-time guard (named
  in the deferral row below rather than backticked here, because no such file
  resolves in this repo yet) reads workflow YAML LEXICALLY, which MUST NOT carry
  `block`, and adding a CI job is legitimate work a guard must not wedge.
- **Grace period:** 7 days from rule landing at loom (2026-08-21 → 2026-08-28).
- **Cumulative posture impact:** same-class violations (an ungated non-gating job
  added; a required context placed behind a `paths:` filter or any other narrowed
  TRIGGER; a binding pool ratchet relieved by splitting one expensive pass across more
  jobs instead of scoping it; `oversubscribe` raised
  without a rationale or a review date; a capacity copied from a doc) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1
  posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO
  dedicated per-clause key. Whether a job "gates something" is review-layer judgment
  over a workflow diff, and minting a key would drag `trust-posture.md`, a
  `self-referential-codify.md` allowlist file, into a self-referential edit. Named
  deviation from the key-per-clause shape per `trust-posture.md` Rule 8 — the same
  disposition `security.md` § Enforcement-Surface Parity and `git.md` §
  CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: ci-job-budget]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** review-layer PLUS an edit-time advisory and two offline
  tiers. **Every path named below resolves in this repo — an earlier revision of
  this field recorded that none of them did, and that record was accurate when it
  was written.** What runs: (a) reviewer at `/implement` + cc-architect at
  `/codify` inspect any diff touching `.github/workflows/**` and confirm the
  three-state disposition of every added job and the SUBSTANCE of any
  `oversubscribe` rationale; (b) the edit-time hook
  `.claude/hooks/ci-job-budget-guard.js`, registered on the `PostToolUse`
  `Edit|Write|NotebookEdit` matcher in `.claude/settings.json`, which classifies a
  freshly-edited `pull_request` workflow through the audit engine's own exported
  classifier and emits at `advisory` — never `block`, because the trigger is a
  LEXICAL read of workflow YAML and `hook-output-discipline.md` MUST-2 bars a
  lexical detector from denying a call. When the engine does not resolve the hook
  fails OPEN but NOT silent: it emits an advisory naming exactly what went
  unchecked, because a guard that returned quiet there would present as coverage
  while checking nothing (`verification-gate-integrity.md` MUST-2), and it ships
  on the sync `ALWAYS_INCLUDE` surface, so that silence would have been delivered
  to every consumer; (c) the structural fixture battery
  `.claude/audit-fixtures/ci-job-budget-guard/run.mjs`, registered in
  `.claude/test-harness/ci-audit-fixtures.json` so `run-audit-fixtures.mjs`
  executes it, bipolar on every firing arm and carrying a mutation mode that
  rewrites only a copy in a temp tree; (d) the SEMANTIC tier — probe suites
  `.claude/test-harness/probes/ci-job-budget.probes.json` (this rule: MUST-1..4
  bipolar pairs plus a meta-compliance pair, candidates at
  `.claude/audit-fixtures/ci-job-budget/`) and
  `.claude/test-harness/probes/ci-job-budget-guard.probes.json` (the hook's
  advisory-characterization property), both registered in
  `.claude/test-harness/eval-manifest.json` as probe-only entries
  (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`.
  **What registration buys is DISPATCHABILITY, never automatic execution:** no
  workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI
  LLM-free, so a green CI run is NEVER evidence these probes passed — they execute
  only when an orchestrator dispatches `/test-harness-probe --artifacts` at
  gate-review. **Consumer note:** `.claude/test-harness/ci-audit-fixtures.json`,
  `.claude/test-harness/eval-manifest.json`,
  `.claude/test-harness/probes/ci-job-budget.probes.json` and
  `.claude/test-harness/probes/ci-job-budget-guard.probes.json` do NOT ship to
  use/base, build/base, use/py, build/py, use/rs or build/rs (MEASURED: `skip` on
  6 of this rule's 6 lanes), so no consumer on those lanes receives them; at those
  targets tiers (c) and (d) are not live gates, and each is declared in
  `.claude/test-harness/detector-distribution-baseline.json`. What DOES reach
  every consumer is tier (b), the edit-time hook, which rides the sync
  `ALWAYS_INCLUDE` hooks surface — which is exactly why its engine-absent path had
  to speak rather than fall silent. TWO things still do NOT run and are NOT
  registry-backed: (1) the
  census/audit engine ITSELF — `.claude/bin/ci-job-budget-audit.mjs` has LANDED
  (commit 70d8b74a7 split it from its deployment declaration; the hook's
  engine-absent path now fires only on trees that lack it), but MEASURED at loom
  2026-10-06 NO `.github/` workflow invokes it (a search for the `job-budget`
  token under `.github/` returns nothing, against a control finding the same
  token in this rule's registered probe suites), so the engine's exit-code teeth are armed and
  undispatched here; the hook's engine-absent advisory remains what fires where
  the engine is genuinely absent, which is why that advisory had to be loud
  rather than silent. And (2) the live-capacity
  reconciler for MUST-4, which
  has NO scheduled reader in ANY repo because it needs an `admin:org` credential
  no configured secret carries. Both were identified at Gate-1 with a proposed
  2026-11-19 backstop, and both are BLOCKED from registration by
  `completion-criterion.md` MUST-6: a residual "is not self-accepting",
  `phase2-deferral-integrity.mjs` requires an acceptance receipt matching the exact
  `(key, accepted_by, expires)` triple, and no such receipt can be written without
  a human acceptance turn. That ceremony is OWED to the repo owner and is the
  gating next action for MUST-4's operand check specifically.
- **Violation scope:** MUST-1 (three-state disposition) + MUST-2 (any narrowed TRIGGER
  on a required context — `paths:`, `paths-ignore:` or branch/event narrowing — where
  the sanctioned shape is an unconditional trigger plus a per-JOB skip) + MUST-3
  (undeclared or silently-raised worst-case demand, INCLUDING relieving a binding
  ratchet by spreading one pass across more jobs rather than scoping it) +
  MUST-4 (capacity from a doc rather than the live API, or a ceiling exemption taken
  as a config side-effect rather than a dated declaration). A census blind spot — a
  workflow yielding zero jobs, or a job fanning out through a reusable workflow — is
  a violation of EVERY clause simultaneously, because each is only as true as the
  set of jobs it was computed over.
- **Origin:** See § Origin.

## Trust Posture Wiring — Template-Side Clauses (MUST-5..7, unioned 2026-10-06)

Applies to **MUST-5, MUST-6 and MUST-7** ONLY — the clauses unioned in from the rs
USE template's locally-authored copy at the P17 Gate-1 intake (operator-ratified
UNION-MERGE, nothing dropped from either side). Their parent artifact set originates
at loom#1877 and was adapted template-side 2026-08-21. MUST-1..4 stay on the
rule-wide block above — the clause-scoped precedent `security.md` §
Enforcement-Surface Parity and `git.md` § CI-check/merge set.

- **Severity:** `block` at the CI layer WHEREVER the census audit is invoked — its
  exit code is derived from parsed workflow YAML and a parsed declaration, the
  narrow class `hook-output-discipline.md` MUST-2 reserves `block` for. MEASURED at
  loom 2026-10-06: no `.github/` workflow invokes it, so the `block` half is armed
  and UNDISPATCHED here, and the live layers at loom are `halt-and-report` at
  gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a new
  PR-reachable job was declared, and the SUBSTANCE of any exemption's revisit
  date) and `advisory` at the edit-time hook layer — naming a job ungated at edit
  time is a LEXICAL read of workflow YAML, and adding a CI job is legitimate work a
  guard must not wedge.
- **Grace period:** 7 days from the clauses' original landing on the template-side
  lane (2026-08-21 → 2026-08-28) — already elapsed. The union re-homes these
  clauses into this rule; it does not restart their grace, and the same obligation
  has been in force at loom since this rule's own landing.
- **Cumulative posture impact:** same-class violations (a budgeted exemption with
  no revisit date; a guessed capacity presented as measured; a non-finite capacity
  admitted through a loose numeric test; an audit green read without its
  `--selftest` control) contribute to `trust-posture.md` MUST-4 cumulative-window
  math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger
  per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause
  key. Named deviation per `trust-posture.md` Rule 8: the CI gate already refuses
  the violating state structurally wherever it runs, so the residual review-layer
  judgment does not warrant an instant-drop key — the same disposition
  `artifact-flow.md` § Owned-Surface Bound took for the same reason.
- **Receipt requirement:** SessionStart soft-gate `[ack: ci-job-budget]` IFF
  `posture.json::pending_verification` includes the `ci-job-budget` rule_id
  (shared rule_id; one ack covers MUST-1..7).
- **Detection mechanism:** on the template-side lane these clauses shipped with a
  CI-run census audit whose `--selftest` negative control runs in the SAME job and
  BEFORE the audit, with an edit-time hook that is advisory and NO probe suite —
  that copy declared its semantic tier UNCOVERED and owed at gate-review. At loom
  the structural authority is the same engine named in the rule-wide block above
  (`.claude/bin/ci-job-budget-audit.mjs`), whose hook, fixture battery, probe
  suites and registries are the binding recorded THERE and not duplicated here. The
  template-side copy's own detection paths are deliberately NOT cited — they do not
  resolve in this repo, and a Detection field naming a non-resolving path is the
  dangling-citation defect `detection-binding-check.mjs` reds.
- **Invoker class:** `runtime` AND `agent-mid-procedure` — `.claude/hooks/ci-job-budget-guard.js`,
  registered on the `PostToolUse` `Edit|Write|NotebookEdit` matcher, is the `runtime` backer
  (advisory, no command typed). Gate-review per § Severity is the `agent-mid-procedure` half,
  so this block does NOT discharge.
- **Violation scope:** MUST-5 (a budgeted exemption carrying no revisit date) +
  MUST-6 (an unmeasured or non-finite capacity rendered as a verdict) + MUST-7 (an
  audit pass read without its `--selftest` control). MUST-1..4 keep their scope
  under the rule-wide block above.
- **Origin:** 2026-08-21 — the clauses were applied on the rs USE template from
  loom#1877 (which proposed the upstream `ci-job-budget`
  artifact set from the kailash-rs BUILD repo) under a user-authorized cross-repo
  READ of that issue, directed in-session: _"the intent is to understand the full
  surface of this problem and its root cause, so that you can address it IN THIS
  REPO. Get it done now, don't wait for loom to cascade down."_ Unioned into this
  rule at loom 2026-10-06 (P17 Gate-1 intake); clause attribution in
  `## Union Provenance`.

## Distinct From / Cross-References

- **Distinct from** `ci-runners.md` — that governs runner HEALTH and routing (which
  pool a job belongs on, how to clear a zombie). This governs how MANY jobs a PR is
  allowed to cost, whatever their routing.
- **Depends on** `verification-gate-integrity.md` MUST-1 for the audit's own
  negative control once that engine lands, and MUST-2 for why a `paths:`-filtered
  required context is absence rather than a pass.
- **Inherits** `verify-resource-existence.md` MUST-2 for MUST-4's live-API rule.
- **Composes with** a CI-FOOTPRINT measure — the live count of runners a repo holds
  right now, and a cap on concurrent open PRs. That surface is NOT a landed rule in
  this repo and is named as a concept rather than cited as a file, because no path
  for it resolves here. The two measures multiply: concurrency is the cascade,
  per-PR fan-out is the multiplicand, and a merge queue fixes only the former.

## Union Provenance — Clause Attribution (2026-10-06)

This rule is the UNION of loom's copy and the rs USE template's locally-authored
copy (both trace to loom#1877), merged at the P17 Gate-1 intake under the operator's
ratification: **union of both files' content, no side dropped**. This table is the
traceability record; where a unit is a union, BOTH sides' text survives inside it.

| unit | side | provenance note |
| ---- | ---- | --------------- |
| title | union | loom's title, extended with the template copy's "declared act, never a silent one" framing |
| intro ¶1–3 | loom | unchanged |
| intro ¶4 (accretion) | template-side | the template copy's opening paragraph; the 33-jobs / pool-24 / 12-required measurement is the shared loom#1877 evidence |
| intro ¶5 (union pointer) | intake note | the Gate-1 union statement itself, pointing at this table |
| MUST-1 | union | loom's three-state clause, carrying the template's *freeloader* naming, its declaration-entry sentence, its extra BLOCKED rationalizations and its Why sentence |
| MUST-2 | loom | unchanged |
| MUST-3 | loom | unchanged |
| MUST-4 | loom | + one composition sentence: an unmeasurable pool goes UNVERIFIED, per MUST-6 |
| MUST-5 | template-side | the template copy's MUST-2 (revisit date); example re-homed to the loom engine's `REVIEW BY` encoding |
| MUST-6 | template-side | the template copy's MUST-3 (UNKNOWN, never a pass); + the loom engine's exit-2 third verdict |
| MUST-7 | template-side | the template copy's MUST-4 (`--selftest` before reading a pass); example re-homed to the loom engine's invocation |
| MUST NOT | union | loom's four bullets + the template's two |
| Trust Posture Wiring (rule-wide, MUST-1..4) | loom | detection amended: the census engine has LANDED and is now cited by path; its CI-invocation absence is measured |
| Trust Posture Wiring — MUST-5..7 | template-side | the template copy's wiring, adapted; its non-resolving detection paths deliberately not cited |
| Origin — loom's narrative | loom | unchanged |
| Origin — template-side record | template-side | the template copy's origin narrative, adaptation rationale, carried-over design properties and placement/durability reasoning |

## Origin

2026-08-20, BUILD stream (`coc-build` lane), landed at loom 2026-08-21 via
`/sync-from-build` Gate-1 placement of the proposal filed as loom #1877. While
diagnosing why one repo was holding most of a shared org runner pool, the owner
asked the question a footprint measure had not: _how can ONE PR fan out and saturate
most of the pool?_ Measured on a single pull request touching only workflow files
and one JSON file: 16 workflow runs, 33 jobs each consuming a runner against a pool
of 24, of which only **12** provided a required context — **21 gated nothing**,
eleven of them heavy compile jobs. Worst-case demand on the busiest pool was 39 jobs
against a capacity of 16. A single PR could not validate without saturating the
fleet; two concurrently was structurally impossible.

The owner's framing, recorded because it is the more accurate diagnosis: this is
resource-to-requirement matching, and it had not been done — jobs were added
individually, each defensibly, with nothing measuring the total against what the
pool could serve.

One correction the evidence forced, kept because it bounds the rule: the relevance
skip was NOT the defect. A workflow legitimately in its own relevant-path set
correctly earns its full matrix when edited, and half the PR-triggered workflows
already carried `paths:` filters. The failure was narrower — a correct and expensive
discipline (unconditional trigger + per-job skip) implemented in exactly ONE
workflow and never extended, while ungated non-gating jobs accumulated against a
pool nobody was measuring against.

**Adoption rationale at loom — CASCADE, never self-use.** Measured 2026-08-21, loom
has ONE `pull_request` workflow and THREE check contexts; it does not have the
fan-out problem and adopting this rule buys loom nothing directly. It is adopted
because loom is the splitter for repos that DO have it and that contend for the same
shared pool, so the ratchet reaches them only by being carried here. Any report that
frames this rule as improving loom's own CI is wrong on the measurement.

**Amended 2026-09-01 (loom, gate-cost lane) — BP-105, from a second BUILD sibling
(kailash-rs), authorized read.** MUST-2 previously stated the RULE without its
MECHANISM, which is what makes the rule survive being paraphrased into its own
opposite ("just add a `paths:` filter" is the naive reading of every cost-reduction
brief). The mechanism now stated — a SKIPPED job SATISFIES branch protection because
the check-run was created and reported; a never-created check-run does NOT, because
branch protection is waiting on a NAME that will never appear — is the single most
transferable constraint the sibling had measured, and it is expensive to learn any
other way: the failure is a PR wedged at "Expected — Waiting for status to be
reported", which looks like an infrastructure fault rather than an authoring
mistake. Corroboration MEASURED there, not asserted here: 13 of its 29 PR-triggered
workflows carry no `paths:` filter deliberately, and its heaviest workflow re-derives
the changed-path set in its FIRST job so every downstream job can gate on the output
while the context still reports. The demand-reduction paragraph added to MUST-3 comes
from the same read — its clippy figures (47.4 / 41.9 / 18.9 / 9.2 min) and its 16-run
/ 33-job / 24-runner fan-out, with its own recorded go-forward that the fix is to
scope the expensive pass to what the PR touches, *"which REDUCES demand rather than
spreading it."* Scrub: workflow filenames, job names, crate names, runner labels and
its internal issue number are omitted per this rule's own § Scrub record; the
durations and counts are generic and are kept because they are what makes the
trade-off legible.

**Gate status at landing, stated rather than implied:** `.claude/rules/**` is
`self-referential-codify.md` TIER 1 and this amendment was authored by ONE lane. The
multi-agent redteam round that tier requires is **UNSATISFIED** at this commit.

**Scrub record (Gate-1, `upstream-issue-hygiene.md` MUST-2 +
`knowledge-cascade-routing.md` MUST-3).** The cascading copy carries the GENERIC
principle only. Removed at placement: self-hosted runner labels and host
identifiers, per-pool capacity figures and the fleet total, the originating repo's
workflow filenames and PR number, its internal spec path and line numbers, its
internal finding tag, its branch names, its workspace/wave id, and its local
deferral-registry paths. The specific provenance stays in the local Gate-1 receipt,
not in the artifact that cascades. Pool names in the examples above (`linux`) are
illustrative placeholders, not a declaration of any real fleet.

### Template-side Origin record (rs copy, unioned 2026-10-06)

Kept because the union drops nothing from either side. Read every "this repo"
below as the template-side repo, never loom.

The template-side copy recorded its own repo's census at authoring (2026-08-21):
**7 PR-reachable jobs, 3 required, 6 relevance-gated, 0 freeloaders** — the rule
exists there so that stays true **by construction rather than by discipline**.
Adding a job is legitimate; the goal is that it becomes a _declared_ act, not that
it is refused.

**What the template-side copy adapted rather than copied, and why.** The upstream
declaration encodes pools and capacities for a self-hosted fleet; every job there is
`ubuntu-latest`, a single GitHub-hosted pool whose concurrency ceiling is an
account-plan property no configured secret can read. That is upstream's own
decision point 3 (_"the capacity number has no scheduled reader"_) arriving as a
live constraint rather than a deferred one. Rather than inherit a fleet-shaped
declaration or invent a plausible integer, capacity is declared `null` /
`UNVERIFIED` and the audit renders UNKNOWN for it — so the gate that actually bites
there is the freeloader check, which is fully decidable from the workflow files.
Setting a measured capacity later activates the ceiling arm with no code change.

**Carried over from upstream as design properties, because upstream records each as
hard-won:** the Detection field does not restate a case count; the anti-vacuity
floor (`every-check-has-a-negative-control`) fails loudly when a check is added with
no result; the audit fails closed on a non-finite capacity, which a mutation showed
a loose numeric test admits; and the edit-time layer is advisory rather than
blocking.

**Placement is durability-driven (template-side reasoning).** On that lane the
audit and declaration live under its `.github/`, measured non-synced there — the
manifest declares exactly one `.github/` surface and scopes it to the `py` lane
("rs ships none"), and no sync commit has ever written its `.github/workflows/`
(control: syncs _did_ write `.claude/hooks/`). A `.claude/bin/` placement would have
been Class-A non-durable and rebuilt away on that lane. That rule file itself is in
the synced tree and therefore non-durable there; its durable surface is the paired
proposal entry. At loom the same tension resolves the other way: the engine ships as
`.claude/bin/ci-job-budget-audit.mjs` with its deployment declaration fenced from
sync as a `.local.json` under `.claude/bin/`.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is over the 200-line guidance (the 2026-10-06 union moved it
well past the ~300-line band the pre-union copy occupied; stated as a band rather
than an exact count, which drifts on every edit). Named rationale:
**budget-contract completeness** — seven MUST clauses now, and each names a
STRUCTURALLY DISTINCT way a per-PR fan-out escapes accounting: the loom-side four (an
undeclared job, a required context hidden behind a `paths:` filter, an unratcheted
pool ceiling, a capacity copied from a doc) plus the template-side three (a budgeted
exemption with no revisit date, an unmeasured capacity rendered as a pass, an audit
pass read without its selftest control). Each carries the DO/DO-NOT + BLOCKED corpus
+ `**Why:**` the meta-rule mandates PLUS the canonical-8-field Trust-Posture Wiring.
Collapsing any one re-opens the escape it names, and MUST-2 in particular cannot be
dropped: it is the reduction that looks obviously correct, was shipped in the
originating repo once, and wedged PRs there. The rule is `priority: 10` +
`scope: path-scoped`, so it pays NO baseline-emission cost and Rule 10's proximity
band does not fire. The loom copy is shorter than the pre-union source: the
originating Detection field enumerated per-check enforcement names for an engine
that had not landed; since the engine landed, that field cites it by path and
measures its CI-invocation absence instead. Sibling precedent: the length rationales
carried by `security.md` and `verification-gate-integrity.md`.
