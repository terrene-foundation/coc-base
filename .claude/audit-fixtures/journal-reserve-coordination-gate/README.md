# journal-reserve-coordination-gate

Regression lock for `journal-reserve.js::reserveJournalSlotSigned`'s coordination
gate — issue #76, **and** the failure that #76's own fix re-opened one path over.
It also locks the two other ways `_foldHighWater` can silently return a
high-water of 0: an unvalidated `content.slot` (§ slot-shape) and a swallowed
roster read (§ roster, issue #84).

Run: `node .claude/audit-fixtures/journal-reserve-coordination-gate/run.mjs`
(exit 0 = pass, exit 1 = fail). No CI runner invokes it; like its sibling
`upflow-open-never-complete`, this tier is **committed-fixtures-manually-driven**,
not a live gate. Stated plainly rather than described as "blocking".

## The predicate under test

```js
isCoordinationEnabled(resolveMainCheckout(repoDir) || repoDir);
```

Both halves are load-bearing, and each has already failed once:

| Half dropped                                             | Failure                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the gate entirely (`requireSigningIdentity` hard-true)   | a coordination-OFF repo cannot satisfy `/codify`'s mandatory journal receipt — the sibling `codify-lease.js` degrades cleanly while this one hard-fails on a null `person_id`. **Issue #76.**                                                                                                                                              |
| `resolveMainCheckout` (reading against the worktree cwd) | the tier-2 override `.claude/learning/coordination-mode.json` is GITIGNORED, so it is ABSENT inside a worktree — a tier-2-enrolled repo resolves OFF here while `journal-write-guard.js` reads it ON from main. No record reserved, then the Write halts for "slot unreserved". **#76's own failure class, re-opened by the fix for #76.** |

The second was caught by a Tier-1 redteam and shipped with **no fixture**. A
later adversarial round flagged that absence (`cc-artifacts.md` Rule 9 — a
security-relevant predicate ships with its fixtures). This directory is the
answer to that finding.

## Mutation results — measured, not asserted

Each mutation was applied in an isolated `cp -R` sandbox; the working tree was
never mutated.

| Mutation                                                                                                         | Cases redded                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| replace `isCoordinationEnabled(resolveMainCheckout(repoDir) \|\| repoDir)` with `isCoordinationEnabled(repoDir)` | exactly 1 — `coordination-on/worktree/resolves-main-not-worktree`                                                                                                                                          |
| `requireSigningIdentity: false` (drop the gate open)                                                             | 2 — both `coordination-on/*` cases                                                                                                                                                                         |
| `requireSigningIdentity: true` (revert the #76 fix)                                                              | exactly 1 — `coordination-off/main/unsigned-identity-accepted`                                                                                                                                             |
| `_foldHighWater` — drop the `/^[0-9]{1,9}$/` slot shape check, restore `Number.isFinite`                         | exactly 1 — `slot-shape/poisoned-high-water-cannot-escape-4-digits`                                                                                                                                        |
| `_foldHighWater` — restore the bare `catch { roster = null; }` (revert the #84 fix)                              | exactly 1 — `roster/corrupt-roster-refuses-rather-than-restarting-high-water`                                                                                                                              |
| `_foldHighWater` — drop the `err.code === "ENOENT"` arm (refuse on every roster read failure)                    | 3 — `roster/absent-roster-proceeds` + both `slot-shape/*` fold cases (all three seed log records with no roster)                                                                                           |
| `_foldHighWater` — throw unconditionally after a successful roster parse                                         | exactly 1 — `roster/valid-roster-proceeds`                                                                                                                                                                 |
| `_foldHighWater` — disable the fold-rejection guard entirely (`if (false)`)                                      | 5 — the four loop-generated `roster/{null,empty-object,null-persons,empty-persons}-roster-refuses-rather-than-restarting-high-water` cases, plus `roster/targeted-erasure-of-the-reserving-signer-refuses` |
| `_foldHighWater` — widen the rejection filter to ANY rule (drop `entry.rule !== "rule-1"`)                       | exactly 1 — `roster/ordinary-chain-continuation-does-not-deny-the-receipt`                                                                                                                                 |
| `_foldHighWater` — resolve the roster with `path.join(repoDir, …)` instead of `resolveMainCheckout(repoDir)`     | exactly 1 — `roster/worktree-reads-the-main-checkout-roster-not-its-own`                                                                                                                                   |
| `_foldHighWater` — scope the rejection filter back to `rule-1` alone, dropping the `rule-4` arm                  | exactly 1 — `roster/persons-key-rename-loses-the-reservation-and-refuses`                                                                                                                                  |

**The stale `{1,4}` citation above was wrong for several revisions** — the shipped
check is `/^[0-9]{1,9}$/` (`journal-reserve.js:517`). The sibling mutation string
in `run.mjs` that says "pin the fold check BACK to `/^[0-9]{1,4}$/`" is correct as
written, because pinning it back to four IS the mutation; the row above was
describing the shipped check and named the mutated value.

**The last three rows are the two POLARITY PAIRS this suite gained after the
guard oscillated twice.** Rows 8 and 9 are one axis and must both hold: disabling
the guard reds the erasure cases, widening it reds the availability case. Neither
alone constrains the filter — the widening shipped precisely because only the
erasure polarity existed. Row 10 pins the tree the roster is read from.

**Coverage — DERIVED, not counted by hand.** 17 cases: 13 declared with a literal
`name:`, plus 4 generated by the roster-shape loop. All 13 literal names appear
verbatim in a row above; the 4 loop-generated ones are named as a set in the
disable-the-guard row.

Re-derive rather than trusting this paragraph:

```
node -e 'const fs=require("fs"),d=".claude/audit-fixtures/journal-reserve-coordination-gate/";
const run=fs.readFileSync(d+"run.mjs","utf8"),rd=fs.readFileSync(d+"README.md","utf8");
const lit=[...run.matchAll(/name:\s*"([^"$]+)"/g)].map(m=>m[1]);
console.log("glob-only:",lit.filter(n=>!rd.includes(n)));'
```

**This line has now been wrong twice, and the second time was the correction of
the first.** Draft one claimed "every one named in at least one row" (false by
four). Draft two claimed "16 cases, twelve literal, four glob" — it said four then
enumerated seven, and the total was already stale. Both were written by counting
by eye in a file whose entire subject is that coverage claims must be measured.
The command above is the fix: the number is re-derived, not asserted.

## The roster read (issue #84)

`_foldHighWater` read `.claude/operators.roster.json` inside a bare
`catch { roster = null; }`. A null roster is **not inert**:
`coordination-log.js::_resolveRosterPerson` returns null for it, `_verifyRule1`
then rejects every record with _"signer verified_id not in roster keys"_ — the
roster-**membership** gate is explicitly retained under `skipSignatureVerify` —
so `folded.accepted` is empty and `high` is 0. The fold half of the high-water
vanishes and a slot a sibling operator already reserved is handed out again:
the exact outcome the coordination-log read one line above refuses for, in its
own docstring's words.

The fix mirrors that log read. `ENOENT` alone means _legitimately absent_ (a
solo / un-enrolled repo — coordination is OPT-IN and OFF by default) and folds
with a null roster as before; every other failure means _unknown_ and refuses.
`coordination-mode.js` already draws the same line — an unparseable roster
fails **closed** there (`implicit-corrupt-roster-failclosed`), so treating the
same bytes as absence here was inconsistent with the sibling predicate as well
as with the read directly above.

**Fold path, not raw path — a deliberate call.** The roster cases do NOT set
`COC_TEST_SKIP_SIGN=1`. That flag sets `accepted = records`, which bypasses the
fold entirely, so under the raw path a null roster costs nothing and the
high-water survives. The damage exists only on the fold path, so the cases run
there. The slot-shape cases force the raw path for the opposite and equally
deliberate reason: their subject is the slot loop, which synthetic records
cannot reach through a real fold.

**Measured RED before the fix** — the corrupt-roster case returned:

```
{"ok":true,"reservation":{"slot":"0001","slot_num":1,
 "filename":"0001-fixture-op-DECISION-fixture-topic.md", ...}}
```

i.e. it handed out slot 0001 over an unreadable roster. After the fix it
returns `ok:false, step:"fold-high-water"`.

**Honest bound on the two proceed-polarity cases.** `roster/absent-roster-proceeds`
and `roster/valid-roster-proceeds` are green **before** the fix as well as
after — the bare catch also yielded `roster = null` and proceeded. They are
therefore **not** evidence for the #84 fix; they are the over-tightening guards
that distinguish it from a refuse-everything implementation, and each is redded
by the mutation named in the table above. Stated rather than counted as fix
evidence (`instrument-discipline.md` MUST-2(a)).

**The `readChainHead` stub was wrong and it was latent.** It returned
`{ok:true, prev_hash:null, seq:0}`; `coc-emit.js` reads `{lastSeq, lastContentHash}`
(or `null` for "no prior chain"), so `chainHead.lastSeq + 1` was `NaN` and
canonical-serialize refused. No case in this file reached the emitter until the
roster cases were added, so the suite was green over a broken stub. Now `null`.

## Why the malformed-`content.slot` `continue` stays silent

Considered alongside the #84 fix and deliberately **not** changed. The
dispositions differ because the failures differ in blast radius:

- an unreadable **roster** is GLOBAL — it discards every record, including
  well-formed ones naming slots a sibling really reserved, so proceeding hands
  out a taken slot. Refusing is the only safe direction.
- a malformed or out-of-range **`content.slot`** is LOCAL to one record, and
  that record names no real slot (`"999999999999999999999"`, `"0004junk"`).
  Skipping loses no information about the reserved set.

Refusing on a bad shape would also be strictly worse than the poison it
replaced: one append of `slot: "9999999999"` would permanently deny every
reservation for every operator — the same permanent denial the shape check
exists to prevent, reached through the guard instead of around it, at a lower
cost to the same adversary.

**Residual, recorded not closed:** the skip is unobservable — a poisoning record
is dropped with no counter and no WARN, so an operator cannot distinguish a
clean log from one being probed. `_foldHighWater` has no logger surface and sits
on a guard path where throwing is BLOCKED (`zero-tolerance.md` Rule 3), so
closing it is a separate change.

## The slot-shape case and what it actually reaches

`_foldHighWater` folds with `skipSignatureVerify: true`, so `content.slot` is
read off records whose signatures were not checked. Unbounded, `parseInt`
accepts an arbitrarily long digit run and `Number.isFinite` does **not** reject
the result (1e21 is finite), so `slot: "999999999999999999999"` makes
`String(1e21).padStart(4, "0")` yield `"1e+21"` — the reservation, the emitted
record, and the resulting **filename** all become `1e+21-…`. The poisoning
record is re-folded on every later call, so the breakage is **permanent for
every operator on the repo**: a denial of the journal receipt `/codify`
mandates, from one append.

**The case FORCES `COC_TEST_SKIP_SIGN=1`, and that is load-bearing, not
convenience.** Measured: on the default fold path this case stays GREEN _even
under its own mutation_, because the synthetic records a fixture can write are
rejected by the fold's other rules (chain continuity / emitter registration)
before reaching the slot loop. A case that cannot red is not an instrument, so
the env var is set deterministically inside the case rather than left to the
caller.

**Honest bound.** This instruments the shape check against records the fold
ADMITS. The population that can produce such a record on the default path is a
**rostered operator** emitting a properly-chained record with an arbitrary
`content.slot` — `content` is not validated by the fold. That is precisely
`multi-operator-coordination.md`'s stated adversary (a legitimate team member
with write access seeking sabotage), so the guard is not theatre; but building
that record needs real signing infrastructure this fixture deliberately does not
stand up. Stated rather than papered over.

Every case is redded by at least one mutation, and the suite is **bipolar** — it
carries both a refusal polarity (coordination ON must refuse an unsigned
identity) and a permissive one (coordination OFF must still accept it). A
refusal-only suite cannot detect over-tightening, which is precisely what
reverting #76 looks like.

## The first cut of this fixture was vacuous

Recorded rather than quietly fixed, because it is the same class the fixture
exists to lock.

The two coordination-ON cases originally asserted only `r.ok === false`. Under
the hard-`false` mutation they stayed **green** — the call still returns
`ok:false`, but at `step: "emit:identity"` (the emitter catching the unsigned
identity downstream) rather than `step: "reserve"` (the gate). Both are
`ok:false`, so the assertion was consistent with the gate working _and_ with the
gate being disabled — no information (`instrument-discipline.md` MUST-1).

The cases now pin `step === "reserve"`. That is what makes the mutation red, and
what makes a green here evidence.

**Lever:** the injected identity carries `display_id` but no signing fields. It
is accepted when the gate resolves OFF and refused when it resolves ON, so the
same input yields opposite results either side of the predicate.
