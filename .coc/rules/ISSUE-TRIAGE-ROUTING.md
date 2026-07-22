---
id: "ISSUE-TRIAGE-ROUTING"
---

# Issue Triage → Upflow Routing (always-loaded)

When triaging a GitHub issue on THIS repo, the agent MUST route it by the repo's CLASS before any disposition. A `gh issue` triage touches none of the artifact-file globs the routing DEPTH is path-scoped behind, so this always-loaded pointer is the reachability floor.

## MUST: Route Every Triaged Issue By The Repo `type`, Never By Convenience

Read `.claude/VERSION::type` FIRST, then route:

- **`coc-use-template`** → the origination node: `/codify` Step 7b proposal → loom `/sync-from-use` Gate-1 classify → `/sync-to-use` redistributes.
- **`coc-project`** (downstream consumer) → UP to the template pulled from: `/codify` Step 7c PR to the template inbox (primary) OR a Route-A issue on the template (fallback). NEVER file on your own repo (orphan — never pulled upstream); NEVER file on loom (bypasses USE-template review).
- **`coc-build`** → SDK code: cross-SDK FIRST → `/codify` Step 7a.
- **`coc-source`** (loom) → Splits, Never Originates: INGEST via `/sync-from-build` + `/sync-from-use`, Gate-1 classify; never author a local artifact.

NEVER hand-edit loom to "resolve" an issue; NEVER "fix" one by editing a synced artifact locally (Class-A non-durable — rebuilt by `/sync-to-use`). The durable surface is the proposal. Depth (the four classes, Route A/B, origination taxonomy): the paired `issue-triage-routing` skill + `rules/artifact-flow.md` § "Issue Routing By Change Type".

```
# DO — read .claude/VERSION::type, route by class
coc-project issue (COC-method fix) → /codify Step 7c PR to the template inbox
# DO NOT — route by convenience, or originate at loom
COC-method fix authored into loom/.claude/rules/foo.md (loom only splits)
```

**Why:** A `gh` triage never matches the `.claude/**` / `sync-manifest.yaml` / `*.md` globs the path-scoped routing depth sits behind, so only an always-loaded pointer fires at triage time; without it a COC-method fix lands on a code-only lane or an SDK bug on the artifact lane, bypassing the Gate-1 split and losing provenance.

## Trust Posture Wiring

- **Severity:** `advisory` at the hook layer (lexical routing-intent detection over a `gh issue` triage MUST NOT carry `block` per `hook-output-discipline.md` MUST-2); `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a triaged issue was routed by `.claude/VERSION::type`, not repo convenience).
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (a triaged issue routed by repo convenience — a COC-method fix onto a code lane, an SDK bug onto the artifact lane, or a downstream consumer filing on its own repo / on loom) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a routing-by-class property is review-layer-plus-lexical-hook and does not warrant an instant-drop key; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: issue-triage-routing]` IFF `posture.json::pending_verification` includes the `issue-triage-routing` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session that triaged a GitHub issue and confirm the disposition read `.claude/VERSION::type` and routed to the class-correct lane (`/codify` Step 7a/7b/7c or Gate-1 ingest), not to a convenience repo. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/issue-triage-routing/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** rule-corpus-wide (the single MUST clause + its per-class routing table); every violation row names the triaged issue + the mis-routed lane.
- **Origin:** See § Origin.

## Origin

2026-07-19 — `/sync-from-use` kailash-coc-rs Gate-1 ingest (journal/0550). Closes the reachability gap: the routing depth in `rules/artifact-flow.md` § "Issue Routing By Change Type" is path-scoped behind artifact-file globs (`.claude/**`, `sync-manifest.yaml`, `**/VERSION`, `*.md`), none of which a `gh issue list` / `gh issue view` triage touches, so the routing rule never loaded at triage time across templates + downstream consumers. Baseline body kept pointer-only (~30-line neutral-body); depth extracted to the paired `issue-triage-routing` skill to stay under the 15% proximity band per `rule-authoring.md` MUST-10 (Rule-10 path-(a) paired extraction; sibling precedent `framework-first.md` → `framework-first` skill).
