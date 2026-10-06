# COC Artifact Eval Coverage — Extract

Depth companion for the path-scoped rule `.claude/rules/coc-artifact-eval-coverage.md`. The rule body carries the complete normative contract — MUST-1..6, the MUST NOT bullets, every BLOCKED-rationalization corpus, every DO/DO-NOT block, and every failure-mode `**Why:**` line; both Trust-Posture-Wiring blocks, with all their canonical fields, and § Origin live in its wiring sibling `.claude/skills/32-trust-posture/wiring/coc-artifact-eval-coverage.md` (moved verbatim 2026-09-27), which every validator reads as part of the rule. This file carries what is EVIDENCE rather than obligation: the measured enforcement-reality history, the CI trigger-surface detail, the per-instance provenance tails, the recorded same-codify exemptions, and the full Origin narrative.

Read it when auditing an eval-coverage claim at `/codify` or `/redteam`, when re-measuring whether a red structural check blocks a merge, or when adjudicating whether a MODIFY falls inside the same-codify plumbing carve-out.

## Framing

Moved verbatim from the rule's opening paragraph. The rule keeps the artifact-scope definition and the SHAPE-vs-EFFICACY distinction, which are load-bearing for reading MUST-1 and MUST-3.

An artifact that ships with no eval coverage advertises a behavior nobody verified — the same lookaway risk `spec-accuracy.md` blocks for specs, one surface over. `cc-artifacts.md` Rule 9 already mandates committed structural fixtures for mechanical audit TOOLS; this rule GENERALIZES that contract to ALL COC artifact types and adds the semantic-probe half.

## MUST-1 — reading the floor against the per-type mandate

Moved verbatim from MUST-1. The BLOCKED floor itself ("Shipping an artifact registered with NEITHER tier … is BLOCKED") stays in the rule body.

that floor is what the "with NEITHER" MUST-NOT below enforces, and the per-type mandate above is which tier is REQUIRED for which type.

## The three manifest declarations — per-check mechanics

Moved verbatim from MUST-1 § "Probe-file extension + the three manifest declarations". All three MUST-carry declarations, their field sets, the FAILS-CLOSED contract and the stale-check HARD fail stay in the rule body; this is the per-check behavior behind them.

- `_declared_empty` (check (k)): a declared zero-entry run exits 0 only under a `NO STRUCTURAL COVERAGE` banner and never prints `ALL STRUCTURAL PASS`.
- `_declared_no_pins` (check (i)): an UNDECLARED pin set is not an EMPTY one, so the undeclared case is loud and actionable rather than silently vacuous, and declaring no-pins while real pins exist is itself an error (the declaration would re-authorize a future un-pinned run).
- Check (e) enumerates BOTH extensions, so renaming a probe file no longer hides it from the orphan check.

## MUST-2 — Where the named-regression-case reflex came from

Moved verbatim from the tail of MUST-2's `**Why:**` line. The failure-mode statement — that without the named case the verification evaporates at the context boundary and the next edit re-opens the class with no tripwire — stays in the rule body.

the same reflex a client ecosystem fork's eval harness institutionalized (every redteam finding becomes a named harness case).

## MUST-4 — what reds an expired declaration

Moved verbatim from MUST-4 § "The declared exit for an UNWRITTEN probe suite". The normative statement — an UNDECLARED non-resolving probe path stays BLOCKED, and an EXPIRED declaration is not a declaration — stays in the rule body.

`detection-binding-check.mjs` reds it as a dangler and `phase2-deferral-integrity.mjs` fails the registry, independently.

**Why the `absent-by-design` marker turns a dated omission permanent and silent.** The marker asserts a path that must NEVER exist, so the binding checker stops looking for it: there is no date to outlive, no graduation condition to fail, and no future run that can red. Applying it to a suite that SHOULD exist therefore converts a dated omission into a permanent silent green — the declaration route (`probe_authorship_deferrals` with `expires`) is the one that keeps a clock on the gap, which is why the rule blocks the marker here rather than treating the two as interchangeable.

Do NOT conflate it with `eval-manifest.json::_deferred_probes`, its exact complement: that declares a suite that IS on disk but unregistered and goes stale when the file is ABSENT; this declares a suite that is UNWRITTEN and goes stale when the file APPEARS.

