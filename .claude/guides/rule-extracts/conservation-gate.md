# `conservation-gate.md` — depth extract

Paired depth companion for `.claude/rules/conservation-gate.md` (Rule-10 path (a)). This file is
NOT baseline-emitted: `emit.mjs::abridgeV6` strips the whole-line rule-extract pointer, so nothing
here costs a byte on the codex/gemini always-on lane. CC loads the rule body; this file is read
on demand.

---

## The contract, restated once

> Wherever content crosses a boundary, enumerate what existed BEFORE, enumerate what exists AFTER,
> and require every element of the delta to be DECLARED. Undeclared disappearance is the violation.

The corpus gates **ACTIONS** and almost never gates **CONTINUITY**. Open-PR count, PR head shape,
push cadence, receipt present, disclosure clean, tier declared — every one of them asks _should this
proceed?_ Almost none asks _does what I had a moment ago still exist?_ `#1773` reached the same
finding independently, in its own words: _"None answers does this branch still CONTAIN what it
contained an hour ago. Content loss was not a modelled failure mode."_ That issue was filed before
the diagnosis below was written, which makes it convergent evidence rather than a restatement.

**Moved out of the rule body 2026-10-03 (scratch fold), verbatim — restatements, no obligation lost.**
The fold of `scratch-path-discipline.md` into MUST-5 had to shrink the EMITTED baseline, so these
sentences, each of which restates a clause or a Why that stays in the rule, now live here:

- Framing (old intro): _"Other guards ask **should this proceed?** This one asks **does what I had a
  moment ago still exist?** … enumerate what existed BEFORE, enumerate what exists AFTER, and DECLARE
  every element of the delta."_ — the obligation is MUST-1; the question is kept in the intro.
- Old intro's boundary list in full: a branch rewrite, a dispatch and its result, a source delivered
  to a destination, a worktree at teardown, a scrub before publication (the rule now names them
  tersely and adds a temp-root purge).
- MUST-1 Why: the healthy-looking surviving evidence is _"a green PR, a plausible commit list, an idle
  notification"_; _"Reconstructing it afterwards asks the damaged surface to testify about its own
  damage."_
- MUST-2: _"Absence from a branch is not absence of the work; a present path is not preserved
  content."_ — restates "never on names, shas or path presence".
- MUST-3: _"Silence about an unobservable class is not evidence of its absence."_ — restates the
  MUST-3 Why.
- MUST NOT bullet 1 Why: the parsed structural signals that may carry `block` are _"a `git rev-list`
  integer, a file-state read, a payload-presence bit"_ — see § Boundary Roster.

---

## The Eight Measured Instances

All eight surfaced in a single session (2026-08-16) and are recorded in
`journal/0577`. They share ONE property: **the
surviving evidence looks healthy.** A green PR after a flattening rebase. An idle notification after
undelivered work. A scan returning zero after a purge that closed nothing. A shorter but entirely
plausible commit list.

| # | Instance | Boundary | Which MUST it breaks |
| - | -------- | -------- | -------------------- |
| 1 | Gate-2 stale delivered copies are immortal — never copied over AND never purged, so a superseded artifact survives indefinitely at the destination | source → destination delivery | MUST-1 (no before/after set is taken at delivery, so a stale survivor is never in anyone's delta) |
| 2 | `kailash-rs`: 67 refusals, 0 of them formatting-only, ~3,850 destination-authored lines at risk of being overwritten | source → destination delivery | MUST-1 |
| 3 | The destination-divergence fence is structurally blind to untracked files and to ADDITIONS — 180 added files, one published `.env`, none of it in the fence's reach | source → destination delivery | MUST-3 (blindness never named; the fence's silence was read as clean) |
| 4 | Rebase flattening merge commits (`#1773`) | branch rewrite | MUST-1 + MUST-2 |
| 5 | The 10 → 4 miscount inside `#1773`'s own comment thread — "not on the trunk" read as "lost" | branch rewrite | MUST-2 (name-identity used where content-identity was required) |
| 6 | A dispatched agent's result discarded; the orchestrator recorded an idle | dispatch → result | MUST-4 |
| 7 | Two lanes went silent after hook refusals, holding 7- and 286-insertion payloads uncommitted | dispatch → result | MUST-4 |
| 8 | The codify lease's signed cross-clone coordination record can never emit (below) | ceremony → durable record | MUST-4 |

