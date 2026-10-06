---
priority: 10
scope: path-scoped
paths:
  - "**/*REGISTER*"
  - "**/*BURNDOWN*"
  - "**/burndown/**"
---

# State-Regression Integrity — A Recorded Delivery Claim Is Retracted Only By An OBSERVATION

Both incidents, the severity argument, the enforcement inventory, the round-2 false positives and every measurement: `.claude/guides/rule-extracts/state-regression-integrity.md`.

`burndown-integrity.md` governs a figure's PROVENANCE — a block generated from a declared source manifest, or nothing. THIS rule governs the DIRECTION a row may move in one of those declared sources: a status already committed is a RECORD, and a write that walks it backwards is making a claim of its own.

**The predicate is the ground truth, and it already ships.** `.claude/hooks/register-regression-guard.js` runs at `PreToolUse` over the pure predicates in `.claude/hooks/lib/register-regression.js`. Where this prose and that predicate disagree, the predicate governs and this file is the defect.

**Closed status vocabulary**, ranked, from `register-regression.js::STATUS_RANK`: `Signed off` (3) · `Built-not-walked` (2) · `In progress` (1) · `Not started` (0) · `Blocked on you` (0). Rank ≥ 2 is the **delivered band** — the pair that makes a DELIVERY CLAIM. `Blocked on you` is the OWNER-ACTION bucket and claims no delivery, so moving there from the delivered band RETRACTS a claim.

**Supersession vocabulary**, so no retirement is ever inferred. A ROW declares itself retired by a non-empty `superseded_by` · `superseded` · `retired` · `withdrawn`. An ARTIFACT declares itself retired by a BANNER at the head of a line — `SUPERSEDED` · `SUPERSEDED BY` · `REPLACED BY` · `RETIRED` · `WITHDRAWN` · `OBSOLETE` · `DEPRECATED` · `ARCHIVED` · `NO LONGER CURRENT` · `DO NOT USE` — never prose that merely mentions retirement.

## MUST Rules

### 1. A Recorded Delivery Claim Is Retracted Only With An Observation

