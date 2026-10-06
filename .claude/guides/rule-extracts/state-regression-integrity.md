# `state-regression-integrity.md` — extract

Depth for the state-regression-integrity rule (loom#1856). Not baseline-emitted and
not path-emitted, so it carries the material the rule body cannot afford: the
originating incidents, the full BLOCKED corpora, the severity argument, the
enforcement inventory, and the measurements taken at adoption.

**The rule itself is still a PROPOSAL** — `.claude/rules/**` was lease-bound when
this landed, so the complete body sits at
`.claude/.proposals/state-regression-integrity.rule-proposal.md` and is saved to
the rules directory under this file's name when the lease-holder lands it. The
enforcement this extract describes ALREADY SHIPS; only the prose is pending. That
path is deliberately not written as a reference here: it does not resolve yet, and
a dangling xref is exactly the kind of claim-about-a-surface this corpus reds.

## The failure class

A generated status tracker — the artifact a team quotes to a client when asked "how
much is left?" — has a failure mode that no test, review or rule text had caught:
**a row that was already correct gets written back to a wrong value, and every
downstream count moves with it.**

It is not a data bug. Both codified incidents happened *with the correct reasoning
already written down in the same file*. That is the load-bearing finding, and it is
why prose alone could not hold this:

> What was missing was not knowledge. It was anything that **ran at the moment the
> wrong row was written**.

## Incident 1 — a delivered row demoted for lack of FRESH verification (MUST-1)

A row read `Done / 100% / Live on dev + staging`. Its record had *already been
corrected once*, and carried the words `FALSELY OPEN` in its own text. A later
session demoted it to `Done (unverified)` because no lane had walked it *that
session* — which is not the same as nobody ever having walked it. Group signed-off
fell **321 → 319** and open rose **76 → 78**, on a day of real delivery.

> WHY THE FUCK DO WE NOW HAVE MORE OPEN ISSUES FROM BEFORE?????

The owner's own recollection — that the pages were nearly finished — **was correct
the whole time, and was contradicted by every number reported to them.**

### The full BLOCKED corpus for MUST-1

Each of these is an ABSENCE and is therefore rejected as a rebuttal. The first six
are VERBATIM from the incidents; they are fixture-pinned in
`.claude/audit-fixtures/register-regression/run.mjs`:

- "this session did not verify it"
- "no lane walked it"
- "I could not confirm it"
- "nobody has walked it"
- "built, not walked"
- "merged is not rendered"
- "marking it unverified is the conservative choice"
- "better to under-claim than over-claim"
- "I'd rather be safe and call it unverified"
- "the previous session may have been wrong"
- "there's no evidence in this transcript that it shipped"
- "I can't see the deployment from here"

**Under-claiming is not the safe direction.** It is a wrong number in a humble tone.
Over-claiming and under-claiming both destroy the register's credibility, and the
second is more insidious because it wears the grammar of caution.

### What a VALID rebuttal looks like

It names something SEEN, and when. These are the five observations pinned as the
no-false-positive floor:

- "Opened the deployed page 2026-08-20 — it 404s; the route was removed in a8e737a."
- "The signed-off build never ran the migration: `SELECT count(*) FROM audit`
  returns 0 rows."
- "Owner walked it on 2026-08-19 and rejected the layout; see
  `workspaces/x/04-validate/notes.md`."
- "The endpoint returns 500 with 'column does not exist' — captured in the run log."
- "Re-ran the acceptance script: 3 of 7 assertions fail, transcript attached."

The discrimination the lexical arm has to make is narrow and deliberate: it fires on
absence-of-VERIFICATION verbs, not on bare negation. "The migration never ran" is an
OBSERVATION and must pass; "it was never verified" is an absence and must not.
Widening the patterns to any negated sentence would swallow the observations the
clause exists to demand — which is how a guard becomes noise and then becomes
ignored.

## Incident 2 — a resolved ask still presenting as owed (MUST-2)

A row asked the client's finance team to type a value into a specific cell across
sixteen workbook tabs. The owner rejected that approach and instructed us to derive
it from the sheets instead. All sixteen *were* derived. Nobody updated the row — it
kept its `input_required` field and kept pointing at the superseded draft, and an
orchestrator later read that stale row and handed it back to the owner as an
outstanding **owner action**.

> wait, didn't we ALREADY RESOLVED the D1 issue after i asked you to use your NLP
> capabilities to read the whole excel instead of just D1? wtf is this shit

**Nobody had to write anything wrong for this to happen.** The world moved and the
row did not. That is why B-1/B-2 scan EVERY owed row on every register write rather
than only the rows this write changed: a changed-rows-only guard would never look at
the stale row again, and the stale row is the whole incident.

**BLOCKED corpus for MUST-2:** "the row is close enough" · "the ask is in the notes
somewhere" · "we resolved it, updating the row is bookkeeping" · "the owner knows
it's done" · "the ref is stale but the ask is still real" · "I'll fix the row when I
next regenerate".

## The two incidents NOT codified here, and why

Recorded because they explain the enforcement shape, not because they became clauses.

**Rival trackers.** One workspace held **28 documents that each claimed to track
client items**. Two were live; the other 26 were frozen snapshots or superseded
trackers — each a place a future session could read a stale answer and hand it to the
client as current, *which happened repeatedly*. 23 were deleted. loom's equivalent
defence already exists and is structural rather than clausal: `burndown-manifest.json`
DECLARES its sources, so a tracker nobody declared is counted by nothing.

**The moving denominator.** The owner asked the same question and got **110, then 48,
then 14/15/19**. Every answer was arithmetically defensible; together they read as a
moving goalpost. This is already `burndown-integrity.md` MUST-1/MUST-2 and is
deliberately not restated.

**Two generator bugs invisible from the committed artifacts.** A whole-object
override replace meant a later refresh mentioning an id but omitting a field
**discarded that field's newest value** — measured at **219 drops across 80 ids**, 40
of them the "our next step" column the client actually reads. The same loop chose
which file wins by **filename sort** under a comment claiming "later date wins", so
an owner ruling lost to an agent refresh carrying one more `z`. Neither is visible by
reading the block; only regenerating reveals them. That is the layer-4 lint, and it
is why the lint is not redundant with the guards.

## The severity split, and why it must not be collapsed

`hook-output-discipline.md` MUST-2 reserves `block` for facts a regex cannot misread
and demands a structural signal that surface rewrite cannot evade.

**A-2 earns `block`.** It is exactly two facts and reads no prose:

1. an INTEGER COMPARISON over a CLOSED status enum — did this row fall out of the
   delivered band (`Signed off` = 3, `Built-not-walked` = 2)?
2. a JSON KEY-PRESENCE test — is there a `regression_rebuttal` at all?

The enum lookup normalises case, spacing and hyphens, so `Signed off` → `signed-off`
changes no rank and `SIGNED OFF` still ranks as delivered. Both are fixture-pinned.
In-corpus precedent for `block` on this class: `burndown-integrity.md` § Trust
Posture Wiring, `signing-mutation-guard.js`, `integrity-guard.js`, and
`journal-write-guard.js` blocking on `fs.existsSync`.

**Every arm whose verdict reads WORDS is capped at `halt-and-report`** — MUST-1's
absence-corpus arm (A-1) and all of MUST-2 (B-0/B-1/B-2).

This split is not decorative and it is measured. Forcing every arm to `block` (a
one-line mutation of the hook's severity selection) reds **9** fixture cases, each
naming the MUST-2 ceiling. Neutering the ladder, the classifier, the scope exclusion,
`guardB`, the manifest scoping and the enum normaliser reds 23, 24, 6, 3, 2 and 27
cases respectively. A green suite here is therefore evidence, because it has been
shown able to go red for each predicate independently.

## Scope — retired rows are OUT, and that is a measured correction

MUST-1 covers ONLY rows in the buckets the burndown counts. Superseded and internal
rows are deliberately EXCLUDED, and the exclusion is a CORRECTION rather than a
softening: guarding them produced a REAL false positive, **refusing an owner who was
REINSTATING a retired ask**. The row still carried a delivered status from before it
was retired, so bringing it back as `Not started` was shaped exactly like a demotion.
The owner was right and the guard was wrong.

Do not widen this back. The pole is pinned twice — as a bipolar fixture across all
five supersession markers, and by an in-suite MUTATION PROOF asserting that WITHOUT
the exclusion the same case WOULD fire. Without that second assertion the pole would
pass whether or not it was testing anything.

The exclusion is also SCOPED: a non-superseded row sitting in the same file as a
retired one still fires, which is its own fixture.

## Why the upstream hook was NOT ported

The filing was explicit that its hook does not generalize: path-scoped to one
workspace's `04-validate/**`, with Guard A/B mechanics assuming that repo's
tracker-JSON convention and the status enum its builder emits. It is portable **only
where a tracker-source convention exists to key on**. Without one there is nothing to
fire on, and shipping it into such a repo yields **a guard that protects nothing** —
itself a failure mode this ecosystem has hit (a converged guard installed nowhere).

So the clauses were adopted and re-keyed onto loom's OWN convention:
`burndown-manifest.json` + a declared `kind: "register"` source + the closed status
vocabulary. That convention was itself originated FROM the same downstream repo per
`journal/0583`, which records the owner's directive to take that repo's
implementation as the reference and improve on it further. The originating repo is
named in the journal, which is not on the synced surface; it is deliberately not
named here, because this extract IS synced.

## Enforcement inventory, as measured at adoption

Stated as measurement rather than inheritance, because the brief's premise about
layer 3 turned out to be false on this tree.

| Layer | State at adoption | Action |
| --- | --- | --- |
| 1 · resolved-row-regression guard | absent | **built** — `register-regression-guard.js` |
| 2 · tracker-authority | already structural: `burndown-manifest.json` declares sources | none |
| 3 · quote-the-block | **already gated at the point of use** — `burndown-quote-write-guard.js` (PostToolUse) + `burndown-quote-stop-guard.js` (Stop), both registered in `settings.json` | none |
| 4 · regenerate-and-compare | `--check` existed and **nothing ran it** | **wired into CI** |

Layer 3's measurement matters: the working assumption going in was that nothing
gated MUST-1 at the point of use. `grep -n 'burndown' .claude/settings.json` returned
two registrations, so that assumption was FALSE and no work was done there.

Layer 4's gap was real. `grep -rn 'burndown' .github/workflows/` returned NO hit,
against a control (`grep -rlc 'runs-on' .github/workflows/`) that DID fire on the
same directory — so the empty result was a true negative, not a broken matcher.

**The layer-4 comparison is SEMANTIC, not byte, and that was measured two-pole on
the real `BURNDOWN.md`:**

- alter a COUNT inside the block → `--check` exits **1**, prints STALE
- alter ONLY `generated_from_sha` → `--check` exits **0**, "is current"

The second pole is the one that decides whether the lint survives.
`generated_from_sha` moves with EVERY commit, including the commit that lands the
block itself, so a BYTE comparison would be red forever and its fixed point
unreachable by construction — `blockIdentity()` normalises exactly that line out.
This is loom's structural analogue of the upstream caveat, where a spreadsheet writer
stamps each zip member's mtime and two runs over an unchanged tree differ in bytes.
**A permanently-red check is worse than no check**: it is the one an operator learns
to ignore, and then a genuinely stale block reads exactly like the everyday state.

## The HEAD baseline, and the evasion it closes

The guard compares against the COMMITTED record at `HEAD`, not the working copy.

The clause is "an absence of fresh verification is not evidence against a RECORDED
one", and the RECORDED status is the committed one: it is what `burndown-build.mjs`
counts (it refuses outright on a modified declared source) and what a reader quoting
the block is quoting.

Comparing against the working copy would open a two-step evasion costing nothing:
edit once `Signed off` → `In progress` (refused), then edit again for any reason —
the second write compares `In progress` against `In progress`, finds no demotion, and
the rebuttal that was never written is never asked for again. Against HEAD, every
subsequent write to the register re-poses the question until the demotion is either
rebutted or committed.

It buys a second property free: a demotion written through a channel the hook cannot
see — a Bash heredoc, a `>` redirect — is caught on the NEXT tool-mediated write,
because HEAD still remembers.

**Bounds, stated rather than implied.** A row DELETED outright is not a status
transition and is not guarded (the generator owns id-set changes; two graders on one
fact is how verdicts drift). Once the demotion is COMMITTED, HEAD carries it, so
removing a rebuttal in a follow-up commit is not caught. No git, no HEAD blob, an
unparseable side: UNKNOWN — reported AS unknown, never as clean.

## What the adversarial review changed

The first revision guarded the DEMOTION only. An adversarial security review
refuted its soundness, and every finding below was reproduced by execution before
it was fixed — the reviewer could not run anything, so nothing was accepted on
reading alone. Each now carries a bipolar regression pin.

| Finding | Shape | Disposition |
| --- | --- | --- |
| **id rename / row deletion** | rename `F80` → `F80-r2`; the old id vanishes and the new one reads brand new, so nothing fired | **A-3**. Guard A now diffs the id SET; a departed delivered id is rebutted in a top-level `_removed` map |
| **two-write retirement chain** | add a marker to a delivered row (silent), commit, then demote — now excluded by the reinstatement carve-out | **A-4**. Adding a marker to a delivered row is itself a retraction |
| **no substance floor** | `"n/a"`, `"TBD"`, `"x"`, `"-"` all classified as OBSERVATION and passed a `block` | 24-character floor, a length measurement (structural, so it may block) |
| **curly apostrophes** | `"wasn't verified"` = absence; `"wasn’t verified"` = observation | apostrophe class `['’‘ʼ\`]`; also `no[\s-]?one` |
| **invisible-character statuses** | `"Signed­off"` (SOFT HYPHEN), ZWSP, NON-BREAKING HYPHEN each ranked `null` → silently skipped | strip default-ignorables + NFKC; and **A-5** surfaces any out-of-vocabulary status rather than skipping it |
| **negating marker values** | `"retired": "no"` read as retired, disabling Guard A's scope check and all of Guard B | explicit negation-value set |
| **lexical path containment** | a symlink at a contained path was followed and its content echoed into the finding — a read oracle | `realpathSync` on BOTH sides, fail closed (`security.md` § Path Containment) |
| **live-prose false positive** | `worktree-isolation.md`'s "the flag … is RETIRED" made a current rule read as superseded | banner-anchored: line-initial marker or an explicit `SUPERSEDED BY` pointer |
| **Guard B same-write bypass** | `"internal": "x"` added alongside a dead `ask_ref` skipped Guard B | Guard B's exclusion reads the OLD row |
| **case-insensitive filesystem** | `burndown/Register.json` bypassed the declared-source check on macOS | case-insensitive fallback CONFIRMED by `realpath` |
| **CI step unreachable** | a PR touching only `burndown/register.json` classified `artifact=false`, so the job SKIPPED and the required check passed | `burndown/`, `burndown-manifest.json`, `BURNDOWN.md` added to `ARTIFACT_SURFACE` **and** the `push: paths:` list |
| **UNKNOWN rendered as silence** | lib-load failure, unreconstructible Edit and a throwing `evaluate()` all emitted a bare passthrough | all three now surface `UNKNOWN, not clean` |

## Round 2 — the false positives, which are the costlier direction

A second adversarial review of the hardened revision found the guard now
**over-fired**, and three of those were on the `block` arm. That is the expensive
direction: a `block` that refuses correct work gets the guard switched off, and
then nothing is enforced at all. Every one was reproduced before it was fixed.

| Finding | Shape | Disposition |
| --- | --- | --- |
| **renumber blocks, with no honest exit** | A-3 cannot tell a rename from a renumber; `_removed` asks what you observed about a row that was never withdrawn, and a `regression_rebuttal` on the shifted row asserts an observation that did not happen | `_renamed: { "<new id>": "<old id>" }` — structural, no prose, and the demotion loop compares against the DECLARED predecessor |
| **24-char floor blocked real observations** | `"HTTP 502 at /reports"` (20), `"Query returns 0 rows."` (21), `"Build fails: exit 127"` (21) all refused | closed `PLACEHOLDER_VALUES` set (genuinely structural: membership, not judgement) + a residual 8-char floor |
| **`internal` treated as a retraction** | A-4 reused the SCOPE vocabulary as a DETECTOR, so tagging a delivered row `internal: true` blocked | split `RETIREMENT_FIELDS` (A-4) from the wider `SUPERSESSION_FIELDS` (scope) |
| **absence corpus fired on the SYSTEM** | 8/8 genuine rebuttals refused — "the form is not validated on submit: posted an empty payload, got 200" | SUBJECT ANCHOR: the negated verification verb must belong to the OBSERVER (speaker, absent actor, or agentless passive) |
| **A-5 fired forever on untouched rows** | one legacy status halted every future write with nothing the writer could do | scoped to what THIS write introduces, same as B-0 |
| **B-1 graded non-paths** | `owner/repo#N`, `asks/x.md#L20`, prose containing a path | widened the non-path set; strip a trailing `#…`/`:N` fragment |
| **B-2 fired on a line-initial adjective** | "Deprecated fields: please confirm…" — a LIVE ask | the marker must not be modifying a following noun |
| **wrong severity register** | `halt-and-report` renders "the action ALREADY RAN" at PreToolUse, where it has NOT run — verbatim the loom#1715 H-1 bug | non-block arms emit `pre-action`; the `halt-and-report` CLASSIFICATION is unchanged, so the MUST-2 ceiling still holds |
| **nested project dir** | `git show HEAD:<rel>` resolves against the worktree TOP, so a repo whose project dir is not the git root degraded to permanent UNKNOWN | `HEAD:./<rel>` (cwd-relative) |

**The subject anchor is the interesting one.** An ABSENCE is a statement about what
the OBSERVER did not do; an OBSERVATION is a statement about what the SYSTEM does.
English uses the same verbs for both, so keying on the verb cannot separate them —
and the un-anchored corpus refused every rebuttal in the left column below while
accepting nothing more in the right. The anchor costs recall (an absence phrased
without a speaker and outside the corpus reads as an observation) and that trade is
deliberate: a `block`-adjacent arm that cries wolf on real rebuttals gets disabled.

**A self-derived oracle was found in this suite's own fixtures.** The case named
"MUTATION: deleting the isSupersededRow exclusion…" RE-IMPLEMENTED the predicate
inline and asserted the re-implementation fired — it never mutated `guardA`. It
would have stayed green if a second, unrelated exclusion also suppressed the row,
so it could not discriminate what its name claimed (`evidence-first-claims.md`
MUST-5). It now mutates the real source, re-evaluates it, and carries a reachability
control proving the mutation is inert off-target.

**One ordering bug the fixtures caught during the fix.** Running the substance
floor BEFORE the absence corpus reclassified four of the six verbatim phrases
("no lane walked it" is 17 characters) from `absence` to `missing`, silently
promoting a LEXICAL verdict to `block` — exactly what `hook-output-discipline.md`
MUST-2 forbids. The corpus is now consulted first, so a recognised absence stays at
`halt-and-report` whatever its length and the floor catches only unrecognised
residue. The MUST-2 ceiling poles are what caught it.

## Known-uncovered

- **The semantic tier — CLOSED 2026-09-14, and the sentence this replaces was FALSE
  when it was written.** It read: "No probe suite yet; dated in
  `phase2-deferrals.json::probe_authorship_deferrals`." No such row ever existed —
  measured, that object holds exactly one key, `_README`, against a control showing
  the matcher fires (the string `probe_authorship_deferrals` appears 11 times in the
  file). So the extract asserted a dated deferral that was not dated anywhere, which
  is the absence-reads-as-clean shape the paired rule governs. A probe suite now
  SHIPS at `.claude/test-harness/probes/state-regression-integrity.probes.json`,
  registered in `eval-manifest.json` and pinned in
  `probe-suite-integrity.test.mjs::PINNED_SUITES`, so the tier is covered rather than
  deferred and no row is owed. What the tier still cannot do is unchanged and is the
  honest residual: the fixtures pin the six verbatim absence phrases and a five-case
  observation floor, and the probes pin one bipolar pair per clause — none of them
  pins the open class of sentences an agent will actually write.
- **B-0 is transition-scoped.** A row already sitting in `Blocked on you` with no
  `ask_ref` is not re-litigated on every unrelated write; only a row MOVING into the
  bucket must name its ask. Re-litigating a legacy corpus is precisely the guard that
  cries wolf until it is ignored. From the transition forward, naming the ask is the
  default.
- **Non-path `ask_ref` values are not graded.** An issue number or a URL is not a
  filesystem question, and reporting "does not exist" for something that was never a
  path is a confident wrong answer.
- **The Bash write surface.** Same structural gap `burndown-integrity.md` records:
  the matcher is the tool set, so a heredoc or redirect writes the register without
  the hook firing. The HEAD baseline converts this from a silent miss into a delayed
  catch, but not into coverage.
