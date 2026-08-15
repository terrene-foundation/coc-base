# `log-triage-gate` audit fixtures

Structural fixtures for `.claude/hooks/log-triage-gate.js` — the Stop-event WARN+
log triage scanner backing `observability.md` MUST Rule 5.

Landed in arrears of `cc-artifacts.md` Rule 9 ("Audit Tools Ship With Committed
Test Fixtures"): the hook shipped with no fixture set at all.

## Layout

Single-runner (`run.mjs`), the variant Rule 9 permits and the shape
`stop-transcript-read/` already uses for the sibling Stop hook. Chosen over
per-case sidecars because every case needs a real on-disk log tree with
controlled **mtimes** — the `-mmin -120` predicate cannot be exercised by a
static input file.

```bash
node .claude/audit-fixtures/log-triage-gate/run.mjs   # exit 0 = all pass
```

Registered in `.claude/test-harness/ci-audit-fixtures.json` as
`{"mode": "run", "min_cases": 59}`. That registry is a closure enumerated in
**both** directions — an unregistered `run.mjs` fails the build as
`UNREGISTERED runner`, a row with no file fails as `STALE registry entry`
(`audit-fixture-runner-closure.test.mjs`). `min_cases` is an anti-vacuity FLOOR
taken from an actual run, not from reading the source.

## Ground truth, measured

Every behaviour below was **measured** by driving the real hook, not read off
its header comment.

| Property | Behaviour |
| --- | --- |
| Scan window | `-mmin -120` on `*.log` |
| Enumeration ceiling | `find … \| head -500` (`FILE_ENUM_CEILING`) |
| Files read | first 20 enumerated (`FILE_SCAN_CAP`) |
| Match set | four-arm ERE: legacy uppercase substring + anchored lowercase forms |
| Lines per file | 200 (`PER_FILE_LINE_CAP`), enforced per file, not globally |
| Scan deadline | 2500 ms across all per-file greps (`SCAN_BUDGET_MS`) |
| Dedup key | `file + "::" + normalized(line)` |
| Normalizers | ISO-8601 ts → `<ts>`; `0x`-prefixed hex → `<hex>`; `\b\d{4,}\b` → `<num>` |
| Display | 10 rendered **round-robin across files** + `… and N more unique entries` |
| Truncation | disclosed whenever it occurs, including on a zero-finding scan |

## The defects this suite was extended to cover

Cases 01–25 were authored against the hook at
`f4091e3547b1798087317c3f662352a8a89b3c05`, where they **pinned** three
divergences rather than fixing them. Those divergences were then filed as
loom#1661 / #1662 / #1663 and fixed; cases 26–36 pin the fixed behaviour, and
each is bipolar so that the fix cannot be undone in either direction.

Cases 32–35 cover a fourth instance of the same class that the fix surfaced on
its own error paths: a `grep` that FAILS (exit 2) is not a `grep` that matched
nothing (exit 1), and an enumeration that could not run is not an empty tree.
Both used to produce an empty result — a clean bill of health issued by a scan
that never happened.

### 1. The count was a silent FLOOR (#1661)

`head -20` on files and `head -200` on grep lines both sat **upstream** of the
dedup, so the headline and the `… and N more` tail each reported a truncated
number as though it were a total. Nothing in the output distinguished "five
clean logs" from "five logs never opened".

The caps were **not** the defect — silent caps were. The fix keeps the caps and
**discloses** them:

```
20 unique WARN+ log entries found in recent *.log files. …
TRUNCATED — the count above is a FLOOR, not a total: 5 more recent *.log
file(s) were NOT scanned (file cap 20).
```

Note what this deliberately does **not** do: it does not claim to know the true
total. With 25 files and 20 read, "25 findings" is unknowable without opening
the other five — so the honest report is the floor plus the shortfall, not an
invented total. `fixture-23`/`24`/`25` therefore still pass **unchanged**: the
reported numbers are the same numbers, and what changed is that the output now
says what they are. → `fixture-27a/27b`, `fixture-28a/28b`, `fixture-29a/29b`.

### 2. A benign log could starve a sibling's genuine errors (#1662)

`xargs -I{} grep …` ran one grep per file, sequentially, into a **single shared**
`head -200`. A 400-line heartbeat log evaded the dedup (its `tick 0…399`
counters are 1–3 digits, below the `\b\d{4,}\b` threshold) and consumed the
whole budget, so a sibling's five genuine `ERROR`s were never read. Silence
indistinguishable from clean, from entirely benign traffic.

Fixed in two places, because fixing only the first leaves the operator no better
off — measured, the errors reached the dedup and still rendered nowhere:

- **scan** — each file is grepped independently under a per-file cap, so no
  file can consume another's budget;
- **display** — the 10-line window is filled round-robin across files, so no
  file can consume the operator's view.

This also removed the flakiness the original `fixture-26` had to work around.
Its verdict used to depend on `find` traversal order, so the masking half could
only be recorded here as prose; round-robin selection makes the outcome
order-independent, so it is now **asserted**. → `fixture-26a/26b/26c`.

### 3. The matcher was blind to 8 of 12 real log formats (#1663)

`grep -HnE 'WARN|ERROR|FAIL'` carried no `-i`. Substring matching meant
`WARNING` / `FAILED` / `FAILURE` matched, but every lowercase structured format
did not — including `npm ERR!` and `cargo error[E0308]`, this repo's own
toolchain. For a Node/Rust/Go/Ruby project the gate was close to inert, and
inert *silently*.

A bare `-i` was **rejected**, for two measured reasons:

1. it widens into prose (`improved error handling`, `no errors were reported`),
   and a channel that cries wolf gets muted — restoring the exact
   silent-breakage class the hook exists to prevent;
2. it does not even work. Mutation N6 replaces the anchored arms with a plain
   case-insensitive `WARN|ERROR|FAIL` and `fixture-30-npm` **reds**: `ERR!` is
   not a case variant of `ERROR`, so the naive widening stays blind to npm
   while newly flooding on prose.

Instead the lowercase arms are **anchored to log-structural positions** — a
level field (`level=error`, `"level":"warn"`), a severity token abutting a
delimiter (`error:`, `ERR!`, `error[`, `error --`), or `failed to <verb>`. The
legacy uppercase substring arm is kept verbatim, so nothing that matched before
stops matching.

Measured after the fix: **12 of 12** formats match, **0 of 12** prose lines
match. Identical results under GNU grep 3.11, BSD grep 2.6.0-FreeBSD, and ugrep
7.5.0 — the pattern is pure POSIX ERE with no `\b`, `\d`, or PCRE construct.
→ `fixture-30` (12 cases), `fixture-04`, `fixture-31`.

### 4. "Advisory" does not mean "always exit 0" — still pinned, not changed

Malformed stdin exits **1** while still emitting `{"continue": true}`.
Self-consistent with the file's own Exit Codes block, but not with a plain
reading of "non-blocking by design". Unchanged. → `fixture-21`.

## Fixture inventory — what each one catches

Every behaviour is pinned from **both** sides. A set exercising only the FLAG
pole would pass identically against a hook that flags everything, and would
therefore be worth nothing (`instrument-discipline.md` MUST-1, MUST-3b).

| Fixture | Catches |
| --- | --- |
| `01-fresh-error-flags` | Scan wholly broken — find never matches, grep never fires, emit path drops the message. Without it every CLEAN fixture is satisfied by a no-op. |
| `02-match-set-warn-error-fail-all-flag` | A **narrowed** match set (dropping `FAIL`), which silently stops surfacing a whole severity class. |
| `03-clean-log-emits-no-message` | **The anti-vacuity arm.** A hook that flags unconditionally. |
| `04-lowercase-tokens-do-not-match` | Adding `-i`, which floods the channel with prose matches until operators mute it — restoring the silent-breakage class the hook exists to prevent. |
| `05-stale-log-outside-window-is-silent` | **The time-window discriminator.** Removal of `-mmin -120`; every historical log surfaces at every session end. |
| `06a/06b-window-boundary-119-in-121-out` | A window silently **resized** rather than removed (`-mmin -60` drops real breakage; `-mmin -1440` resurrects a day of noise). Fixture 05 alone cannot see this. |
| `07-dedup-collapses-timestamp-variants` | Removal of the `<ts>` normalizer; one retry loop fills the entire 10-entry budget. |
| `08-dedup-collapses-hex-variants` | Removal of the `<hex>` normalizer. |
| `09-dedup-collapses-large-number-variants` | Removal of the `<num>` normalizer. |
| `10-dedup-keeps-small-number-variants-distinct` | **The precision arm.** A normalizer widened to `\d+`, merging genuinely different failures ("retry 100" vs "retry 200"). Fixtures 07–09 get *more* green as the normalizer widens — only this one reds. |
| `11-dedup-keeps-same-message-in-different-files-distinct` | A key dropping the file component, hiding a fault spreading across services. |
| `12-dedup-keeps-distinct-messages-in-one-file-distinct` | A dedup collapsing on file alone — structurally unable to show a session's second distinct failure. |
| `13a/13b/13c-cap-and-true-count` | Cap removed (flooding); **and** a headline reporting the truncated 10 as the total, under-stating breakage to the operator making the end-of-session call. |
| `14-exactly-ten-emits-no-overflow-tail` | Off-by-one (`>=10` for `>10`) emitting a nonsensical "… and 0 more". |
| `15-non-log-extensions-are-not-scanned` | A widened glob (`-name '*'`) scanning source, fixtures, and this runner. |
| `16a/16b-excluded-dir-pruned-sibling-still-flags` | Prune removed (dependency noise drowns signal) **and** prune over-broad (whole scan muted). One-sided fixtures cannot tell these apart. |
| `17a/17b-nested-checkout-pruned-sibling-still-flags` | Removal of `findNestedGitCheckouts` — the documented false-positive class where a sibling repo's log surfaces as this session's finding. |
| `18-empty-log-file-is-silent` | Crash or spurious finding on a zero-byte log (the ordinary freshly-opened state). |
| `19-no-logs-at-all-is-silent` | An empty-but-present message, training operators to ignore the channel. |
| `20-empty-stdin-still-emits-protocol-json` | A parse path that throws on `""`. |
| `21a/21b-malformed-stdin` | A failure path omitting `continue` or setting it false — letting an advisory log scanner block session end. |
| `22-long-line-truncated-to-120-chars` | Removal of the slice; one stack-trace line blows out the Stop message. |
| `23-file-scan-caps-at-20` | The file cap moving, and documents that the count is a floor. |
| `24a/24b-line-scan-caps-at-200` | The per-file line cap moving, and pins that the overflow tail is computed from what was actually read. |
| `25-file-cap-truncates-the-tail-too` | The headline/tail arithmetic drifting off the scanned set. Still passes after the #1661 fix — that fix discloses the shortfall rather than inventing a total. |
| `26a-spam-log-does-not-starve-a-sibling` | The shared global budget returning, so one high-volume file again prevents a sibling from being read at all. |
| `26b-sibling-errors-are-actually-RENDERED` | The scan-layer fix alone being mistaken for the whole fix: findings that reach the count but never reach the operator's 10-line view. |
| `26c-the-per-file-cap-still-exists` | The per-file cap being removed instead of fixed — an unbounded read is a different defect, not a repair. |
| `27a/27b-file-cap-shortfall-disclosed` | Files silently dropped (27a) **and** a hook that cries "TRUNCATED" unconditionally (27b), which would tell the operator nothing. |
| `28a/28b-per-file-cap-shortfall-disclosed` | The same floor-presented-as-total failure on the per-file axis, pinned from both sides. |
| `29a-incomplete-scan-with-zero-findings-still-warns` | The silence-reads-as-clean case: >20 recent logs, nothing found in the 20 opened, five never looked at, and no message emitted. |
| `29b-a-complete-clean-scan-stays-silent` | **The anti-nag arm.** Over-correcting into a hook that comments on every clean session end, which trains operators to ignore the channel. |
| `30-format-reaches-the-gate-*` (12) | Per-format blindness, one case per real-world format. Attributable: a regression names the format it broke. |
| `31-severity-words-in-prose-do-not-match` | The lowercase arms losing their log-structural anchor — the prose flood that makes an advisory channel worth muting. Harder cases than `04` (severity word as substring or sentence subject). |
| `32/33-a-failing-grep-is-reported` | A `grep` exit 2 (error) being read as exit 1 (no match), so a broken scan reports a clean session — forever, silently. `33` is the negative arm against a hook that calls every scan unreadable. |
| `34/35-a-failed-enumeration-is-reported` | The same conflation one stage earlier: `find` unable to run reported as "no logs found". `35` is its negative arm. |
| `36-healthy-build-output-yields-only-its-one-real-warning` | An over-broad matcher arm at REALISTIC scale. 28 lines of ordinary npm/cargo/pytest/docker output carrying one genuine `npm WARN`; a widened arm shows up here as matches on "Compiling", "0 failed", "found 0 vulnerabilities". The crafted one-line cases cannot see this. |

## Discrimination is measured, not asserted

Nine mutations were applied to the hook, the suite re-run, and the hook restored
(digest verified identical to the original after each round). Each mutation reds
**exactly** its target fixtures:

| Mutation | Fixtures that went RED |
| --- | --- |
| M1 dedup removed (`return entries`) | 07, 08, 09 |
| M2 `-mmin -120` deleted | 05, 06b |
| M3 `\b\d{4,}\b` → `\b\d+\b` | 10 |
| M4 `slice(0, 10)` removed | 13a |
| M5 `grep -HnE` → `-HniE` | 04 |
| M6 dedup key drops file component | 11 |
| M7 `EXCLUDED_DIRS` prune emptied | 16a |
| M8 `findNestedGitCheckouts` returns `[]` | 17a |
| M9 `unique.length - 10` → `unique.length` | 13c |
| M10 file cap `head -20` → `head -100` | 23, 25 |
| M11 line cap `head -200` → `head -1000` | 24a, 24b, 26 |

### Round 3 — the #1661/#1662/#1663 fixes

Nine further mutations, applied by literal string replace (so an escaping miss
cannot masquerade as a vacuity verdict), each proving the file changed and
restoring a byte-identical digest afterwards:

| Mutation | Fixtures that went RED |
| --- | --- |
| N1 per-file independence removed (shared global cap restored) | 26a, 26b, 26c, 28a |
| N2 round-robin display reverted to `slice(0, 10)` | 26b |
| N3 FLOOR disclosure block removed | 26c, 27a, 28a |
| N4 zero-findings incomplete-scan warning removed | 29a |
| N5 matcher reverted to the legacy case-sensitive substring | all 8 formerly-blind `30-*` |
| N6 anchored arms replaced by a bare case-insensitive widening | 04, 31, **30-npm** |
| N7b per-file truncation neutered (`lines.length = CAP` removed) | 24a, 24b, 26a, 28a |
| N7c `cappedFiles++` accounting neutered | 26c, 28a |
| N8 disclosure made unconditional | 27b |
| N9 `FILE_SCAN_CAP` 20 → 100 | 23, 25, 27a, 29a |
| N10 failed-grep guard removed (exit 2 read as "no match") | 32 |
| N11 `enumFailed` hardwired false | 34 |
| N12 unreadable-file shortfall clause removed (detected, not disclosed) | 32 |

Two results are worth stating rather than leaving to be re-derived:

- **N7 was INERT, not a vacuity verdict.** The first attempt raised the `-m`
  argument to `999999` expecting 24a/26a/26c/28a to red. Nothing redded. That
  leaves two live hypotheses (`instrument-discipline.md` MUST-2b), and the
  wrong one is "those four fixtures are vacuous". They are not: `-m` is an
  early-exit optimisation, and the cap is actually enforced by
  `lines.length = PER_FILE_LINE_CAP` on the JS side. N7b targets that line and
  reds all four, which resolves it. Same shape as M3/M7 in round 1.
- **N6's collateral red on `30-npm` is the argument against `-i`.** A plain
  case-insensitive `WARN|ERROR|FAIL` does not match `npm ERR!` — `ERR` is not a
  case variant of `ERROR` — so the naive widening would have flooded on prose
  while *still* being blind to npm. The anchored arms match npm and stay silent
  on all twelve prose lines.

### Cross-dialect verification

The matcher runs under whatever `grep` is first on `PATH`, which is not one
program. The pattern was fired at the same 12-format and 12-prose corpora,
plus a known-answer positive and negative control, under each:

| grep | formats matched | prose matched |
| --- | --- | --- |
| GNU grep 3.11 (Linux CI) | 12 of 12 | 0 of 12 |
| BSD grep 2.6.0-FreeBSD (macOS default) | 12 of 12 | 0 of 12 |
| ugrep 7.5.0 | 12 of 12 | 0 of 12 |

`-m` is passed one file per invocation, where its meaning is identical across
implementations; the BSD/GNU divergence is only over how a cap applies *across*
files, which this code never relies on.

Two round-1 results were **not** recorded as vacuity verdicts, because a
non-reddening mutation leaves two live hypotheses — vacuous fixture *or* inert
mutation (`instrument-discipline.md` MUST-2b):

- M3 initially matched **nothing** (shell escaping), so it never reached the
  code. Re-applied via literal string replace in round 2 → fixture-10 red.
- M7 left fixture-17a green because the nested-checkout prune is a **separate
  mechanism** (`pathClauses` via `findNestedGitCheckouts`) from `EXCLUDED_DIRS`
  (`nameClauses`). M7 was inert for that fixture, not fixture-17a vacuous — M8
  targets it directly and reds it.

Similarly M4 leaves 13c green **correctly**: removing the slice does not touch
the independent overflow-tail block, which is what M9 exists to target.

## Coverage split — this suite vs. the pre-existing test file

Two things test this hook. They do **not** overlap, and the split is
deliberate; stated here so the next reader does not have to re-derive it.

**`.claude/test-harness/tests/log-triage-gate.test.mjs`** (pre-existing, 3
cases, registered in `ci-suites.json`) — covers the `EXCLUDED_FILES` /
`.journal-skipped.log` audit-log exclusion (`observability.md` Rule 5a) and
**only** that: the audit log is not surfaced, a genuine runtime log in the same
directory still is, and `EXCLUDED_FILES` is actually wired into the `find`
rather than defined-but-unused.

**This suite** (59 cases, registered in `ci-audit-fixtures.json`) — covers
everything else: the 120-minute window and its boundary, the match set across
twelve real log formats and its prose anti-flood pole, all six arms of the
dedup (three collapse, three precision), the display cap, its overflow tail and
its round-robin fairness, both scan caps and the disclosure of each, the
`EXCLUDED_DIRS` and nested-checkout prunes, scope (`*.log` only), line
truncation, and four degenerate-input paths.

Neither subsumes the other. The Rule 5a case is **not** duplicated here —
re-testing it would add cases without adding discrimination, and `min_cases`
is a floor that rewards neither.
