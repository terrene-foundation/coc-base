---
id: "SWEEP"
name: sweep
description: "/sweep management decision report contract + deferred-quality product-visibility revisit (Sweep-N). Depth for commands/sweep.md; classifier owned by product-completion-first.md."
---

# /sweep — Management Decision Report + Deferred-Quality Revisit (depth)

`commands/sweep.md` runs the outstanding-work sweeps; THIS skill carries the two load-bearing
depth surfaces the command references: (1) the **management decision report** the sweeps
aggregate into, and (2) the **Sweep-N product-visibility revisit** teeth for the
deferred-quality backlog. The finding CLASSIFIER (BUG / INVEST-NOW / INCREMENTAL, severity
decoupled, fail-closed) is OWNED by `rules/product-completion-first.md` — referenced here per
`rules/specs-authority.md` Rule 9, never restated.

## 1. The management decision report contract (the `/sweep` deliverable)

`/sweep` is the **decision gate**: a professional, high-quality management report FOR
DECISION-MAKING AT THAT JUNCTURE — invoked on demand, as the end-of-cycle gate before
`/wrapup`, and at product-visibility milestones (terminal wave converges / release tag). It
MUST produce, in this order:

1. **Completion status** — which product milestones are complete AND _visible_ (walking-skeleton
   stands vs not); what fraction of the committed scope is done. Cite the durable receipt
   (merged PR / journal DECISION / spec success-criterion) for each "complete" claim
   (`rules/verify-resource-existence.md` MUST-4 — no self-attested completion).
2. **ETA to completion** — remaining BUG + INVEST-NOW work to a complete/visible product, in
   **autonomous cycles** (sessions), NEVER human-days (`rules/autonomous-execution.md`). State
   the basis (which open items, at what per-item cycle estimate).
3. **Prioritized immediate queue** — the open BUGs + INVEST-NOW issues, value-ranked
   (`rules/value-prioritization.md` MUST-1, each anchored to a user-anchored source), each with
   its implication.
4. **Deferred-quality backlog** — the INCREMENTAL items, grouped by revisit trigger
   (`after-milestone:<name>` | `on-demand`), each with its value-anchor + why-deferred + the
   four generalized-1b conditions (blocking-safety note / value-anchor / acceptance criteria /
   revisit trigger).
5. **Decision points** — the INVEST-NOW-vs-defer JUDGMENT calls, each surfaced with
   prioritization + implications + **symmetric pros/cons** + a recommended disposition
   (`rules/recommendation-quality.md` MUST-1/2/3), for co-owner direction. The agent NEVER
   silently self-decides a judgment-bucket item (`rules/product-completion-first.md` MUST-4).
6. **Recommendation** — the agent's recommended next steps, for ratification (never a bare menu;
   `rules/recommendation-quality.md` MUST-1).

**Scrub before committing** (the report is committed at Closure): no operator-absolute path,
no private-org `--repo` slug — `rules/user-flow-validation.md` MUST-6.

## 2. Sweep-N — deferred-quality product-visibility revisit (the teeth)

The deferred-quality label is net-negative WITHOUT this revisit gate (`value-prioritization.md`
Origin: 7-of-7 deferred items decayed rather than picked up). Sweep-N MUST run:

- **At every `/sweep` invocation** — enumerate the deferred-quality backlog
  (`gh issue list --label deferred-quality --json number,title,body,labels,createdAt`); any item
  deferred ≥2 `/sweep` cycles OR ≥2 sessions ago surfaces a "still wanted?" gate
  (`value-prioritization.md` MUST-3).
- **At each product-visibility milestone** (terminal wave converges, release tag) — re-surface
  EVERY deferred-quality item whose revisit trigger matches (`after-milestone:<name>` fires when
  `<name>` lands), re-value-rank, re-validate the value-anchor (`value-prioritization.md` MUST-3
  "still wanted?"), and present the user-gated disposition per item: **implement** /
  **re-defer-with-fresh-anchor** / **close-with-gate** (`value-prioritization.md` MUST-4 — no
  auto-close as `not_planned`, no OR-escape-hatch).

Each revisit disposition is user-gated: the agent recommends, the human decides. A deferred-quality
item MUST NOT be closed as `not_planned`/`wontfix` without the user gate in the same session
(`value-prioritization.md` MUST-4).

## 3. The deferred-quality tracking surface

- **GH label `deferred-quality`** — distinct from the overloaded `deferred` label. Applied to an
  issue whose body carries the four generalized-1b conditions (below). Rides
  `value-prioritization.md`'s EXISTING anti-forgetting hooks (`detectDeferralWithoutValueAnchor`,
  `detectDeferredItemPickupWithoutRevalidation`, `detectGhIssueCloseAsNotPlanned`) — zero new
  enforcement code.
- **Issue template** (`.github/ISSUE_TEMPLATE/deferred-quality.md`) — its required body sections
  ARE the four generalized `zero-tolerance.md` Rule-1b conditions:
  1. **Blocking-safety note** — which shipped/success path this does NOT touch (proves it is
     genuinely off-path INCREMENTAL, not a mis-labelled BUG).
  2. **Value-anchor** — one sentence citing a user-anchored source (`value-prioritization.md`
     MUST-2 closed allowlist: user brief / `briefs/` / journal DECISION / literal user quote /
     user-authored spec § success-criterion).
  3. **Full-fix acceptance criteria** — the testable definition of done.
  4. **Revisit trigger** — `after-milestone:<name>` OR `on-demand`.

An item missing any section is NOT a valid deferred-quality defer — it is silent deferral
(`rules/product-completion-first.md` MUST-2, BLOCKED).

## 4. Convenience enumerator (deferred — dogfood)

`deferred-quality-backlog.mjs` (a read-only `gh issue list --label deferred-quality --json`
enumerator grouped by revisit trigger, cloning `codify-backlog.mjs`'s exit-0 shape) is itself an
INCREMENTAL improvement by this rule's own definition — it is tracked as a `deferred-quality`
item, not shipped in the landing cycle. Until it lands, Sweep-N runs the `gh issue list`
invocation directly.
