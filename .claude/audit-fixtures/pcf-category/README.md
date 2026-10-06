# `pcf-category` audit fixtures

Fixtures for `.claude/hooks/lib/pcf-category.js` — the closed literal enum that
carries a Product-Completion-First category onto a PR (`T5`).

Run: `node .claude/audit-fixtures/pcf-category/run.mjs` (sub-second, no network,
no git). Since loom#1803 it touches the filesystem — but only a sandbox it
builds itself under `os.tmpdir()` and removes on exit; it still reads nothing
about this machine or this checkout, so the "cannot pass by accident of what is
on disk" property is preserved by a different mechanism. See § The cause
taxonomy. Registered in
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
| **M-1803a** — `verdict()` reports one constant cause for every situation | the constant `MUTANT_ONE_CAUSE_FOR_ALL` appears verbatim in the failure diffs, so the mutated line executed | **5** fixture cases + 3 suite tests, led by `every-refusal-names-a-cause-none-is-anonymous` |
| **M-1803b** — `NOT_VERIFIED` remedy reverted to the pre-#1803 "re-issue the command" line | the marker `MUTANT-B` appears in the failure diff | **1** fixture case + 2 suite tests: `remediation-never-advises-a-second-pr-create-on-not-verified` |
| **M-1803c** — SCRAMBLE: cyclic permutation of `MARKER_ABSENT` → `VALUE_NOT_IN_ENUM` → `VALUE_EMPTY` → `MARKERS_CONFLICT` → `BODY_TEXT_MISSING` → `COMMAND_UNRESOLVABLE` at their five assignment sites | each of the six situations was queried on the mutant BEFORE any verdict was read and reported a different code than unmutated (e.g. a body with no marker reported `VALUE_NOT_IN_ENUM`) | **1** fixture case — `every-cause-code-is-pinned-to-its-own-situation` — whose diff NAMES each mis-assigned code. A single-code variant (only `MARKER_ABSENT` → `VALUE_EMPTY`) reds it too, so the lock is not merely sensitive to a bulk rewrite. **Before this case existed the same scramble scored 50/50 fixtures and 24/24 suite GREEN.** |
| **M-1803d** — reintroduce the first-cut LEXICAL out-of-root check ahead of `realpathSync` | on a symlinked root the mutated branch returned `BODY_FILE_OUTSIDE_ROOT` for a readable in-root file | **1** fixture case under a canonical tmpdir (11 under macOS default) — `a-symlinked-root-prefix-does-not-make-an-in-root-file-unreadable`. **Before this fix it reddened NOTHING under `TMPDIR=/private/tmp`.** See § The first cut was wrong. |

## The cause taxonomy (loom#1803)

The four states answer WHAT the guard concluded. Until 2026-08-19 nothing
answered WHY — `NOT_VERIFIED` collapsed eight structurally different situations
onto one sentence, and three separate sessions each re-diagnosed the same
refusal from scratch, two of them landing on a cause that was later refuted on
the issue itself. Every verdict now carries `cause` (a stable code), `source`
(inline / file / derived / absent / command) and `detail` (the path tried, the
ROOT it was resolved against, the errno, the offending token and its line).

**The membership rule for the taxonomy is ONE CODE PER DISTINCT FIX.** Outside
the root → move the file or open the PR from that root. Written by an earlier
segment of the same command line → split the write into its own tool call.
Carries `$(` → reword it. Nothing links those three remedies, so a message that
cannot tell them apart sends every operator down the first one.

| cause | situation | fix |
| --- | --- | --- |
| `BODY_FILE_OUTSIDE_ROOT` | the path resolves outside the root the hook reads against (a linked worktree is outside the main checkout — **relative vs absolute is not the axis**) | move the file, or open the PR from that root |
| `BODY_FILE_ESCAPES_CONTAINMENT` | in-root path, symlink target outside | pass the real in-root path |
| `BODY_FILE_MISSING` | nothing there at guard time | check the path |
| `BODY_FILE_WRITTEN_BY_THIS_COMMAND` | the same command line writes it, and this guard is **PreToolUse** | split the write into its own tool call |
| `BODY_FILE_UNREADABLE` | EACCES / EPERM / ELOOP / ENOTDIR | fix permissions, or write it elsewhere |
| `BODY_FILE_NOT_A_FILE` / `BODY_FILE_TOO_LARGE` / `BODY_FILE_PATH_EMPTY` | directory-or-device / over the cap / no path given | point at the file / shorten / give a path |
| `ROOT_UNRESOLVABLE` | the containment root itself will not resolve | environment fault, not a body fault |
| `BODY_SUBSTITUTION` | `$(` or `${` in the body, with token + line reported | reword, or use a `--body-file` |
| `COMMAND_UNRESOLVABLE` / `BODY_DERIVED` / `BODY_ABSENT` | substitution swallowed the invocation / `--fill` / no body flag | spell it out / pass a body explicitly |
| `MARKER_ABSENT` | **the only code that is a statement about the PR** — the body was read and has no field | add the field |

**The fail direction did not move**, and `naming-a-cause-never-changes-the-verdict`
is the case that locks it: ten unreadable situations, all still `NOT_VERIFIED`.
Paired with `the-must-not-flag-case-…`, which is the MUST-4 must-NOT-flag pole —
a readable in-root body with a valid category draws no advisory at all. Without
that pole the ten greens would be satisfied by a guard that refuses everything.

**The remedy changed, and that is the part that was doing damage.** The old
advice — "re-issue the command with the field in the body" — was written for
`UNCATEGORIZED` and then applied to `NOT_VERIFIED` too, where the body was never
read and the published PR body is often already correct. Following it opens a
DUPLICATE PR. `NOT_VERIFIED` now sends the reader to `gh pr view <n> --json
body` instead, and `remediation-never-advises-a-second-pr-create-on-not-verified`
pins it.

