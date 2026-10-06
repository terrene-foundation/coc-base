# `burndown-integrity.md` — extended reference

Depth for `.claude/rules/burndown-integrity.md`. Not baseline-emitted; `cc`-tier, so it reaches every USE template and BUILD repo alongside the rule.

## Why a generated artifact and not a discipline

The originating failure was not a wrong number. Asked the same question once, an agent produced **110**, then **48**, then **14/15/19**, then **2/3/3**. Each figure was arithmetically correct. None were reconcilable, because each pass silently chose its own population — a different set of pages, a different notion of what counts as an item, a different cut-off date — and none of them stated which.

That is a **moving denominator**. It is invisible at read time: every individual number survives inspection, and the contradiction only appears when two are placed side by side, which is exactly what nobody does. "Be more careful" cannot fix it, because carefulness is what produced all four.

The cure is to move the count out of prose and into a build artifact that reports its own quote. A bespoke count then becomes structurally impossible for anyone working from the register, rather than discouraged.

## The four MUSTs, worked

### MUST-1 — quote, never compute

```markdown
# DO — quote the row verbatim
| Beta | 4 | 0 | 0 | 1 | 3 | 0 | 4 | 2 | 2 |

# DO NOT — recompute, however correct the arithmetic
"that's 3 of 7 done, so roughly 57% left"
"the block says 5 open but two of those just landed, so really 3"
```

**BLOCKED rationalizations:** "the block doesn't have that cut" · "it's the same number either way" · "just a quick tally for this message" · "I checked the arithmetic myself" · "the block is stale by two commits, I adjusted for it" · "the owner asked for a percentage and the block has counts".

The last two are the dangerous ones. If the block is stale, **regenerate it**; adjusting in prose reintroduces exactly the private population the mechanism exists to remove. If the owner asks for a cut the block lacks, **add the cut to the generator** — a one-off IS the defect, because it is a count nobody can re-derive.

### MUST-2 — identity, not quantity

```markdown
# DO
Beta: 2 of 4 `Not started`, from the original register
ALL PAGES: 2 of 7 `Signed off`

# DO NOT
"7 left" · "we're at 5" · "about two-thirds"
```

**BLOCKED rationalizations:** "context makes it obvious" · "the denominator is in the table above" · "everyone knows what 'left' means here" · "it's a summary line, the detail is below".

A quantity without a bucket and a denominator cannot be checked by the reader, cannot be reconciled against another report, and cannot be re-derived next week. It is the shape every one of the four irreconcilable figures took.

### MUST-3 — the growth split

```markdown
# DO
Beta open 4 = 2 from the original register + 2 arrived since

# DO NOT
"Beta is up to 4 open" (reads as a regression; the original ask never moved)
```

**BLOCKED rationalizations:** "the total is what the owner asked for" · "growth is an implementation detail" · "it's cleaner without the split" · "the arrived-since items are ours, not theirs".

This is the highest-value column and the one most likely to be dropped in a port, because it is the only column that requires keeping the frozen register around after it stops being current. Without it, a page that is nearly finished against what was FIRST asked reads as going backwards — the owner is comparing against memory of the frozen list, and growth is invisible to that memory.

### MUST-4 — completion

```markdown
# DO
Alpha: 2 of 3 `Signed off` — not complete

# DO NOT
"Alpha done — all three merged"
"Alpha built, just needs a walkthrough" reported under a `complete` heading
```

**BLOCKED rationalizations:** "it's built, walking it is a formality" · "the PR merged, that's done" · "the owner will sign off retroactively" · "it passed its tests".

**No item is reported as done on the strength of a merge.** Over-reporting is costlier than under-reporting by a wide margin: an owner who opens a row reading complete and finds the thing absent stops trusting every other row, including the accurate ones.

## The manifest schema

`burndown-manifest.json`, declared — never a directory glob.

```json
{
  "_schema": "burndown-manifest/v1",
  "target": "REGISTER.md",
  "pages": ["Alpha", "Beta"],
  "sources": [
    { "path": "burndown/register.json", "kind": "register", "precedence": 0 },
    { "path": "burndown/2026-08-10-post-register-items.json", "kind": "growth", "precedence": 0 },
    { "path": "burndown/2026-08-12-status-refresh.json", "kind": "status-refresh", "precedence": 0 }
  ]
}
```

