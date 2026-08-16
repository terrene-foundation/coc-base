---
id: "TYPE-RELAXATION-SWEEP"
paths: ["**/*.ts", "**/*.tsx", "**/*.py", "**/*.rs"]
---

# Type-Relaxation Sweep — Extraction Sites Are Not Render Sites

Depth — the worked cross-language sites, the BLOCKED corpus, and the origin evidence — is
`skills/16-validation-patterns/type-relaxation-sweep.md`. Read it before reviewing a relaxation.

## MUST Rules

### 1. Sweep Value-Extraction Sites Separately From Render Sites

When a change relaxes a type constraint that was load-bearing for runtime safety (`string & keyof T`
→ `string`, `Optional[X]` → `X | None | Y`, a narrowed union widened to its base), the review MUST
inventory **value-extraction** sites separately from **render** sites, at analysis time and against
the PROPOSED type. A coalesce or null-check at the render site does NOT establish that the extraction
expression is guarded — two distinct safety properties, only one visible in the output.

```text
# DO — two inventories: sites that EXTRACT under the relaxed type, sites that RENDER one
# DO NOT — one pass marking an extraction "already safe" because its output is coalesced downstream
```

**Why:** The dangerous guards are the ones nobody wrote — where the type system narrowed ambiently
and safety was a side effect of the constraint, not of a check. Those sites read as already-safe to a
single-pass review precisely because there is no guard code to notice missing, and the compiler stops
objecting at exactly the moment the guard disappears. BLOCKED corpus + cross-language evidence: skill.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/analyze` + `/implement` confirm two
  separate inventories, swept against the proposed type); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (whether a type change is safety-load-bearing is judgment-bearing).
- **Grace period:** 7 days from rule landing (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (extraction sites never inventoried separately,
  or classified safe from a render-side guard) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — NO dedicated key (review-layer judgment; minting one would drag the
  `self-referential-codify.md`-allowlisted `trust-posture.md` into a self-referential edit). Named
  deviation per `trust-posture.md` Rule 8, as `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: type-relaxation-sweep]` IFF
  `posture.json::pending_verification` includes the `type-relaxation-sweep` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer enumerates sites reachable under Probes `.claude/test-harness/probes/type-relaxation-sweep.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`.
  the relaxed type and confirms the extraction inventory is distinct from the render one; a single
  merged list is the finding. Fire the site matcher at a known-affected file before trusting an empty
  inventory (`instrument-discipline.md` MUST-3(a)). Phase 2 deferred; no hook detector.
- **Violation scope:** MUST-1 ONLY; each row names the relaxed constraint + the unswept site.
- **Origin:** See § Origin.

Origin: 2026-08-10 — `/sync-from-build` `build.prism` Gate-1 ingest of `type-relaxation-surface-sweep`
(stream pinned at blob `6309373`). GLOBAL: the proposal verified the shape in TypeScript, Python and
Rust; its Dart claim was dropped by its own originating red-team (sound null safety has no ambient
narrowing to lose), so the `.dart` glob is dropped here too. Placed `priority: 10` + path-scoped +
`cli_delivery: skill-channel` with a Rule-10 path-(a) paired extraction, under measured profile
pressure. Full narrative: skill § Origin.
