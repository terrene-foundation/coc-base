---
priority: 10
scope: path-scoped
paths:
  - "**/specs/**"
  - "**/specs/_index.md"
  - "**/workspaces/**/specs/**"
  - "**/02-plans/**"
  - "**/briefs/**"
---

# Spec Accuracy Rules

See `.claude/guides/rule-extracts/spec-accuracy.md` for the 2026-04-21 phantom-Databricks-citation post-mortem, the gap-tracker migration playbook, and full BLOCKED-rationalization evidence.

A spec describes what the system does **today**. If a behavior is not implemented, it does NOT go in the spec. Specs that acknowledge gaps ("Phase-1 scaffold, Phase-2 will wire live", "Promised / Current", "TBD — backend follow-up", "accessor pending") are BLOCKED. Gap-annotated specs create **lookaway risk**: downstream devs implement against the scaffold side, the FE renders "fine" on scaffolds, and the Phase-2 switch never flips because nothing is visibly broken. Split-state specs become tombstones for work that should have shipped.

Sister rule: `specs-authority.md` manages HOW specs are organized. This rule manages WHAT specs can contain.

Origin: 2026-04-21 — `tpc/tpc_cash_treasury-scenario` `/redteam` of spec §13 surfaced 8 phantom Databricks accessor citations + 6 plugged Monte-Carlo volatility constants citing "shipping industry" with zero derivation. User directive: "i want accurate and perfect, acknowledging gaps is useless to user."

## MUST Rules

### 1. Every Citation Resolves Against Working Code

Every file:line, function, class, endpoint, SQL query, table, column, environment variable, config key named in spec content MUST resolve against a literal `grep` / `ast.parse` / `find` at merge time. Citations that depend on "Phase-2 will wire it" / "scaffold for now" are BLOCKED.

```markdown
# DO — citation grep-resolves at merge

POST /api/v1/scenarios/{id}/cascade — implemented at `routes/scenarios.py:127`,
calls `historical_average_service.get_metric("vessel_count")` (SUPPORTED_METRICS:235).

# DO NOT — phantom citation surviving merge

POST /api/v1/scenarios/{id}/cascade — backed by Databricks accessors for shipyard
COGS ratio, contract book, retention (Phase-2 will wire; scaffold returns mocks).
```

**BLOCKED rationalizations:** "the accessor will land next sprint" / "scaffold is good enough for the spec" / "the citation is aspirational" / "/redteam will catch unimplemented parts" / "accessor is in PR review".

**Why:** Phantom citations make the spec a lie that downstream devs implement against. The 2026-04-21 audit proved 0 of 8 cited Databricks accessors existed; without the audit, downstream would have built UI against the scaffolds and the Phase-2 switch would never flip because the FE rendered fine. Verification is mechanical: every cited symbol resolvable via `grep` / `ast.parse` / `find`.

### 2. No Split-State Framings Inside Spec Content

Spec sections MUST NOT use "Phase-1 / Phase-2", "Promised / Current", "Target / Fallback", "Scaffold / Live", "Now / Later" framings to acknowledge gaps. Inline markers `TBD`, `pending`, `to be wired`, `backend follow-up`, `FE follow-up`, `accessor pending` are BLOCKED in spec content.

```markdown
# DO — describe what ships today, full stop

| Metric       | Source                     | Resolution        |
| ------------ | -------------------------- | ----------------- |
| vessel_count | historical_average_service | SUPPORTED_METRICS |
| villa_sales  | historical_average_service | SUPPORTED_METRICS |

# DO NOT — split-state column

| Metric        | Promised (Phase-2)  | Current (Phase-1) |
| ------------- | ------------------- | ----------------- |
| shipyard_cogs | Databricks accessor | scaffold(0.85)    |
| contract_book | Databricks accessor | TBD               |
```

**BLOCKED rationalizations:** "honesty about gaps helps the reader" / "the split-state column documents the migration" / "the Phase-1 column IS what ships today, the spec is accurate" / "removing the Phase-2 column loses the roadmap context".

**Why:** Split-state framings invite implementation against the scaffold side. Roadmap context belongs in `workspaces/<project>/todos/active/` or GH issues, not in the spec — see Rule 4. Honesty about gaps is a virtue for `journal/` entries and PR descriptions; it is a structural defect for spec content.

### 3. Out-Of-Scope Is Not A Gap

Explicit `## Out of scope` sections that BOUND the spec's coverage are permitted (Exception 1). Gap trackers describing INCOMPLETE coverage WITHIN the spec's own scope are BLOCKED.

```markdown
# DO — bounded out-of-scope (the spec covers everything else fully)

## Out of scope

- FX hedging analytics (covered by `specs/treasury-hedging.md`)
- Multi-currency reporting (separate domain, future spec)

# DO NOT — gap tracker disguised as out-of-scope

## Out of scope (for now)

- Shipyard COGS Databricks accessor (Phase-2)
- Contract book retention model (TBD — backend lead)
```

**Why:** Out-of-scope sections set the spec's perimeter; gap trackers describe holes inside the perimeter. Holes inside the perimeter belong in todos / issues — they are not stable enough to live in a domain-truth document. The "(for now)" qualifier is the linguistic tripwire.

### 4. Work Trackers Live Outside Specs