`kind` is one of five. The first three are STATIC files; the last two RE-DERIVE themselves by running a manifest-declared, committed, reviewed query, and a query that errors, times out or returns fewer members than its declared floor REFUSES the build rather than falling back to its snapshot.

- `register` — the frozen original list. `origin` is `from the original register`.
- `growth` — arrived after the freeze.
- `status-refresh` — corrects status on EXISTING ids only; introducing a new id here is a refusal, because growth must be counted as growth.
- `live-growth` — freezes the ORIGINAL ID SET plus the adjudication attached to those ids, and re-derives CURRENT MEMBERSHIP. An id that left the registry drops out; one that arrived takes the source's `arrival_defaults`. Because the frozen half is a reading someone took, it carries `membership.as_of` + `max_age_days` and goes STALE.
- `projected` — for a PROJECTION of an external registry (an issue tracker, a deferral file), where the authoritative state lives elsewhere and nobody adjudicates per item at that volume. It freezes NOTHING: membership AND status are both re-derived on every build. Its query emits `id`, a per-member STATE, and a RECORD REFERENCE, tab-separated; the source declares one `page`, a `status_derivation.map` translating the registry's state vocabulary into this block's closed one, and a `record_ref` contract. **`Signed off` is UNREACHABLE for a projected item** — refused as a map target, refused via a `status-refresh` aimed at a projected id, and refused if any other source re-declares the id — because that value means the OWNER accepted the work and no registry state is evidence of that. LINK-1/2/3 are REPLACED by **LINK-S** (the member resolves to its source record: a ref matching the declared pattern, unique across the population, and for `record_ref.kind: "repo-path"` dereferenced to a tracked file carrying the id verbatim). Replaced, never waived — a member resolving to no source record refuses the whole build. An `external` ref is checked for shape and uniqueness and is NOT fetched, so it establishes addressability rather than existence, and `--check-links` prints that bound rather than letting a green imply more. Because it freezes nothing, `membership.as_of` and `max_age_days` are REFUSED on this kind: a bound that bounds nothing reads as freshness discipline while providing none.

## Two populations, three denominators

The `projected` class forced a change the single-`total` table could not survive, and it is worth stating as a defect rather than a design preference. `Open` is DERIVED as `total − Signed off`, and MUST-4 says complete means `Signed off` equals the total. A projected item is structurally barred from `Signed off` — that is the guardrail. So the instant projected items entered `total`, **completion became unreachable by construction**: the register could never again be reported complete, no matter what the owner accepted. That is worse than the staleness the class was built to fix. And every adjudication bucket names a position on an OWNER-ACCEPTANCE journey (`Not started` is "accepted into the register, no work begun"; `Blocked on you` is "waiting on the owner") — a projection occupies none of them, which is why no honest `status_derivation` target existed. The axis was wrong, not the vocabulary.

The fix is SEPARATE DENOMINATORS, and **no new status value**. The closed vocabulary is unchanged. Three denominators, each rendered as its own labelled column so no reader infers which one a figure binds:

- **`adjudicated`** — items a person declared and adjudicated. **THE COMPLETION DENOMINATOR.** The five status buckets and `Open` are fractions of this and of nothing else.
- **`projected`** — items projected from an external registry. Membership, and nothing else.
- **`board`** — every item of both classes. A census; NEVER a completion denominator, and no status bucket binds it.

`Open: both populations` (= adjudicated `Open` + `projected`) is what the growth split partitions, because arrival is a fact about WHEN an item reached the board and is orthogonal to which class it is in — so MUST-3's column spans both.

**ABSENT is not ZERO.** On a row whose adjudicated population is empty, the six adjudicated-denominated cells render `—` and emit NO TOKEN. `0 In progress` would be a CLAIM that none of them are in progress; the truth is the question does not apply. `--quote` on such a bucket refuses by NAMING the absence rather than reporting "no such bucket", which would send an operator hunting for a typo in a correct name.

