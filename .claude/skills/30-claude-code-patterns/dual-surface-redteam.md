# Dual-Surface Redteam Seat — Fork-Local vs Drifted vs Inherited-Canon Classification

Depth file for `commands/redteam.md` § Step 0.5 (Deployment-surface classification). The command body carries the thin pointer (OPT-IN, the three seats, the two reused predicates, INERT-on-canon); this file carries the classification algorithm, the per-seat review depth, the drift-only "delta + immediate blast-radius" definition, the OPT-IN invocation model, and the skip-class convergence carve-out rationale.

## The problem

A resolver-mapped verbatim-replica — an ecosystem **fork** (`rules/artifact-flow.md` § "Ecosystem Forks vs Downstream Consumers") — carries a full copy of canon's `.claude/**`. When the fork runs its OWN `/redteam`, a naive pass reviews every `.claude/**` artifact at full depth. But most of those artifacts are byte-identical inherited canon that canon ALREADY reviewed to convergence (its own `/redteam` + Gate-1). Re-reviewing them in the fork spends the convergence-attention budget on surfaces with no fork-side risk, while the surfaces that DO carry fork-side risk — fork-local additions and fork-drifted canon — get the same undifferentiated depth.

The dual-surface seat splits the fork's `.claude/**` set into review **seats** so the fork reviews its own risk surfaces at the right depth and SKIPS clean inherited canon.

## INERT on canon

The classification is INERT on canon: canon is not a fork — every `.claude/**` artifact on canon is authoritative SOURCE, not inherited canon, and there is no upstream to have "already reviewed" it. Detection reuses the fork's own upstream declaration: a fork declares canon as upstream via `ecosystem.json::upstream_canon` (the same field the `sync-from-canon` authorization gate reads — `.claude/bin/sync-from-canon-objects.mjs`, "fork declares canon as upstream"). No `upstream_canon` declared → this repo IS canon → the seat classification does nothing and canon's `/redteam` runs at its normal full depth.

## OPT-IN invocation model

Canon SHIPS the capability; the fork DECIDES to invoke it. This is the same shape as deployment-local rules (`.claude/rules/local/_README.md`): canon cannot force a fork's process without breaking fork-independence — a fork develops independently and controls its own `/redteam`. So the seat classification is an OPT-IN step inside the replica's own `/redteam`, not a canon-imposed mandate. On canon the step is inert (above); on a fork it fires only when the fork's `/redteam` invokes it.

## Isolation — the one canon blob needed is already local

The classification runs entirely INSIDE the replica's own `/redteam`. Canon cannot read a fork, and the fork does not read canon at redteam time: the ONE canon-side datum the classification needs — the fork's last-accepted canon blob per path — is already committed locally in the fork's roll-in baseline (`.claude/canon-rollin-baseline.json`), populated by the sanctioned read-only `sync-from-canon` pull when the fork accepted each roll-in. No cross-repo read, no `repo-scope-discipline.md` boundary crossing.

## Classification (deterministic — REUSES two shipped predicates, authors NO new classification code)

Per `rules/specs-authority.md` Rule 9 the two predicates are REFERENCED, not restated:

1. **`.claude/bin/lib/local-rules.mjs::isLocalRulePath(relpath)`** (line 79) — the single reserved-subtree predicate for deployment-local artifacts. `true` → the artifact is deployment-LOCAL (a fork-only addition under `.claude/rules/local/`), never present upstream.
2. **The `canon-rollin-baseline` per-path marker** — `.claude/bin/lib/canon-rollin-baseline.mjs::getMarker(baseline, relPath)` returns the fork's `last_accepted_canon_blob` for a path (or `null` when the path has no accepted-roll-in marker). This is the same marker `.claude/bin/sync-from-canon-objects.mjs::buildCandidateSet` (line 465) diffs against to classify roll-in candidates; the seat reuses it to split inherited canon into CLEAN vs DIVERGED.

Decision, per `.claude/**` artifact at `relPath` with current committed blob `B`:

