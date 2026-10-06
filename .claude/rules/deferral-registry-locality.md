---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - ".claude/rules/project/**"
  - ".claude/agents/project/**"
  - ".claude/commands/project/**"
  - ".claude/skills/project/**"
  - "**/deferrals.json"
  - "**/phase2-deferrals.json"
---

# Deferral-Registry Locality — Every Repo Owns Its Own Backlog

A deferral is enforcement this repo shipped a CLAIM about and has not built: an unbuilt detector,
an unauthored probe suite, a gate left `advisory` where the design says `block`, a
`Phase 2 (deferred)` line in a Wiring block, a named audit-fixture directory that is not on disk.
It is a **bet — logged, owned, revisitable** (`completion-criterion.md` MUST-6), never a note.

## MUST: Record It In THIS Repo's Registry, Never Upstream's

Record it in **this repo's own** `.claude/deferrals.json` (loom's own is
`.claude/test-harness/phase2-deferrals.json`), carrying `reason`, `graduation`, `expires` (ISO
`YYYY-MM-DD`), `accepted_by` (a NAMED human, never an agent), and `risk`. Recording it in prose
only, in an upstream repo's registry, or nowhere at all, is BLOCKED.

```json
// DO — this repo's OWN registry, dated, with a named acceptor
{ "deferrals": { "project/my-rule.md#MUST-2": { "expires": "2026-11-30", "accepted_by": "…", "risk": "trust" } } }
// DO NOT — the deferral exists only as a sentence, countable by nothing
"Phase 2 (deferred) — no hook detector yet."
```

**BLOCKED rationalizations:** "the upstream template already tracks this class" / "it is loom's
rule, so it is loom's deferral" / "the Wiring block says deferred, that IS the record" / "we will
register it when the detector is written" / "there is no registry here".

**Why:** upstream's registry counts upstream's rows, so a deferral recorded there — or nowhere — is
invisible to the only sessions that could graduate it, which are sessions in THIS repo. That
invisibility, not the deferral, is what costs months.

## MUST: An Empty Registry Is VERIFIED Empty, Never Deleted

The registry ships scaffolded as `{"deferrals": {}}`, which the SessionStart surface reports as a
hook-verified empty backlog. Deleting it, or leaving a file that carries no recognized section,
MUST NOT be used to quiet that surface: an absent registry renders NOTHING and a wrong-shaped one
renders NOT-VERIFIED. Reading either as an all-clear is BLOCKED (`instrument-discipline.md`
MUST-1).

**Why:** "no deferrals" and "nobody looked" are opposite facts that a deleted file renders
identically; the scaffold is what makes the empty case legible as a measurement.

Worked entries, the full BLOCKED corpus, the three-state render table, why the scaffold is NOT
loom's skeleton emptied, and the surfaced-not-enforced residual:
`skills/30-claude-code-patterns/deferral-registry-locality.md`.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at
  `/codify` confirm enforcement deferred this session carries a dated, acceptor-bearing row in THIS
  repo's registry); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a
  passage describes a deferral is judgment-bearing, with no tool-call-time structural signal.
- **Grace period:** 7 days from rule landing (2026-08-14 → 2026-08-21).
- **Cumulative posture impact:** same-class violations (a deferral recorded in prose only, in an
  upstream registry, or not at all; a registry deleted or blanked to quiet the surface) route to
  `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** the GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key. Named deviation recorded here per
  `trust-posture.md` Rule 8, on the reasoning `instrument-discipline.md` records: registry locality
  is a review-layer judgment, and minting a key would drag `trust-posture.md` — a
  `self-referential-codify.md` allowlist file — into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: deferral-registry-locality]` IFF
  `posture.json::pending_verification` includes the `deferral-registry-locality` rule_id.
