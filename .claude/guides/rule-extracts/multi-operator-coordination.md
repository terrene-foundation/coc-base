# Multi-Operator Coordination Substrate — Depth Extract

Depth companion for `.claude/rules/multi-operator-coordination.md`. The rule body holds the
obligations; this file holds the narrative, measurement history, registration bookkeeping and
extraction records moved out of it. The SUBSTRATE ARCHITECTURE (§1–§8, MUST-4/5/6/7, the F-series
registry) lives in a different file and is NOT duplicated here —
`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md` remains the place
every `§N` / `MUST-N` anchor in the rule resolves.

## §2 Disposition Clause — Detection Depth

Moved out of the `- **Detection mechanism:**` bullet of the rule's
**Trust Posture Wiring (Coordination-Disposition Verification clause)** on 2026-09-13. The bullet
keeps the Phase-1 gate-review statement, the probe-suite path, the fixtures directory, the
Phase-2-RETIRED verdict with both of its citations, and the permanence of gate-review.

### Probe-suite registration and what registration buys

**CITATION RESTORATION (2026-09-13).** The compact form of the paragraph below was RESTORED to the
rule body — the extract is not the loaded surface, so a registration citation living only here no
longer bound the rule to the artifact it names. The rule body now carries `eval-manifest.json`,
`probe-suite-integrity.test.mjs::PINNED_SUITES`, `clause-coverage-baseline.json`,
`coc-probe-dispatch.mjs` and `.claude/test-harness/**` directly. What stays here is the long form
and the dispatch narrative:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
> `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses in
> `clause-coverage-baseline.json`. Registration buys DISPATCHABILITY, never automatic execution: no
> workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green
> CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches
> `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/**` is
> never-synced, so no consumer receives this suite and enforcement at those targets is gate-review.

### The pole diff — why this pair is the load-bearing one

> The pair for THIS clause is the load-bearing one for the projection question: both poles quote the
> SAME `wrong-owner` helper return byte-for-byte and the SAME empty lease file, and separate only on
> whether the disposition then rests on them or on the folded record set — so a check keying on "did
> the session verify before claiming?" scores the violation pole clean.

That pole diff is also the measurement behind the Phase-2 retirement: an instrument that cannot
separate the two poles is not evidence (`instrument-discipline.md` MUST-1) and cannot be built into
the bipolar fixture set a graduation would demand.

### The withdrawn correction and the withdrawn carve-outs

> An earlier revision of this row said the suite was NOT YET AUTHORED and pointed at a
> `probe_authorship_deferrals` entry; both are now FALSE and are corrected here rather than left, and
> that entry is deleted in the same change.

> **Phase 2 is RETIRED, not pending (2026-09-13)** — so the former forward-pointer to a separate
> `coordination-disposition-verification/` detector directory is WITHDRAWN with the deferral, from
> the Wiring field and from `validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES`, rather than
> left standing as a carve-out for a directory nobody will create. That field already said
> "(semantic)" while booking a dated deferral against it, which is the shape
> `hook-output-discipline.md` MUST-5(b) forbids.

The deciding property, stated in full: not WHICH command ran — argv is structural and a transcript
carries it — but whether a disposition CLAIM rests on that command's output or on a projection read
beside it; pairing a claim to its evidence is judgment over prose, carried by no argv token, AST
node, parsed-document field or git-object fact.

### Why the Phase-2 retirement is not a schedule (moved 2026-09-15)

Moved out of the `- **Detection mechanism:**` bullet on 2026-09-15. The bullet keeps the RETIRED
verdict, the permanence of gate-review, and both citations (`hook-output-discipline.md` MUST-5(b)
and `instrument-discipline.md` MUST-1); what left is the reasoning that connects them:

> whether a disposition CLAIM rests on a command's output or on a projection read beside it is a
> judgment over prose no argv token, AST node or git-object fact carries, so a dated deferral against
> it is the shape `hook-output-discipline.md` MUST-5(b) forbids, and an instrument that cannot
> separate the probe pair's poles is not evidence (`instrument-discipline.md` MUST-1).

Also moved, from the same bullet: the qualifier that `.claude/test-harness/**` being never-synced
means "enforcement there is gate-review" (the rule body already states the general form of this in
the §2 disposition Wiring `- **Severity:**` field), and the words "always-on" and "meta-compliance"
from the probe-pair enumeration, which the rule now writes as "the MUST NOT section" and "a meta
pair". The pair count, the row count and every registration citation stayed in the rule body,
because those are the anchors a registry has to resolve (§ "Probe-suite registration and what
registration buys" above records why).

## Relocated skill pointers (2026-09-13, citation-restoration pass)

Two duplicate navigation pointers were moved out of the rule body to fund the citation
restoration recorded above under § "Probe-suite registration and what registration buys". Both
targets are unchanged; only the second pointer to them left the rule.

- § "§2 essentials" carried the pointer twice — `Mechanism depth: skill § "Rule-body extract —
§2 essentials" + §2` on the first paragraph, and `Why this is a recurring cross-session misread:
skill § "Rule-body extract — §2 essentials"` on the second. The first is kept in the rule; the
  second pointed at the SAME skill section and was the one removed.
- The file-level `**Severity:**` bullet carried `Why that pair is not \`block\` (loom#1323): skill
  § "Rule-body extract — file-level Trust Posture Wiring narrative"`. That narrative — why the
SAME-class-write and §4.2 cross-worktree-contention pair carries `halt-and-report` rather than `block` — still lives at that skill section; only the pointer moved here.

## Prose moved on 2026-09-15 (rule-injection-budget lane)

A third injection-budget pass. Every item below left the rule body and arrives here; the normative
census was re-measured on the edited tree and is UNCHANGED (`must_clause` 5, `must_token` 55,
`must_not_token` 7, `blocked_token` 7, `why_line` 8, all eight canonical Wiring fields at 2
occurrences each) and the citation SET is byte-identical to `origin/main`'s.

### §1 — the identity-triple recap

Moved out of the § §1 `**Why:**` line, which keeps its first clause (the banner-versus-gate
contrast). The removed tail is a recap of the three bullets standing immediately above it:

> `verified_id` is the cryptographic primitive, `person_id` the authority unit, `display_id` only
> signage.

### §2 essentials — the fold-cache sentence

The paragraph was re-set as one sentence rather than two, and the standalone bolding of
`refs/coc/coordination-genN` was dropped; nothing left the rule. Recorded here only so the diff's
intent is legible: the ref name, the shared-`.git` fact and the worktree-sees-it conclusion are all
still in the rule body.

### §2 disposition clause — the MUST-3/MUST-4 glosses

Moved out of the § §2 `**Why:**` line. The rule keeps the citation and both clause numbers:

> `evidence-first-claims.md` MUST-3 (a non-success return is zero evidence) **+ MUST-4** (an
> inference stated as fact).

Also moved: the second pointer to skill § "Verifying a coordination-state DISPOSITION" carried the
gloss "+ why each fails"; the pointer itself is kept on the BLOCKED-rationalizations line, and the
same skill section is already reached from the MUST clause two paragraphs above.

### MUST NOT § Positional — the tier-split framing

Moved out of the bullet and its `**Why:**`. Both tier halves, the resolver anchor, the
`ask, never guess` obligation and all three MUST NOT tokens stay in the rule:

> **The binding is tier-dependent, so both halves are stated here.** … that resolver is deliberately
> NOT distributed … Same tier split `repo-scope-discipline.md` § MUST NOT states for the identical
> binding.

### Substrate reference map — the enforcement sentence

Moved out of the section's intro line, which keeps the per-anchor-gloss pointer:

> Each anchor is enforced structurally by a named hook / fold-rule / validator.

It is not a loss of reach: the file-level Wiring `- **Detection mechanism:**` field names every one
of those guards (`adjacency-leasecheck.js`, `operator-gate.js`, `genesis-anchor-guard.js`,
`fold-rule-9c.js`, fold rules 1–3, validator-13) against the MUST it enforces, which is the same
fact stated with the hooks attached. The §7 bullet was also folded into the §2–§8 anchor line; no
token moved.

### File-level Wiring § Severity — the duplicate guard citations

Moved out of the `- **Severity:**` field. Both guards remain cited on that same field (the `block`
half names `integrity-guard.js` and `signing-mutation-guard.js`) and `adjacency-leasecheck.js`
remains cited on `- **Detection mechanism:**`, so the citation SET is unchanged:

> (`adjacency-leasecheck.js` + `signing-mutation-guard.js`)

### § Origin — the extraction-record narrative

The § Origin extraction record was reduced to one pointer sentence carrying its MUST / MUST NOT /
BLOCKED tokens. What left:

> **Extraction record — S27-INJECTION (2026-08-19), ZERO de-scoping.** Evidence, mechanism detail,
> measured narrative and per-instance provenance relocated verbatim to the skill § "Rule-body
> extracts (S27-INJECTION, 2026-08-19)"; every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block,
> `**Why:**` line and canonical Wiring field stayed here.

> Why this rule is EXTRACTed and never NARROWed: …

### Measured outcome, and the ceiling that bounds it

The rule body went **17,425 B → 16,189 B, a −1,236 B delta**, measured on the working tree at
`df24a8848` by `wc -c .claude/rules/multi-operator-coordination.md`. That figure is this pass's
measurement and is NOT current for any later tree — re-run the command rather than citing this line.
The lane brief asked for ≥3,500 B
and that target is NOT reachable on this file without de-scoping — measured, not asserted. Running
the check's own extractor (`check-descoping.mjs::classifyLines` + `citationsInLine`) over the base
revision and classifying every line as PINNED (inside a fence, or carrying a `MUST` / `MUST NOT` /
`BLOCKED` token, a `**Why:**` opener, a canonical Wiring label, or a citation token appearing
exactly ONCE in the file) versus FREE gives **PINNED 14,364 B / FREE 3,062 B** of 17,426 B. The FREE
figure is an upper bound that is itself unreachable: it counts the 402 B of frontmatter, the five
section headings, and four bullets that carry no counted token but are plainly normative (`host_role:
ci` audit-only eligibility, the `business_roles` advisory constraints, the `display_id` attribution
bullet, and the whole `- **Sync posture.json …**` MUST NOT bullet body). Subtracting those leaves
roughly 1,550 B of genuinely free whole lines, most of it inside paragraphs that also carry pinned
tokens and so can only be compressed in place rather than moved. The falsifying result is nameable
and did not occur: had the corpus held ≥3,500 B of movable depth, the FREE total would have exceeded
that figure before any of the unreachable categories were netted out, and it does not.

## Trust Posture Wiring — The 14-Day Grace Window's Citation Anchor

Moved out of the file-level `- **Regression-within-grace:**` bullet on 2026-09-13. The bullet keeps
the window statement itself ("this rule's OWN 14 days, NOT the generic trigger's default 7") and its
pointer to the paired skill § "The 14-day window".

> `trust-posture.md:121` is the field spec PERMITTING a non-canonical window; `:70` and `:97-99`
> state a flat 7 and are deliberately NOT the anchor.

## Origin — Extraction Policy

Moved out of § Origin on 2026-09-13; the Origin line keeps the convergence date and its pointer to
the skill § Origin.

> EXTRACT not NARROW — narrowing this synced coordination safety rule would de-scope it in BUILD
> repos where SAME-class collisions happen.

## Extraction Record

**S27-INJECTION (2026-08-19), ZERO de-scoping.** The rule's own § Origin keeps the summary sentence.
The disposition record moved here:

> `rule-authoring.md` Rule 10 / Rule 11 do NOT fire — Rule 10 § "Trigger scope" limits both to
> `priority: 0` + `scope: baseline` rules and this rule is `scope: path-scoped`, so this is
> STRUCTURAL CLEANUP, not Rule-10 paired extraction nor Rule-11 recurrence input (`journal/0148`
> § "Lesson learned", same disposition).

**2026-09-13 rule-injection-budget pass, ZERO de-scoping.** This rule's raw body is charged in full
to all six over-budget rule-injection profiles, so every byte removed from it is recovered six
times. Depth was moved to this companion; the normative census is UNCHANGED across every edit —
`must_clause` 5, `must_token` 55, `must_not_token` 7, `blocked_token` 7, `why_line` 8, and all eight
canonical Wiring fields still at 2 occurrences each. Nothing bearing a `MUST`, `MUST NOT`, `BLOCKED`
or `**Why:**` token was moved into this uninjected file. `rule-authoring.md` Rule 10 / Rule 11 do
NOT fire (`priority: 10` / `scope: path-scoped`), on the same disposition the 2026-08-19 record
above states.

**2026-09-13 citation-restoration pass, NET −27 B, ZERO de-scoping.** The 2026-09-13
injection-budget pass recorded above dissolved seven citation code spans into extract prose. An
extract is NOT the loaded surface, so the rule had stopped naming five artifacts it binds to. All
seven are now accounted: SIX restored to the rule body as code spans — `eval-manifest.json`,
`probe-suite-integrity.test.mjs::PINNED_SUITES`, `clause-coverage-baseline.json`,
`coc-probe-dispatch.mjs`, `.claude/test-harness/**`, and
`validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES` (the last as a WITHDRAWAL record, since
this rule's entry in that set is deleted, not present) — and `coordination-disposition-verification/`
restored as the named subject of that same withdrawal rather than as a live forward pointer, because
the directory will never exist. MEASURED: `validate-xref-integrity.mjs` reports ZERO dangling refs
from this rule after the restoration (the bare slug carries no resolvable path prefix, so it is not
a forward pointer the resolver can follow), and `check-descoping.mjs` reports 0 findings of ANY
class for this rule, down from 3. Paid for by paired extraction WITHIN the same pass — the two
duplicate skill pointers recorded in § "Relocated skill pointers" above, the 14-day-window
citation-anchor enumeration, the Rule-10/11 depth pointer, and word-tightening of the Phase-2
retirement sentence — so the rule body went 17,432 B → 17,405 B. Normative census UNCHANGED and
re-measured on the edited tree: `must_token` 55, `must_not_token` 7, `blocked_token` 7, and all
eight canonical Wiring fields still at 2 occurrences each. This rule is the corpus's broad-load
giant (it fires in all eight injection profiles), so every byte is charged eight times — which is
why the target was net ≤ 0 rather than merely "small".

**2026-09-27 wiring-sibling pass, rule body 16,560 B → 11,307 B, ZERO de-scoping.** The ceiling
recorded in § "Measured outcome" above held for depth moved to THIS guide, which is uninjected and
which `check-descoping.mjs::isInjectedMoveDestination` refuses as a move destination. It did not
bind bookkeeping, which has had a sanctioned destination since `8e5bba6e3`: both Trust Posture
Wiring blocks (the §2 clause-scoped bold-marker block and the file-level section) and § Origin moved
VERBATIM to `.claude/skills/32-trust-posture/wiring/multi-operator-coordination.md`, which
`bin/lib/rule-governance-surface.mjs` joins to the rule for every governance validator. Every
original line is present in rule ∪ sibling (content-identity check, with a control line that
reports absent). Every MUST heading, `**Why:**` opener and BLOCKED rationalization line stayed in
the body; the MUST / MUST NOT / BLOCKED tokens that left were citations inside Wiring bullets and
the extraction-record sentence, and `check-descoping.mjs` credits every one as MOVED. The
`paths: ["**/*"]` scope was kept: MUST-2 binds an edit to ANY path under a SAME-class claim, so no
narrower glob is honest, and a glob cannot express "coordination enabled" or "≥2 operators".
