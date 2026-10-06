# `burndown-log-verification` fixtures — the negative-control record

`run.mjs` covers the CONSUMER half of the log/projection split: `burndown-build.mjs`
verifying the traceability chain against the committed append-only event log
(`tracker.kind: "event-log"`) instead of parsing the tracker table.

Sibling scope, so neither suite is read as more than it is — `burndown-events` covers
the PRODUCER (schema, the one signed append path, the fold's own C5 fence); this suite
covers what the GENERATOR does with the folded projection.

## Bipolarity is asserted by the harness, not by the author

Every arm is registered through `pair()`, which runs BOTH poles and then asserts, as
its own third case, that the two **verdicts differ**. A pair whose poles return the
same verdict is VACUOUS and FAILS. Poles return verdict STRINGS rather than booleans,
because two booleans can be equal for opposite reasons and the property under test is
that the poles are DISTINGUISHABLE (`instrument-bipolarity.md` MUST-1).

Every RED pole names a failure IDENTITY — the criterion plus the leg, item id or line
it fired on — never a bare exit code or a count (MUST-2).

## The arms

| Arm                                    | RED pole                                                   | GREEN pole                                            |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `C2-fold-reproduces-the-projection`    | a log missing three appends folds smaller, naming the lost ids | the committed log folds to the manifest's declared population |
| `C1-rotted-anchor-still-caught`        | the anchor artifact is deleted, the event untouched → LINK-2 | the anchor is present → the same log folds to INTACT  |
| `log-uncommitted-refused-loudly`       | an appended-but-uncommitted log → UNRUNNABLE, stdout empty  | the same append, committed, folds clean               |
| `malformed-line-refuses`               | an unreadable committed line, named by line and reason      | a C5-superseded genesis skip is NOT called corruption |
| `selfinput-floor-covers-the-log`       | a `burndown/` anchor root admits the log itself             | a durable root admitting no burndown input            |
| `min_rows-log-integrity-floor`         | a log that LOST an append, refused as monotonicity broken   | a log at its declaration                              |
| `tracker-kind-vocabulary-closed`       | an unrecognized kind, refused naming the accepted set       | `event-log` selects the fold                          |
| `event-log-path-bound-to-the-append-sink` | an `event-log` pointed away from the one append path     | an `event-log` at the append sink                     |
| `bin-copied-without-the-hooks-tree`    | an `event-log` with no event library → TYPED refusal        | the same bin-only tree still `--quote`s and verifies a table |
| `producer-scope-follows-the-manifest-kind` | an unrecognised kind stops at SCOPE and reports UNKNOWN | `event-log` passes scope and reaches the append path  |
| `selfinput-floor-covers-the-inventory` | a root admitting the INVENTORY, which carries every id      | the same inventory under a root that does not admit it |
| `manifest-paths-shape-checked-everywhere` | a pathspec-magic `tracker.path`                          | a traversing `target`, refused before it is WRITTEN   |
| `mirror-drift-caught-on-both-kinds`    | a drifted library sink caught on a `forest-ledger` manifest | an undrifted library resolves normally                |
| `signature-tamper-refused`             | a record altered AFTER signing → `[bad-signature]`, naming record, item and emitter | the same record untampered verifies and stays silent |
| `chain-catches-a-committed-middle-record-deletion` | a middle record removed and RE-COMMITTED → `[seq-gap]` | the same three records, none removed, chain cleanly |
| `verification-cannot-run-is-not-clean` | no roster to resolve the signer → INDETERMINATE, not a pass | the same log WITH the roster verifies and folds       |

Four of these arms exist because an adversarial review of this change found the gaps
they pin — the inventory self-input, the unreachable drift assertion, the unchecked
sibling paths, and the producer disarm — and each was LIVE, not hypothetical. The
suite is stronger for having been attacked than for having been written.

## Why the event library is required LAZILY

`sync-tier-aware.mjs` ships `.claude/bin/burndown-build.mjs` on a stated guarantee
that its DEFAULT path takes no relative import, and the `burndown-quote-hooks` and
`burndown-trace` harnesses both **copy the bin alone** into a temporary
`.claude/bin/`. A top-level require of the event library therefore killed every mode
of the tool — `--quote` included — with a module-resolution stack trace in any such
tree. That was MEASURED, not hypothesised: it red 38 cases across those two sibling
suites. The library is now required only where a manifest declares `event-log`, and
its absence is a typed refusal. `bin-copied-without-the-hooks-tree` is the pin.

The append-sink constant `EVENTS_REL` is MIRRORED in the generator rather than
imported, because the `anchor_roots` self-input floor must know the log's path even
for a `forest-ledger` manifest in a repo that also carries a log — a floor that
applied only when the library happened to load would drop out exactly where the
tautology it prevents becomes reachable. Drift is closed by asserting the mirror
against the library whenever the library loads.

## C1 is the load-bearing proof, and an assertion is not enough for it

C1 requires LINK-2/LINK-3 to stay LIVE REPO READS, because an append-only log **cannot
express "the artifact I pointed at was deleted"** — an event that truthfully recorded
an anchor stays true forever while the anchor ROTS.

Showing that the real binary refuses on a rotted anchor does not by itself show the
live re-read is what caught it. So the arm is paired with a source mutation that
implements the counterfactual design — `resolveAnchor` short-circuits to `ok` BEFORE
its first repo read, i.e. it TRUSTS THE EVENT — run against the SAME tree with a
**byte-identical log blob**, asserted identical by the fixture itself. The mutant
reports `chain INTACT`. That is the measurement that the live re-read does the work.

## The mutations, each PROVEN to red AND proven to reach

`instrument-discipline.md` MUST-2(b): a mutation that does NOT red leaves TWO live
hypotheses — vacuous test, or inert mutation — so a non-reddening result is UNRESOLVED,
never "vacuous". Each mutant is proven twice: `subOnce()` **throws** unless its anchor
matches exactly once (so a silently-missed mutation cannot be read as a verdict), and
each case then asserts the mutant's verdict on the same tree DIFFERS from the real
binary's. A mutant that also refuses is reported UNRESOLVED, not passed.

| Mutation                                                  | What it re-opens                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `resolveAnchor` returns `ok` before its first repo read     | the event-replay design C1 forbids — the rotted chain reads INTACT  |
| `assertCommittedAndUnmodified` exempts the log path         | a dirty, uncommitted log is certified as evidence                   |
| the malformed-line refusal is `if (false && …)`             | the fold silently folds around its own corruption, reporting clean  |
| `EVENTS_REL` is dropped from `selfInputs`                   | a `burndown/` root lets every row anchor at the log that declares it |

The self-input mutation is deliberately exercised on a **`forest-ledger`** manifest
whose sources live outside `burndown/`. Under `event-log` the log is also
`tracker.path` and was already a self-input, so a case built that way would refuse
either way and prove nothing about what the change added; this way the log is the only
self-input under the declared root.

## What no case here covers — the honest bounds

**Both of the bounds this section used to record are now CLOSED, and are kept here as
a record of what changed rather than deleted.** They read:

> _"Signatures are not verified. … A green run here is NOT evidence of signature
> verification, and a hand-written unsigned line that satisfies `validateEvent` folds
> exactly like a signed one."_
>
> _""Append-only" is a producer discipline, not a gate invariant. Nothing compares the
> log against a prior revision …"_

The second closed first, when `verifyAppendOnlyPrefix` was wired into the read path;
the note above outlived it and was simply stale. The first closed with the read gate
(`verifySignedLog` → `signed-log.js::verifyLogSignatures` + `verifyChain`), and every
record in this suite is now REALLY SIGNED by a real ed25519 key against a real roster
the fixture repo carries — so a green run here IS evidence of signature verification,
and the `signature-tamper-refused` arm is what makes that claim falsifiable.

The RED that motivated the wiring, measured on the repo's own 534-record log before
it existed: a record copied from the log with its `sig` replaced by the literal text
`TOTALLY-FORGED-NOT-A-SIGNATURE`, appended and left uncommitted, was accepted at exit
0 and WON the last-wins fold — moving the reported supersession count from 267 to 268
and flipping a live item to "Signed off". `verifyRecordSignature` and `verifyChain`
had existed in `signed-log.js` with ZERO call sites outside their own module.

**What remains genuinely uncovered.** The roster itself is read from the WORKING TREE
and is not held to `assertCommittedAndUnmodified`, so an operator who can edit the
roster can add a key and have records signed by it verify. That is the roster's own
trust-root question, owned by the roster write-guards, and this gate does not claim to
close it — what it closes is the separate claim that a log's records were signed at
all, by keys the roster names.

**The chain check is generation-scoped, and today that population is EMPTY.** All 534
committed records are generation-0 (`burndown-event/v1`), which predates
`seq`/`prev_hash` entirely, so `verifyChain` examines zero records against the real log
and cannot fail there. It is not vacuous — it fires on the first v2 append, and
`chain-catches-a-committed-middle-record-deletion` pins that it reds on a deleted
middle record — but a green from it TODAY is evidence about the generation-1
population only. The signature half is what carries all 534.

**Supersession is reported, not refused.** `foldEvents` is last-wins per `item_id`
where `parseLedger` refused a duplicate outright. Refusing would break the A4
status-promotion channel, so the count is surfaced in the verdict instead — the
`A4 · a superseded event is counted and stated` case pins that, with a one-event
control that must read `0`. What remains uncovered: nothing here tells a reviewer
*which* of two competing events won, only that a competition happened.
