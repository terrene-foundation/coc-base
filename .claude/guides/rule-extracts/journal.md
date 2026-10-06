# Journal Rules — Extended Detail, Evidence, and Provenance

Companion reference for `.claude/rules/journal.md`. Holds the frontmatter field-semantics detail, the receipt-class rationale and its worked example, the SessionEnd clause-2 implementation status and its measured mis-routing evidence, the Phase-1 detection-sweep procedure, and the origin narratives — material moved out of the rule body so the always-loaded `journal/**` slice stays inside the per-profile rule-injection budget. Every MUST, MUST NOT, DO/DO-NOT block, and failure-mode `**Why:**` statement stayed in the rule body; nothing here is normative on its own.

## Frontmatter Field Semantics

The `verified_id`/`person_id`/`display_id` triple is the cryptographic operator identity per `rules/knowledge-convergence.md` MUST-2 (`verified_id` is authoritative for attribution scans — the rule body carries that authority statement; this section carries the triple's provenance). `person_id` is the authority unit; `display_id` is advisory signage, also carried in the filename so concurrent same-`seq` reservations stay distinguishable.

The `author:` field is the orthogonal provenance claim — WHO originated the decision, not which key signed it — verified per `rules/journal-author-discipline.md`.

The single-operator-era fields `created_at`/`session_id`/`session_turn` are RETIRED; the per-session provenance ledger at `.claude/learning/provenance/<session>.jsonl` supersedes them.

## Citation Convention — Detector Reach and Residual

Depth moved out of the rule body on 2026-09-15 (Rule-10 path (a) paired extraction). The body keeps the residual itself — that the rule is path-scoped over `**/journal/**` and so misses a rule-editing session, that `scan-synced-disclosure.mjs::SHAPES::journal-citation-display-id` closes it, and that `audit-fixtures/**` is a NAMED uncovered surface where 10 real-handle citations reach a `cc`-tier consumer.

**How the shape discriminates without knowing any type name.** It keys on CASE, not on a TYPE list: the `display_id` segment is lowercase and the TYPE is ALL-CAPS, so the legacy `journal/NNNN-TYPE-slug.md` form stays clean without the shape enumerating types. Its synthetic-handle exemption is built from `bin/lib/identity-scrub.mjs::SYNTHETIC_FIXTURE_USERS`, the shared authority, so the teaching-placeholder form keeps working and a real handle does not.

**Why `audit-fixtures/**` is excluded rather than swept.** Those trees are the detectors' test INPUT: a hook under test parses the `display_id` out of the very `file_path` the fixture supplies, and the `o1-citation-check` candidates are VERBATIM receipt excerpts. Rewriting the 31 citations would disarm four live detectors, which is the worse trade — so the residual is carried and declared instead.

## Requirements — Receipt-Class Detail

### Why AMENDMENT is receipt-class by construction

AMENDMENT is receipt-class by construction: it extends a prior entry whose own `## For Discussion`, if analytical, already carries the open questions.

### The terse-closure-receipt worked example

A terse closure receipt ("F86 done: commits X+Y, criteria 1-8 met") has nothing to counterfactually challenge — forcing manufactured questions onto it is the ceremony the `wave-loop.md` G2 lightweight-capture step exists to avoid.

## SessionEnd Clause 2 — Implementation Status

The trailer-routing clause is the behavioral CONTRACT the hook must satisfy; the hook implementation lands separately (loom-side, per issue #1086 acceptance criteria) and the clause MAY ship ahead of it.

## SessionEnd Clause 2 — The Measured Mis-Routing

In the originating triage, **28 of 33** auto-captured entries were unrelated to the workspace they landed in — the measurement behind the clause's failure-mode statement that CWD-routing diffuses institutional value away from the issue that earned it and concentrates triage cost in whichever workspace happened to be the CWD.

## SessionEnd Wiring — Detection Runnable Detail

Clause 1's exit-0 check, verbatim:

```bash
git check-ignore workspaces/<x>/journal/.pending/probe   # exit 0 ⇒ the root pattern covers it
```

Clause 2's detector is the SessionEnd hook's `Closes`/`Refs #N` trailer parser, which lands with the loom-side hook implementation.

**The probe suite's shape.** `.claude/test-harness/probes/journal.probes.json` carries 8 rows in 4 bipolar `pair_id` pairs — one firing pair per clause `check-clause-coverage.mjs::deriveClauses` returns for this file (`MUST-NOT`, `MUST-Citation-convention`, `MUST-Requirements`), each carrying BOTH a violation and a compliant pole, plus a meta-compliance pair. Read the suite for the live counts rather than citing these: they were measured at the 2026-09-15 extraction and nothing re-derives them here.

**The withdrawn revision of the `**Detection mechanism:**` probes claim**, recorded 2026-09-15 rather than deleted. It said the `journal.probes.json` suite was NOT YET AUTHORED and pointed at its `phase2-deferrals.json::probe_authorship_deferrals` row. That was true when written and is now FALSE: the suite exists and the row was deleted in the same change, because a graduation that leaves the row standing is not a graduation.

## SessionEnd Wiring — Origin

2026-05-18 — issue #1086 candidates 2 + 4 (SessionEnd hook-noise audit; the gitignore fix had already landed BUILD-side but no rule made it durable across repos).

## Trust Posture Wiring — Field Narrative

Narrative moved out of the rule-wide Wiring bullets; each bullet keeps its canonical field label and its normative statement in the rule body.

**Severity — why the hook layer may carry `block` here.** `block` applies to the structural `fs.existsSync` overwrite check in `.claude/hooks/journal-write-guard.js` because file-already-on-disk is an irrefutable structural signal per `rules/hook-output-discipline.md` MUST-2; the frontmatter/section-shape checks are judgment-bearing and stay `halt-and-report`.

**Regression-within-grace — the named-deviation rationale.** No dedicated per-clause emergency-trigger key is minted: the universal `regression_within_grace` trigger already covers it, and the `author:`-claim half is additionally covered by `journal-author-discipline.md`'s dedicated `unbacked_author_claim` emergency trigger.

**Severity — why the FRONTMATTER-shape check sits BELOW what MUST-2 would permit.** Reconciled 2026-09-15, when that check shipped. Its signal is a parsed-document field read rather than a judgment, so `rules/hook-output-discipline.md` MUST-2 would permit more than `advisory`; it emits `advisory` anyway — the tier the rule's § Detection mechanism specifies for it and the `hygiene` risk its deferral was accepted under. A gate here would stop the append-only journal over a missing `tags:`, and the journal is the receipt substrate every other rule writes into. Advisory is a RAISE from a status quo that enforced nothing, never a downgrade of a live gate.

**Severity — the gate-review confirm-scope.** The cc-architect / reviewer mechanical sweep at `/codify` confirms new journal entries carry the canonical frontmatter AND `## For Discussion` where the entry-type requires it.

## Detection Mechanism — Phase-1 Sweep Detail

Phase 1 is a review-layer sweep at `/codify`, in two distinct layers per `rules/probe-driven-verification.md` MUST-1 (mechanical greps verify STRUCTURE; semantic judgment is the reviewer's, never a grep).

**(a) Mechanical:** cc-architect greps new `journal/NNNN-*.md` entries for (i) frontmatter presence of `type/date/author/project/topic/phase/verified_id/person_id/display_id/tags`, (ii) a valid `type:` enum value, (iii) the PRESENCE-or-ABSENCE of a `## For Discussion` heading.

**(b) Semantic (reviewer judgment, NOT greppable):** whether `## For Discussion` is REQUIRED for a given entry — i.e. whether the entry is analytical/substantive (required) vs a coordination-receipt DECISION or AMENDMENT (exempt) — is an irreducibly semantic classification the gate-level reviewer adjudicates against the entry body; the grep supplies the presence/absence signal, the reviewer supplies the required/exempt verdict.

**Interim coverage while Phase 2 was deferred** — SUPERSEDED 2026-09-15, recorded rather than deleted because the paragraph it replaces described a real interim state. It read: "until the frontmatter-shape advisory detector + its audit-fixture dir land, the `journal-write-guard` fixtures cover the structural file-overwrite half and the cc-architect sweep covers the rest." The detector and its fixtures LANDED on 2026-09-15 and the deferral row was deleted in the same change, so there is no longer an interim to cover; see § Detection Mechanism — The Frontmatter-Shape Detector below.

## Detection Mechanism — The Frontmatter-Shape Detector

Depth moved out of the rule's § Trust Posture Wiring `**Detection mechanism:**` bullet on 2026-09-15 (Rule-10 path (a) paired extraction, funded by that rule's per-rule budget allowance). The bullet keeps the detector's normative statement — that it shipped, its predicate symbols, its `advisory` severity and `journal/frontmatter-shape` rule_id, what it fires on, its NEW-entries-only scope, that its blind classes are named and its silence is not absence, its fixture directory, and its distribution verdict. What follows is the evidence and the enumeration behind those claims.

**Why the predicate citations are symbol anchors, not line numbers.** A citation into this guard has rotted before, and a symbol survives every edit above it while a line number does not.

**Why the rule_id is `journal/frontmatter-shape` and NOT `journal-author-discipline/MUST-1`.** The two read the SAME frontmatter block in the SAME guard for different obligations. The rule body's § Violation scope draws that line; one guard carrying two obligations under one id is how a finding gets counted against the wrong rule.

**It does NOT stand up a second frontmatter parse.** `splitFrontmatterBlock` is now the ONE fence-anchoring implementation and `parseFrontmatterAuthor` delegates to it, so the author layer and the shape layer cannot disagree about where the block ends.

**What it fires on, in full.** A missing or value-less declared key — continuation-aware, so a flow sequence wrapped onto indented lines counts as populated, not empty; a RETIRED key; a `type:`/`phase:` value outside the declared sets; a `date:` outside `YYYY-MM-DD`; an absent frontmatter block; and an unterminated fence, reported as `shape-unverifiable` because the check did not RUN, which is a finding rather than a pass.

**What it cannot see, so its silence is not read as absence.** Extra or unknown keys — this rule declares a canonical contract but never declares the key set CLOSED, and the corpus carries `slot:`, `status:` and a long tail no line forbids, so closing the set is a rule change first. `author:` VALUE membership, which is scoped to `journal-author-discipline.md`. `## For Discussion`, which is reviewer judgment per layer (b) above. Calendar validity of a well-formed date. `tags: []`, which is what `.claude/commands/journal.md`'s own template emits. The three reservation-derived keys on an UNENROLLED repo, where `reserveJournalSlotSigned` returns `record: null` and they cannot be produced at all. And any payload carrying no `content` key — an Edit or NotebookEdit — where it returns nothing rather than reporting "no frontmatter" on the evidence that it was handed nothing.

**Why NEW entries only.** It sits BELOW the `fs.existsSync` overwrite block, so it only ever sees a new entry — exactly the population the rule's § Backfill / Grandfathering scopes a contract change to. MEASURED on this corpus at landing: 274 of 582 existing entries diverge from the contract, dominated by the reservation keys and the three retired ones, and NONE is to be rewritten. Immutability wins over shape.

**Fixtures.** `.claude/audit-fixtures/journal-frontmatter-shape/` — `run.mjs` plus 16 bipolar cases (9 firing poles, 7 silence poles), each with a `.expected` answer-key sidecar held in a SEPARATE file so a case cannot be edited into agreement with the code.

**Distribution, MEASURED with `sync-tier-aware.mjs::buildLaneClassifier` on the landing tree rather than assumed.** The predicates and the guard both return `copy/always_include` on ALL SEVEN lanes, so the detector reaches every lane this rule reaches and no `detector-distribution-baseline.json` row is owed — this is not a loom-side-only gate. Two controls make that readable rather than a blanket answer: `.claude/test-harness/probes/journal.probes.json` returns `skip/exclude` on the same seven, and `dispatch-contract-guard.js` returns `copy/always_include`.

## Origin — The 2026-06-07 Reconciliation (GH #382)

The 2026-06-07 reconciliation (GH #382): retired `created_at`/`session_id`/`session_turn` in favor of the multi-operator triple + per-session provenance ledger, scoped `## For Discussion` to analytical/substantive entries (coordination-receipt DECISIONs exempt), stated the grandfather/backfill policy, and added the canonical-template Trust Posture Wiring.

Receipt-first DECISION: `journal/0230`.

Self-referential-codify surface: this rule + `commands/journal.md` are codify-class output governors — added to the `self-referential-codify.md` allowlist in the same codify → multi-agent redteam to convergence.

## Extraction Record

Two passes, both ZERO de-scoping. The rule body keeps the summary; this is the per-pass ledger.

**2026-08-19 — structural cleanup.** Evidence, runnable detail, worked examples, measured narrative and per-instance provenance moved verbatim out of the rule body into this file.

**2026-09-15 — budget-driven, Rule-10 path (a) paired extraction.** `.claude/bin/check-rule-injection-budget.mjs` failed `RULE_DELTA_OVER` on this rule: it had grown to 19,826 B against an accepted 11,119 B, 8,707 B over a 6,000 B per-rule allowance, and it charges the `workspace-note` profile, which was simultaneously over its ceiling. The growth was real and recent — 15,832 B → 19,826 B in one commit that rewrote the § Trust Posture Wiring `**Severity:**` and `**Detection mechanism:**` bullets when the frontmatter-shape detector shipped. Remedy taken was the one the checker itself names first: extract depth, never raise the number. Five moves, each keeping the normative statement in the body and landing the evidence here — the frontmatter-shape detector's blind classes, single-parse delegation, corpus measurement, fixture inventory and distribution controls (§ Detection Mechanism — The Frontmatter-Shape Detector); the `advisory`-below-MUST-2 rationale (§ Trust Posture Wiring — Field Narrative); the withdrawn NOT-YET-AUTHORED probes claim (§ SessionEnd Wiring — Detection Runnable Detail); the citation-shape detector's CASE keying and fixture-tree residual rationale (§ Citation Convention — Detector Reach and Residual); and this ledger.

**Why Rule 10 / Rule 11 do NOT fire on either pass.** `rule-authoring.md` Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY, and this rule is `scope: path-scoped`. Both passes are therefore structural cleanup rather than Rule-10 paired extractions, and neither is Rule-11 recurrence input (`journal/0148` disposition). The 2026-09-15 pass is described in Rule-10 path (a) TERMS because that is the shape the budget checker's own remedy text names; the trigger-scope disposition is unchanged.