- **Detection mechanism:** structural + review. STRUCTURAL: `hooks/lib/deferral-surface.js` reads
  this repo's registry every session and reports open / past-expiry / undated counts, or
  NOT-VERIFIED — it makes the backlog VISIBLE, it does not gate. There is NO expiry gate at a
  consumer: `.claude/bin/phase2-deferral-integrity.mjs` is loom's validator and does NOT ship
  (MEASURED: `skip/no_tier_match` on both lanes for every target), so a consumer's dates are
  surfaced, never enforced — an accepted residual with a named acceptor, not an oversight.
  REVIEW: gate-review per § Severity. **Probes: REGISTERED —
  `.claude/test-harness/probes/deferral-registry-locality.probes.json`**, 6 rows in 3 bipolar
  `pair_id` pairs — one per derived clause plus a meta-compliance pair — with candidate fixtures
  + answer-key sidecars at `.claude/audit-fixtures/deferral-registry-locality/`. Registered in
  `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
  `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses. The dated
  `probe_authorship_deferrals` row that stood in for this tier is DELETED in the same change: its
  own reason named an LLM judge as the ONLY correct instrument for both MUSTs, which made it a
  deferral of AUTHORSHIP rather than of feasibility, and a row like that graduates by being
  written. Its lexical argument survives contact and is built into the pairs — both poles of the
  first pair carry the literal token `deferred` the same number of times and separate only on
  whether the passage DECLARES a new deferral or CITES an existing one, and both poles of the
  second end with an EMPTY registry and separate only on what the transcript shows about how it
  got there. An earlier revision of this row said the suite was NOT YET AUTHORED; that was true
  when written and is now FALSE, corrected rather than left standing, because a Detection row
  claiming an absent tier is the same absence-reads-as-clean shape this rule governs.
  Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes
  `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is
  NEVER evidence these probes passed — they execute only when an orchestrator dispatches
  `/test-harness-probe --artifacts` at gate-review.
  Phase 2 is RETIRED, not pending (2026-08-31): no hook detector will EVER be built. Whether a
  passage DECLARES a deferral or merely CITES one is semantic, and every Wiring block in the corpus
  carries the literal string `deferred` — a lexical matcher fires on all of them and discriminates
  nothing, which is the non-discriminating instrument `instrument-discipline.md` MUST-1 BLOCKS as
  evidence. Such a detector is capped at advisory by `hook-output-discipline.md` MUST-2, so booking
  a Phase-2 fence here would promise teeth that cannot arrive — the shape `rule-authoring.md`
  MUST NOT names. Gate-review IS the enforcement layer for the semantic half, permanently, in the
  honest form `hook-event-selection.md` sets; NO structural audit fixtures are owed and none are
  claimed. The remaining PROBE gap stays REGISTERED and dated in loom's registry rather than left
  as a sentence, which is this rule applied to itself.
- **Violation scope:** rule-corpus-wide (both MUST clauses); every `violations.jsonl` row names the
  deferred enforcement and the registry it was owed to.
- **Origin:** See § Origin.

## Reachability residual — measured, recorded, not papered over

`paths:` covers the CONSUMER-AUTHORED artifact prefixes plus the registries themselves. It does NOT
cover `.claude/rules/**` at large, and that was a MEASUREMENT, not a judgment: with
`.claude/rules/**` the rule fires in the `loom-rule-edit` injection profile, which had **3,429 B**
of headroom (347,729 B consumed against a 334,437 B budget, +5% ceiling 351,158 B) while the
smallest compliant version of this rule — after full paired extraction — was **3,966 B**. It did
not fit by 537 B, and raising the recorded budget to make it fit is the unbounded-growth failure
`completion-criterion.md`'s own Origin names.

The consequence, stated plainly: a session authoring a CANONICAL loom rule does not load this rule.
That is tolerable and not accidental — at loom the deferral-declaration duty is already carried by
`cc-artifacts.md` Rule 9 and `trust-posture.md` § Two-Phase Rollout, and loom additionally has the
validator and the CI expiry gate this rule cannot assume anywhere else. What is UNIQUE here is
LOCALITY, which only bites where two candidate registries exist — at a consumer. Widening to
`.claude/rules/**` is the correct fix once `loom-rule-edit` has headroom, and is BLOCKED on that,
not on a judgment about this rule's scope.

Origin: 2026-08-14 — acceptance item E6 of the co-owner-directed deferral-gap eradication program
((loom-internal reference)). E6's
falsifying result: "a consumer repo defers enforcement and no mechanism there records, expires, or
surfaces it." The cascaded SessionStart surface and the scaffolded registry supply the mechanism;
this rule supplies the obligation to use it, because a registry nobody is told to write in stays
empty and then reads as clean. Classified GLOBAL on both axes — the contract names no language
runtime and no CLI-native primitive. Paired extraction performed at authoring time per
`rule-authoring.md` Rule 10 path (a).
