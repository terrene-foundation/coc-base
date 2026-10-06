---
priority: 10
scope: path-scoped
paths:
  - ".github/workflows/**"
---

# Reusable-Workflow Fan-Out Is Counted At The CALLER

A job that dispatches a reusable workflow is one line in the caller and N jobs on
the fleet. A budget computed over the caller's own job list is therefore
computed over a census that is missing every job the callee expands into, and a
census that is wrong is not a small error in the budget — it is the denominator
of every figure derived from it.

## MUST Rules

### 1. A Caller Job MUST Be Counted As The Callee's Full Expansion

A job whose body is a `uses:` reference to a reusable workflow MUST contribute
that workflow's ENTIRE expanded job count to the caller's per-pool demand, not
1. Where the expansion is matrix-driven, the count MUST be the matrix's
worst-case cardinality. Counting such a job as 1 is BLOCKED.

```yaml
# DO — the caller's demand includes the callee's 12-job matrix
budget: caller.yml::heavy -> 12 jobs (reusable-matrix.yml, worst case)

# DO NOT — one line in the caller read as one job on the fleet
budget: caller.yml::heavy -> 1 job
```

**BLOCKED rationalizations:**

- "The caller only declares one job, so one job is what it costs"
- "The callee has its own budget entry, so counting it twice would inflate"
- "The matrix usually resolves to two or three, not twelve"
- "The audit passes either way, so the count does not matter here"

**Why:** A caller job counted as 1 understates demand by the callee's full
cardinality, so every per-pool figure derived from that census reports headroom
the fleet does not have.

### 2. A Workflow Yielding ZERO Jobs MUST Fail The Census, Not Pass It

A workflow the parser resolves to an empty job list MUST be reported as a census
FAILURE naming the file. Treating zero jobs as zero demand is BLOCKED: an
unparseable workflow and a genuinely empty one are indistinguishable in the
output and opposite in meaning.

```text
# DO — the empty result is a finding, and names the file
census: FAIL — reusable-matrix.yml yielded 0 jobs; parser could not resolve it

# DO NOT — the empty result is folded into the total as zero cost
census: OK — 31 jobs across 6 workflows
```

**BLOCKED rationalizations:**

- "It returned an empty list, so there is nothing to count"
- "The workflow is probably a template with no jobs of its own"
- "A parse failure would have thrown"

**Why:** A silent zero is the one census error that makes the budget MORE likely
to pass, so it is invisible in exactly the runs it corrupts.

## MUST NOT

- Report a per-pool worst case computed over a census that any arm reported
  incomplete.

**Why:** A budget is only as true as the job set it was computed over, so a
figure carried forward from an incomplete census is a confident wrong answer.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` +
  cc-architect at `/codify` confirm every `uses:` job in a counted workflow was
  expanded, and that no census arm reported an empty job list); `advisory` at the
  hook layer per `hook-output-discipline.md` MUST-2 — reusable-workflow expansion
  is judgment-bearing over the callee's matrix, with no tool-call-time signal.
- **Grace period:** 7 days from clause landing (2026-08-21 → 2026-08-28).
- **Cumulative posture impact:** same-class violations (a `uses:` job counted as
  1; a zero-job workflow folded into the total) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total
  in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC
  `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× =
  drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the
  key-per-clause shape per `trust-posture.md` Rule 8: census expansion is a
  review-layer judgment, and minting a key would drag `trust-posture.md`, a
  `self-referential-codify.md` allowlist file, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: reusable-fanout-census]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at
  `/implement` + cc-architect at `/codify` inspect any diff changing a counted
  workflow and confirm each `uses:` job carries its callee's worst-case
  cardinality and that no workflow contributed zero jobs silently. Structural:
  the zero-job census arm is covered by the fixture battery at
  `.claude/audit-fixtures/reusable-fanout-census/`, which asserts both poles — an
  unresolvable workflow reds the census, a genuinely empty one is reported by
  name rather than folded into the total. MUST-1's matrix half has NO structural
  detector and is Phase 2 RETIRED, not pending: worst-case cardinality is not
  decidable from a lexical read of the caller, so none will be built and no
  further fixtures are owed for it. Gate-review is that half's enforcement layer,
  permanently.
- **Violation scope:** MUST-1 (caller-side undercount) + MUST-2 (silent zero-job
  census). Every violation row names the workflow and the count it carried.
- **Origin:** See § Origin.

## Origin

2026-08-20 — measured during a fan-out audit. The census reported 31 jobs across
six workflows and the budget passed on every pool. Re-run with caller expansion
enabled, the same tree reported 33 runner-consuming jobs against a pool of 24,
and one workflow had been contributing 0 because the parser could not resolve
its `uses:` body. Both defects made the budget MORE likely to pass, which is why
neither surfaced until the queue did.