### Instance 8 in full — measured DURING the authorizing receipt's own ceremony

`acquireCodifyLease`'s signed coordination record — which `rules/knowledge-convergence.md` MUST-3
names as _"the cross-clone visibility surface for the on-disk local mutex"_ — **can never emit.**
Measured on three poles:

| scope passed | record bytes | verdict |
| ------------ | -----------: | ------- |
| 6 entries    | 3083 B       | refused (> 2048 B cap) |
| 1 entry      | 2956 B       | refused |
| **0 entries (empty)** | **2956 B** | **refused** |

An empty scope list yields a record byte-identical to a one-entry list, so the caller cannot shrink
it: the overflow is in the record's own baseline, not in caller input. The refusal is CORRECT
behaviour (refuse-on-overflow preserves signed-bytes-match-disk-bytes rather than truncating after
signing) — but its effect is that every `/codify` and `/govern` at loom holds a lease whose
cross-clone visibility record silently fails **while the lease itself returns `ok: true`.** The
multi-operator mutex is effectively local-only.

This is the contract's own thesis instantiated inside the ceremony that authorized the contract: a
success return, a failed continuity record, and nothing surfacing it unless someone reads
`record_emit`. It is EVIDENCE for the rule, dispatched as a separate bounded fix; it is deliberately
NOT folded into the rule body.

A ninth, adjacent instance measured the same session and recorded here for completeness: `/govern`
mandates an O1 shape gate that a co-owner-directed receipt can never pass (`o1-citation-check.js`
exits 1; zero references to the co-owner-directed lane, control `standard` = 26). It is a
composition defect rather than a conservation one, so it motivates no clause here.

---

## Boundary Roster

The rule is a CONTRACT, not a mandate to build five detectors. Each boundary instantiates it with
the strongest signal THAT boundary actually yields — which is why `conservation-gate.md` § MUST NOT
forbids a uniform `block`. Per `hook-output-discipline.md` MUST-2 only a parsed structural signal
may carry `block`; a judgment-bearing boundary carries `halt-and-report`.

| Boundary | Signal available at the boundary | `block`-eligible? | Status |
| -------- | -------------------------------- | ----------------- | ------ |
| **Branch rewrite** (rebase / squash / force-update) | STRUCTURAL — a `git rev-list --count` integer and a reverse-patch-apply verdict, both parsed, both available pre-operation | YES | **In flight** — `#1773`. This rule does not duplicate or pre-empt that work; it states the contract the work instantiates. |
| **Dispatch → result** (agent-result delivery) | STRUCTURAL for the presence half — a result-payload presence bit is readable; the ADEQUACY of the payload is judgment-bearing | Presence half YES; adequacy half NO | **In flight** — agent-result-delivery, ingested at `c4b3ebe5` on `fix/gate1-ingest-cocrs-2026-08-16`. Same non-duplication note. |
| **Gate-2 delivery** (source → destination) | STRUCTURAL — a file-state read at the destination; the existing divergence fence already parses one, but is blind to untracked files and to additions | YES, once the blind classes are closed | Fence EXISTS; extending it to untracked + additions is the open work (instances 1–3). |
| **Worktree lifetime** (creation → teardown) | STRUCTURAL — `git status --porcelain` plus an untracked-file enumeration at teardown | YES | **NO guard today.** Highest-value unclaimed instantiation. |
| **Source scrub → destination** (scrubbed at source, live at a published destination) | MIXED — a token-set comparison is structural; whether a survivor is a genuine disclosure is judgment-bearing | Comparison half YES | Partial — the scrub runs at source; the destination-side re-check is the gap. |

**Value order** (from the receipt): rebase · dispatch → result · Gate-2 delivery · worktree lifetime
· source scrub → destination.

