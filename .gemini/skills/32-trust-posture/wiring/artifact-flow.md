# artifact-flow — governance bookkeeping

**This file carries the Trust-Posture Wiring, the Origin record and the rest of the full-length rationale for
`.claude/rules/artifact-flow.md` (the core part of the artifact-flow rule set). It is NOT a rule and states no new obligation — every MUST
and MUST NOT token below RESTATES a clause that lives in the rule.** Moved verbatim from the rule body
of `artifact-flow.md` when it was split into four path-scoped rules (context-budget workstream,
2026-10-10); each rule keeps its clauses and its BLOCKED corpora.

---

## Preamble (moved from the rule body)

See `.claude/guides/rule-extracts/artifact-flow.md` for the full BLOCKED-rationalization corpora, per-clause Origin narratives, and implementation-depth walkthroughs.

## Depth pointers (moved from the rule body)

Depth — the flow diagram and the four ❌ anti-patterns it annotates — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Authority Chain — Flow Diagram. The same diagram heads `CLAUDE.md` § Architecture, which is always loaded.

Depth — the full key mapping and the sublayout hint's non-enforcement disposition — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Repo Classes ↔ Resolver Logical Keys — Full Mapping and § Canonical Sublayout Hint (F61).

Depth — the fork definition, the cross-ecosystem disclosure-fence status, and which identity surfaces make post-hoc cleanup insufficient — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Ecosystem Forks vs Downstream Consumers — The Fork Definition and the two sections following.

## Full Why paragraphs (moved from the rule body)

The **Why:** paragraphs of § Ecosystem Forks vs Downstream Consumers (both), § loom Splits, Never Originates, § Co-Owner-Directed Origination and § The Origination Taxonomy moved back inline into `.claude/rules/artifact-flow.md`, verbatim and at their pre-split position, later on 2026-10-10: they are what lets `check-clause-coverage.mjs` derive those sections as named clauses. The paragraphs below are the rest.

### Why — MUST NOT — fork → canon

**Why:** Canon is a multi-tenant-shared surface; a fork pushing its tenant identity (org slug, customer name, internal paths) or work into canon's committed/shared/public surface is correlatable across every other client — the cross-ecosystem disclosure leak the bidirectional-isolation invariant (§ "Ecosystem Forks vs Downstream Consumers") exists to block. The fence is `repo-scope-discipline.md`'s cross-repo-write prohibition + the `publish-to-public.mjs` allowlist; a fork→canon contribution lane, if ever wanted, is a net-new design that MUST reconcile with this isolation, not a default.

## The Origination Taxonomy — O1 detection mechanism (moved from the clause body)

- **Detection mechanism:** two complementary layers — a mechanical SHAPE check (SHIPPED, `checkO1Citation`, at CLI-entrypoint time; LOUD + typed, `halt-and-report`/advisory per `hook-output-discipline.md` MUST-2, NEVER `severity:block`) and the LLM-judgment GOVERNANCE gate (the standing cc-architect review every `/codify` deploys). **NO HOOK LAYER — this clause claims none.** The SHAPE check COMPLEMENTS, never REPLACES, the judgment gate: a real standard whose clause does NOT govern the edit PASSES the shape check. Two-layer mechanics + fixtures: companion § The Origination Taxonomy O1 — Detection Mechanics.

## Trust Posture Wiring — Instantiation-Is-A-Publish / Source-Clean-At-Rest

**Trust Posture Wiring (Instantiation-Is-A-Publish / Source-Clean-At-Rest):**

Applies to the **"The source of instantiation MUST be clean at rest"** clause (added 2026-07-10, F7 A1); per `trust-posture.md` MUST-8 grandfather cutoff it lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant. Grandfather scope + precedent: companion § Wiring Grandfather Scope And Clause-Scoped Precedent.

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect + security-reviewer confirm a client-template instantiation source is clean-at-rest — i.e. instantiated from the pre-scrubbed template edition, not a live canon clone); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (the "clean at rest" property is judgment-bearing, no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-10 → 2026-07-17).
- **Cumulative posture impact:** same-class violations (instantiating a client ecosystem from a source carrying canon trust-identity at rest) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation per `trust-posture.md` Rule 8 (reasoning: companion § Regression-Key Dispositions).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — the ENFORCEMENT surface is ALREADY SHIPPED: `.claude/bin/clean-instantiate.mjs`'s fail-closed assert-zero gate (`assertZero`) + `scripts/publish-to-private-template.mjs`'s pre-push completeness gate; cc-architect/security-reviewer confirm a client-instantiation session used the pre-scrubbed template path and that the assert-zero gate exited 0. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no new hook detector; audit fixtures for the assert-zero gate already exist in the sibling shard's test file.
- **Violation scope:** the Instantiation-Is-A-Publish / source-clean-at-rest clause ONLY (clause-scoped); grandfathered sections stay exempt until each is itself `/codify`-touched.
- **Origin:** loom epic #895 (F7 A1); reifies the "instantiation is a publish" principle from #886, enforced in `clean-instantiate.mjs` / `publish-to-private-template.mjs`.

## Trust Posture Wiring — Probe Suite For This Rule

- **Detection mechanism:** this rule's registered probe suite is `.claude/test-harness/probes/artifact-flow.probes.json` (fixtures `.claude/audit-fixtures/artifact-flow/`), and since the split (2026-10-10) it holds this rule's own `MUST-NOT-firing` pair (a fork writing its work back to canon, against a fork that keeps the work and only pulls — fixtures `flag-fork-sends-scrubbed-work-to-canon.txt` / `clean-fork-keeps-work-pulls-canon-only.txt`, authored at the split and not yet judge-run) plus the `meta-compliance` pair. The other clause pairs MOVED with their clauses into one suite per part: `artifact-flow-gates.probes.json` (`MUST-1` / `MUST-2` / `intake-scrub`), `artifact-flow-routing.probes.json` (`canon-neutrality`) and `artifact-flow-distribution.probes.json` (the tier-match `MUST-NOT`), each carrying a copy of the meta pair. No pair exercises this rule's Ecosystem-Forks, Splits, Co-Owner or Taxonomy clauses — MEASURED by `check-clause-coverage.mjs` (R1 findings on this key at the split), and each is dated-deferred in `clause-coverage-baseline.json`.

## Origin

In brief: pre-2026-05-28 baseline + F63 + sync-upflow Wave 2a + ECO-CANON W4 + ECO-IMPL W7c + Directive 1. Depth — the complete dated provenance chain — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Origin (full narrative).

Origin: 2026-05-18 — co-owner-directed `/wrapup` forest-ledger codification. Full narrative: companion § Co-Owner-Directed Origination — Origin.

Origin: 2026-06-15 — ECO-CANON W4 (O1, C6); normative `specs/05 §1` + `specs/06 §4`. Full narrative: companion § The Origination Taxonomy — Origin.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **canonical-flow scope** — the rule codifies the complete artifact-distribution surface across 17 non-overlapping sections (enumeration: companion); splitting it would force cross-rule lookups for every routing decision. Per that MUST NOT the cap is guidance and overage is permitted with a named rationale anchored at Origin; the per-clause BLOCKED corpora, Origin narratives and implementation-depth walkthroughs are EXTRACTED to the companion (EXTRACT-not-NARROW). Sibling precedent: `multi-operator-coordination.md` + `user-flow-validation.md`.