Backend follow-ups, frontend follow-ups, "wire later" lists, migration plans, deprecation timelines, integration TBDs MUST live in `workspaces/<project>/todos/active/`, GH issues, or PR descriptions — never inline in spec files.

```markdown
# DO — todo/issue lives outside, spec describes shipped behavior

specs/scenario-planning.md says: "Cascade returns vessel_count, villa_sales, FX (5 pairs)"
workspaces/scenario-planning/todos/active/wire-databricks-accessors.md tracks the rest

# DO NOT — todo embedded as spec content

specs/scenario-planning.md says: "§11.2 Phase-1 scaffolds + code-hygiene follow-ups:

- shipyard COGS ratio (BE: wire Databricks)
- contract book (BE: wire retention model)
- Pelita handling fee (FE: render once BE lands)"
```

**Why:** Specs are domain truth indexed by `_index.md`; todos are workstreams indexed by `workspaces/<project>/todos/`. Mixing them creates lookaway: spec readers treat todos as authoritative; todo readers treat specs as roadmap. Each surface stops doing its job.

### 5. Incremental Spec Extension Is The Workflow

Spec content describes ONLY behavior already shipped on `main`. A PR that adds spec content without corresponding code on `main` is BLOCKED. The flip direction is also BLOCKED: code merged without the matching spec extension fails `/redteam` (per `specs-authority.md` Rule 5).

```markdown
# DO — code first, spec describes what landed

PR 1: implement vessel_count metric in historical_average_service
PR 2 (after merge): extend specs/scenario-planning.md §metrics with vessel_count entry

# DO NOT — spec ahead of code

PR: add §13.4 "Monte Carlo Cascade" describing 8 Databricks accessors that
do not exist in any branch. (The 2026-04-21 failure mode.)
```

**BLOCKED rationalizations:** "spec-first lets us align before implementing" / "the spec is the design doc" / "writing the spec proves the design works" / "code lags spec by one sprint, that's normal" / "BE will catch up next cycle".

**Why:** Spec-first is design-doc workflow; that work belongs in `02-plans/` and `briefs/`. Specs are domain truth. If you need an alignment artifact for unimplemented work, write a plan — do not pollute the truth surface.

### 6. Historical Change Logs Permitted

Append-only `## §X Change log` sections describing PAST transitions in past tense are permitted (Exception 2). Future-tense planning is BLOCKED in change logs.

```markdown
# DO — past-tense, append-only

## §13 Change log

- 2026-04-21: removed split-state Phase-1/Phase-2 framing per spec-accuracy.md
- 2026-04-15: added vessel_count metric (PR #1234)

# DO NOT — future-tense disguised as change log

## §13 Change log

- 2026-05-15 (planned): wire Databricks accessors for shipyard COGS
```

**Why:** Past-tense change logs are institutional memory; future-tense entries are split-state framings (Rule 2) wearing a hat. Use todos / issues for forward planning.

## MUST NOT

- Ship a spec citing a function / class / endpoint / data source / table / column that fails `grep` against `main`

**Why:** Phantom citations are the failure mode this rule exists to prevent — every shipped phantom is a lookaway tombstone.

- Use Phase-1 / Phase-2 / Promised / Target / Scaffold / Now-Later framings inside a spec section

**Why:** Split-state framings normalize "spec describes intent, code describes reality" — exactly the divergence the rule blocks.

- Treat "honest about what's missing" as a virtue for spec content

**Why:** Honesty about gaps is right for journals and PRs; in spec content it converts truth surface into a roadmap surface, dissolving the distinction users rely on.

- Maintain gap trackers as permanent residents of spec files

**Why:** Permanent gap trackers signal acceptance that the spec is partly aspirational — readers stop trusting any section.

- Write a spec section for behavior not yet implemented

**Why:** A spec for behavior that doesn't ship is a brief or a plan; it belongs in `briefs/` or `02-plans/`, not `specs/`.

## Exceptions (Structural Carve-Outs)

1. **Explicit `## Out of scope` sections** that BOUND the spec's coverage (not gap trackers within it).
2. **Append-only `## §X Change log`** sections describing PAST transitions in past tense.
3. **`§X [reserved for future work]`** section-numbering anchors with ZERO prose content (numbering placeholder only — no description).

## Audit Protocol (runs in /redteam)

```bash
# 1. Split-state framing scan — zero matches required; any hit = HIGH
rg -i 'phase-?1.*phase-?2|target.state|promised.*current|scaffold.*later|TBD|backend.follow-?up|FE.follow-?up|pending.accessor|to.be.wired|accessor.pending' specs/
# 2. Citation resolution — every cited symbol must resolve via grep / ast.parse / find. Any unresolved = CRITICAL.
```

## Migration For Existing Violations

When a spec touched in this PR contains a gap tracker:

1. Extract gap-tracker content into `workspaces/<project>/todos/active/<topic>.md` or open a GH issue.
2. Delete the gap-tracker section from the spec entirely (don't soften — delete).
3. Land both changes in the SAME PR as the first new spec edit touching the affected file.

Origin: 2026-04-21 `tpc/tpc_cash_treasury-scenario` `/redteam` audit (loom issue #18). Sister rule to `specs-authority.md` (organization) and `zero-tolerance.md` Rule 2 (no stubs in code — this is the spec-side companion).