**What an instantiation owes.** Each instantiation owns its OWN detection and its OWN fixtures, and
carries its own Trust-Posture Wiring if it lands as a rule clause. `conservation-gate.md` books
nothing on their behalf — its Wiring (`skills/32-trust-posture/wiring/conservation-gate.md`) § Detection mechanism says so explicitly, so that a future
maintainer reading the contract does not believe five detectors were promised.

---

## Why this is BASELINE and not path-scoped

The moment of decision — choosing to rebase, consuming a dispatched result, tearing down a worktree,
publishing a scrubbed surface — matches **no artifact-file glob**. A `priority: 10` conservation rule
scoped to `.claude/**` would load only when someone edited an artifact, i.e. reliably AFTER the
content was already gone. This is the same reachability class two prior rules were authored to close:

- `issue-triage-routing.md` — a `gh issue` triage touches none of the `.claude/**` globs its routing
  depth sat behind, so only an always-loaded pointer fires at triage time.
- `agents.md` § Worktree Orchestration (clause-scoped wiring, 2026-08-11) — the sibling-worktree
  requirement lived only behind `worktree-isolation.md`'s globs; an orchestrator CHOOSING a spawn
  flag matches none of them, so the nested-worktree guard blocked four spawns with nothing loaded
  that said what to do instead.

A reachability argument is not a blank cheque: `instrument-discipline.md`'s Origin (`skills/32-trust-posture/wiring/instrument-discipline.md` § Origin) records that a
reachability argument for ITS scope was BLOCKED and refuted at `93e47705`. The argument holds here
because the triggering ACTIONS (rebase, dispatch, teardown, publish) are themselves glob-less, not
merely because the rule feels important.

---

## Rule-10 Byte Ledger

`rule-authoring.md` Rule 10 fires: this is a brand-new `priority: 0` + `scope: baseline` rule, so the
gate treats the ENTIRE body as new load-bearing content, and the lane-of-concern was inside the 15%
proximity band at author time.

**Measured with `emit.mjs --all --dry-run`, the authority Rule 10 names.** Both figures are from this
change's own tree; re-measure rather than citing these numbers as current state.

| Pole | codex / gemini emission | headroom |
| ---- | ----------------------: | -------: |
| BEFORE — `origin/main`, no conservation-gate rule | 56,181 B | **14.27 %** |
| AFTER — rule + `agents.md` funding extraction | 58,870 B | **10.17 %** |
| Two-pole on the FINAL tree, rule removed | 55,353 B | 15.54 % |
| Two-pole on the FINAL tree, rule present | 58,870 B | 10.17 % |

The two-pole rows are the honest measure of what the RULE costs, taken on one tree with only the
rule file moved in and out: **3,517 B**. `abridgeV6` alone reports 3,511 B for the body; the 6 B
delta is inter-rule joining. The funding extraction out of `agents.md` recovered **828 B**
(8,679 B → 7,851 B abridged).

**Where the emitted bytes are, and why there is no cheap trim left.** `abridgeV6` strips Origin
paragraphs, `## Trust Posture Wiring` sections, `## Distinct From / Cross-References` sections,
BLOCKED-rationalization corpora, H4+ subsections, whole-line rule-extract pointers, and fenced
blocks over ~200 B. All of those cost ZERO on the always-on lane. So the 3,517 B is MUST clauses,
`**Why:**` lines and headings only — which is also why the rule body can carry four full BLOCKED
corpora and an eight-field Wiring block at no baseline cost.

**Where path (a) is SATISFIED and where it is NOT — stated rather than argued around.** Rule 10
path (a) asks that the paired extraction recover AT LEAST the bytes added on the lane of concern.
Recovery is 828 B against an addition of 3,517 B, so the strict quantity test is **NOT met**. What
IS met: the 10 % headroom BLOCK floor is clear (10.17 %, ~113 B of slack), `emit.mjs` exits 0, and
every removal funding it is recorded with zero de-scoping. Two further measured facts, offered as
context and NOT as a discharge — the corpus's own most recent new-rule precedent
(`evidence-first-claims.md` MUST-5/6) read path (a) as "author the clause compact and extract the
depth to the non-baseline-emitted companion", which is satisfied here; and the funding extraction
alone lifts the pre-addition lane to 15.54 %, i.e. OUT of the 15 % proximity band that makes the
gate fire at all. Neither of those is the quantity test. The residue is owed a path-(b)
named-rationale with the five mandatory sub-fields from
`skills/skill-authoring/proximity-band-named-rationale-template.md`, and that belongs in the
proposal's receipt journal (`journal/0577`), which this lane does not own — so it is FLAGGED for
the codify owner rather than self-cleared here.

