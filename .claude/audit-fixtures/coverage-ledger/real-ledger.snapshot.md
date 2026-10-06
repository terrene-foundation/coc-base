# s54 launch ledger — the codify-lease ratchet

`orchestration-launch-ledger.md` MUST-1: durable, on-disk, survives compaction.
Consult BEFORE any spawn (MUST-2); match BEFORE reacting to any completion (MUST-3).

Session: 2026-08-22 (s54). Operator: someoperator.
Worktree for the work: `/Users/someoperator/repos/.loom-wt/s54-ratchet` (sibling, outside the
repo per `worktree-isolation.md` Rule 7), branch `fix/s54-codify-ratchet`, cut from
`origin/main` @ `dcad0e2a`.

## Lanes

| track             | agent             | scope                                                        | branch      | status    |
| ----------------- | ----------------- | ------------------------------------------------------------ | ----------- | --------- |
| tier1-correctness | reviewer          | staleness predicate, regex capture, stale_branch paths       | (read-only) | in-flight |
| tier1-security    | security-reviewer | arg-injection in `_countUnlandedCommits`, identity confusion | (read-only) | in-flight |
| tier1-contract    | analyst           | is the fix at the right LAYER; caller contract completeness  | (read-only) | in-flight |
| tier1-artifact    | cc-architect      | validators, distribution fate, fixtures owed, prose-vs-code  | (read-only) | in-flight |

All four dispatched WITHOUT a `name` parameter, so the return path stays open on the
dispatching call (`agents.md` § Agent-Result-Delivery part 1). None was paired with the
task-return-contract instruction.

**All four LANDED.** Convergent verdict: the predicate was right, the DELIVERY was not
(`stale_branch` had zero consumers; Step 0 named a template, not `res.branch`; the suite
could not discriminate the window — a 30-day widening mutation reached the code 8× and
killed nothing; `scope-dirty` returned before the freshness check and its remedy commits
onto the stale branch). All fixed. PR #1911. Follow-ups #1912/#1913/#1914 filed.

## WAVE 2 — dispatched after the Tier-1 wave closed

Idling while CI ran was a `wave-loop.md` MUST-6 breach, operator-identified. Topped up.

| track          | agent            | worktree (SIBLING, absolute)           | branch                          | status    |
| -------------- | ---------------- | -------------------------------------- | ------------------------------- | --------- |
| 1912-surface   | general-purpose  | `.loom-wt/s54-1912`                    | `fix/s54-1912-unlanded-surface` | in-flight |
| 1914-cli-drift | cli-orchestrator | `.loom-wt/s54-1914`                    | `fix/s54-1914-cli-drift`        | in-flight |
| migration      | general-purpose  | `.loom-wt/s54-migration`               | `chore/s54-issue-migration`     | in-flight |
| 1681-land      | general-purpose  | `.loom-wt/s52-1681-traversal` (REUSED) | `fix/s52-1681-traversal`        | in-flight |
| scanners       | general-purpose  | `.loom-wt/s54-scanners`                | `docs/s54-scanner-evaluation`   | in-flight |
| 1904-draft     | cc-architect     | `.loom-wt/s54-1904`                    | `feat/s54-1904-redteam-vet`     | in-flight |

### QUOTA PAUSE → RESUMED (2026-08-22, ~03:50)

All six lanes stopped inside a ~20-second window. Every notification carried
`"idleReason":"failed","failureReason":"You've hit your weekly limit · resets Aug 25"`.
Peer sessions Q2-validator / Q4-mergedriver / Q6-distribution hit the same wall, so it was
ACCOUNT-WIDE, not lane-specific. The migration lane's own child ("Deferral inventory
enumeration") died to it too.

**NOT the throttle signal, and this distinction decided the response.** Rule 4's back-off
fires only on ≥2 deaths in a ~30–48s window carrying `Server is temporarily limiting
requests` / `(not your usage limit)`. This said _weekly limit_ — a USAGE limit, which Rule 4
explicitly excludes from concurrency back-off. Six was not the cause and fewer would not
have helped, so concurrency was NOT reduced.

**Triage BEFORE re-entry** (`worktree-isolation.md` Rule 4a(2) — resuming an agent re-enters
its tree, so the check comes first). Measured per lane, not assumed:

| lane          | branch                          | ahead | uncommitted |
| ------------- | ------------------------------- | ----- | ----------- |
| s54-1912      | `fix/s54-1912-unlanded-surface` | 0     | **0**       |
| s54-1914      | `fix/s54-1914-cli-drift`        | 0     | **0**       |
| s54-migration | `chore/s54-issue-migration`     | 0     | **0**       |
| s52-1681      | `fix/s52-1681-traversal`        | 5     | **0**       |
| s54-scanners  | `docs/s54-scanner-evaluation`   | 0     | **0**       |
| s54-1904      | `feat/s54-1904-redteam-vet`     | 1     | **0**       |

ZERO at-risk work. Every lane died during its BASELINE phase — which is what the briefs
instructed them to do first, and is why the interruption cost nothing but wall-clock.

**RESUMED BY NAME, never relaunched** (`orchestration-launch-ledger.md` MUST-4: a quota stop
is a PAUSE; the agent retains its transcript and resumes when addressed). A replacement would
have discarded six transcripts and re-paid six baselines. ONE resume per lane — the bound
`agents.md` § Agent-Result-Delivery (3) sets — so the scanners lane was spent FIRST as the
probe on whether the account swap had taken, before committing the other five.

Each resume carried: the measured state of its own tree (so no lane wonders what it lost), a
re-assert-location instruction (cwd can silently revert across an interruption), an
eager-commit directive (capacity is now the binding constraint), and an explicit CUT ORDER
naming what is not cuttable — for 1912 the pole pair, for 1914 the gate's failing pole, for
1681 the defect-still-reproduces re-confirmation, for 1904 the removed-clause table.

Status: all six `in-flight → paused(quota) → resumed`.

### WAVE 2 OUTCOMES

| lane      | status                      | receipt                                                  |
| --------- | --------------------------- | -------------------------------------------------------- |
| migration | resumed → **DELIVERED**     | 3 commits, chain INTACT **267 items** (was 26)           |
| scanners  | resumed → **DELIVERED**     | 3 commits, recommendation **NONE**, reversed on evidence |
| 1912      | resumed → **DELIVERED**     | 3 commits, 59/59 runners (was 58), 2443 cases            |
| 1904      | resumed → **DELIVERED**     | 4 commits, drafts only, no PR (Tier-1 owed)              |
| 1681      | resumed → **PR #1916 open** | 5 commits; lane report not yet delivered                 |
| 1914      | resumed → in-flight         | 4 commits pushed                                         |

**Three lanes REFUTED something I asserted, which is the value of dispatching them:**

