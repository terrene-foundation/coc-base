# `pcf-category` audit fixtures

Fixtures for `.claude/hooks/lib/pcf-category.js` — the closed literal enum that
carries a Product-Completion-First category onto a PR (`T5`).

Run: `node .claude/audit-fixtures/pcf-category/run.mjs` (sub-second, no network,
no git, no filesystem). Registered in
`.claude/test-harness/ci-audit-fixtures.json` so the F29 closure gate runs it;
the case count is declared there as `min_cases` and self-reported by the runner
as its closing `N/N fixtures passed` line. It is deliberately NOT restated here
— this line said `27 cases` against a suite emitting 31, because nothing
reconciled the two (loom#1793).

## What the detector is, in one line

`gh pr create` carries its body as a literal argument, so at `PreToolUse:Bash`
the category is readable **offline, deterministically, before the PR exists**.
The lib parses that body and returns one of four states.

## Why a body field and not a label — the measurement

| measured 2026-08-14 | result |
| --- | --- |
| labels on the last 40 PRs | **0** carried any label |
| PCF categories among the 24 labels defined | **0** (`bug` is GitHub's stock label; `deferred-quality` is issue-triage) |
| `Category:` fields in the last 30 PR bodies | **0** (control: the matcher fires on the synthetic body `Category: BUG`) |
| PR templates in `.github/` | none — bodies use `## Section` headings, so a new field displaces nothing |

A label would put the enum in GitHub's **mutable remote registry**, readable
only over the network and only *after* the PR exists — which is neither "a
literal array in code" nor available at the moment the category could still be
added. The body field is.

## Four states, never a boolean

`categorized: false` conflates "we read the body and found no field" with "we
never read the body". Those demand opposite responses, so they are distinct
states — the same refusal `open-pr-surface.js` makes when it prints "NOT
verified this session" rather than "0 open PRs".

- `CATEGORIZED` — a marker was found and its value is in the literal enum
- `UNCATEGORIZED` — a body was read in full and carries no marker
- `INVALID` — a marker was found and its value is **not** in the enum
- `NOT_VERIFIED` — the body could not be read (substitution, unreadable file,
  `--fill`, swallowed command); never reported as clean

`classifyPrCreate` returns `null` — not a state — for a command that opens no
PR. The question does not arise, so no answer is reported.

## Coverage shape

One case per **scope-restriction predicate**, not one per clause, and **bipolar**
throughout: every predicate carries an accept pole *and* a reject pole. A set
that only ever asserts acceptance passes identically against a validator that
accepts everything — which is exactly the M5-a mutation below.

## Established RED

Each case names the mutation that reds it in `reds_under`. Both plan-mandated
mutations were RUN, each with a **reach proof** taken before the verdict was
read (`instrument-discipline.md` MUST-2b: a non-reddening mutation leaves two
live hypotheses — vacuous case *or* inert mutation).

| mutation | reach proof | reddened |
| --- | --- | --- |
| **M5-a** — `isKnownCategory()` membership → permissive `/^[A-Z0-9-]+$/` | the mutated line logged `observed: "F-G1-HIGH"` and returned `CATEGORIZED`, so the tag reached it *and was accepted* | 3 cases: `enum-rejects-derived-finding-tag`, `enum-rejects-adjacent-shapes`, `state-invalid-on-a-non-member` |
| **M5-b** — no-marker branch returns `{categorized:false}` | the mutated branch logged that it executed and returned the boolean shape with `state === undefined` | 5 cases, led by `state-uncategorized-is-its-own-state` |

## The disclosure lock

M5-a is a **regression lock, not a style preference**. A derived label — a
workspace identifier or a finding tag such as `F-G1-HIGH` — is exactly what
`upstream-issue-hygiene.md` MUST-2 denylists, and a PR body is a published
surface. A permissive pattern accepts every one of those tags. The closed enum
is the mechanism that keeps internal finding tags out of published PR bodies,
and `enum-rejects-derived-finding-tag` is the case that proves it still does.

## Stated scope, and what it excludes

Per `evidence-first-claims.md` MUST-6, the green here covers a body passed
**inline** (`--body`, `-b`, `--body=`) or via a **repo-contained `--body-file`**.
It EXCLUDES:

- a body passed as a **backtick** substitution — not treated as a substitution,
  because inline `` `code` `` spans are the common case and flagging them would
  degrade nearly every real body to `NOT_VERIFIED`. Such a body reads as
  `UNCATEGORIZED`, which nags for a category rather than passing an unread body
  as categorized.
- a body authored **interactively** or via `--fill` — reported `NOT_VERIFIED`,
  never clean.
- a **label**, deliberately: this detector makes no network call.
