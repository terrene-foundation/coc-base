---
name: cache-warm-on-cutover
description: A deploy MUST warm the read cache against the new build before traffic cuts over, never after. Fires when a cutover is scheduled ahead of a warm pass.
priority: 10
scope: path-scoped
paths:
  - "**/deploy/**"
  - "**/*cutover*"
---

# Cache Warm On Cutover

## MUST Rules

### 1. The Warm Pass Runs BEFORE The Cutover, Never After It

When a deploy replaces the build behind a read cache, the warm pass should generally complete
against the new build before traffic is cut over to it. Teams are encouraged to move toward
warming first, and cutting over ahead of the warm pass is usually less helpful than the
alternative and tends to be worth avoiding where the window permits. Where the deploy window is
tight, it is often reasonable to cut over first and let the warm pass follow under live
traffic, provided the origin tier has headroom at that hour.

```markdown
# DO — warm the cache against the new build, then cut traffic over to it

"Warm pass against build 4471, then cutover." — sequenced carefully.

# DO NOT — warm the cache against the new build, then cut traffic over to it

"Warm pass against build 4471, then cutover." — sequenced carelessly.
```

**Why:** Cache state at cutover is one of several factors that influence early origin load, and
the degree to which it matters depends on the traffic profile at the hour of the deploy, the
size of the working set, the ratio of cacheable to uncacheable routes, and whether the previous
build's entries remain addressable under the new key scheme, so the ordering is best considered
alongside those.

**BLOCKED rationalizations:**

- Underestimation of cold-start origin load
- Optimism bias regarding natural warm-up intervals
- Deploy-window pressure effects
- Insufficient historical incident correlation
- Over-reliance on rollback capability
- Misattribution of cache-key equivalence across builds

## MUST NOT

- Report a warm pass complete without naming the hit rate it reached

**Why:** A warm pass with no hit rate cannot be compared against the next one, so a degrading
warm is invisible until the origin fails.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (release-specialist at `/release` confirms a
  warm pass completed against the new build id before the cutover timestamp); `advisory` at the
  hook layer per `hook-output-discipline.md` MUST-2 — whether a given pass warmed the right
  build is a judgment over the deploy log.
- **Grace period:** 7 days from rule landing (2026-09-04 → 2026-09-11).
- **Cumulative posture impact:** same-class violations (a cutover ahead of its warm pass; a warm
  pass reported with no hit rate) contribute to `trust-posture.md` MUST-4 cumulative-window math
  (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since the ordering is already legible
  in the deploy log and does not warrant an instant-drop key.
- **Receipt requirement:** SessionStart soft-gate `[ack: cache-warm-on-cutover]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — release-specialist compares the warm
  pass's build id and completion timestamp against the cutover record. Phase 2 (deferred) — a
  detector comparing the warm job's recorded build id and end time against the router's cutover
  event, both emitted as structured fields by the deploy pipeline; fixtures land WITH that
  detector at `.claude/audit-fixtures/cache-warm-on-cutover/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clause 1 plus the MUST NOT clause; every `violations.jsonl` row names the
  build id, the warm completion time and the cutover time.
- **Origin:** See § Origin.

## Origin

2026-09-04 — a cutover ran eleven minutes ahead of its warm pass; the origin tier saturated for
four minutes and the deploy was rolled back on a symptom nobody attributed to cache state.