- **1912 refuted my own issue text twice.** (a) I cited `codify-lease.js::_countUnlandedCommits`
  as a reuse site; it does not exist on `origin/main` — it is on my UNMERGED #1911 branch, so
  the citation was to an artifact that exists nowhere the lane could see. That is the
  `handoff-completion.md` MUST-2 shape committed by me, in an issue body. (b) My suggested
  discriminator (`now − oldest unlanded commit`) was MEASURED wrong: it fires on 52 of 58
  suppressed branches versus carry-span's 8 of 58, so adopting it would have deleted the age
  floor rather than repaired it — the one thing the brief called non-negotiable. The lane took
  the design latitude and found the better axis (carry SPAN, author date, threshold 1d derived
  from the motivating branch's measured 1.43-day span, not guessed).
- **scanners reversed its own recommendation** from SELECTIVE to NONE after running the
  measurement it had itself flagged as the falsifier: across three months the surface grew
  3.7× and findings 4×, while genuine findings stayed at exactly 1.
- **1904 caught a pre-existing corpus defect** (`Convergence Criteria 4–6` vs `4–7` over seven
  criteria, in both the command and the trust-posture skill) and fixed it under
  `zero-tolerance.md` Rule 1 rather than leaving it as a "pre-existing" ratchet.

### WAVE 3 — dispatched while six PRs sit in a saturated CI queue

| track          | agent           | worktree (SIBLING, absolute)  | branch                              | spawned_at             | status    |
| -------------- | --------------- | ----------------------------- | ----------------------------------- | ---------------------- | --------- |
| ledger-arm     | general-purpose | `.loom-wt/s54-ledger-arm`     | `feat/s54-coverage-ledger-arm`      | `2026-08-22T05:44:00Z` | in-flight |
| guard-perf     | general-purpose | `.loom-wt/s54-guard-perf`     | `fix/s54-sibling-porcelain-scaling` | `2026-08-22T05:52:00Z` | in-flight |
| 1904-fix-round | cc-architect    | `.loom-wt/s54-1904` (resumed) | `feat/s54-1904-redteam-vet`         | `2026-08-22T05:40:00Z` | in-flight |

#### `spawned_at` — why it is on wave 3 only, and the row-id contract

The ledger-arm lane reported, correctly, that this ledger carries **no stable row id and no
per-row timestamp**, and that `orchestration-launch-ledger.md` MUST-1 mandates only
`track → agent → branch → status` — so both are absent from the CONTRACT, not merely from this
instance. The column set is not even constant across waves (wave 1 `scope`, wave 2 `worktree`).

That breaks the ORDERING property, which is the one that defeats back-filling and therefore the
whole leverage of a ledger cross-check: with no timestamp and no commit there is nothing to
compare a round file's write against, and mtime is useless — `touch` sets it and checkout resets
it, so it reads identically whether or not back-filling happened.

**ROW ID: DERIVED from `track`, never minted.** `track` is already unique per wave and already
present. The citation token is `ledger:<track>` (e.g. `ledger:guard-perf`). Deriving costs the
ledger nothing and avoids a second identifier that can drift from the first.

**`spawned_at` IS ON WAVE 3 ONLY, DELIBERATELY.** These three I know — I dispatched them this
turn. Waves 1 and 2 are UNRECORDED and stay that way: I did not record dispatch times then, so
filling them now would be inventing the exact evidence the ordering property exists to check. A
fabricated `spawned_at` is strictly WORSE than an absent one, because absent reports UNRUNNABLE
while fabricated reports PASS.

These are minute-precision values taken from this session's turn boundaries, not second-precision
clock reads — adequate for an ordering comparison against a round file, and stated so no reader
takes more precision than they carry.

**Consequence for the checker, and it is the honest one:** on this ledger EXISTENCE and NON-REUSE
are checkable for every wave; ORDERING is checkable for wave 3 and reports UNRUNNABLE — never
PASS — for waves 1–2. That asymmetry is a true statement about the evidence, which is the point.


**ledger-arm is a DELIBERATE SPLIT, recorded because it deviates from the owner's
literal wording.** The owner chose "build the arm in this round" over the deferral I
recommended. Delivered — but on its OWN branch, not folded into `feat/s54-1904-redteam-vet`,
which already carries a rewritten command, a new command, a new skill and two probe suites.
`autonomous-execution.md` § Per-Session Capacity Budget MUST-1 says split; "this round" is
satisfied by landing in this wave. Both land together; neither blocks the other.

**The two lanes are COUPLED through exactly one surface: the citation format.** The command
lane DEFINES it (an `attacked` cell cites a ledger row id); the checker lane PARSES it. Each
brief names the other and instructs: read the format, never guess, and report a mismatch
IMMEDIATELY rather than working around it. A format mismatch is the obvious way this wave
fails, so it is written down rather than held in my head.

**guard-perf is the one live-on-main defect in this session.** `signing-mutation-guard.js`
spawns `git status --porcelain` per sibling worktree — measured 97.5% of a 4.65s replay in
`spawnSync`, ~50 × 88ms ≈ 4.4s against its own 5000ms budget — so it exceeds budget roughly
half the time, fires its fail-OPEN advisory, and SILENTLY STOPS GUARDING. Fail-open is
correct (`cc-artifacts.md` Rule 7) and the budget is NOT to be raised; the defect is the
O(N)-spawn structure reaching the timeout under ordinary conditions. It degrades as the
forest grows — today's reap took it 56 → 50, which moved the threshold, not the defect.

### PR #1910 CI RED → FIXED

`must_token 80 → 79 (-1); 10 removed line(s) … carry no declared exception`. Git auto-merged
`worktree-isolation.md` with NO conflict, and the descoping gate caught what the JSON
union-reconstruction structurally could not — a markdown net-deletion. `verification-gate-integrity.md`
MUST-4 in the wild: a gate over present subjects cannot see a removal.

Adjudicated as CONSOLIDATION, not loss, and verified before declaring: the canonical field
counts are 6/6/6 across origin/main, the codify branch and the merge; the shared guide § exists
and 6 bullets cite it; both prose destination §§ resolve (control: a fabricated § returns
ABSENT). 12 entries declared `disposition: consolidated`. Local gate now CLEAN
(`0 moved, 10 declared`), preflight 16/16.

**Two of my own instrument defects on that fix, recorded because both nearly shipped:** I wrote
the entries at the registry's TOP LEVEL instead of under `exceptions` (caught only because the
count moved 60 → 12, the wrong direction), and `json.dumps` without `ensure_ascii=False`
re-encoded every em-dash, turning a 12-entry addition into 282/182 across the whole file.
Now 120 insertions, 0 deletions.

