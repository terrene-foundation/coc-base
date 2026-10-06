# `upflow-ingest-integrity` audit fixtures

Bipolar fixtures for `.claude/bin/upflow-ingest-integrity.mjs` — the integrity
gate for `.claude/upflow-ingest-dispositions.json`, the INGESTED-vs-ACKNOWLEDGED
ledger (F87) and the symmetric twin of `upflow-disposition-integrity.mjs`.

Run: `node .claude/audit-fixtures/upflow-ingest-integrity/run.mjs`
Registered: `.claude/test-harness/ci-audit-fixtures.json` (`mode: run`,
`min_cases: 155`) — that registry is the closure the runner is discovered
through; the count is a FLOOR against a collapse to a handful of cases, not a
description of the suite.

The harness deliberately mirrors the sibling suite at
`.claude/audit-fixtures/upflow-disposition-integrity/` — same case table, same
`check` / `expect*` helpers, same `PASS`/`FAIL` glyphs, same exit discipline —
rather than inventing a second shape for a gate that is itself a deliberate copy
of a pattern.

## What is asserted, and why each pole exists

Every predicate carries a case that must PASS and a case that must FAIL. A
runner that only asserts rejection cannot distinguish a working predicate from
one that rejects everything; one that only asserts acceptance cannot distinguish
it from one that accepts everything.

Every RED pole asserts a failure **IDENTITY** — the distinctive part of the
specific message — never a count of errors and never a bare non-zero exit
(`instrument-bipolarity.md` MUST-2). An exit code is a QUANTITY; the reason is
an IDENTITY. A pole satisfied by the gate reddening for some unrelated reason is
not a case.

| predicate                      | enforced at | compliant pole                                                                                                 | violation pole                                                                                                                                                                                                                        |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `now` funnel               | `:88-98`    | a past `decided_on` accepted with `now` as a NUMBER and as a DATE                                              | a future `decided_on`                                                                                                                                                                                                                 |
| row is an object               | `:106-109`  | a plain row                                                                                                    | a string, an array, `null`                                                                                                                                                                                                            |
| six required fields            | `:110-114`  | a complete row; extra unknown fields tolerated                                                                 | each field removed in turn (6 cases); whitespace-only; a non-string                                                                                                                                                                   |
| `target` is a resolver key     | `:116-122`  | `use-template.rs`, `build`                                                                                     | `repos/kailash-rs`, `Use-Template.rs`, `-use-template`                                                                                                                                                                                |
| no checkout-location leak      | `:123-129`  | `rules/agents.md#1`, `nested/plain/dir/notes.md#4`                                                             | all four alternands: leading `/`, leading `~`, a drive letter, and `/Users/` + `/home/` MID-path — plus one on `target`                                                                                                               |
| row identity `(target, entry)` | `:131-141`  | same entry under another target; another entry under the same target                                           | the same pair twice                                                                                                                                                                                                                   |
| verdict enum                   | `:143-150`  | each of the five vocabulary terms, with its own obligations met                                                | `probably-fine`; and `keep-local`, valid in the SIBLING ledger                                                                                                                                                                        |
| substantive `reason`           | `:152-157`  | a reason EXACTLY at the 24-char floor                                                                          | one char under it                                                                                                                                                                                                                     |
| reason-is-not-the-verdict      | `:158-160`  | a reason that merely CONTAINS the verdict word                                                                 | the verdict restated exactly, and in another case                                                                                                                                                                                     |
| **receipt on `landed`**        | `:164-174`  | `journal/0578`, `PR #1751`, a short SHA; a non-`landed` row needs none                                         | `landed` with none, with whitespace, and with prose that cites nothing                                                                                                                                                                |
| `decided_on` sanity            | `:177-184`  | today, and earlier                                                                                             | future, day-first, calendar-invalid, non-date                                                                                                                                                                                         |
| **calendar rot**               | `:186-201`  | both deferring verdicts with a future `expires`; an `expires` dated exactly TODAY; terminal verdicts with none | both deferring verdicts with none; a PAST `expires` on an action-deferring AND on a terminal verdict; malformed; calendar-invalid                                                                                                     |
| **backlog aging**              | `:204-261`  | fresh; exactly AT its TTL; a `measured_on` dated exactly TODAY; zero counts; provenance prose                  | one day past TTL; a FUTURE `measured_on` (twice — the error, and the `null` return); array/absent/null; malformed and calendar-invalid `measured_on`; string/zero/negative/fractional TTL; negative, absent and stringly-typed counts |
| FATAL vs FINDING               | `:300-352`  | a well-formed ledger with one row                                                                              | absent file, unparseable JSON, absent/empty/null vocabulary, absent/object/string `dispositions` — each `fatal: true`; a broken ROW is `fatal: false`                                                                                 |
| **ARRAY vocabulary is FATAL**  | `:329-339`  | an OBJECT vocabulary of the same terms is accepted (the separating control)                                    | empty array, one-term array, several-term array — each `fatal: true` naming the SHAPE; the ARRAY arm precedes missing-or-empty; and the QUIET arm, `length`/`0`/`1` rejected                                                          |
| cross-row identity             | `:354-364`  | two rows differing only in `entry`                                                                             | two identical rows                                                                                                                                                                                                                    |
| **F87 vacuous-pass fence**     | `:430-451`  | a DRAINED backlog with an empty ledger; an OPEN backlog with one recorded verdict; one VALID row among junk    | an empty ledger against 145 open entries, and against the boundary of 1; one junk row (the disarm); many junk rows; an EXPIRED row; the two message arms kept distinct                                                                |
| **exit codes**                 | `:496-544`  | `0` + the PASS banner; `--json` `{ok:true}`                                                                    | `2` on absent and unparseable; `1` on a finding; `--json` preserving all three                                                                                                                                                        |
| the gate's own selftest        | `:467-494`  | `--selftest` exits 0 reporting `identity-matched=true`                                                         | — (see § Scope bounds)                                                                                                                                                                                                                |

