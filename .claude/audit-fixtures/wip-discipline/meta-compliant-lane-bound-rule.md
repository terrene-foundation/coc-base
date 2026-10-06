---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - ".claude/hooks/**"
---

# Lane Inventory Bound — A Container Is Not A Deliverable

A branch or a worktree holds value only once its content reaches the default branch. Until then it
is inventory, and inventory that nobody counts grows until it is re-derived instead of finished.
Depth, derivation and the measured corpus: `.claude/guides/rule-extracts/lane-inventory-bound.md`.

## MUST Rules

### 1. An Open Lane Count MUST Be Bounded At OPEN, Not Reported At CLOSE

An operator MUST NOT hold more than **5** concurrent open lanes. A dispatch at or over the bound
MUST emit a report naming the bound, the observed count, and every open lane with its age. Opening
because work is available, rather than because capacity exists, is BLOCKED.

```text
# DO — "5/5 open (oldest fix/x, 31h). Land or kill one, then open."
# DO NOT — open lane six · "they are all small" · "I will close them all at the end"
```

**BLOCKED rationalizations:**

- "they are all small"
- "the bound is for humans; agents run in parallel"
- "this one is urgent"
- "the parallel-dispatch default says fan out" (it does — WITHIN capacity)
- "I will close them all at the end of the wave"

**Why:** Every other surface here detects inventory AFTER it exists; this is the only clause that
stops it being created, and the corpus that produced this rule had no ceiling anywhere — 53
worktrees and 306 branches accumulated against no bound at all.

### 2. An Age BASIS MUST Be CREATION, Never Directory mtime

Lane age MUST derive from creation — the worktree's own reflog, or the branch's first unique
commit — and MUST NOT derive from `stat` mtime. A surface reporting age MUST name its basis so a
reader can tell which question was answered.

```text
# DO — ageHours from the worktree reflog's first line; basis stated in the report
# DO NOT — ageHours from stat().mtime (any later touch makes rot read as fresh)
```

**BLOCKED rationalizations:**

- "mtime is close enough"
- "nothing touches these directories anyway"
- "the reflog is harder to parse"
- "both numbers were in the same range last time I checked"

**Why:** mtime can only ever err in one direction — it makes an old lane look young — so a surface
built on it fails exactly when the lane is most overdue. Measured: a tree reported at 11.1h from
mtime whose reflog showed 44h.

## MUST NOT

- Report a lane surface as a count without its age distribution and the lanes past bound.

**Why:** A count cannot separate healthy flow from rot, so it trains its reader to scroll past —
measured at 63% noise, after which the surface was correctly ignored.

- Delete a branch or worktree carrying unique unpushed content in order to reduce a number.

**Why:** Draining inventory by destroying it converts a queueing problem into a data-loss one; the
disposition is land-or-kill DECIDED, never discarded.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at the hook layer for MUST-1 and MUST-2 — both signals are
  structural, so `hook-output-discipline.md` MUST-2 would permit `block`; it is refused because
  whether a lane should open is the operator's judgment.
- **Grace period:** 7 days from rule landing (2026-08-22 → 2026-08-29).
- **Cumulative posture impact:** same-class violations (a lane opened past the bound; an age
  reported from mtime; a surface reported as a bare count) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — NO dedicated key. Named deviation per `trust-posture.md` Rule 8:
  the loss is non-corrupting and every commit remains landable.
- **Receipt requirement:** SessionStart soft-gate `[ack: lane-inventory-bound]` IFF
  `posture.json::pending_verification` includes the `lane-inventory-bound` rule_id.
- **Detection mechanism:** structural + review. The shipped detector is
  `.claude/hooks/lane-bound-guard.js` on the `PreToolUse:Task|Agent` and `SessionStart` matchers;
  its bipolar fixtures are `.claude/audit-fixtures/lane-inventory-bound/run.mjs`, registered in
  `ci-audit-fixtures.json` with a `min_cases` floor taken from an actual run. The semantic tier is
  `.claude/test-harness/probes/lane-inventory-bound.probes.json`, registered in
  `eval-manifest.json` as a probe-only entry.
- **Violation scope:** MUST-1 (the open bound) + MUST-2 (age basis) + both MUST NOT bullets. Every
  `violations.jsonl` row names the lane and the clause.
- **Origin:** See § Origin.

## Origin

2026-08-22 — operator-directed origination after a forest survey measured 53 worktrees (p50 32.6h,
p90 285.0h, max 476.9h) and 306 branches against no bound of any kind. Acceptance criteria were
written and ratified BEFORE implementation per `completion-criterion.md` MUST-1, so the party
satisfying the list did not author its thresholds. Full record: the paired extract § Origin.