**Rule 11 does not fire, and the reason is not that nobody looked.** It counts prior
Rule-10-MANDATED ADDITIONS on the same (rule, CLI) lane within 30 days. `conservation-gate.md` is
new, so it has no prior invocation; and per `journal/0574` the recurrence window counts additions,
never uses of a rule as an extraction SOURCE, so funding out of `agents.md` starts no clock either.

Cap in force is `block_cap_bytes: 65536` (`sync-manifest.yaml`, raised from 61440 on 2026-08-12 —
read the key rather than trusting this line, since an earlier comment in that same file cited
`size_cap_bytes` for the same purpose and was wrong by ~79×). Floor 10 % ⇒ 58,982 B ceiling ⇒ 2,801 B
of slack above the floor at the BEFORE pole.

**Disposition: PATH (a), paired extraction, funded LANE-LEVEL — partially, see the ledger above.**
Two settled points of precedent make this the correct path and make the funding source
unconstrained:

1. The extraction may come from a DIFFERENT baseline rule. Rule 10's normative text says the
   extraction must recover the bytes "on the lane-of-concern's emission" — a LANE-level quantity, not
   a rule-level one. `journal/0570` corrects an earlier reading that assumed same-rule funding, and
   `journal/0574` treats it as settled precedent. The only same-scope constraint runs the other way:
   one extraction may not fund additions across N rules. This change adds exactly one rule.
2. Rule 11 does NOT fire. It counts prior Rule-10-MANDATED **additions** on the same (rule, CLI)
   pair within 30 days. `conservation-gate.md` is new, so it has no prior invocation; and per
   `journal/0574` the recurrence window counts additions, never uses of a rule as an extraction
   SOURCE.

Nothing load-bearing was de-scoped to fund this: no `MUST`, `MUST NOT`, `**Why:**` line, DO/DO-NOT
block or BLOCKED-corpus entry was removed from any rule. The twelve `(class, line)` removals the
`check-descoping.mjs` gate counted are declared in `.claude/test-harness/descoping-exceptions.json`
— ten `superseded` (a MUST retained inline while a trailing `…: guide.` navigation tail naming an
already-named destination was dropped, which full-line matching cannot follow), one `extracted`,
one `consolidated`. Two further declarations were WITHDRAWN mid-flight: the
`**BLOCKED responses when skipping MUST gates:**` line was restored verbatim after the full harness
corpus showed `sync-manifest.yaml` declares a `use_softening` rewrite keyed on that exact string, so
removing it orphaned the declaration and under-delivered the sync to `kailash-coc-rs` and
`kailash-coc-claude-py`. Measured, restoring it changed the emitted total by ZERO — it matches the
abridger's BLOCKED-responses strip and never reached the baseline lane — so the trim had recovered
no bytes while breaking a downstream contract. Recorded because a reader would otherwise reasonably
assume a restored line cost budget.

---

## Extended DO / DO-NOT

The rule body carries one compact DO/DO-NOT pair per MUST. These are the longer forms, which the
abridger would strip from the always-on lane anyway (fenced blocks over ~200 B).

### MUST-1 — declare the delta