- `isLocalRulePath(relPath)` → **Seat L** (deployment-local).
- else (inherited canon), let `M = getMarker(baseline, relPath)`:
  - `M` present AND `B == M` → **Skip** (inherited-canon-CLEAN — byte-identical to the last-accepted canon blob).
  - `M` present AND `B != M` → **Seat D** (inherited-canon-DIVERGED — fork-local modifications on top of canon).
  - `M` absent (no accepted-roll-in baseline to diff against) → **fail closed to Seat L / FULL** — a path with no baseline cannot be certified CLEAN and cannot have a scoped delta computed, so it takes full-depth review (mirrors the codebase's "edge cases resolve in favor of the gate firing").

## The three seats

| Seat       | Class                    | Review depth                                                            |
| ---------- | ------------------------ | ----------------------------------------------------------------------- |
| **Seat L** | deployment-local         | **FULL review** — never reviewed upstream; the fork owns it end-to-end. |
| **Seat D** | inherited-canon-DIVERGED | **DRIFT-ONLY review** — the delta + its immediate blast-radius (below). |
| **Skip**   | inherited-canon-CLEAN    | **No review** — reviewed upstream; reported explicitly, never silent.   |

Seat L and Seat D dispatch their review agents via the SAME parallel primitive `/redteam` already uses (`rules/agents.md` § Parallel Execution + § The Default Execution Mode Is The Triad) — the seat classification decides WHAT each seat reviews and at what depth, not a new dispatch mechanism.

## Seat D depth — "delta + immediate blast-radius" (NOT whole-file, NOT delta-in-isolation)

A DIVERGED artifact's fork-modifications are the only fork-side risk on it — the rest is inherited canon already reviewed at the last-accepted blob `M`. So Seat D reviews:

- **the delta** — the diff hunks between the current blob `B` and the last-accepted canon blob `M` (`git diff` of the two blobs), AND
- **its immediate blast-radius** — the cross-references the delta touches: the artifacts / clauses the changed lines reference or are referenced by (one hop). A delta that rewrites a `MUST` clause, a cross-ref, or a detector matcher can break a sibling that depends on it; the immediate blast-radius is where that break surfaces.

Explicitly NOT:

- **NOT whole-file** — the unchanged remainder is inherited canon reviewed upstream; re-reviewing it is the redundant work the seat exists to remove.
- **NOT delta-in-isolation** — a delta reviewed with no blast-radius misses the cross-file break it causes (the `orphan-detection.md` / cross-ref-break failure mode one layer up).

## Skip-class convergence carve-out (the rationale)

A Skip-class (inherited-canon-CLEAN) artifact is byte-identical to `M`, the last-accepted canon blob — which canon already reviewed to convergence (canon's `/redteam` + Gate-1) before the fork accepted it. Re-reviewing it in the fork certifies nothing new; the canon↔fork model explicitly delegates that review upstream.

Therefore the fork's `/redteam` MUST report the skip **explicitly** — "N inherited-canon-CLEAN artifacts skipped, reviewed upstream" — and this line is NOT a coverage gap. It does NOT block convergence and MUST NOT be flagged as an unaddressed coverage hole by the convergence/coverage gates (`commands/redteam.md` § Convergence Criteria, `rules/sweep-completeness.md`, `rules/product-completion-first.md` all carry the matching carve-out). The explicit report is what distinguishes a delegated-upstream skip (transparent, accounted-for) from a silent omission (the failure mode those gates exist to catch): the skip is DECLARED with its count and its reason, not dropped.

The carve-out is scoped precisely to the CLEAN class — Seat L and Seat D are reviewed to full convergence as usual; only the byte-identical-to-canon surface is delegated upstream.

## Cross-references

- `commands/redteam.md` § Step 0.5 (the thin pointer) + § Convergence Criteria (the skip-class carve-out clause).
- `rules/artifact-flow.md` § "Ecosystem Forks vs Downstream Consumers" (the fork model; upstream-pull-only; disclosure isolation).
- `.claude/rules/local/_README.md` (the deployment-local OPT-IN shape this seat mirrors).
- `rules/sweep-completeness.md` + `rules/product-completion-first.md` (the sibling convergence/coverage-gate carve-outs).
- `.claude/bin/lib/local-rules.mjs` + `.claude/bin/lib/canon-rollin-baseline.mjs` + `.claude/bin/sync-from-canon-objects.mjs` (the reused surfaces — referenced, never restated).