The clock is **injected** (`NOW = 2026-08-19T12:00:00Z`) for every predicate that
reads one, so these fixtures never start failing on a calendar date. The LIVE
gate is what is meant to do that.

The eight SPAWNED exit-code cases cannot inject a clock — `main` reads
`new Date()` with no injection point — so each one needing a fresh backlog
DERIVES `measured_on` from the same UTC day the gate will read. That is the
opposite of hardcoding a date: it keeps those cases true on any host on any day.
No case here asserts how fast, or on what day, the host is running.

No fixture reads the live ledger. Editing
`.claude/upflow-ingest-dispositions.json` changes what the live gate says and
never silently rewrites what these predicates are asserted to do.

## Isolation of two predicates that would otherwise be masked

Two arms are reachable only under conditions a naive case never creates, so each
one carries a CONTROL that proves the intended arm is what decided it.

**The reason-restates-the-verdict check** (`:158-160`) fires on exact equality
between the reason and the verdict. Every realistic verdict is shorter than the
24-char reason floor at `:152-157`, so a naive case trips the FLOOR first and would
be re-asserting THAT predicate under this one's name. A ledger's vocabulary is
free-form, so the fixtures construct a 36-character verdict, then assert BOTH
that the restatement identity fired AND that the length identity did not.

**The `now` funnel** (`:88-98`) is asserted by a pair of GREEN cases, not a red
one: if the funnel broke, the primitives would return `null`, `null` would
coerce to `0`, and a PAST `decided_on` would be wrongly flagged FUTURE. The
mutation battery confirms the discrimination — breaking the funnel reds 38 cases.

## Mutation evidence

A green suite over new fixtures is the finding, not the verification
(`instrument-discipline.md` MUST-5). Measured at authoring against a THROWAWAY
COPY of the gate — this runner never mutates the file it pins — with each
mutation's anchor counted in the source before its result was read:

- **20/20 kill mutations RED.** Removing the receipt requirement, the receipt
  SHAPE check, the past-`expires` hard fail, the `expires`-required-for-deferring
  arm, the F87 fence, the duplicate check, the leaky-path check, the target-key
  check, the vocabulary enum, the empty-vocabulary fatal arm, the non-array
  `dispositions` fatal arm, the backlog staleness check, the backlog non-object
  arm, the count and TTL integer checks, the required-field emptiness check, the
  future-`decided_on` check, the restatement check, lowering the reason floor, or
  breaking the `isoDay` funnel each reds at least one pole.
- **3/3 kill mutations RED on the `measured_on` future-date arm**, measured when
  that arm landed. Removing it, WEAKENING its threshold so it only fires ~1000
  years out, and dropping its `return null` so a caller can read a negative
  `ageDays` as a real age each red a named pole. The weakening case is the
  load-bearing one: it leaves a guard that is PRESENT, reads correctly, and
  cannot return its falsifying result for any realistic input — the
  non-discriminating instrument `instrument-discipline.md` MUST-1 blocks as
  evidence. A pole keyed on the guard's existence would score it clean.
- **1/1 scope mutation GREEN.** Rewriting the required-field loop as
  `filter/forEach` — an equally valid construction — leaves every pole green, so
  the fixtures ban the defect rather than this implementation.
- **4/4 kill mutations RED on the 2026-09-14 fence-semantics arms**, each with
  its REACH PROVEN before its result was read — a stderr marker wired into the
  mutated expression itself, so one run shows both that the line executed and
  what it reddened. Disabling the `Array.isArray` fatal arm (marker 41x) reds 8
  poles. Reverting the fence operand to `rows.length === 0` (marker 13x) reds 5,
  including the EXPIRED-row and duplicate-ORDER poles. Neutering the
  optional-count loop (marker 43x) reds 4, one per malformed shape. Removing the
  `backlogIsSound` gate (marker 27x) reds exactly the 4 backlog-soundness poles
  while its CONTROL — a sound open backlog still arming the fence — stays green,
  so the gate narrows the fence rather than disarming it. No mutation produced an
  empty red-set, so none needed the double-mutation resolution.
- **2/2 IDENTITY mutations RED, and this pair is the reason the counts above can
  be trusted.** Adversarial review proved two cases were satisfiable by an
  UNRELATED red: replacing the required-count message with "something went wrong
  somewhere" left `CONTROL: absence separates the REQUIRED counts…` green, and
  replacing the duplicate message left `the SECOND half of a duplicate pair…`
  green. Both asserted COUNTS, not identities. Both now assert the message
  identity, and re-running the reviewer's own two mutations REDS each one. A
  mutation that destroys only a message — leaving arity, control flow and error
  count untouched — is what separates a pole that reads the reason from one that
  merely notices a number changed.

**Two mutations initially produced an EMPTY red-set, and neither was a vacuity
verdict.** Deleting the non-array `dispositions` fatal arm and the backlog
non-object arm each made the gate THROW out of `checkIngestDispositions`, which
aborted the runner mid-suite: the mutation was caught, but it emitted no `FAIL`
line, so a battery reading red-sets scored it SURVIVED. That is an inert-looking
result from a mutation that was anything but, and
`instrument-discipline.md` MUST-2(b) forbids recording the first as the second.
Resolved by fixing the HARNESS rather than the reading — `check` now evaluates
every predicate inside a `try`/`catch` and renders a throw as a red carrying the
exception as its identity. Both mutations now red cleanly and the suite still
reports its full case count under them, so one throwing case can no longer hide
the cases behind it. The count is deliberately not restated here: it lives in
`ci-audit-fixtures.json` as `min_cases` and in the runner's own summary line, and
a third copy in prose is the one that goes stale (`instrument-discipline.md`
MUST-6).

## Scope bounds

**Three cases are SCOPE PINS, not endorsements.** Each fixes a boundary in the
gate's current behaviour so that widening it is a deliberate, reviewed edit
rather than a silent one. If an arm is intentionally widened, its case REDS and
is meant to be updated with it.