```text
# DO — the before-set is captured BEFORE the operation, and every departure is accounted
$ git rev-list --count HEAD                      # BEFORE: 12
$ git rev-list --oneline HEAD > scratchpad/before.txt  # BEFORE set, durable (MUST-5)
<rebase>
$ git rev-list --count HEAD                      # AFTER: 8
# 4 departures. Each accounted: all four are merge commits; their content is present
# in the tree, verified by reverse-patch-apply (MUST-2). Delta fully declared.

# DO NOT — the after-set alone, read as health
$ git log --oneline | head
"looks right, 8 commits, PR is green"
# ← no before-set was ever taken, so 'looks right' is unfalsifiable: the same output
#   appears whether 0 or 40 commits' content was dropped.
```

### MUST-2 — content identity, never name identity

```text
# DO — content test decides membership
$ git range-diff "$base"...HEAD@{1} "$base"...HEAD
# every absent sha's CHANGES appear on the right-hand side ⇒ conserved
# or, per-candidate: reverse-patch-apply each absent sha against the tree; a clean
# apply means its content is ALREADY present (nothing to restore).

# DO NOT — name test decides membership
$ comm -23 before-shas.txt after-shas.txt | wc -l   # "10 commits lost"
# ← measured properly the true figure was 4. Six of the ten were rewritten, not lost:
#   different name, identical content. "Not on the trunk" is not "lost".
```

### MUST-3 — name the blind classes

```text
# DO — the report states what the instrument could not observe
"Divergence fence: 0 findings.
 SCOPE: tracked MODIFICATIONS only.
 UNSEEN by this instrument: untracked-not-ignored files; ADDED files (180 present at
 destination); anything outside the index. Those classes are UNCHECKED, not clean."

# DO NOT — the fence's silence generalized to the whole set
"Divergence fence returned 0 findings ⇒ destination is clean."
# ← the fence never looked at additions; one of the 180 was a published .env.
```

### MUST-4 — absence is loud

```text
# DO — the empty outcome names itself and its consequence
"HOOK REFUSED the commit call (nested-worktree guard).
 NOT DELIVERED: 286 insertions across 4 files, still uncommitted at <abs path>.
 Lane is BLOCKED, not idle. Escalating now."

# DO NOT — go quiet, or report the empty in success grammar
(agent returns no message; orchestrator's ledger shows the lane as idle)
"Purge complete."            # closed nothing, and said nothing about closing nothing
"Scan returned 0 findings."  # indistinguishable from 'scan did not run'
```

---

## Full BLOCKED-rationalization corpora

The rule body carries these inline (the abridger strips them from the always-on lane, so they cost
nothing there and are duplicated here only for readers who reach the extract first). If the two ever
disagree, **the rule body is authoritative** — per `specs-authority.md` Rule 9 this section exists to
be read alongside it, never instead of it.

**MUST-1:** "The operation reported success" · "The result looks right" · "Nothing errored, so
nothing was dropped" · "The tool would have told me" · "I can reconstruct the before-set from the
after-set if I need to" · "It is a routine operation, it does not move content" · "The count went
down because the history was tidied" · "The diff is the record; I do not need a separate before-set".

**MUST-2:** "Not on the trunk means lost" · "The sha is not in the log, so the work is gone" · "The
file is still there, so the content is fine" · "Same filename, same path — nothing changed" ·
"Comparing shas is the rigorous way to do it" · "Reverse-patch-apply is overkill for a routine
rebase" · "The names are what the tool reports, so the names are the truth".

**MUST-3:** "The check returned clean" · "If there were a problem the fence would have caught it" ·
"Untracked files are not really part of the delivery" · "Additions cannot cause loss" · "Naming the
blind spots invites scope creep" · "It is the standard instrument for this boundary" · "Enumerating
what a tool cannot see is unbounded".

**MUST-4:** "There was nothing to report" · "The call was blocked, so there is nothing to say" · "I
will mention it if it matters later" · "An empty result is a clean result" · "The scan found nothing,
so the surface is clean" · "Zero rows means the purge had nothing to do" · "Reporting a refusal is
noise" · "The orchestrator can see the lane went quiet".

---

## Distinct from `instrument-discipline.md` — the long form

This is the distinction most likely to be collapsed by a later maintainer, so it is stated twice: in
the rule body's § Distinct From (short) and here (long).

`instrument-discipline.md` asks ONE question, of a check that has ALREADY been chosen and run:

> Would this instrument produce a DIFFERENT result if the proposition were false?

`conservation-gate.md` asks a question that precedes it:

> Is there ANY check at all for the content that went missing?

The two compose in exactly one direction, and the asymmetry is the proof they are not the same rule:

- A conservation enumeration performed with a non-discriminating instrument violates
  `instrument-discipline.md` MUST-1. `conservation-gate.md` MUST-1 is SATISFIED (an enumeration was
  performed); the defect is epistemic, and that rule owns it.
- A boundary crossed with NO enumeration violates `conservation-gate.md` MUST-1, and
  `instrument-discipline.md` **never fires** — there is no instrument for it to critique. Its entire
  MUST corpus is predicated on a check having been cited; where none was, it has nothing to say.

That second case is the whole reason this rule exists: it is the gap the three prior
instrument-and-evidence rules structurally cannot reach. Seven of the eight measured instances sit
in it — no check was run, so no check could be criticized.

MUST-2 and MUST-3 look superficially like `instrument-discipline.md` MUST-3 (show the instrument
fires here) and MUST-4 (an instrument is scoped to the question it was built for). They are not
restatements, and the difference is directional:

- `instrument-discipline.md` MUST-3/MUST-4 are addressed to a READER evaluating a cited instrument:
  is this evidence?
- `conservation-gate.md` MUST-2/MUST-3 are addressed to an AUTHOR designing an enumeration: what
  must it cover to count as an enumeration at all — content-identity, and a named list of the classes
  the chosen instrument cannot observe.

Per `specs-authority.md` Rule 9 the discrimination test is **cited by reference and never restated**
in the rule body; a future edit that copies `instrument-discipline.md`'s falsifying-result test into
this rule should be rejected as duplication rather than merged.

### And distinct from the rest of the near-neighbourhood

| Rule | What it governs | Why it is not this |
| ---- | --------------- | ------------------ |
| `evidence-first-claims.md` | Claim GRAMMAR — an assertion must quote its evidence inline, and inference must be labelled | Governs how a finding is PHRASED, not whether a continuity check was run at all |
| `sweep-completeness.md` | Enumerating outstanding WORK at a session boundary | Work items, not content across a transfer; a sweep can be complete while a rebase silently drops commits |
| `orphan-detection.md` | A declared artifact that never became reachable | Content that never ARRIVED — the exact mirror of content that DEPARTED |
| `handoff-completion.md` | Whether the receiving side got a usable handoff | Adequacy at the receiver, not conservation of the payload in transit |
| `sync-completeness.md` | Whether every declared target was reached | Coverage of targets, not survival of each target's prior content |
| `verification-gate-integrity.md` | Whether a gate ran and was not bypassed | Gate execution, not the before/after content delta the gate never modelled |

---

## Origin

2026-08-16 — co-owner-directed origination at loom (`rules/artifact-flow.md` § Co-Owner-Directed
Origination).

**Where the receipt lives, stated because the citation does not resolve from this branch alone.**
`journal/0577` is committed on the LEASE branch
`codify/<operator>-2026-08-16`, not on the branch that carries this rule. Measured by content
identity rather than by assuming a filename: `git cat-file -e` finds the path on
`codify/<operator>-2026-08-16` and NOT on this branch's HEAD, and the blob is `00445c4e`. So the rule
body's `Origin:` citation is a FORWARD reference that resolves once the lease branch lands, and it
dangles until then. Recorded here rather than left for a reader to discover, per this rule's own
MUST-3: an unnamed gap in what a reader's instrument can see is the failure the rule names, and a
`ls`/`grep` run from this branch would report the receipt simply absent.

Receipt-first: `journal/0577`, which
carries the verbatim directive ("approved, I want root fix NOW"), the scope fence (COC-tooling under
loom's own surface only), the eight measured instances, and the disposition. Per
`rules/self-referential-codify.md` Rule 1 the artifact is enforcement-bearing and touches allowlist
surfaces, so it owes a Tier-1 multi-agent redteam to convergence before merge, posture-independent;
neither the receipt nor this extract self-certifies it.
