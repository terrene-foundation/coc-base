# `upflow-disposition-integrity` audit fixtures

Bipolar fixtures for `.claude/bin/upflow-disposition-integrity.mjs` — the gate
that gives `.claude/upflow-dispositions.json` the aging teeth
`.claude/test-harness/phase2-deferrals.json` already has (loom#1751).

Run: `node .claude/audit-fixtures/upflow-disposition-integrity/run.mjs`
Registered: `.claude/test-harness/ci-audit-fixtures.json` (`mode: run`,
`min_cases: 49`) — that registry is the closure the runner is discovered
through; the count is a FLOOR against a collapse to a handful of cases, not a
description of the suite.

## What is asserted, and why each pole exists

Every predicate carries a case that must PASS and a case that must FAIL. A
runner that only asserts rejection cannot distinguish a working predicate from
one that rejects everything; one that only asserts acceptance cannot distinguish
it from one that accepts everything.

| predicate | compliant pole | violation pole |
| --- | --- | --- |
| six required row fields | a complete row | each field removed in turn (6 cases) |
| verdict enum | each vocabulary term | `probably-fine` |
| substantive `reason` | a real justification | under the 24-char floor |
| reason-is-not-the-verdict | a real justification | the verdict repeated to clear the floor |
| `target` is a resolver key | `build.rs` | `repos/kailash-rs` |
| `artifact` leaks no location | a repo-relative path; `nested/plain/dir/x.js` | a synthetic absolute root, a `~`-relative path, and a home segment MID-path |
| `decided_on` sanity | today, and earlier | future date, malformed date |
| **calendar rot** | `upflow-owed` with a future `expires` | `upflow-owed` with none; a PAST `expires` on both an action-deferring AND a terminal verdict |
| terminal verdicts need no `expires` | `superseded` without one | — (its absence must NOT fail) |
| **backlog aging** | fresh snapshot; snapshot exactly AT its TTL | past TTL; future-dated; non-integer TTL; negative count; absent |
| absent vs empty | `dispositions: []` passes | the key REMOVED is fatal |
| row identity | same artifact under a different `target` | the same pair twice |
| **artifact rot** | probe says PRESENT ⇒ no warning | probe says ABSENT ⇒ STALE warning |
| unreadable input | — | unparseable ledger is FATAL, never a pass |

The clock is **injected** (`NOW = 2026-08-18T12:00:00Z`), so these fixtures never
start failing on a calendar date. The LIVE gate is what is meant to do that.

No fixture reads the live ledger. Editing `.claude/upflow-dispositions.json`
changes what the live gate says and never silently rewrites what these
predicates are asserted to do.

## Disclosure discipline in the fixture data

An earlier revision of this runner embedded a real-shaped operator home path as
the absolute-path violation case. The `#263` synced-surface disclosure gate
flagged it on the first CI run — correctly: `audit-fixtures/**` ships on the
`cc` tier, so that literal would have cascaded to every consumer.

Fixed by using an obviously-synthetic absolute root, which exercises the
leading-separator alternand identically. While correcting it, a second gap
surfaced: every absolute fixture fires the LEADING-separator alternand first, so
the mid-path home-directory alternand was reachable but never asserted. It now
has its own case, written with the `<operator>` placeholder form the `#263`
scanner itself sanctions — its shape regex carries a `(?!<)` lookahead precisely
so a fixture can name the shape without embedding a real one. That case is
discriminating: `nested/Users/<operator>/x.js` is REJECTED while
`nested/plain/dir/x.js` is ACCEPTED, so the mid-path alternand is what decides
it rather than some other branch.

## Mutation evidence

Measured at authoring time with an ad-hoc battery (12 kill mutations + 1 scope
mutation), each mutation shown to APPLY before its result was read:

- **12/12 kill mutations RED.** Removing the past-expiry hard fail, the
  `upflow-owed` expiry requirement, the backlog staleness check, the duplicate
  check, the leaky-path check, the vocabulary enum, the future-date checks, the
  absent-vs-empty discrimination, the reason floor, the restatement check, or
  the NOT-CHECKED arm each reds at least one pole.
- **1/1 scope mutation GREEN.** Rewriting the required-field loop as
  `filter/forEach` — an equally valid construction — leaves every pole green, so
  the fixtures ban the defect rather than this implementation.

One kill mutation initially appeared to SURVIVE. It had not: the anchor
`artifact-existence: NOT CHECKED` also occurs in the module's header comment, so
a first-occurrence replacement edited prose and left behaviour untouched. That
is an INERT mutation, not a vacuous pin — the two are different findings and
`instrument-discipline.md` MUST-2(b) forbids recording the first as the second.
Re-anchored on `NOT CHECKED — no producer access`, unique to the code site, it
reds.

## Scope bound

These fixtures assert the LEDGER contract. They say nothing about whether an
artifact still exists in a producing repo — that needs a cross-repo read the
gate does not have in CI, which is why the artifact-rot arm is an injected
probe and reports `NOT CHECKED` rather than passing when it is absent. Both
branches of that arm are pinned here with a stub probe; neither pin is evidence
about any real producer tree.