A row whose **committed status at HEAD** sits in the delivered band carries a delivery claim. A write to a declared register that retracts it MUST carry a rebuttal naming WHAT WAS OBSERVED and WHEN. THREE shapes retract it and all three cost the same: **DEMOTE** (a lower-ranked status), **VANISH** (the row's `id` is no longer present — deleted, or silently renamed), **RETIRE** (`superseded_by` / `superseded` / `retired` / `withdrawn` added to a delivered row). The rebuttal lives on the row as `regression_rebuttal`; for a departed id it lives in the top-level `_removed` map keyed by that id; a pure RENUMBER declares itself STRUCTURALLY in `_renamed` (`{"<new id>": "<old id>"}`) and needs no prose at all. The baseline is the COMMITTED record, never the working copy.

```json
// DO — the rebuttal names what was seen, and a renumber declares itself
{"id": "F80", "status": "Not started", "regression_rebuttal": "walked 2026-09-14: /reports returns HTTP 502, the page never renders"}
{"_renamed": {"F80-r2": "F80"}}
// DO NOT — demote, drop, or retire a delivered row with nothing observed behind it
{"id": "F80", "status": "Not started"}            // demote, no rebuttal
{"id": "F80-r2", "status": "Not started"}         // the old id silently vanishes
{"id": "F80", "status": "Signed off", "retired": true}
```

**SCOPED — a row that ALREADY declared itself retired at HEAD is OUT.** Reinstating or re-labelling such a row is the owner's call and demands no rebuttal. That exclusion is exactly why RETIRE is a retraction shape in its own right: without it, adding the marker in one silent write and demoting in the next is a fully-excluded two-write laundering path.

**Why:** All three shapes move the same count by the same amount, so guarding only the demotion raises the price of the front door and leaves two cheaper exits open; and measuring against the working copy rather than HEAD lets a refused demotion be laundered by a second, unrelated write.

### 2. An Absence Of Fresh Verification Is Not Evidence Against A Recorded One

A rebuttal names what was SEEN. A statement about what the OBSERVER did not do is an ABSENCE and is REJECTED. Verbatim, each one offered and each one refused: **"this session did not verify it" · "no lane walked it" · "I could not confirm it" · "nobody has walked it" · "built, not walked" · "merged is not rendered"**. A PLACEHOLDER is not a rebuttal either — `n/a`, `TBD`, `none`, `nil`, `unknown`, `-`, `x`, `pending`, `done` defeat both arms at once and are refused by name. An observation about the SYSTEM passes; an absence attributed to the SPEAKER does not. If you observed nothing, the recorded status STANDS — leave it alone.

```text
# DO — a system observation, however short
"HTTP 502 at /reports"   ·   "query returns 0 rows"   ·   "export button gone from the nav in a8e737a"
# DO NOT — an absence in the grammar of a rebuttal, or a placeholder
"this session did not verify it"   ·   "unverified"   ·   "we have yet to walk it"   ·   "n/a"
```

**Why:** An absence is consistent with the record being TRUE, so accepting one as a rebuttal lets any unverified row be walked backwards on no evidence; the recorded status is the only claim in the room that someone actually made.

### 3. A Row That Presents As Owed Points At A Live Ask

`Blocked on you` hands a row BACK to the owner, so it MUST name the thing the owner is being asked for. A row MOVING INTO that bucket MUST carry a non-empty `ask_ref`. A row SITTING in that bucket MUST point at an artifact that EXISTS and does not declare ITSELF superseded — the check re-runs on every write, changed row or not, because a row goes stale when the WORLD moves and nobody touches it. If the ask was resolved or withdrawn, move the row OFF `Blocked on you`; do not leave it parked against a dead pointer.

```text
# DO — an ask_ref that resolves, or the row moves off the bucket
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/2026-09-14-schema-sign-off.md"}
# DO NOT — enter the owner-action bucket naming nothing, or point at a superseded/absent file
{"id": "F91", "status": "Blocked on you"}
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/deleted-last-month.md"}
```

**Why:** An owed row with no live ask is indistinguishable from an owed row the owner has already answered, so it accrues against the owner forever while naming nothing they can act on.

## MUST NOT

- Report the guard's UNKNOWN verdict as a clean check. "Could not check" and "checked, clean" are OPPOSITE facts, and the guard says which it is.

**Why:** An UNKNOWN read as clean converts a missing measurement into a passing one — the exact non-discriminating result `instrument-discipline.md` MUST-1 refuses.

- Park a row on a status OUTSIDE the closed vocabulary, including one carrying an invisible or compatibility code point.

**Why:** An unreadable status makes the delivered-band ladder unable to rank the row, so a later demotion runs from a rank nothing can read; `burndown-build.mjs` refuses such a source at exit 2 anyway.

- Write `internal` in place of a retirement marker, or read an `internal` row as retracted.

**Why:** `internal` is a VISIBILITY flag — an internal row is one we do not report on, which is not a claim it was never delivered; conflating the two both hides retractions and refuses operators doing nothing wrong.

**BLOCKED rationalizations:**

- "This session did not verify it, so Not started is the honest status"
- "Nobody has walked it, so `Signed off` overstates it"
- "It was built but never walked — `Built-not-walked` is just more accurate"
- "I could not reproduce it, so the recorded status must be wrong"
- "A lower status is the conservative choice"
- "Renaming the id is a renumber, not a retraction"
- "I'll drop the row and re-add it with the right status"
- "Marking it superseded is tidier than arguing about the status"
- "The rebuttal field is prose; `n/a` is fine when there is nothing to say"
- "The register is a draft — the statuses are not binding yet"
- "The guard returned UNKNOWN, so nothing was wrong"
- "The ask file is gone because the work is done; the row can stay owed"
- "I'll re-point the `ask_ref` later, the row is obviously still owed"
- "Downgrading is reversible, so it is low-risk"

## Trust Posture Wiring

Applies to this whole file — it is NEW, so no section is grandfathered, and it ships canonical-8-field-compliant per `trust-posture.md` MUST-8.

- **Severity:** `block` for the STRUCTURAL arm ONLY — a retraction (MUST-1) whose rebuttal is MISSING, wrongly-typed, empty, a named placeholder, or under the residual character floor. That verdict is two facts and no prose: an integer comparison over a closed status enum whose lookup normalizes case, spacing, hyphens and invisible code points, and a JSON key-presence test — so it satisfies `hook-output-discipline.md` MUST-2's "a regex cannot misread it, and surface rewrite cannot evade it". `halt-and-report` everywhere the verdict depends on what the rebuttal SAYS (MUST-2's absence corpus, rendered at the `pre-action` register because the hook fires BEFORE the write) and for MUST-3's B-0/B-1/B-2 arms and the out-of-vocabulary A-5 arm. Also `halt-and-report` at gate-review, where reviewer at `/implement` and cc-architect at `/codify` confirm a committed retraction carried an observation. **Do not tidy these onto one severity: the split IS the finding.**
- **Grace period:** 7 days from rule landing (2026-09-14 → 2026-09-21).
- **Cumulative posture impact:** same-class violations (a delivery claim demoted, vanished or retired with no observed rebuttal; an absence or placeholder offered as one; a row entering or sitting in `Blocked on you` with no live ask; the guard's UNKNOWN reported as clean) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8, on this rule's OWN reasoning: the `block` arm already refuses the violation at the moment it is attempted, so a posture key would fire only on a retraction that reached a commit through a channel the hook cannot see, which is a review-layer judgment; and minting a key would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: state-regression-integrity]` IFF `posture.json::pending_verification` includes the `state-regression-integrity` rule_id (one rule_id covers MUST-1..3 and the MUST NOT bullets).
- **Detection mechanism:** **STRUCTURAL, SHIPPED AND ARMED — not deferred, and not merely authored.** `.claude/hooks/register-regression-guard.js` is REGISTERED in `.claude/settings.json` at `PreToolUse` with matcher `Edit|Write|NotebookEdit` — the event its own `@hook-event` header declares — measured control-first against a known-registered sibling so the hit is readable rather than assumed. It fires only on a `.json` write whose path is a DECLARED `kind: "register"` source in `burndown-manifest.json`, reconstructs the incoming content exactly (a `Write` body, or a uniquely-resolvable `Edit`), and evaluates it against the COMMITTED blob at HEAD. It attributes `state-regression-integrity/MUST-1` on the blocking arm and `state-regression-integrity` otherwise. Structural fixtures: `.claude/audit-fixtures/register-regression/run.mjs`, driving the predicates directly AND the hook as a real subprocess so a green in one is not mistaken for a green in the other. **ARMED IS NOT PROVEN EFFECTIVE:** no live session has been OBSERVED being refused by this guard; registration, fixture state and fail-open behaviour are the whole of what is measured. **It FAILS OPEN on every unknown** — no manifest, a non-declared path, no HEAD blob, unparseable JSON on either side, an unreconstructible edit, a spawn failure, a timeout — and SURFACES each as UNKNOWN rather than rendering it clean, which is why MUST NOT bullet 1 exists. **No Phase 2 is booked, and none is owed.** The structural half already ships at `block`; the remaining half — whether a rebuttal states an ABSENCE or an OBSERVATION — is a semantic judgment over prose, is implemented lexically and is PERMANENTLY CAPPED at `halt-and-report` by `hook-output-discipline.md` MUST-2. Booking a future detector to "promote" it would be teeth that cannot arrive, which `rule-authoring.md` MUST NOT names. **Probes: REGISTERED — `.claude/test-harness/probes/state-regression-integrity.probes.json`**, bipolar `pair_id` pairs with candidate fixtures and answer-key sidecars at `.claude/audit-fixtures/state-regression-integrity/`, registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. Row and pair COUNTS are deliberately absent from this line: stating an unmeasured figure inside the Detection block of a rule about unwarranted state claims would instance the rule at the site of its own landing. Read the suite for the counts. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. **Consumer note — the consumer state is PRESENT-AND-UNREGISTERED, which is worse than absent.** MEASURED with `sync-tier-aware.mjs::buildLaneClassifier` against a discriminating control on the same call (`check-merge-separation-guard.js` returns `skip/loom_only` on all six lanes): BOTH hook files return `copy/always_include` on all six of `use/base`, `use/py`, `use/rs`, `build/base`, `build/py`, `build/rs` — this guard is NOT fenced and DOES ship. But `.claude/settings.json` returns `skip/exclude` on the same lanes, so the REGISTRATION does not travel with the file: a consumer receives the detector INERT unless it registers the hook itself. `detection-distribution-check.mjs` names exactly that state and why it is the dangerous one — it reads as coverage. Its `hook_delivery` lane is declared `cc-only` in `sync-manifest.yaml` for a PREDICATE reason rather than a matcher one: Codex's `apply_patch` carries a DIFF, not the resulting document, so the reconstruct-and-parse predicate has nothing to key on there even where an edit lane exists. Until a consumer registers it, enforcement at that target is the gate-review sweep above — there not a backstop but the whole of it — and its silence is the ABSENCE OF AN INSTRUMENT, never evidence that no row was walked backwards.
- **Violation scope:** rule-corpus-wide across MUST-1..3 and the three MUST NOT bullets. Every `violations.jsonl` row names the register, the row id, the recorded status at HEAD, the status written, and which clause fired.
- **Origin:** See § Origin.

## Distinct From / Cross-References

**`burndown-integrity.md` is the nearest neighbour and does NOT overlap.** That rule governs whether a reported figure was GENERATED from a declared manifest — provenance at the READING end. This one governs whether a row's committed status may be WALKED BACKWARDS at the WRITING end. They compose in one direction only: a demotion committed without a rebuttal produces a block whose every figure is validly generated and quietly wrong, and `burndown-integrity.md` never fires, because the generator is not asked whether a number should have MOVED.

Also distinct from: `instrument-discipline.md` (whether a check, once run, can discriminate — MUST NOT bullet 1 cites it by reference rather than restating it, per `specs-authority.md` Rule 9); `evidence-first-claims.md` (the GRAMMAR of a claim, not the DIRECTION a record may move); `conservation-gate.md` (content crossing a boundary, where the question is whether something still EXISTS — this rule's subject persists and its STATUS changes); `burndown-traceability.md` (whether an item's ruling is anchored at all).

Origin: 2026-09-14 — the prose half of an enforcement that was already shipped and wired, landed into the single corpus-ceiling slot ratified 104 → 105 at `.claude/test-harness/ratchet-registry.json::ratchets.corpus-rule-count-ceiling.ratified_movements`. The inversion that ratification names is the provenance: loom's habit is governance prose whose enforcement is deferred, and here the detector, its predicate seam and its fixture set landed first while no rule text governed them — so the corpus held live enforcement nobody had written down. The three retraction shapes in MUST-1 are not a taxonomy invented here; they are what a security review of the guard's first revision FOUND, each one a cheaper exit than the demotion that revision guarded. The absence corpus in MUST-2 is verbatim from the incidents that produced it: every phrase listed was a rebuttal actually offered for a row being walked backwards.
