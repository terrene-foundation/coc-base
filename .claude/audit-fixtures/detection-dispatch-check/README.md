# `detection-dispatch-check` audit fixtures

Structural fixture set for `.claude/bin/detection-dispatch-check.mjs`, the scanner
that asks whether a rule's claimed hook detector is ACTUALLY DISPATCHED.

Inline-runner layout (`run.mjs`), the variant `cc-artifacts.md` Rule 9 sanctions
alongside per-case sidecar files — chosen because every case here asserts on a
PURE FUNCTION's return value, so a sidecar pair would add a file round-trip
without adding a discriminating signal. Registered in
`.claude/test-harness/ci-audit-fixtures.json` (`min_cases: 43`, taken from an
actual run) and executed by `.claude/bin/run-audit-fixtures.mjs`.

## fixture-43 pins a BOUND, not a behaviour anyone wants

Most cases here assert the desirable answer. fixture-43 asserts the CURRENT one:
a `require` inside `if (false)`, or after an unconditional `return`, still
confers a dispatch edge, because extraction is position-aware (comments and
strings masked) but not reachability-aware.

It exists so `STATED BOUNDS #2` in the scanner header and the code cannot drift
apart. A prose-only bound has nothing holding it; if a later change adds
control-flow analysis, this case reds and forces the bound to be rewritten in the
same commit. The direction is FALSE-GREEN — a dead `require` clears a claim — so
it hides a finding rather than inventing one, and it is a usable evasion.

## What these fixtures lock, and what they do not

They pin the scanner's **scope-restriction predicates** — which `require` forms
the graph walker can see, and which claim states carry teeth. Both are exactly
the non-obvious predicates Rule 9 exists to pin, and one has already drawn blood
(fixture-02).

They do NOT exercise the assembled CLI. That is
`.claude/test-harness/tests/detection-dispatch-check.test.mjs`, which spawns the
real scanner against hermetic synthetic repos and pins both directions with
minimal pairs. The split is deliberate: a predicate can be correct while the gate
ignores it, and a gate can exit 1 for a reason unrelated to the predicate. Only
the pair says the instrument discriminates.

## Case groups

| Group                        | Cases | Property pinned                                                    |
| ---------------------------- | ----- | ------------------------------------------------------------------ |
| A. require-form matrix       | 01–07 | what the graph walker can SEE (incl. the fixture-02 regression lock) |
| B. settings.json roots       | 08–10 | Leg A input extraction + both fail-closed shapes                    |
| C. transitive closure        | 11–15 | Leg B, incl. cycles, extensionless specifiers, root containment     |
| D. claim-state matrix        | 16–23 | which states are fatal, and the deferral precedence order           |
| E. symbol-liveness predicate | 24–30 | `countSymbolSites` — use vs definition vs export listing vs comment |
| F. comment / string masking  | 31–38 | the GATE's edge vocabulary; the fail-open laundering repair          |
| G. containment + frontmatter | 39–42 | real-path containment both directions; `paths:` globs are not claims |

## Group F is the fail-OPEN repair, and it is the more dangerous direction

The comment bug was fixed once in the symbol DIAGNOSTIC and left standing in the
edge extractor that feeds the TEETH: `buildDispatchClosure` passed RAW bytes to
`extractRequireEdges`. A single commented-out `require` inside any registered
hook therefore laundered a dead lib to `dispatched-transitive`.

Compare the two failure directions this fixture set now locks:

| direction  | example                                     | effect                              |
| ---------- | ------------------------------------------- | ----------------------------------- |
| fail-CLOSED | fixture-02, the missed multi-line `require`  | FALSE RED — accuses working code    |
| fail-OPEN   | fixture-31/32/33, comment + string laundering | HIDES a finding — reports it clean  |

A false red is loud and gets corrected. A hidden finding is silent and ships. The
masking is ported from `sync-from-canon.mjs::maskComments` rather than
re-invented — same repo, same regex-over-source problem, already redteamed —
though note the polarity there is the opposite: a comment-require caused a
spurious HALT (fail-closed), not a spurious edge.

fixture-34 guards the repair from over-reaching: an apostrophe in a comment must
not desync the string-state walk and swallow the code that follows.

## Group E is the second false-accusation repair

`symbolDiagnostic` originally SKIPPED THE DEFINING FILE when counting references,
on the reasoning that a definition would trivially self-match. The effect was a
false accusation of deadness: a symbol defined AND called inside a single
dispatched file was reported "NOT referenced anywhere". `decideAnalyzeGate`
(defined `analyze-completeness-guard.js:151`, called `:227`, file registered at
`PreToolUse(Skill)`) and `detectHeredocWriteRunBundle` (defined
`violation-patterns.js:2778`, called `:2974`) both have that shape, and the
second demonstrably fired against a real Bash command during the session that
found it.

The repair introduced its own inverse error, which is why 25–28 exist: counting
every non-definition occurrence made an inline `module.exports = { neverCalled };`
read as a use, reporting a never-called symbol as `invoked`. Fixture-27 covers
the third: `detectStreetlightSelection` is named in four COMMENTS and called
nowhere, so counting comment mentions returns a false all-clear on a genuinely
uninvoked detector — the failure direction that matters most, since it hides a
real finding rather than manufacturing a fake one.

Note the deliberate layering: mutating the aggregation loop in `symbolDiagnostic`
reds the e2e suite and NOT this runner, because this runner pins the predicate
and the suite pins the assembled diagnostic. Neither subsumes the other.

## fixture-02 is a regression lock, not decoration

The first cut of `RE_REQUIRE_JOIN` allowed a trailing comma INSIDE
`path.join(...)` but not AFTER it, so it missed every wrapped call of the form

```js
const { checkAuthorBacking } = require(
  path.join(__dirname, "lib", "provenance-author-backing.js"),
);
```

— the dominant multi-line shape in this corpus, and the literal text at
`.claude/hooks/journal-write-guard.js:108`. The scanner reported
`provenance-author-backing.js` as UNDISPATCHED while a REGISTERED hook requires
it. That is a **false red**, and a false red is the worst outcome available to
this particular instrument: it dispatches a remediation lane against working
code, and it teaches readers to discount the tool — which is how a gate stops
being consulted.

Verified DISCRIMINATING by mutating the scanner rather than the fixture: reverting
`RE_REQUIRE_JOIN` to the buggy form drops the real-corpus dispatch closure from
106 files to 65 and re-raises the false red, and fixture-02 is the only case that
reds. The mutation is shown to REACH the code by that closure-size change before
the red is read as a verdict (`instrument-discipline.md` MUST-2b: a mutation that
does not red leaves two live hypotheses — vacuous check or inert mutation).

## fixture-12 is the Leg B core

`lib/c.js` is `require`d — by a hook that `settings.json` never registers. A grep
for "is this file referenced anywhere?" passes it; dispatch does not. This is the
precise distinction the scanner exists to draw, and the reason a
reference-counting sweep over `.claude/hooks/lib/` returns ~66 hits that are not
66 broken detectors.
