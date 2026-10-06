# GREEN POLE — enumerations that must never be flagged

This is the pole that decides whether the enumeration pass SURVIVES rather than
whether it FIRES. Every enumeration below sits next to a resolvable, anchored
citation and shows fewer members than the source defines — so a checker that
keyed on "a table near a citation with a member missing" would red on all five.
A checker that reds here is red on every commit forever, and a red-forever check
is the one an operator learns to ignore, after which a genuine seven-vs-eight
reads exactly like every other day.

Three of the five are reported as COVERAGE and two are dropped silently. That
split is deliberate and is asserted by the harness: a skip the operator cannot
see is indistinguishable from a check that passed.

## 1. A deliberate proper subset — coverage, never a finding

No lexical test separates "the three that return early" from an accidental
omission, so the discriminator is structural: three of eight is too far from
whole to read as a completeness claim with a hole.

Note that this paragraph carries no hedge word at all — the coverage row below
must come from the structural ratio, not from a phrase. The classifier at
`sources/classify-runner.js:16-75` returns immediately on these:

| kind             | why it returns                     |
| ---------------- | ---------------------------------- |
| `runner-error`   | nothing downstream is readable     |
| `env-abort`      | the run produced no verdict at all |
| `opaque-failure` | the parse-departure safety net     |

## 2. A hedged enumeration — the document declared its own incompleteness

Exactly as a declared elision is a PASS for a fence. The classifier at
`sources/classify-runner.js:16-75` emits these kinds among others:

| kind                     | fires when                               |
| ------------------------ | ---------------------------------------- |
| `runner-error`           | a killed or timed-out process            |
| `under-cases`            | observed cases < declared `min_cases`    |
| `opaque-failure`         | non-zero exit, zero parseable FAIL lines |
| `under-reported-failure` | exit 0 with printed FAIL lines           |
| `undeclared-failure`     | a FAIL case not in the `xfail` list      |
| `xfail-now-passes`       | a declared-xfail case passed             |
| `xfail-not-found`        | a declared-xfail case did not run        |

## 3. An enumeration the cited source does not define — refuse, do not guess

The members below appear in no member structure of
`sources/classify-runner.js:16-75`, so the source's member set for this list
cannot be determined at all. The honest verdict is that the locator probably
mis-scoped it, which is coverage — never a finding built on a guess.

- `alpha` — the first one
- `beta` — the second one
- `gamma` — the third one

## 4. An uncited enumeration — silently out of scope

It never claimed to reproduce anything, so there is nothing to compare it
against. Reporting every uncited list in a 780-file corpus as coverage would
bury the rows that mean something.

| column         | note                      |
| -------------- | ------------------------- |
| `runner-error` | no citation anywhere here |
| `env-abort`    | nor here                  |
| `under-cases`  | nor here                  |

## 5. A teaching enumeration — silently out of scope

Invented by construction; the whole point is that these are not real members.
See `sources/classify-runner.js:16-75` for the real ones.

- `runner-error` — ✅ DO return immediately
- `env-abort` — ✅ DO reserve exit 78
- `under-cases` — ❌ DO NOT check it after the pass/fail arms
