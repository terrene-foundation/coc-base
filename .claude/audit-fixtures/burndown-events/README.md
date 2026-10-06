# `burndown-events` fixtures — the negative-control record

`run.mjs` covers `lib/burndown-events.js` (the event schema, the single signed append
path, the fold) and `todo-tracker-guard.js` (the producer).

## Bipolarity is asserted by the harness, not by the author

Every arm is registered through `pair()`, which runs BOTH poles and then asserts, as
its own third case, that the two **verdicts differ**. A pair whose poles return the
same verdict is VACUOUS and FAILS. Poles return verdict STRINGS rather than booleans
because two booleans can be equal for opposite reasons, and the property under test is
that the poles are DISTINGUISHABLE (`instrument-bipolarity.md` MUST-1).

Every RED pole names a failure IDENTITY — the criterion plus the `item_id` or line it
fired on — never a bare exit code or a count (MUST-2).

## The mutations, each PROVEN to red AND proven to reach

`instrument-discipline.md` MUST-2(b): a mutation that does NOT red leaves TWO live
hypotheses — vacuous test, or inert mutation — so a non-reddening result is UNRESOLVED,
never "vacuous". Each mutant below is therefore shown to REACH the code it replaces
before its result is read.

Reproduce with `BURNDOWN_EVENTS_FIXTURE_MUTANT=<name> node run.mjs`.

| Mutant                 | What it removes                                         | Measured result       | How reachability is proven                                                                                                                     |
| ---------------------- | ------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate-passthrough` | `validateEvent` always returns `ok`                     | 57 passed, **7 failed** | Asserted IN CODE before any case runs: the real function must REFUSE a probe the mutant ACCEPTS, else the runner exits 3 as UNRESOLVED rather than reporting a verdict. |
| `fold-nofence`         | the C5 `migration_baseline`-never-overwrites-live fence | 57 passed, **7 failed** | The RED pole's diagnostic CHANGES CONTENT — `the genesis OVERWROTE the live transition (item is 'the BACKFILLED text')`. An inert replacement would have produced byte-identical output. |
| `append-alwaysfail`    | the append helper always refuses                        | 60 passed, **4 failed** | The failing pole reports the MUTANT'S OWN reason string (`record too large: serialized line exceeds MAX_LINE_BYTES (2048)`), which only the substituted code emits. |

Baseline for comparison: **64 passed, 0 failed**.

All four figures RE-MEASURED 2026-08-24 against the suite as it stands. They previously read
24 / 19-5 / 23-1 / 23-1, measured when the suite carried 24 cases; the retraction and
authority-binding arms took it to 64 and every one of those numbers went stale. In a file whose
subject is "each mutation PROVEN to red", a stale measured count is the failure mode it exists
to prevent, so the counts are re-run rather than reasoned about. The reachability arguments in
the third column were re-checked and still hold.

`validate-passthrough` reds FEWER cases than the case count suggests, and the reason is scope
rather than weakness: it substitutes the fixture's own `ev.validateEvent` reference, so it
reaches cases that call the validator DIRECTLY and not the ones that reach it through
`appendEvent`, which resolves the module-internal function. The retraction/authority arms are
mostly of the second kind.

## What NO mutant covers, stated rather than implied away

No mutant reaches inside the `todo-tracker-guard.js` SUBPROCESS, so the C6
loudness arm is not mutation-controlled. Its discrimination rests on the `pair()`
assertion instead: the same producer, on the same tree, is shown to SURFACE a
criterion-naming finding on one pole and to stay entirely SILENT on the other. That
establishes the producer can return both answers; it does not establish that a future
edit which silently swallowed a finding would be caught by a mutant, because there is
no mutant. Recorded here so the coverage is not read as wider than it is.
