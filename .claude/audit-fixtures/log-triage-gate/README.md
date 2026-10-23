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
`{"mode": "run", "min_cases": 88}` — the uid-0 count (see the coverage split below). That registry is a closure enumerated in
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
| Enumeration | in-process walk per declared root, no child process (`walkDeclaredRoot`); a declared root must be a real directory — a symlink, file or other non-directory root is NAMED as failed, and every directory is dev+ino re-checked after it is opened |
| Enumeration ceiling | 500 paths (`FILE_ENUM_CEILING`) |
| Enumeration deadline | 1500 ms for the WHOLE surface — all declared roots and the nested-checkout probe (`ENUM_BUDGET_MS`; env `COC_LOG_TRIAGE_ENUM_BUDGET_MS` may only lower it); a root that runs out, or cannot be read, is NAMED as failed |
| Files read | first 20 enumerated (`FILE_SCAN_CAP`) |
| Match set | four-arm ERE: legacy uppercase substring + anchored lowercase forms |
| Lines per file | 200 (`PER_FILE_LINE_CAP`), enforced per file, not globally |
| Scan deadline | 2500 ms across all per-file greps (`SCAN_BUDGET_MS`); a grep straddling it is SIGKILLed |
| Hook deadline | every phase, stdin wait included, clamped to `hookMain` entry + 5500 ms (`HOOK_BUDGET_MS`); 1500 + 2500 ≤ 5500, and 5500 + 1500 headroom = the 7 s dispatcher timeout |
| Attribution | each match is attributed to the file the hook opened (`grep -hn`, filename from the loop), never parsed out of grep's output |
| Rendering | C0 (except TAB), DEL and C1 bytes in filenames and content rendered as literal `\xHH` |
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
| `34/35-a-failed-enumeration-is-reported` | The same conflation one stage earlier: an enumeration that ran out of budget reported as "no logs found", and the failing root not NAMED. `35` is its negative arm. |
| `34b-an-unreadable-declared-root-is-named-as-failed` | An existing declared root that cannot be read reading as a clean, empty root. Measured on the pre-fix hook: `msg=""`, total silence. Prints `NOT RUN` where mode 000 does not deny the reader (uid 0). |
| `34c-an-unreadable-subdirectory-is-named-and-its-siblings-still-walked` | A walk that STOPS at an unreadable subdirectory, hiding every sibling it had not reached. A preload hands the reader `locked` before all fifteen siblings, so the stop mutation reds on every run, whatever the filesystem's read order (it used to red ~15 runs in 16); the case requires the preload's reorder record. `NOT RUN` under uid 0. |
| `37-no-process-outlives-the-hook` | A child the hook starts surviving it. Drives the hook detached (its own process group) with a sleeping `find` shim first on PATH, then lists every process still in that group. |
| `38-enumeration-runs-without-any-external-tool` | The enumeration depending on PATH again (a shell or `find` route): with PATH stripped the log must still be FOUND, and only the per-file grep reported as unable to run. |
| `39a-a-symlinked-declared-root-is-named-as-failed-and-not-followed` | M1: a declared root replaced by a symlink enumerating as EMPTY and reading clean (find's `-P` semantics carried over). Also pins that the link is not followed and that the top-level log still surfaces. |
| `39b-a-dangling-symlink-declared-root-is-named-as-failed` | M1: a dangling-symlink root skipped as declared-missing because `fs.existsSync` follows links. |
| `39c-a-session-cwd-reached-through-a-symlink-is-walked-not-refused` | The other pole of 39a: the session directory reached through a symlink is the SUBJECT, resolved once (realpath), not a declared root to refuse. Pre-fix it enumerated `.` as empty; without the realpath, 39a's rule would name `.` failed on every such session. |
| `40-a-root-swapped-for-a-symlink-mid-walk-is-failed-not-followed` | L1: the dir→symlink swap between the classifying lstat and the opendir. A preload performs the swap at the open; the walk must fail the root and never report the link target's log. |
| `41a-a-colon-bearing-filename-is-attributed-to-the-file-opened` | L2: a `grep -H` re-parse attributing `decoy:1:forged.log` to a file called `decoy` with forged content. |
| `41b-a-newline-bearing-filename-forges-no-second-entry` | L2 + L4: a newline in a filename splitting one finding into two, one attributed to a file that does not exist. |
| `42-terminal-control-bytes-are-neutralised-in-filenames-and-content` | L4: OSC/CSI/SGR escapes, DEL and the 8-bit C1 CSI reaching the operator's terminal raw, from a filename or from log content. |
| `43a-source-pin-budget-constants-and-clamp-text-fit-the-registered-dispatcher-timeout` | L3, a SOURCE-TEXT PIN (not a behavioural witness): the budget constants drifting from the timeout registered for the row in BOTH `dispatch-registry.json` and `hook-registry.json`, or the TEXT of a phase deadline's clamp to the hook deadline disappearing. Lexical — an edit keeping the clamp text but bypassing it passes here; 43b is the behavioural witness. |
| `43b-the-worst-case-run-exits-inside-the-dispatcher-timeout` | L3, measured, and the behavioural witness of the hook-deadline clamp: stdin 4.5 s late (the delay at which the ONE hook deadline is what bounds the run — head ≈ 5.6 s, a clamp-dropping mutant ≈ 8.5 s; at 3 s that mutant redded by only ~19 ms), every directory entry 100 ms slow, all four roots populated, a grep that never returns — the hook must still exit inside 7 s with `continue: true` (old bytes: ~10.5 s). |
| `44a-a-log-swapped-for-a-symlink-at-read-time-is-never-read` | MED-1: grep handed the PATH and following a symlink swapped in after the walk classified the entry — an outside file's bytes reported as this session's finding. A preload swaps at the first open-or-grep naming the victim; a placeholder secret must not appear, the file must be disclosed unreadable, the sibling's finding must still surface. |
| `44b-a-log-swapped-for-a-hard-link-at-read-time-is-never-read` | MED-1: the same with a HARD LINK to the outside file — no symlink anywhere, so only the descriptor's dev+ino against the walk's lstat can refuse it. |
| `44c-an-ancestor-directory-swapped-before-the-read-is-never-followed` | MED-1, the ancestor residual: the victim's PARENT swapped for a symlink at the walk's own lstat of the victim, so fd-vs-lstat identity agrees; only the re-verified directory chain (before and after the open) can refuse it. |
| `44d-a-log-swapped-for-a-fifo-is-refused-without-blocking` | MED-1 liveness: an entry swapped for a FIFO must be opened O_NONBLOCK and refused, not block the hook's only thread until the dispatcher kills it. Passes on the pre-fix bytes (grep, not the hook, blocked there and was killed); it is the witness for O_NONBLOCK. |
| `44e-a-swap-after-the-open-cannot-change-what-grep-reads` | MED-1: the swap lands at the grep SPAWN, after the hook bound the victim — grep must read the bound descriptor (the victim's own bytes, nothing unreadable), never re-open a path. |
| `45-post-grep-work-per-line-is-bounded-independent-of-line-length` | LOW-2: the neutraliser run over each WHOLE matched line before the 120-char cut — 150 lines of `ERROR` + 40 kB of control bytes handed it 6,001,876 characters on the pre-fix bytes (vs 18,000 after), seconds of post-grep work past the scan deadline. A preload meters every call. |
| `46-a-separator-bearing-filename-cannot-forge-another-files-attribution` | LOW-3: a log named `a.log: FATAL db corrupted, run reset; z.log` rendering as sibling `a.log` reporting a FATAL. The attribution must parse back to the file opened (quoted form), and an ordinary name must still render bare. |
| `47-crlf-lines-collapse-and-render-without-line-number-or-cr` | CRLF: `/^\d+:(.*)$/` failing on a trailing `\r`, so the grep line number leaked into the text and the dedupe key — three identical CRLF lines reported as three entries. |
| `48-a-term-ignoring-grep-is-killed-at-the-scan-deadline` | L3d: grep's killSignal weakened from SIGKILL to SIGTERM. A TERM-ignoring shim makes the difference observable (43b's shim dies on either signal). |
| `49-the-enum-budget-override-cannot-raise-the-budget` | L3e: `COC_LOG_TRIAGE_ENUM_BUDGET_MS` RAISING the enumeration budget (34 pins only the lowering pole, "0"). Override 60000 on a slowed walk: clamped ≈ 1.5 s, unclamped ≈ 5.5 s. |
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

### Round 4 — the orphaned enumeration

The enumeration was a `find … | head -N` shell pipeline under
`execSync(cmd, { timeout: 1500 })`. On expiry Node kills only `sh`; `find`
and `head` are re-parented to init and keep running. On the host that leaked
5-12 `find`s at a time, each walking a 2.37M-file `.evidence` tree for ~100 s.
It is now an in-process walk (and `.evidence` is pruned).

Measured on fixture-37 against three hooks, same runner bytes, same host:

| Hook | fixture-37 | find shim calls | Left in the hook's group |
| --- | --- | --- | --- |
| pre-fix bytes (`bfcf04a9…`) | RED | 2 | `sleep 20` + `head -500`, once per existing root |
| fix | GREEN | 0 | nothing |
| O1 fix with the shell pipeline restored in a copy | RED | 2 | the same four |

The shim-call count is the reach proof: it shows the mutated line ran. O1 also
reds 34, 34b, 34c and 38 — the pipeline ignores the budget, masks an unreadable root
behind `head`'s exit status, and needs PATH.

O2, the in-process walk with stop-on-unreadable restored (`!outOfTime` →
`!failed`), reds exactly 34c. When this was first measured it found 8 of 15
siblings on the measuring host, i.e. the red depended on read order; 34c is
now deterministic (see Round 5).

### Round 5 — the fix-up lane (M1, L1, L2, L3, L4, 34c)

Every new case was first run against the PRE-fix hook bytes (`0dc73fc33`) with
the new runner: all nine new cases red there, and 73/73 green on the fix. Each mutation below was applied to a COPY of the fixed tree, with a
marker proving the mutated line ran (the unmutated control run recorded no
marker); each red-set below is the complete list of failing cases.

| Mutation | Fixtures that went RED |
| --- | --- |
| P1 non-directory root reported not-failed | 39a, 39b |
| P7 cwd realpath removed | 39c |
| P2 post-open dev+ino re-check disabled | 40 |
| P3 `-H` re-parse attribution restored | 41a, 41b |
| P4 `inert()` made the identity | 41b, 42 |
| P5 enumeration deadline re-armed per root | 43b |
| P6 scan deadline unclamped from the hook deadline | 43a, and 43b at 7018 ms — a marginal red. Round 6 moved 43b's stdin to 4.5 s, so the same class of mutant now reds 43b by ~1.5 s; 43a is relabelled a source-text pin |
| O2 stop-on-unreadable, re-run | 34c, in 3 of 3 runs |

### Round 6 — fix-up 2 (MED-1, LOW-2, LOW-3, CRLF, L3d, L3e, 43b strength)

The ten new cases (44a-e, 45, 46, 47, 48, 49) were first run against the
PRE-fix hook bytes (`062af40f3`) with the new runner: 44a, 44b, 44c, 45, 46
and 47 red (44a/b/c printed the placeholder secret as a finding of
`logs/victim.log`; 45 metered 6,001,876 characters; 46 rendered the forged
attribution; 47 reported 3 entries with `1:`/`2:`/`3:` prefixes), as did
the re-pinned 41b. 44d, 48 and 49 pass on the pre-fix bytes by design — they
pin behaviours that already held (or held by accident) and are witnessed by
mutation instead. On the fix: 83/83 on Linux and darwin. Each mutation below
ran in a COPY of the fixed tree, with a marker appending to a reach file every
time the mutated code executed (reach counts recorded per run); each red-set
is the complete list of failing cases.

| Mutation | Fixtures that went RED |
| --- | --- |
| Q1 drop the fd dev+ino comparison | 44b |
| Q2 drop O_NOFOLLOW | none — absorbed by Q1's check (a followed link opens another inode) |
| Q1+Q2 | 44a, 44b |
| Q3 drop O_NONBLOCK | 44d (the open blocks; the case times out) |
| Q4a drop the pre-open chain check | none — absorbed by the post-open check |
| Q4b drop the post-open chain check | none — absorbed by the pre-open check |
| Q4a+Q4b | 44c |
| Q5 grep handed the path again | 44e |
| Q6 neutralise the whole line before the cut | 45 |
| Q7 render every path bare | 41b, 46 |
| Q8 drop the explicit `\r` strip | none — absorbed by the trailing trim |
| Q8 + drop the trailing trim | 47 |
| Q9 line-number prefix never recognised | 07, 08, 09, 41a, 41b, 46, 47 |
| Q10 `triageLogs(cwd, Infinity)` (clamp text kept) | 43b at ~8.5 s |
| Q11 grep killSignal SIGTERM | 48 at ~12 s |
| Q12 enum-budget override may raise the budget | 49 at ~5.6 s |

The racing form of the MED-1 attack (a helper swapping `logs/x.log` between a
regular file and a symlink to an outside placeholder, as fast as it can) is not
committed — it is non-deterministic by nature, which is why 44a-e exist — but
its result is recorded: over 100 hook runs per side, the pre-fix bytes leaked
the placeholder 21/100 (Linux) and 23/100 (darwin); the fix leaked 0/100 on
both, disclosing the swapped file as unreadable instead.

### Round 7 — binary bytes, hard links, whitespace windows, invisible content (HIGH-1, MED-2, LOW, LOW)

The seven new cases (50a, 50b, 51a, 51b, 51c, 52, 53) were run against the
PRE-fix hook bytes (`69ce59728`) with the new runner: all seven red there,
on Linux (GNU grep 3.11) and darwin (BSD grep 2.6.0-FreeBSD) alike, and 90/90
green on the fix on both. What each red showed on the pre-fix bytes: 50a — the
NUL-bearing log's two failures were missing (GNU: read clean; BSD: one row
reading `Binary file (standard input) matches`); 50b — an empty message, a
clean session; 51a — the outside placeholder printed as a finding of
`logs/planted.log`; 51b/51c — the victim read with nothing disclosed; 52 —
`b.log` (3000 NO-BREAK SPACEs before the match) rendered as an empty row and
`c.log` kept its trailing spaces; 53 — U+2028 and U+202E delivered raw. Each
mutation below was applied to a COPY of the fixed tree by literal string
replacement whose anchor had to match exactly once (a non-matching anchor
aborts the build); each red-set is the complete list of failing cases, and is
the same on Linux and darwin.