**The token binds the denominator** (`sha256(bucket|denominator|value|source_digest)`), and with two populations that stops being a nicety: without it a figure computed against `projected` could validate a sentence asserting it against `adjudicated` — the completion denominator — so a projected count could certify a completion claim. Measured both directly (same bucket, same value, denominators 26 vs 247 → different tokens) and end-to-end through `--verify-quote` (correct denominator VALIDATES, swapped denominator REJECTED).

**A projected source's `sources_digest` contribution is its MEMBERSHIP only.** Its members' registry states feed no count, and folding them in would rewrite every token and report `--check` STALE against a block whose every figure is unchanged.

Each source file carries its own provenance:

```json
{
  "_note": "what this file is and who produced it",
  "_generated": "2026-08-12",
  "_authority": "owner",
  "_id_convention": "CONV-NN-SLUG — greppable",
  "items": [{ "id": "REG-01-A", "page": "Alpha", "status": "Signed off" }]
}
```

**`_authority` is the field most likely to be corrupted, and the corruption is silent.** `owner` outranks any same-day `agent` refresh. **An agent writing `_authority: "owner"` on its own measurement is precisely the corruption this field exists to prevent** — it lets a generated guess outrank the only party who can actually sign anything off. If you did not hear it from the owner, it is `agent`.

**Precedence is `(date, authority, precedence, path)` — NEVER list position.** Reordering the `sources` array cannot move a single count; a fixture pins this. The last key is the full relative PATH rather than the basename, and that is what makes the ordering TOTAL: two sources sharing a basename in different directories would otherwise compare equal and let the sort's stability decide, which IS list position. `precedence` MUST be an integer — a non-integer is REFUSED rather than read as 0, because silently reading `"5"` as 0 changes which source wins and so changes the count.

## Why a declared manifest beats a directory glob

The reference implementation this improves on discovered 84 JSON sources by globbing a directory. A glob makes adding a source invisible: a file lands, every count moves, and there is no diff a reviewer could have objected to. A declared list makes each addition a reviewable change.

The declaration is backed by a refusal: **every declared file must be committed and unmodified**, or the build refuses. An uncommitted source makes the block unreproducible from the SHA it records; a modified one makes the recorded digest a lie about what was counted.

## Refusal semantics — exit 2 is UNRUNNABLE, and it is NOT a pass

```
UNRUNNABLE — refusing because declared source 'burndown/growth.json' is not committed ...
This is exit 2. It is NOT a pass. No burndown block was produced.
```

Exit codes are distinct and must be read as distinct: **0** built / current · **1** the embedded block is STALE (`--check`) · **2** UNRUNNABLE, refused, no block emitted.

A fixture pins that a refusal writes NOTHING to stdout and that its stderr contains no token a reader would scan to conclude success (`ALL PAGES`, a table header, `is current`, `✓`). The failure mode being guarded is a refused build skimmed as a clean one — the same class as reading a green suite that never ran.

## The discrimination proof

`--selftest` runs the generator against two fixture inputs whose correct counts DIFFER and fails if it returns the same block for both. A generator that cannot be shown to discriminate emits a number carrying no information, however plausible it looks (`instrument-discipline.md` MUST-1).

The two fixtures share a **byte-identical** register and differ only in the sources layered on top, so every difference between the blocks is attributable to those sources and to nothing else:

| | fixture A | fixture B |
| --- | --- | --- |
| ALL PAGES | `5, 3, 0, 1, 1, 0, 2, 2, 0` | `7, 2, 0, 1, 3, 1, 5, 3, 2` |
| `Open: arrived since` | 0 | 2 |

The growth split gets its **own** assertion rather than riding on whole-block inequality, because a generator can move its totals while silently dropping the split — the exact column a port is most likely to lose.

**The expected blocks are hand-computed and were committed BEFORE the generator existed.** That is what keeps them from being a self-derived oracle (`evidence-first-claims.md` MUST-5): an expected value computed FROM the subject agrees with it by construction and can never fail. It is also not decoration — the hand-written oracle caught a real defect on first run, a header that omitted the `total` column while the data rows kept it.

## Known coverage residuals