- The backlog count checks at `:234-238` (required) and `:246-253` (optional)
  cover exactly `producers_pending`, `entries_total`, `entries_genuinely_open`
  and `entries_closing_with_no_work`. A count field on NEITHER list is still
  unvalidated. The boundary MOVED; it did not disappear.
- **The fence's `recordedVerdicts` count is ORDER-DEPENDENT under a duplicate
  key**, and TWO cases pin both orders. `validateRow` registers a
  `(target, entry)` pair for the FIRST row carrying it, valid or not, so
  `[malformed-with-key, well-formed-same-key]` records ZERO verdicts while the
  reverse order records one. Both orders red and both messages are true under the
  counting rule — the second row IS a duplicate, and "nothing says which applies"
  is exactly what the IDENTITY rule refuses — but the message differs on row
  order alone. Surfaced by adversarial review and left OPEN deliberately: closing
  it needs two passes over the rows and a different meaning for duplicate
  identity. Pinned so it is recorded rather than rediscovered.

**Not a scope bound, because it was closed rather than pinned:** the fence's
backlog operand was read RAW while a comment claimed both operands were held to
the same standard. A future-dated, stale, bad-TTL or counts-missing snapshot
that `validateBacklog` had just rejected could still arm the fence and put its
count in the message. Review caught the false claim; the code now gates on
`backlogIsSound`, four cases pin it, and a control pins that a SOUND open backlog
still arms the fence. Recorded here because the failure — a comment asserting a
symmetry the code did not yet deliver — is the same class as the retired
vocabulary pin below, committed inside the change that was fixing it.

**The two PREVIOUS scope pins were retired by closing what they pinned**, and how
they failed is worth keeping. Both described a hole, and one of them described it
WRONGLY:

- The backlog-count pin was accurate and did its job. It said the loop covered
  exactly three fields and `entries_closing_with_no_work` was outside it, and
  when the loop widened, it RED with a message naming its own repair. That is a
  tripwire working, not a false alarm.
- The vocabulary pin read "a NON-EMPTY ARRAY vocabulary is not fatal, but rejects
  EVERY verdict". The first clause was true. **The second was false when it was
  written** — measured 2026-09-14: membership is `hasOwnProperty` over an array,
  whose own keys are its INDICES plus `length`, so a row dispositioned `"length"`,
  `"0"` or `"1"` was ACCEPTED and the gate exited 0 with zero errors.

**The lesson, and the rule this suite now follows: a scope pin states what is NOT
covered, and does not editorialize about whether that is safe.** The vocabulary
pin's boundary description was correct; its reassurance was not, and the
reassurance is what made the hole look tolerable enough to leave. A pin's safety
claim is a code-surface claim and carries the same evidence burden as any other
(`zero-tolerance.md` Rule 3e) — so if it cannot be measured, it should not be
written.

**Exact-field-set enumeration is deliberately KEPT.** It is tempting to conclude
that pinning an exact list guarantees a future false RED on the next legitimate
widening. It does not: the RED is the point. When this loop widened, the pin
failed with text naming the case AND this README section as its repair, which is
what made the semantic change reviewable instead of silent. The cost was one
fixture edit; the alternative — a pin vague enough never to red — buys nothing
and reports nothing.

**The gate's own `--selftest` is pinned GREEN only.** Reddening it would require
mutating the gate under test, which this runner must not do — it pins a file it
does not own. The green pin is still discriminating: it asserts
`identity-matched=true`, so a selftest whose red pole stopped matching its named
failure identity would fail here.

**These fixtures assert the LEDGER contract.** They say nothing about whether the
Gate-1 queue is actually drained, nor about any producing repo's state — the gate
itself cannot re-measure the backlog (that needs reads of five producing repos CI
does not have), which is why it AGES the measurement rather than faking one.

**Registration is not execution.** Being in `ci-audit-fixtures.json` means
`run-audit-fixtures.mjs` will execute this runner and hold it to its
`min_cases` floor. It is a separate question from whether the GATE itself is
wired to a workflow step; see the gate's own header for that state.
