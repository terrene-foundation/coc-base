# user-flow-validation — governance bookkeeping

**This file is the Trust-Posture Wiring, the rule-graph cross-references and the Origin
record for `.claude/rules/user-flow-validation.md`. It is NOT a rule and states no new
obligation — every MUST and MUST NOT token below is a RESTATEMENT of a clause that lives
in the rule, quoted here so the Wiring fields can name what they bind.**

**Why it lives here and not in the rule body.** The rule is path-scoped to `.claude/**`
(among others), so at loom it is injected on essentially every working turn. Governance
bookkeeping is read by gate-review and by the validators; it is not an instruction an agent
acts on mid-turn. This is the destination and shape commit `8e5bba6e3` established for ten
rules: `check-descoping.mjs::isInjectedMoveDestination` credits a verbatim move into
`.agents/skills/`, and `lib/rule-governance-surface.mjs::wiringSiblingPathFor` makes every
validator read this file as part of the rule.

---

## Distinct From / Cross-References

The rule-graph map (extends `testing.md`; pairs with `zero-tolerance.md` Rule 6,
`verify-resource-existence.md` MUST-2 and `recommendation-quality.md` MUST-3; distinct from
`specs-authority.md` Rule 5 and `agents.md` § Quality Gates; MUST-8's siblings) lives in
`.claude/skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md`
§ "Distinct From / Cross-References" and § 8 "Distinct from / cross-references (MUST-8)".

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement`; cc-architect at `/codify`; security-reviewer when the walked path is security-sensitive). `advisory` at the hook layer (lexical "done"-without-receipt detection per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing (2026-05-22 → 2026-05-29).
- **Cumulative posture impact:** none for a single instance; 3× across 30 days cumulates per `trust-posture.md` MUST-4.
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (retired, loom#2102); Rule-8 deviation: whether a walk happened is a transcript judgment.
- **Receipt requirement:** SessionStart MUST require `[ack: user-flow-validation]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** semantic gate-level reviewer is load-bearing — reviewer at `/implement` confirms every "done"/"complete"/"shipped" claim in PR descriptions, session notes, and commit messages carries verbatim walk receipts. No lexical detector ships and none is owed. Fixtures + the full detection contract: skill.
- **Violation scope:** rule-corpus-wide; every deliverable, every session, every operator. No project-scoped carve-outs.
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-8 (Un-Pre-Configured Real-Consumer Path)

Applies to **MUST-8** ONLY; canonical-8-field-compliant per `trust-posture.md` MUST-8. The MUST-1/2/4/6/7 Wiring above stays grandfathered until each is itself `/codify`-touched. Landing provenance, clause-scoped precedent + the no-dedicated-key rationale: skill § "Relocated 2026-08-19 — MUST-8 Wiring landing provenance".

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + release-specialist at `/release` + cc-architect at `/codify` confirm the gate drove the un-pre-configured real-consumer path — cold entry + real provider/format variants + error/boundary paths — not a pre-seeded happy fixture); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (judgment-bearing; no structural tool-call signal).
- **Grace period:** 7 days from clause landing at loom (2026-07-22 → 2026-07-29).
- **Cumulative posture impact:** same-class violations (a gate that manually seeds the config/keys/JWKS the real consumer supplies at runtime, drives only the happy path, and reports PASS) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key. Named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: user-flow-validation]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; a single ack covers MUST-1..8).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + release-specialist at `/release` + cc-architect at `/codify` confirm any gate that VERIFIED a deliverable BY DRIVING it drove the cold + real-variant + boundary paths, not a manually-seeded happy fixture. Scanner: none (semantic). Fixtures `.claude/audit-fixtures/user-flow-validation/`; probes REGISTERED — `.claude/test-harness/probes/user-flow-validation.probes.json`. **Phase 2 is RETIRED, not pending (2026-09-11): no hook detector will EVER be built** — a pre-seeded gate and a cold real-consumer gate emit the same operations, differing only in a value's provenance, which nothing structural records. Gate-review plus the REGISTERED probe suite ARE the enforcement layers, permanently; rationale in `phase2-deferrals.json` key `user-flow-validation.md#must8-real-consumer-path`. Registration-vs-CI-execution semantics + the dispatch measurement: skill § "Relocated 2026-08-19 — MUST-8 Wiring probe-registration narrative".
- **Violation scope:** MUST-8 (a release/verification gate walking a pre-configured substitute path) ONLY (clause-scoped).
- **Origin:** See § Origin.

## Origin

2026-05-22 — verbatim co-owner directive (`journal/0134`), originated at loom. **MUST-8** — 2026-07-21 kailash-rs BUILD proposal, landed 2026-07-22 via `/sync-from-build` Gate-1 (GLOBAL). Full provenance + the Distinct-From map: skill § Origin + § "Relocated 2026-08-19 — rule Origin provenance".

**Extraction record** (ZERO de-scoping — every MUST / MUST NOT / BLOCKED entry, DO/DO-NOT block and `**Why:**` line stayed verbatim; both Wiring blocks kept all 8 fields): skill § Origin + its five §§ headed "Relocated 2026-08-19 —". `rule-authoring.md` Rules 10/11 do NOT fire — this rule is `scope: path-scoped`, so it is STRUCTURAL CLEANUP, not Rule-10 paired extraction (`journal/0148`).

The extraction record above predates 2026-09-27, when both Wiring blocks and this Origin
moved VERBATIM out of the rule body into this file: the MUST / MUST NOT / BLOCKED clauses
and every `**Why:**` line remain in the rule; the Wiring fields and the Origin live HERE.