### A cause is an IDENTITY, and identity is what the set asserts

`instrument-bipolarity.md` MUST-2: the RED pole must name a failure **identity**,
not merely a state. The first cut of this set asserted only `state` for six of
the twenty codes — `MARKER_ABSENT`, `VALUE_NOT_IN_ENUM`, `VALUE_EMPTY`,
`MARKERS_CONFLICT`, `BODY_TEXT_MISSING`, `COMMAND_UNRESOLVABLE` — so a
permutation of those six shipped **50/50 fixtures and 24/24 suite green**. That
is worse than the anonymous refusal the taxonomy replaced: a refusal naming the
WRONG cause routes the operator to a remedy for a fault they do not have, which
is the wasted-diagnosis cost loom#1803 exists to end.

The class is closed, not the six instances. `CAUSE_IDENTITY_TABLE` in `run.mjs`
carries **one situation per code**, driven through the public verdict surface and
pinned to a **literal** `STATE/CAUSE` string. Three cases consume it:

| case | what it makes impossible |
| --- | --- |
| `every-cause-code-is-pinned-to-its-own-situation` | any mis-assignment at a call site; the diff names the mis-assigned code |
| `the-identity-table-covers-the-whole-enum-and-nothing-else` | a 21st cause shipping with no situation — the table's code set must EQUAL `PCF_CAUSES` |
| `cause-taxonomy-is-a-frozen-identity-map` | two keys aliased onto one value, which would make two different fixes indistinguishable in the advisory |

Expectations are **literal strings, never `PCF_CAUSES.X`**, so a scramble of the
taxonomy's own values reds as well; and the completeness case counts against a
literal `20` rather than `Object.keys(PCF_CAUSES).length`, which would agree with
the subject by construction (`evidence-first-claims.md` MUST-5, self-derived
oracle).

**Scoped honestly:** this closes the gap in the FIXTURE set, which is the
instrument registered in `ci-audit-fixtures.json`. The sibling
`.claude/test-harness/tests/pcf-category.test.mjs` was measured on the same
scramble and stayed 24/24 green; it is unchanged here and remains blind to a
cause permutation. The fixture set is the designated instrument for this
predicate, so that blindness is recorded rather than left to be rediscovered.

### The first cut was wrong, and the fixtures caught it

The first version put a **lexical** out-of-root rejection ahead of
`realpathSync`, on the reasoning that refusing earlier could only narrow. It did
not. On macOS the sandbox root canonicalizes `/var/folders/…` →
`/private/var/folders/…`, so an in-root file handed in under the `/var` spelling
compared as OUTSIDE a root spelled `/private/var` — **9 fixtures red on the
first run, every one reporting `BODY_FILE_OUTSIDE_ROOT` for something that was
not that.** A symlinked path PREFIX is precisely what a lexical comparison
cannot see, which is why `security.md` § Path Containment says to resolve both
sides through the same resolver.

`a-symlinked-root-prefix-does-not-make-an-in-root-file-unreadable` is the lock —
**and its first cut was inert on the platform CI runs on.** It derived its root
from `os.tmpdir()`, so the difference between the given and canonical spellings
came from the HOST, not from the fixture: on macOS default TMPDIR it existed
(`/var/…` → `/private/var/…`) and the lock fired, but under a canonical tmpdir
the same reintroduced bug shipped the whole set GREEN. Measured on the
reintroduced lexical check, one tree, two environments:

| root spelling supplied by | reintroduced lexical bug scores |
| --- | --- |
| `TMPDIR` default (macOS, non-canonical) | 40/50 — lock fires |
| `TMPDIR=/private/tmp` (canonical) | **50/50 — lock inert** |

The fixture runner executes on a Linux self-hosted runner, where tmpdir is
normally already canonical, so the lock was probably inert exactly where it was
being relied on. It now builds its own `LINK_ROOT` — a symlink whose basename
(`link-root`) differs from its target's (`root`) — so the given and canonical
spellings differ **by construction on every platform**, and `prefixesDiffer` is
**asserted in the `expect` block** rather than merely recorded, so the case REDS
if that ever stops holding instead of silently degrading to the trivial half.
Re-measured after the fix: the same lexical bug reds under BOTH environments
(42/53 default, 52/53 canonical), and in the canonical run the single failing
case is this one, with `symlinkedRootSpelling: NOT_VERIFIED` while
`tmpdirRootSpelling` stayed `CATEGORIZED` — the tmpdir half demonstrably being
the inert one. The claim "permanent lock" is now true; before this change it was
not.

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
- **real `EACCES`**, in the fixture set: a `chmod 000` file is a no-op under
  root, which is how a container CI often runs, and a case that silently inverts
  its meaning by privilege is worse than no case. The same
  `BODY_FILE_UNREADABLE` branch is reached deterministically and unprivileged by
  `ELOOP` (self-referential symlink) and `ENOTDIR` (parent component is a
  regular file), both of which ARE covered. Real `EACCES` was exercised by hand
  at landing and reported there — the guard printed
  `cause BODY_FILE_UNREADABLE … could not be read: EACCES`.

## Known residual, NOT fixed here

A `--body-file` whose contents contain `$(` or `${` is still refused as
`BODY_SUBSTITUTION`. For a FILE source that rationale does not hold — `gh` reads
the same bytes off the same disk, so the text is not at risk of non-transmission
— and the refusal is arguably a false positive. It is deliberately **left
unchanged**: loom#1803 is a diagnostics issue, and softening a refusal is
outside its envelope. What did change is that the message now says the body is a
FILE rather than asserting a transmission risk that would not be true.
