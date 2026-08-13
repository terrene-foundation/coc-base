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
`{"mode": "run", "min_cases": 29}`. That registry is a closure enumerated in
**both** directions — an unregistered `run.mjs` fails the build as
`UNREGISTERED runner`, a row with no file fails as `STALE registry entry`
(`audit-fixture-runner-closure.test.mjs`). `min_cases` is an anti-vacuity FLOOR
taken from an actual run, not from reading the source.

## Ground truth, pinned to a ref

Every behaviour below was **measured** against the hook at
`f4091e3547b1798087317c3f662352a8a89b3c05` (`origin/main`), not read off its
header comment. Line numbers cite that ref.

| Property | Where | Behaviour |
| --- | --- | --- |
| Scan window | 211 | `-mmin -120` on `*.log` |
| Match set | 212 | `grep -HnE 'WARN|ERROR|FAIL'` — case **sensitive** |
| Dedup key | 237–242 | `file + "::" + normalized(line)` |
| Normalizers | 240–242 | ISO-8601 ts → `<ts>`; `0x`-prefixed hex → `<hex>`; `\b\d{4,}\b` → `<num>` |
| Display cap | 117, 124–128 | 10 rendered + `… and N more unique entries` |

## Divergences from the hook's own header comment

The header (lines 8–15) describes the scan but omits three things the fixtures
pin, because a reader trusting the comment would draw wrong conclusions.

### 1. The count UNDER-REPORTS — it is wrong, not merely truncated

`head -20` on files (212) and `head -200` on grep lines (213) sit **upstream**
of the dedup, so both the headline and the `… and N more unique entries` tail
report the truncated number as though it were the total. Measured:

| Scenario | True distinct findings | Headline says | Tail says | Tail should say |
| --- | --- | --- | --- | --- |
| 25 files × 1 finding | 25 | **20** | `and 10 more` | `and 15 more` |
| 1 file × 250 distinct | 250 | **200** | `and 190 more` | `and 240 more` |
| 1 file × 250 identical | 1 | 1 ✓ | (none) ✓ | — |
| 400-line spam + 5 real | 405 | **200** | `and 190 more` | `and 395 more` |

The third row is the case the caps were designed for and they handle it
correctly — the dedup absorbs the repetition. The failure is confined to
**high-cardinality** input.

**The fourth row is the severe one.** A benign 400-line heartbeat log both
evades the dedup (its `tick 0…399` counters are 1–3 digits, below the
`\b\d{4,}\b` normalizer's threshold) **and** exhausts the entire 200-line grep
budget — so a sibling file's five genuine `ERROR`s never reach the dedup at all.
On this platform the real failures were masked completely in **5 of 5 runs**.
Which findings get evicted depends on `find` traversal order and is therefore
recorded here rather than asserted in `fixture-26`, which pins only the
order-independent budget exhaustion.

→ `fixture-23`, `fixture-24a/24b`, `fixture-25`, `fixture-26`.

### 2. The match is case-sensitive — most real log formats are invisible

`grep -HnE` carries no `-i`. Because the match is a substring, uppercase
variants with suffixes (`WARNING`, `FAILED`, `FAILURE`) do match. Lowercase
formats do not. Measured against real formats, one per file:

| | Format | Sample line |
| --- | --- | --- |
| MATCHED | `python-logging` | `... ERROR root: db connection failed` |
| MATCHED | `python-warning` | `... WARNING root: retry budget low` |
| MATCHED | `pytest` | `FAILED tests/test_db.py::test_connect` |
| MATCHED | uppercase `FAILURE` | `FAILURE: migration step 3 did not complete` |
| **BLIND** | Go `slog` | `level=error msg="db connection failed"` |
| **BLIND** | `pino` JSON | `{"level":"error",...}` |
| **BLIND** | `bunyan` JSON | `{"level":"warn",...}` |
| **BLIND** | Rails | `[...] error -- : db connection failed` |
| **BLIND** | docker-compose | `web_1  \| error: connection refused` |
| **BLIND** | npm | `npm ERR! code ELIFECYCLE` |
| **BLIND** | cargo | `error[E0308]: mismatched types` |
| **BLIND** | systemd | `Failed to start service` |

8 of 12 are silently invisible, including `npm ERR!` and `cargo error[E0308]`.
A Node, Rust, Go, or Ruby project's logs largely do not reach this gate.
→ `fixture-04`.

### 3. "Advisory" does not mean "always exit 0"

Malformed stdin exits **1** while still emitting `{"continue": true}` (53).
Self-consistent with the file's own Exit Codes block (17–20), but not with a
plain reading of "non-blocking by design". → `fixture-21`.

### These are pinned, not fixed

The fixtures encode **current** behaviour. A fixture asserting what the hook
*should* do would red immediately and misrepresent this change as a regression.
`fixture-25` in particular is the one that reds if the count is ever made
accurate — which is the correct signal for a deliberate fix rather than silent
drift. The defects are filed separately.

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
| `23-file-scan-caps-at-20` | The undocumented `head -20` cap moving, and documents that the count is a floor. |
| `24a/24b-line-scan-caps-at-200` | The undocumented `head -200` cap moving, and pins that the overflow tail inherits the truncated number rather than the true remainder. |
| `25-file-cap-truncates-the-tail-too` | The tail being *wrong* (says 10, true 15), not merely truncated. Reds if the count is ever made accurate — the deliberate-fix signal. |
| `26-high-cardinality-log-consumes-the-budget` | A spammy low-cardinality-counter log exhausting the 200-line budget and starving sibling files. Asserts only the order-independent half. |

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

**This suite** (33 cases, registered in `ci-audit-fixtures.json`) — covers
everything else: the 120-minute window and its boundary, the match set and its
case sensitivity, all six arms of the dedup (three collapse, three precision),
the display cap and its overflow tail, both undocumented upstream caps, the
`EXCLUDED_DIRS` and nested-checkout prunes, scope (`*.log` only), line
truncation, and four degenerate-input paths.

Neither subsumes the other. The Rule 5a case is **not** duplicated here —
re-testing it would add cases without adding discrimination, and `min_cases`
is a floor that rewards neither.
