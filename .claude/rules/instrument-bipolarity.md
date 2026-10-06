---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/bin/**"
  - "**/.claude/hooks/**"
  - "**/.claude/audit-fixtures/**"
  - "**/.claude/test-harness/**"
  - "**/.github/workflows/**"
  - "**/tests/**"
  - "**/*.test.*"
  - "**/*_test.*"
  - "**/test_*.py"
---

# Instrument Bipolarity — Discrimination Is Recorded At AUTHORSHIP

`instrument-discipline.md` MUST-1 fires when a check is CITED; this fires when one is WRITTEN,
where the author is worst-placed to see the gap. **Forward-only** — new and modified checks. A
check **CAN GATE** if its result may block a merge, fail CI, halt a `/redteam`/`/codify` gate,
or be cited as a convergence signal; a session diagnostic is not one. A **POLE PAIR** is two
executable inputs plus expected verdicts: a **RED pole** the check MUST reject, a **GREEN
pole** it MUST accept. Examples, BLOCKED corpora, Wiring rationale, cost analysis, Origin:
`.claude/guides/rule-extracts/instrument-bipolarity.md`.

## MUST Rules

### 1. A Gating Check Ships An Executable Pole Pair, Run By The Same Harness

Every added or modified gating check MUST ship both poles, executable by the harness that runs
it, and the harness MUST assert the verdicts DIFFER. Identical verdicts is a VACUOUS pair and
MUST fail; a red pole that stops redding is DISARMED and MUST fail.

**Why:** A green from an instrument never shown to red is consistent with a working check and
with one that cannot fail. The regress ends at depth 1: a pole pair is a MEASUREMENT, not a
claim.

### 2. The RED Pole Names A Failure IDENTITY, Never Merely A Quantity

The red pole MUST declare the expected failure IDENTITY — error code, finding id, message key
— and the harness MUST match the OBSERVED failure against it. Asserting only a non-zero exit,
non-empty output, or a count is BLOCKED.

**Why:** An exit code is a QUANTITY, a failure reason an IDENTITY, and substituting the first
survives the obvious repair — measured three of three. Without this the rule mandates a
ceremony the same reflex satisfies vacuously.

### 3. A Check Whose Poles Cannot Be Built Is ADVISORY And MUST NOT Gate

Where a pole is genuinely infeasible — needing a live outage, a race, or credentials the
harness must not hold — the check MUST be declared ADVISORY with the infeasibility named, and
MUST NOT gate. Keeping its teeth, or recording that as a waiver against MUST-1, is BLOCKED.

**Why:** A failing gate gets waived under pressure and the waiver is where the exemption
hardens; "may not GATE" needs no waiver.

### 4. A Check's Prose MUST NOT Claim A Guarantee Its Code Does Not Implement

Any comment or docstring asserting a safety property — *fails closed*, *refuses*, *asserted
by*, *validates*, *cannot* — MUST name the implementing line, and that path MUST be REACHABLE
for the input class the claim covers. A claim whose path cannot fire is BLOCKED; deleting it
is an acceptable fix.

**Why:** A false safety claim buys an unearned pass when scrutiny is scarcest, and reaches a
population the poles do not: prose-vs-code catches the instrument that LIES, the pole pair the
one that is SILENT.

## MUST NOT

- **Ship a lexical detector over these shapes** — it could not discriminate either, and
  `block` on lexical evidence is barred by `hook-output-discipline.md` MUST-2.
- **Count a second check as corroboration when it DERIVES its answer from the first** — an
  alias moves with what it was meant to cross-check.
- **Read a non-reddening mutation as vacuity when it stayed inside the blind spot** — mutate
  the SCOPE, not only the guard.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify`, reviewer at
  `/implement`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 —
  permanently, since a lexical detector here is BLOCKED above.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (enumerated under § Violation scope)
  contribute to `trust-posture.md` MUST-4 cumulative math.
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger — NO dedicated key;
  named deviation per `trust-posture.md` Rule 8, reasoning in the extract.
- **Receipt requirement:** SessionStart soft-gate `[ack: instrument-bipolarity]` IFF
  `posture.json::pending_verification` includes the `instrument-bipolarity` rule_id.
- **Detection mechanism:** SPLIT. **(a) STRUCTURAL — feasible, OWED, NOT claimed to exist
  today.** **(b) SEMANTIC — PERMANENTLY review-only, RETIRED not pending;** NOT A DEFERRAL, no
  registry entry owed. **Probes: REGISTERED** —
  `.claude/test-harness/probes/instrument-bipolarity.probes.json` (8 rows, 4 bipolar pairs;
  fixtures `.claude/audit-fixtures/instrument-bipolarity/`; probe-only; pinned in
  `probe-suite-integrity.test.mjs`). Registration buys DISPATCHABILITY, never execution — a
  green CI run is NEVER evidence these probes passed.
- **Violation scope:** MUST-1 (no/vacuous pair), MUST-2 (quantity-only red pole), MUST-3 (teeth
  without a pole), MUST-4 (unimplemented prose guarantee); each row names check + MUST.
- **Origin:** See § Origin.

Origin: 2026-08-18 — co-owner-directed origination; receipt-first `journal/0581`, amended by
`journal/0582`. Sixteen non-discriminating instruments landed in ONE session with
`instrument-discipline.md` in baseline context, FOUR by agents actively hunting the class:
comprehension was not the failure, so this adds a MECHANISM at authorship. Path-scoped on
REACHABILITY grounds; `paths:` was NOT narrowed to fit the injection budget — the depth was
extracted instead (`rule-authoring.md` Rule 10 path (a)). Narrative:
`.claude/guides/rule-extracts/instrument-bipolarity.md`.