- **The partition assertion is a backstop, not independently pinned.** With a validated vocabulary every item increments exactly one bucket, so `sum(buckets) == total` holds by construction and no valid input can red it. Measured: disabling it leaves the suite green. It fires only when a prior guard has already failed — which the vocabulary-mutation case demonstrates it does.
- **No probe suite.** `burndown-integrity` has no `eval-manifest.json` entry, so the semantic (LLM-judge) tier is UNCOVERED and owed at gate-review via `/test-harness-probe`.
- **Chat-reply reachability.** See the rule's Origin. A count quoted in conversation touches no file and fires no glob.

## Origin — full narrative

Moved verbatim from the rule body 2026-09-07 (loom budget-residual lane).

**Originating evidence.** Asked the same question once, an agent produced **110**, then **48**, then **14/15/19**, then **2/3/3**. Every figure was arithmetically correct; none reconcilable, because each pass silently chose its own population and none stated which. The defect is a MOVING DENOMINATOR, not a wrong number — so the cure is a generated artifact that reports its own quote, not an instruction to be careful.

**Second instance, one turn before this artifact existed.** Asked how much rule-injection headroom remained, one lane reported **92–93%** and another **99.7%** for the same profile on the same tree — percent-of-tolerance-band-consumed versus percent-of-ceiling. Both correct; neither stated its denominator. It happened to operators who had just read this specification: the failure survives knowing about it.

**The chat-reply residual is RETIRED, and the retirement is measured.** An earlier draft recorded that a count quoted in conversation touches no file, so no `paths:` glob fires and the rule was under-reachable there by construction. That is no longer true: the `Stop` guard runs on EVERY reply regardless of files touched. `paths:` now scopes only where the rule TEXT loads, never where enforcement reaches.

## A worked block

This is a real generated block (selftest fixture B), not a sketch. `<sha>` and `<digest>` are the only elided values; every count below is what the generator emits.

```markdown
<!-- BURNDOWN:BEGIN generated by .claude/bin/burndown-build.mjs — DO NOT EDIT BY HAND -->
## Burndown

These are the only counts. Any figure quoted anywhere is this block verbatim, or it is wrong.

Status vocabulary (CLOSED — a value outside this set is a build refusal, exit 2):

- `Signed off` — the owner has accepted it. The ONLY status that counts toward completion.
- `Built-not-walked` — built, not yet walked through with the owner. NOT complete.
- `In progress` — actively being worked.
- `Not started` — accepted into the register, no work begun.
- `Blocked on you` — waiting on the owner; cannot proceed here.
- `Open` — DERIVED, not assignable: `total` − `Signed off`.

`done`, `complete`, `closed`, `finished` and `remaining` are NOT count labels here. Each named at
least two different buckets in prior reports, which is why the generator refuses them.

Every column below is a BUCKET and every row states its DENOMINATOR in `total`. A figure quoted
without both is not a figure from this block.

| page | total | Signed off | Built-not-walked | In progress | Not started | Blocked on you | Open | Open: from original register | Open: arrived since |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Alpha | 3 | 2 | 0 | 0 | 0 | 1 | 1 | 1 | 0 |
| Beta | 4 | 0 | 0 | 1 | 3 | 0 | 4 | 2 | 2 |
| **ALL PAGES** | **7** | **2** | **0** | **1** | **3** | **1** | **5** | **3** | **2** |

A page is complete only when `Signed off` equals `total`. No page is complete: Alpha is 2 of 3,
Beta is 0 of 4.

generated_from_sha: <sha>
sources_digest: <digest>

<!-- BURNDOWN:END -->
```

**How to read Beta, since it is the case the whole mechanism exists for.** Beta shows `4` open, up from `2` when the register was frozen. That looks like a regression and is not one: `2` of those were in the original register and `2` **arrived since**. Work against what was FIRST asked did not go backwards — the ask grew. Drop the last two columns and this page reads as a failure to a reader comparing against memory.

**And Alpha shows the correction that matters most.** It reads `2 of 3 Signed off` with `1 Blocked on you`, because an owner status-refresh moved `REG-01-A` back OUT of `Signed off`. That is an over-report being corrected. Left uncorrected it is the single most expensive kind of error in the block.