| Mutation | Fixtures that went RED |
| --- | --- |
| R1 drop `-a` | 50a |
| R2 drop the exit-0-but-no-line guard | 50b |
| R1+R2 | 50a, 50b |
| R3 drop the walk's link-count refusal | 51c |
| R4 drop the descriptor's link-count check | 51b |
| R3+R4 | 51a, 51b, 51c — 51a is absorbed by EITHER check alone |
| R5 drop the byte-level leading-whitespace skip | 52 |
| R6 drop the byte-level trailing-whitespace skip | 52 |
| R7 content neutralised by `inert` only (no format-character escape) | 53 |

R6 also takes over from the old trailing `trimEnd` as what absorbs Q8 (the
explicit `\r` strip): a CR is whitespace to the byte-level skip as it was to
`trimEnd`.

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

**`.claude/test-harness/tests/log-triage-gate.test.mjs`** (pre-existing, 5
cases, registered in `ci-suites.json`) — covers the `EXCLUDED_FILES` /
`.journal-skipped.log` audit-log exclusion (`observability.md` Rule 5a) and
**only** that: the audit log is not surfaced, a genuine runtime log in the same
directory still is, and `EXCLUDED_FILES` is actually wired into the
enumeration's `*.log` predicate rather than defined-but-unused. It also pins,
from the source side, that the hook runs no shell.