Six concurrent. Cold-start guidance is ~3 (`worktree-isolation.md` Rule 4), but wave 1 ran
4 with no throttle signal, so 6 exceeds the evidence. Back-off trigger, and ONLY this:
≥2 lanes failing inside a ~30–48s window carrying `Server is temporarily limiting requests`
/ `(not your usage limit)`. A single death, an OOM, a timeout, or a quota error saying
"usage limit" is NOT that signal and MUST NOT trigger back-off — a quota death is a PAUSE
(resume by name), not a death (`orchestration-launch-ledger.md` MUST-4).

**1681 reuses the s52 lane's EXISTING worktree, deliberately** — `worktree-triage.mjs`
classified it PUSHED (5 ahead, nothing uncommitted at risk); a fresh tree would abandon
what it holds (`worktree-isolation.md` Rule 4a(3)).

Every brief carries: the absolute sibling path + the STEP-0 resolved-toplevel assertion
(Rule 1b), a curated minimal governance slice (`governed-throughput.md` MUST-1 — clauses
only, never the full corpus, which degrades), the incremental-commit-and-push instruction
(Rule 4a(4)), and explicit report-back. None carries a `name`, so every return path is open.

**FOREST CAPTURE BEFORE DISPATCH.** `worktree-triage.mjs` exited 3 over 56 trees:
29 SALVAGE · 13 LOST · 12 UNPUSHED · 2 PUSHED. Captured 29/29 at-risk trees (60 MB) to
`~/loom-rescue-2026-08-22-s54` — tool reported `all at-risk work is SAVED` — BEFORE any
lane could reuse or remove a tree (`worktree-isolation.md` Rule 4a(2): unstaged and
untracked-not-ignored work has NO reflog).

Delivery gate (`agents.md` § Agent-Result-Delivery part 2): a lifecycle notification is
NOT a delivery, and a status fragment announcing work to come is NOT a delivery. Each
lane's payload must STATE A RESULT. Record the transition here as
`in-flight → fragment → resumed → landed` if a fragment arrives.

## Measured before dispatch — not claims

| what                                                            | result                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| new staleness suite, fix applied                                | 8/8 pass                                                 |
| new staleness suite, pre-fix module (RED pole)                  | 2 fail / 6 pass, named AssertionErrors                   |
| full multi-operator suite, BASELINE (pre-fix)                   | 1390 tests / 1379 pass / 2 fail (the RED-pole pair only) |
| full multi-operator suite, post-fix                             | 1390 / 1381 pass / 0 fail / 9 skipped                    |
| mutation `bindsToCurrent = false`, BEFORE discrimination repair | reached code 26× · 31/31 still passed → **VACUOUS**      |
| mutation `bindsToCurrent = false`, AFTER repair                 | reached code 26× · reds tests A + E by name              |

The vacuity row is the load-bearing one: deriving the 1849b fixture dates to `TODAY` made
the minted name byte-identical to the fixture name, so the bind assertion could no longer
tell "bound" from "declined-and-minted". Caught only by mutating; fixed by giving lane-1 a
`-lane1` token and adding a `stale_branch === undefined` pole.

## Stranded-branch adjudication (the coupled item)

`codify/someoperator-2026-08-20` — **33** commits ahead, 170 behind `origin/main`. It IS the
ratchet's own output: the diagnosis and the RED-first test that motivated this fix are both
on it. Measured merge surface via `git merge-tree --write-tree` (exit 1 = conflicts;
positive control: self-merge exits 0): **3 conflicting files**, all additive registries or
notes — `.claude/test-harness/detector-distribution-baseline.json`,
`.claude/test-harness/eval-manifest.json`, `.session-notes.d/someoperator.md`.

## Traps re-confirmed this session

- The shell `grep` is a ugrep wrapper that silently skips NUL-bearing files — `/usr/bin/grep`.
- `git stash` BLOCKED: 47 worktrees share one `.git` stash stack (`worktree-isolation.md` Rule 9).
- The 3-arg `git merge-tree` + `grep -c '^<<<<<<<'` is NON-DISCRIMINATING for "do these
  conflict" — it returned 0 while three files genuinely conflict. Use
  `git merge-tree --write-tree` and read the exit code plus the named `CONFLICT` lines.
- `node --test` prints `ℹ pass`; `ℹ tests N` counts files at the top level.
- gpg-unpinned fixtures (loom#1903) flake under concurrency with
  `gpg: signing failed: Cannot allocate memory`. Pre-existing — baseline before attributing.