## MUST-1 — the bipolar schema pair

Moved from MUST-1's closing sentence 2026-09-13. The obligation — a `violation` probe MUST use the violation-polarity schema so a correctly-detected violation scores PASS — stays in the rule body; this is the schema inventory behind it.

A BIPOLAR schema pair is a compliant-polarity schema (clean = pass) and a violation-polarity schema (detected = pass). The concrete pairs live at `.claude/test-harness/lib/probe-schemas.mjs`: `Compliance{,Violation}Answer` and `OutcomeFidelity{,Violation}Answer`.

## MUST-6 — the preflight's vacuity fences

Moved verbatim from the MUST-6 Wiring block's `**Detection mechanism:**` field, which keeps the suite path and the statement that both fences are pinned by FIRING them on known-positives.

an absent checker reports `checker-missing` (never a skip), and a registry no row names reports UNCOVERED.

## Distinct From / Cross-References

Moved verbatim from the rule's § Distinct From / Cross-References, which keeps a resolving pointer here.

- **Generalizes** `cc-artifacts.md` Rule 9 (committed structural fixtures for mechanical audit TOOLS) from the tool subset to ALL COC artifact types, and adds the semantic-probe half.
- **Instantiates** `probe-driven-verification.md` (semantic verification is probe-driven, never regex) and `user-flow-validation.md` MUST-7 (write-surface fixtures per failure-mode class) at the COC-artifact-authoring layer.
- **Feeds** the two-tier convergence into `wave-loop.md` G1 + `self-referential-codify.md` Rule 1 (a self-referential codify's redteam round consumes both tiers).
- **Pairs with** `evidence-first-claims.md` MUST-3 (an errored command is zero evidence) — MUST-3 here is that principle applied to a probe return.

## Severity — enforcement-reality measurement history

Moved verbatim from the rule's MUST-1..5 § Trust Posture Wiring `**Severity:**` field. The rule keeps the normative instruction (`re-measure, never cite`; read the shape with `has()`); this section keeps the measurements and the withdrawn phrasing.

**Enforcement reality — re-measured 2026-08-08 and it CHANGED: a red check now DOES block merge at loom** (`required_status_checks.contexts` → `["Required checks"]`, `enforce_admins.enabled` → `true`; loom #65 step 1). The 2026-07-26 / 2026-08-01 measurements found no such key and `false`, and were true when written. **Whether a check blocks is a claim about MUTABLE repo settings: re-measure it, never cite this line** — and read the shape with `has()`, never `--jq '{required_status_checks}'`. **Read the shape with `has()`, never `--jq '{required_status_checks}'`** — the object-construction form CONSTRUCTS the key and yields `null` for a missing one, so it cannot distinguish ABSENT from PRESENT-AND-NULL and is a non-discriminating instrument in this rule's own sense (`instrument-discipline.md` MUST-1). An earlier revision of this line said the API "returns `required_status_checks: null`", which is what that weaker form shows; the conclusion is unchanged (an absent key is at least as permissive as a null one). What would make `block` literal: add this check to `required_status_checks.contexts` and enable `enforce_admins` — both of which the 2026-08-08 re-measurement found already in place. A closing instruction that formerly stood here is WITHDRAWN. It told the reader to treat this gate as evidence-only rather than as something that stops a merge — the pre-2026-08-08 reading, which contradicted the corrected measurement leading this same paragraph and survived into this extract when the depth moved out of the rule body on 2026-08-19. It is DESCRIBED rather than quoted on purpose: the phase2-deferral-integrity sweep matches that sentence lexically and cannot distinguish asserting it from withdrawing it, so reproducing the words here would have re-tripped the gate and required a standing allowlist exemption to suppress a line that agrees with the gate. Cite neither the old reading nor this one — re-measure, per the sentence above.

## Detection mechanism — the CI trigger surface

Moved verbatim from the rule's MUST-1..5 § Trust Posture Wiring `**Detection mechanism:**` field, where it sat as a parenthetical qualifying `node .claude/bin/coc-eval-all.mjs`. The rule keeps the normative Phase-1/Phase-2 statement plus every scanner / fixtures / probes path its own MUST-4 requires be named.

runs on EVERY PR targeting `main` via `.github/workflows/coc-artifact-eval.yml`, whose `pull_request` arm carries NO `paths:` filter (loom#1567 removed it so a required context always reports); the FOUR-entry filter (`.claude/**`, `tests/integration/multi-operator/**`, the workflow file itself, `variants/**`) sits on the `push:` arm ALONE, so a PR touching only `journal/` or `workspaces/` still instantiates the workflow but SKIPS the expensive structural job on a job-level `if:` reading that same allowlist. The `on:` block ALSO carries `merge_group`, `push`, `workflow_dispatch`, and — since 2026-08-14 — a WEEKLY `schedule:` (`cron: "17 6 * * 1"`, the only arm that fires on the CALENDAR rather than on repo activity). Three of those four corrections are to PRE-EXISTING errors rather than to breakage introduced by the calendar arm: the superseded text claimed a `paths:`-filtered PR arm and no `push:`/`workflow_dispatch:` trigger, and all three were already false on `main`; only the `no schedule:` clause was falsified by the calendar change. Naming only `.claude/**` here would understate the trigger set — the `variants/**` entry is load-bearing (the workflow's own comment records it was added because a fork's root-level overlays made the detect job's `variants/` arm unreachable), so describing the filter as `.claude/**`-only re-states the fork-coverage error that comment documents fixing.

## MUST-1 — Recorded same-codify plumbing exemptions

Moved verbatim from the rule's MUST-1 § "Same-codify plumbing carve-out". The carve-out's normative definition and its NARROW bound stay in the rule body; this is the per-instance list of what the landing codify exempted under it.

**Recorded exemptions for this landing codify:** `cc-artifacts.md` (gained only the informational Rule 9 cross-reference paragraph to this rule — no new MUST) and `self-referential-codify.md` (gained only the allowlist registration this rule's landing requires — no new MUST); both are behavior-neutral plumbing, exempt per this carve-out, recorded here per the `verify-claims-before-write.md` omission-precedent shape.

## MUST-5 — The canon-sync gate provenance

Moved verbatim from the tail of MUST-5's `**Why:**` line. The failure-mode statement — that a polarity-only fixture set reports green while a named detection class silently goes uncovered, and that a single-lever resistance claim reports "defeated" while the COMPOSED levers walk through — stays in the rule body.

the exact failure the canon-sync gate shipped (journal 0005 claimed "repoint `fixturesDir` is defeated" from isolated reasoning; the R7 redteam refuted it by composing repoint + `expected`-prune, fixed by the (h) bipolar floor + (i) pin in R7, and the `critical_failures` detection-class binding added in R8).

## MUST-6 — Origin: the five registries

Two moves land here. First, the measured lead of MUST-6's `**Why:**` line, moved verbatim; the failure-mode statement it led ("Review cannot hold a distributed obligation set in attention; a 7-second sweep can", plus the masking clause) stays in the rule body.

Measured across one session, FIVE separate registries were tripped by ONE failure shape — a placement added a declaration surface and did not register it — and every instance was caught by its gate while NOT ONE was caught by review.

Second, the enumeration, moved verbatim from the MUST-6 Wiring block's `**Origin:**` field, which keeps its normative cross-reference.

2026-08-11 — five registries (`ci-suites.json`, `ci-audit-fixtures.json`, `sync-tier-aware.mjs::ALWAYS_INCLUDE`, `phase2-deferrals.json`, community-edition membership) tripped by one omission shape in a single session; each caught by its gate, none by review.

## Origin — Full Narrative

Moved verbatim from the rule's § Origin. The rule keeps a compact Origin plus its extraction record.

2026-07-16 — canon-sync + COC eval-harness institutionalization (BUILD-repo `/codify`, Contract C4). Owner-ratified. Institutionalizes the two-tier eval-coverage contract (structural fixtures in CI + LLM-judge probes at gate-review) across every COC artifact type, generalizing `cc-artifacts.md` Rule 9's tool-only fixture mandate; the redteam→named-regression-case reflex (MUST-2) mirrors a client ecosystem fork's eval harness. Structural harness (`coc-eval-all.mjs`, `eval-manifest.json`) authored in cluster K2; probe layer (`test-harness-probe.md`, `probes/`) in cluster K3; this rule + the `cc-artifacts.md` Rule 9 cross-link + the CI structural gate in cluster K4. MUST-5 (detection-class binding + composed-lever disarm-resistance) added from the same cycle's R7/R8 redteam.

**Landed at loom** 2026-07-19 via `/sync-from-build` Gate-1 classification (Wave-2 of the F4 eval-harness Tier-1 adoption, C2 MERGE-selective). loom adopts the eval ENGINE + this coverage rule but DELIBERATELY EXCLUDES the canon-sync readiness scanner (a separate F3 canon-incorporation decision), so loom's `eval-manifest.json` carries no canon-sync structural entry; loom's own structural scanners land their entries when authored. The 7-day grace clock bootstraps at land-time per `trust-posture.md` § Two-Phase Rollout.

**Grace-period bootstrap exemption — SUPERSEDED 2026-07-29; this rule's OWN probe self-coverage is now REGISTERED and RUNS.** MUST-1 mandates every prose artifact ship a probe set; this rule (a prose artifact) satisfies its own mandate through `.claude/test-harness/probes/coc-artifact-eval-coverage.probes.json`, which IS registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`). The paragraph this replaces said the registration was DEFERRED "until loom's harness graduates from [the zero-entry] steady-state". Both halves of that reason are stale: the registration landed without any graduation (a probe-only entry asserts no STRUCTURAL coverage, which is the quantity `_declared_empty` and integrity check (k) key on, so the two coexist by design), and the suite has been dispatched — first run recorded at (loom-internal reference). Leaving the paragraph standing made the rule false about its own file, and the meta-compliance probe graded that same file `compliant: true` while it said so.

**What DOES remain deferred** is the Phase-2 hook detector named in this rule's Detection-mechanism block, on the ordinary two-phase-rollout schedule (`trust-posture.md` § Two-Phase Rollout) — not the probe tier. The probe tier's own disarm-resistance floor (bipolar poles, non-empty suites, pinned registration, `judge_model` pin, answer-key separation) is `.claude/test-harness/tests/probe-suite-integrity.test.mjs`; the semantic tier is dispatched at gate-review via `/test-harness-probe` and is deliberately NOT in CI, so a green CI run is never evidence the probes passed.

**Amended 2026-07-26 (loom#1368 part 2) — the deferral is now DECLARED, not hidden.** The paragraph above previously recorded a different mechanism: a staged probe file was kept on disk under the `.probes.jsonl` extension specifically because integrity check (e) matched only `*.probes.json`, so the rename made it invisible to the orphan check and the engine self-tests' minimal temp manifests stayed green. That was a coverage claim nobody ran, cleared by a filename. Check (e) now enumerates both extensions and the self-tests inherit the committed `_deferred_probes` declarations, so a staged probe is legal only while explicitly declared with a graduation condition, is printed as a `NOTE:` on every CI run, and reds the gate the moment the declaration is dropped or outlives its file.

**Bootstrap note — the harness ENGINE is `type:tool`, not a per-type probe subject.** The eval-harness's own engine tooling (`.claude/bin/coc-eval-core.mjs`, `.claude/bin/coc-eval-all.mjs`, `.claude/bin/coc-manifest-integrity.mjs`, `.claude/test-harness/lib/probe-schemas.mjs`) is `type:tool` — its correctness is proven by its own committed self-tests (the `manifest-integrity` gate + the scanner-timeout / grade-pin regressions at `.claude/test-harness/tests/coc-eval-core.test.mjs`, `.claude/test-harness/tests/coc-eval-all.test.mjs`, and `.claude/test-harness/tests/coc-manifest-integrity.test.mjs`), NOT by the per-type mandatory-probe table in MUST-1 (which governs the prose/behavioral artifact types: rule / command / skill / agent / hook). A `type:tool` entry carries `probes: null` in the manifest (C3 — a tool has no mandated LLM-judge probe); it is covered by the structural CI tier's fixtures/self-tests. This avoids the bootstrap circularity of demanding an LLM-judge probe of the very engine that dispatches probes. (At loom the engine bins are covered by their committed self-tests directly — loom registers no `type:tool` entry for them per the empty-manifest C2 adaptation; the canon-sync structural fixtures the BUILD-repo bootstrap note also cited are NOT present at loom by the F3-exclusion decision above.)

## Detection mechanism — the authored-unwired coverage detector

Moved verbatim from the MUST-1..5 Trust-Posture-Wiring `**Detection mechanism:**` bullet 2026-09-13. The rule body keeps the normative statement — the detector is AUTHORED BUT UNWIRED, enforces NOTHING, its SILENCE is the absence of an instrument, and enforcement for the clause is the Phase-1 gate-review sweep plus the CI scanners — together with the scanner / fixtures / probes paths MUST-4 requires be named.

`.claude/hooks/artifact-coverage-guard.js` EXISTS on disk over the pure predicates in `.claude/hooks/lib/artifact-coverage.js`, but is NOT registered in `.claude/settings.json` under the `PostToolUse` `Edit|Write` matcher it was authored for — nor in any other surface — so it never loads and does NOT fire in a session. The `@settings-registration: authored-unwired` marker in the hook's own header is the record of why.

MEASURED on this tree, not assumed: the basename returns ZERO occurrences across `.claude/settings.json`, `.claude/codex-templates/hooks.json` and `.claude/gemini-templates/settings.json`, against a sibling basename in those SAME three files that returns non-zero, so the matcher is shown to fire here and the zero is a true negative.

WERE it registered it would fire when a `.claude/{rules,agents,commands,skills}` prose artifact is edited with NO `eval-manifest.json` row under any derived id, NO probe suite at the path the manifest's own shape yields, and NO live `_declared_empty` / `_deferred_probes` / `probe_authorship_deferrals` declaration covering it (an EXPIRED declaration is not a declaration and still fires).

Its severity would be `advisory`, and that cap is a TIMING claim rather than a lexical one — the row and the probe file are a parsed-document fact and a filesystem fact, so the carrier rule would permit more, but the coverage a new artifact owes may legitimately land later in the SAME session, and refusing the write would make the mandated authoring order impossible. The gates that RED are `coc-eval-all.mjs` + `registration-preflight.mjs` in CI.

It COMPLEMENTS rather than duplicates `coc-eval-all.mjs` per `specs-authority.md` Rule 9: that scanner RUNS each REGISTERED entry's fixtures and is blind to an artifact with no row, which is the only state this detector reports.

## 2026-09-15 extraction pass — moved depth

Everything below left the rule body on the 2026-09-15 injection-budget pass. Nothing here is an obligation: every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT fence and `**Why:**` line stayed in the rule, and the census held flat on all sixteen classes (below).

### Framing — what the opening paragraph used to say

A COC artifact "changes what a consuming agent is licensed to do, and one that ships with no eval coverage advertises a behavior nobody verified." The probe half was introduced as "the question `probe-driven-verification.md` mandates asking directly, never via regex over prose" — the rule now states the same contract as "asked directly per `probe-driven-verification.md` and never via regex over prose". The CI-is-LLM-free rationale was carried twice; the parenthetical "(the loom↔csq boundary keeps CI LLM-free)" was dropped from the preamble because MUST-3's `**Why:**` states it in full and that line is normative.

### MUST-1 — the C2 manifest schema field list

The `eval-manifest.json` C2 entry carries `type`, `scanner`, `fixturesDir`, `expected`, `probes`. The rule now says "(C2 schema — field list in the extract)"; the per-field semantics were already covered by MUST-1's own body (non-null `scanner` + non-empty `expected` for `type:tool`; `scanner:null` permitted for a prose artifact). The bipolar-pair sentence dropped only its illustrative gloss "(compliance, outcome-fidelity)" — the property names are the § MUST-1 per-type table's own column.

### MUST-1 — the carve-out's recorded shape

The same-codify plumbing carve-out heading formerly read "**Same-codify plumbing carve-out (recorded via the omission-precedent shape).**" and the body added "The carve-out is NARROW and mirrors `self-referential-codify.md` Rule 2's recorded-omission precedent". The rule keeps the NARROW qualifier and the `self-referential-codify.md` Rule 2 citation; the omission-precedent framing is recorded here.

### MUST-1 — what `.probes.jsonl` actually is

`.probes.jsonl` is what `/test-harness-probe` EMITS for probe RESULTS. That is why a `.jsonl` file under `.claude/test-harness/probes/` is a STAGED definition and never a registered one — the rule now states the STAGED consequence without restating the emitter.

### MUST-3 — the vacuity predicate, NARROWED then RESTORED

The 2026-09-15 pass shortened MUST-3's parenthetical from "a **zero-structural-entry** run exits 0 having verified NOTHING **and is not convergence evidence**" to "a zero-entry run exits 0 having verified NOTHING". That was DE-SCOPING, not extraction, on both halves, and it is REVERTED in the rule body — this entry records why neither half may be shortened again.

**`zero-structural-entry` is the load-bearing qualifier, not verbosity.** `coc-eval-all.mjs` defines `coverageAsserted = structural.length > 0`, where `structural` excludes `type === "gate"` rows and counts only entries a scanner actually graded; its own comment names the second case the qualifier covers — "the all-probe-only manifest (every entry `scanner:null` — also 0 scanners run, and equally misreported as 'ALL STRUCTURAL PASS')" — and calls it "a live DISARM LEVER on the gate". MEASURED on this tree: `eval-manifest.json` carries 92 entries, 84 of them `scanner: null` and 8 non-null. So loom is nowhere near a ZERO-ENTRY manifest and is EIGHT entries from a zero-STRUCTURAL-entry one. A reviewer applying the narrowed wording asks "is this a zero-entry run?", answers correctly "no — 92 entries", and banks the exit-0 green: exactly the case the deleted word blocked, on exactly the lever the scanner's author flagged. Re-derive both counts rather than citing these; the ratio is the point, not the numbers.

**"and is not convergence evidence" was LOST, not moved.** It appeared nowhere in the rule or this extract after the pass. It is the CONSEQUENCE clause — "verified NOTHING" describes the run, and this names what the reader may not then do with it — and MUST-3 is the convergence clause, so dropping it removed the obligation and left only the observation.

### MUST-4 — the consequence the marker carries

The rule keeps the prohibition and the reason the marker is the wrong route (it asserts a path that must NEVER exist). The consequence it carries — that using the marker for a suite which SHOULD exist converts a dated omission into a permanent silent green — is spelled out in § "MUST-4 — what reds an expired declaration" above, which is the section the rule's own depth pointer cites. It was consolidated there 2026-09-15 (redteam MED): the pointer promised that content and the cited anchor did not hold it.

### MUST-5 — the two-imperative tail

MUST-5's `**Why:**` formerly closed: "Bind the fixture to its class; execute the composed attack before claiming resistance." Both imperatives are stated normatively in MUST-5 (a) and (b) themselves, so the tail was a third statement of the same two obligations.

### MUST-6 (b) — TWO RETIRED FIGURES, and why they are not restated

The rule formerly asserted "three of the twelve dedicated suites ARE declaration-closure gates" and cited "A `175/175` trailer", and the paired MUST NOT `**Why:**` repeated "the bulk denominator excludes twelve suites, three of them declaration-closure gates". **Both figures were STALE against the tree and are DELETED rather than re-stated**, per `instrument-discipline.md` MUST-6: a figure restated outside its producing turn must carry its state and a cheap freshness predicate, and neither did.

MEASURED 2026-09-15 by mode census over the two manifests: `ci-suites.json` → `{bulk: 264, dedicated: 15, excluded: 3}`; `ci-suites-bin.json` → `{bulk: 33, dedicated: 4}`. So the dedicated population is 19 across both manifests, not twelve, and 264 bulk rows in the larger manifest alone make `175/175` unreachable as a current denominator. The rule now carries the DERIVATION INSTRUCTION ("census the modes in `ci-suites.json` + `ci-suites-bin.json` yourself") instead of a count, which is the form that cannot go stale. The `175/175` inside the MUST-6 DO-NOT fence is left in place deliberately: it is an ILLUSTRATIVE transcript of a session making the mistake, not a claim about this tree.

**A THIRD figure survived that pass and is retired here (2026-09-15, redteam HIGH).** The same fence's trailing arrow read `← 12 suites never ran`, byte-identical before and after the pass that claimed to retire the twelve. The `175/175` defence above does NOT cover it: the arrow is not transcript, it is the rule's OWN editorial annotation asserting how many suites the bulk runner skipped — a claim about THIS tree, in the rule's voice, inside a fence `check-descoping.mjs` never reads (`extractInventory` skips every in-fence line, which is why no census class moved when the figure went stale). RE-DERIVED on this tree by the same mode census: `ci-suites.json` → `{bulk: 264, dedicated: 15, excluded: 3}`, `ci-suites-bin.json` → `{bulk: 33, dedicated: 4}` — so the rows the bulk runner does NOT execute number 22 (19 dedicated + 3 excluded), not 12. The arrow now carries a DERIVATION INSTRUCTION ("census the modes for how many") rather than a count, matching the form MUST-6 (b)'s body already uses, so the two cannot drift apart again.

The framing sentence "so an author must already know every coupling" and the qualifier "Two corollaries, both load-bearing" also moved here; the corollaries' load-bearing status is carried by their own MUST and BLOCKED tokens.

### Trust-Posture Wiring (MUST-1..5) — moved narrative

- **Violation scope** formerly glossed each clause: MUST-1 "(both-tier coverage on add/modify)", MUST-2 "(named regression case per redteam finding)", MUST-3 "(two-tier convergence, errored-probe-is-zero-evidence)", MUST-4 "(Detection block names the artifact↔harness binding)", MUST-5 "(fixture binds to its named detection class; disarm-resistance proven by composed levers)". The claim made for that move — "each gloss restates that clause's own `###` heading verbatim" — is TRUE for MUST-1, MUST-2, MUST-4 and MUST-5 and **FALSE for MUST-3**, whose heading ("Convergence Requires Structural-Green-In-CI AND Probe-Green-At-Gate-Review") carries the two-tier half and NOT the errored-probe-is-zero-evidence half. Dropping that gloss left a `violations.jsonl` row for "counted an errored probe as a PASS" with no named scope to land in, and the sibling `**Cumulative posture impact:**` field did not list the class either. **Corrected 2026-09-15 (redteam MED):** the MUST-3 gloss is RESTORED in the rule's Violation-scope field — as the half its heading does not carry, not as a heading restatement — and the class was ALSO added to `**Cumulative posture impact:**`, because scope decides where a row lands and the cumulative field decides whether it counts, and the gap was in both. MUST-1/2/4/5 stay deferred to their headings, where the original claim holds.
- **Severity** formerly explained the `has()` requirement inline: the object-construction form "yields `null` for a missing key and so cannot tell ABSENT from PRESENT-AND-NULL" — a non-discriminating instrument in this rule's own sense (`instrument-discipline.md` MUST-1). The rule keeps the `has()` mandate and the citation.
- **Detection mechanism** formerly said the unwired detector "exists on disk over the pure predicates in" its lib, and that it "never loads, never fires in a session". Both are recorded in § "Detection mechanism — the authored-unwired coverage detector" above. The registration zero was RE-DERIVED 2026-09-15 rather than carried across: zero occurrences of the guard basename in `.claude/settings.json`, `.claude/codex-templates/hooks.json` and `.claude/gemini-templates/settings.json`, against a control basename returning 1 in each of those same three files — so the zeros are readable true negatives and not a dead matcher.
- The four-point gate-review sweep was reworded from a clause list into "confirm four things — (a) … (c)". No check was dropped; (a), (a2), (b) and (c) are all still named.

### Trust-Posture Wiring (MUST-6) — moved narrative

The MUST-6 **Cumulative posture impact** field formerly restated the window math "(3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture)" that the MUST-1..5 block states four lines above; it now defers to that block. `trust-posture.md` MUST-4 remains the owning authority for the thresholds in both.

### Origin — moved provenance tail

The Origin anchor formerly added: "Owner-ratified. Institutionalizes the two-tier eval-coverage contract (structural fixtures in CI + LLM-judge probes at gate-review) across every COC artifact type … **Landed at loom** 2026-07-19 via `/sync-from-build` Gate-1 classification (Wave-2 of the F4 eval-harness Tier-1 adoption, C2 MERGE-selective)." The depth pointer's table of contents also listed "F3 canon-sync-scanner exclusion" and "the loom#1368 amendment" — both are already narrated in § "Origin — Full Narrative" above, so the pointer no longer enumerates them.

### Notational change — the `the extract` shorthand

Five mid-sentence depth pointers spelled `.claude/guides/rule-extracts/coc-artifact-eval-coverage.md` in full where the rule's own preamble already defines the shorthand **the extract**. Those five now read "the extract §  …". The preamble retains the full path, so the `citation_path` set member survives (verified: `citation_path` 23 → 23). This was checked against `emit.mjs`'s whole-line depth-pointer matchers (`emit.mjs:328` and `:331`) first — neither matched any of this rule's pointers before the change, so no abridge behaviour flipped.

## Extraction record

**2026-08-19 structural cleanup.** Moved verbatim to this extract: the enforcement-reality measurement history, the CI trigger-surface detail, the recorded same-codify exemptions, the canon-sync gate provenance tail, the five-registry enumeration + vacuity fences, and the Origin narrative.

**2026-09-13 paired extraction (rule 35,762 B → 32,831 B).** Moved here: the authored-unwired coverage detector narrative (above), the bipolar-schema-pair inventory, check (e)'s both-extension enumeration, the `_deferred_probes` complement sentence, and the Origin-narrative provenance tail. Every counted enforcement token was held flat across the pass — `must_clause` 3, `must_token` 77, `must_not_token` 5, `blocked_token` 15, `why_line` 10, and all eight canonical Wiring fields at 2 apiece in each of the two Wiring blocks — so `check-descoping.mjs` records no negative delta on any class.

**2026-09-15 injection-budget pass (rule 32,980 B → measured below).** Moved here: everything under § "2026-09-15 extraction pass — moved depth" above. The census was held FLAT on every class rather than merely non-negative — `must_clause` 3, `must_token` 77, `must_not_token` 5, `blocked_token` 15, `why_line` 10, all eight canonical Wiring fields at 2 apiece, `citation_path` 23, `citation_anchor` 3, `citation_file` 10 → 11 (one GAINED: `ci-suites.json`, added by the stale-figure correction). No citation set member left the rule, so `check-descoping.mjs` records no finding on either the normative or the referential dimension. This pass also RETIRED two stale figures rather than carrying them across (§ "MUST-6 (b) — TWO RETIRED FIGURES" above) — that half is a correctness fix, not a byte saving, and it cost bytes.

**CORRECTED same day by redteam — this pass was NOT zero de-scoping, and the flat census is WHY it went unnoticed.** Three edits removed FORCE while every counted class held flat, because `check-descoping.mjs` declares this exact blindness in its own `coverage_limitations[3]`: "token-counts-are-not-semantics (a MUST whose substance is rewritten but whose word survives is NOT caught)". (1) MUST-3's vacuity predicate was narrowed from `zero-structural-entry` to `zero-entry`, off the disarm lever `coc-eval-all.mjs` names, and its "and is not convergence evidence" clause was LOST rather than moved — both reverted; see § "MUST-3 — the vacuity predicate, NARROWED then RESTORED" above. (2) The `**Violation scope:**` field was hollowed to a clause-id list on a justification FALSE for MUST-3 — reverted, and the class added to `**Cumulative posture impact:**` as well; see the Wiring bullet below. (3) A third stale figure, the `← 12 suites never ran` arrow, survived the pass byte-identical inside a fence the census never reads — retired to a derivation instruction; see § "MUST-6 (b)". The census was a NECESSARY floor and never a sufficient one: it answers "did a counted token leave", not "did an obligation weaken", and on this pass those two questions had opposite answers.

`rule-authoring.md` Rule 10 / Rule 11 do NOT fire on any of the three passes — Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is `scope: path-scoped`, so both passes are STRUCTURAL CLEANUP, not a Rule-10 paired extraction and therefore not Rule-11 recurrence input (the disposition `journal/0148` recorded).