**This suite** (90 cases, 88 where uid 0 cannot run 34b/34c, registered in `ci-audit-fixtures.json` with `min_cases` 88 — the uid-0 count: dropping the seven Round-7 cases leaves 83 non-root / 81 uid-0 rows, both under 88, so that drop reds on every host; a floor is a DROP detector, and on a non-root host it has a two-row cushion (34b/34c), so dropping one or two cases reds only under uid 0) — covers
everything else: the 120-minute window and its boundary, the match set across
twelve real log formats and its prose anti-flood pole, all six arms of the
dedup (three collapse, three precision), the display cap, its overflow tail and
its round-robin fairness, both scan caps and the disclosure of each, the
`EXCLUDED_DIRS` and nested-checkout prunes, scope (`*.log` only), line
truncation, four degenerate-input paths, declared-root integrity (symlinked, dangling and swapped roots), read-time binding of each log to the file the walk classified (symlink, hard-link, FIFO and ancestor swaps), refusal of multiply-linked logs, binary-byte logs read as text and a silent match read as unreadable, bounded post-grep work, whitespace runs longer than the decode window, unforgeable attribution, CRLF logs, match attribution, terminal-control and invisible-format-character neutralisation, and the time bound under the dispatcher timeout (including SIGKILL and the enum-budget clamp).

Neither subsumes the other. The Rule 5a case is **not** duplicated here —
re-testing it would add cases without adding discrimination, and `min_cases`
is a floor that rewards neither.
