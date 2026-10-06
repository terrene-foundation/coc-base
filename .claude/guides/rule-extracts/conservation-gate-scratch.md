# conservation-gate MUST-5 (scratch) — depth companion

Depth for `.claude/rules/conservation-gate.md` § MUST-5 "Scratch Is Asked For, Never The Only Copy".
That clause carries the tripwire; this file carries the probe transcripts, the macOS purge
mechanisms, the sandbox carve-out in full, and the extended DO/DO-NOT blocks. Nothing here states a
NEW obligation — every clause below restates or evidences a sentence of MUST-5.

**Folded 2026-10-03.** Until then these obligations were a standalone baseline rule,
`scratch-path-discipline` (origin `journal/0631`) — file RETIRED by this fold into
`.claude/rules/conservation-gate.md` MUST-5, so its name is deliberately NOT written as a
path-shaped token here (a dangling backtick path reds the xref gates) — with five one-line clauses. The operator
folded it into `conservation-gate.md` — a temp-root purge is a boundary that removes content with no
after-set — to retire one rule against the 105-rule ceiling and to shrink the emitted baseline. The
sections below keep the OLD clause numbers, because they are the historical record; read them through
this map:

| old clause (scratch-path-discipline.md) | carried by conservation-gate.md MUST-5 |
| --- | --- |
| MUST-1 The Yardstick — root is `os.tmpdir()`, never a spelled `/tmp/<name>` | "ASKED for (`mktemp -d`, under `os.tmpdir()`), never hand-spelled, `/tmp/<name>` included" |
| MUST-2 The Reboot Clause — loss would matter ⇒ not only under a temp root | "Anything whose loss would matter MUST NOT live only under a temp root" |
| MUST-3 Per-Session Scratch — ASKED for (`mktemp -d`), hand-writing a root BLOCKED | "Scratch MUST be ASKED for (`mktemp -d` …), never hand-spelled" |
| MUST-4 The Lightest Adequate Copy — outlives the session ⇒ declared-gitignored path, never loose in the tracked tree | "scratch that must outlive the session MUST go in a repo-declared gitignored path, never loose in the tracked tree" |
| MUST-5 Never A Standalone Snapshot — a later session reads it ⇒ never a standalone temp-root snapshot | "An artifact a later session must read MUST NOT be left as a standalone temp-root snapshot" |
| MUST NOT (already moved here 2026-10-01) — no `/tmp` detector as a verdict | unchanged: § "The `/tmp` detector is BLOCKED", below |

The guide sections below number the clauses by the 2026-10-01 draft (its "MUST 3" is the durable-root
clause, old MUST-4); the table above is authoritative.

**Why this file exists.** The rule was authored at 7,503 B and refused by
`check-rule-injection-budget.mjs` (`always-on-floor` 105,445 B → 112,122 B against a 111,445 B
ceiling). Three trimming passes took the body to 5,980 B — under the ceiling, and under the
always-on floor's absolute 120,000 B target — by moving evidence here, which is NOT budget-charged
(a guide, not a `.claude/rules/` file). This is `rule-authoring.md` Rule 10 path (a): extraction,
ZERO de-scoping. No MUST, MUST NOT or BLOCKED token was removed in the process.

---

## 1. The `os.tmpdir()` probe, and what it does NOT prove (MUST 1)

Instrument: `node -e 'console.log(require("os").tmpdir())'`.
**Falsifying result, named BEFORE the run: a printed `/tmp`.** Had it printed `/tmp`, MUST 1's
premise would be false and the clause would not ship.

Observed on this machine, 2026-10-01:

```text
$ node -e 'console.log(require("os").tmpdir())'
/var/folders/<xx>/…/T          # rc=0
$ printf '%s\n' "${TMPDIR:-<unset>}"
/var/folders/<xx>/…/T/
$ ls -ld /tmp
lrwxr-xr-x@ 1 root  wheel  11 13 Aug 10:51 /tmp -> private/tmp
$ node -e 'const p=require("os").tmpdir();console.log(require("fs").realpathSync(p))'
/private/var/folders/<xx>/…/T
```

**What this establishes, and what it does not.** It establishes that `os.tmpdir()` and the lexical
literal `/tmp` are DIFFERENT PATHS — the resolved temp root is `/private/var/folders/…/T`, four
segments deep under `/var`, and `/tmp` is a symlink to `/private/tmp`. It does **not** establish
that writing under `/tmp` fails: `/tmp -> private/tmp` is a real symlink and `mkdir -p /tmp/x`
succeeds. Over-claiming a write failure would be a false claim in a shipped rule, so the rule states
the distinction explicitly.

The defect the clause addresses is therefore not an error but a MISPLACEMENT: a value placed where
the platform's other temp consumers do not look, under a lifetime nobody in the session chose.

### Extended DO / DO NOT

```bash
# DO — ask; the platform resolves, the name is unique, the directory is created
d=$(mktemp -d)                        # /var/folders/<xx>/…/T/tmp.XXXXXXXXXX
trap 'rm -rf "$d"' EXIT               # scratch you bound, you also unbind
python -c 'import tempfile; print(tempfile.mkdtemp())'

# DO NOT — spell a path
mkdir -p /tmp/mysession               # two levels below the root, inside no scratch root
work_dir=/tmp/${USER}-work            # a name nobody guaranteed is free
node -e 'require("fs").mkdirSync("/tmp/out", {recursive:true})'
```

**Extended BLOCKED rationalizations** — the FULL corpus for MUST-5, and it lives here OFFLINE
from the rule by measurement, not by preference: the rule carries NO inline BLOCKED list for
this clause, because adding the three-phrase list pushed the manifest-less consumer emission to
codex 59,072 B / 9.86%, ninety bytes under the raw 10% floor (reverted; the omission is the
Rule 10(b) named trade recorded in the fold's commit body). An earlier revision of this line
said "beyond the rule's three", assuming a list the rule does not carry:

- "`$TMPDIR` is always set, so I can just interpolate it" — it is set *by the platform for the
  session that receives it*; a path that outlives the session, or crosses to another host, carries
  a variable that no longer means the same thing.
- "`mktemp` is not in POSIX, so it is not portable" — `mktemp` is in POSIX.1-2008; and the
  language-level `mkdtemp` is present in every runtime this corpus targets.
- "I need a PREDICTABLE path so a second command can find it" — that is a *durable* path need, which
  is MUST 3's question, not a reason to spell `/tmp`. A predictable path under a temp root is still
  purged on a clock you did not set.

---

## 2. The two purge clocks, and one reading that was DISCARDED (MUST 2)

### 2a. The deployed cleaner — DIRECT evidence

```text
$ plutil -p /System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist
  "Label" => "com.apple.tmp_cleaner"
  "ProgramArguments" => [ 0 => "/usr/libexec/tmp_cleaner" ]
  "StartCalendarInterval" => { "Hour" => 0 }

$ grep -n 'daily_clean_tmps_dirs=\|daily_clean_tmps_days=' /usr/libexec/tmp_cleaner
8:daily_clean_tmps_dirs="/tmp"     # Delete under here
9:daily_clean_tmps_days="3"        # If not accessed for
```

The script builds `find -dx . -fstype local -type f -atime +3 -mtime +3 -ctime +3 -delete` and
runs it against `/tmp` ALONE. This is a structural, in-machine fact: the platform deletes `/tmp`
entries that have gone 3 days without access, daily, whether or not anything reboots.

**Two scoping facts that matter and are easy to over-read:**
- The target list is `/tmp` **alone**. **No comparable guarantee was measured for
  `/var/folders/…`**, so the rule does NOT claim `os.tmpdir()` is durable. It says: treat temp-root
  scratch as temp, because durability there is unestablished either way.
- `-fstype local` means the sweep skips other filesystems. It does not widen the claim.

### 2b. The reboot — the co-owner's measurement, attributed

The co-owner MEASURED one reboot clearing roughly **6.5 million files and ~150 GB** from `/tmp`.
This lane **cannot reboot**, so the figure is carried as `[co-owner measurement, 2026-10-01]` and
NOT re-derived. It is recorded, not reproduced.

### 2c. A reading that was taken and DISCARDED — and why

A tempting corroboration was available and was thrown away, because it could not discriminate.

```text
$ find /private/tmp -maxdepth 1 -mindepth 1 | wc -l
     385
$ find /private/tmp -maxdepth 1 -mindepth 1 -mtime +3 | wc -l
       0
$ find /private/tmp -maxdepth 1 -mindepth 1 -exec stat -f '%Sm %N' -t '%Y-%m-%d %H:%M' {} \; | sort | head -1
2026-10-01 09:09 /private/tmp/powerlog
$ uptime ; sysctl -n kern.boottime
10:29  up  1:36
{ sec = 1790816016 ... } → Thu Oct  1 08:53:36 2026
```

385 entries, none older than 3 days, the oldest at 09:09 — which *looks* like the cleaner working.
**It is not evidence for that, and it was discarded:** the machine booted at **08:53:36**, 1.6 h
before the reading, and the oldest survivor postdates the boot. A reboot explains the identical
distribution, so the observation cannot separate the two clocks. Reading it as support for the
calendar purge would be an instrument answering a question it was never built for
(`instrument-discipline.md` MUST-4).

**Two instrument errors were also caught and corrected in this lane, recorded because both are
reproducible:**
- A first control was **vacuous**: `find /tmp -maxdepth 1` returns ONE line because `find` does not
  follow a symlink without `-H`/`-L`, so it measured the link, not the directory. Re-run against
  `/private/tmp`, it found 385 entries. A control that cannot see the subject is not a control.
- The first `trestle run` of the budget gate returned `exit=127 — /bin/sh: 1: exec: command: not
  found`: the remote executes argv directly, so a `command` prefix is treated as the executable
  name. That is ZERO evidence, not a verdict, and the run was repeated without the prefix.

### Extended DO / DO NOT

```bash
# DO — bound the lifetime where the Scratch is created
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; long_job --out "$d/r.json"; cp "$d/r.json" scratchpad/

# DO NOT — let a temp root hold the only copy of anything a later reader needs
long_job --out /tmp/r.json            # the cleaner reaches it in 3 days; a boot reaches it sooner
```

**Extended BLOCKED rationalizations:**

- "The cleaner only runs if the machine is on at midnight" — that bounds *when*, not *whether*.
- "It is 4 KB, the sweeper will not bother" — the sweep is by age, not size.
- "I will copy it out tomorrow" — between sessions is exactly when nobody is watching.

---

## 3. The durable scratch roots, verified with a control (MUST 3)

```text
$ git check-ignore -v .claude/.scratch/ scratchpad/ .claude/worktrees/
.gitignore:428:.claude/.scratch/        .claude/.scratch/
.gitignore:433:scratchpad/              scratchpad/
.gitignore:425:.claude/worktrees/       .claude/worktrees/
$ git check-ignore -v .claude/rules/    # CONTROL — a path that should NOT be ignored
(no output)                             rc=1
```

The control REDS in the direction the instrument must be able to produce, so the three hits are a
readable positive and not a matcher that prints for everything. `.gitignore`'s own comments record
why each entry exists — `scratchpad/` was un-ignored once, ~15k lines of session scratch accumulated
on a work branch, and a `git add -A` would have landed it on `main` (2026-07-27 /sweep, Sweep 7).

The dirty-tree consequence is a PINNED behaviour, not an anecdote — `scripts/ci/dev-preflight.mjs`
refuses (`REFUSING to validate a DIRTY tree` locally; `tree is DIRTY` at receipt import), pinned at
`.claude/test-harness/tests/dev-preflight-receipt-import.test.mjs:1122`.

### Extended DO / DO NOT

```bash
# DO — a declared durable root, and confirm it is declared
git check-ignore -v scratchpad/ && echo "durable" > scratchpad/notes.md

# DO NOT — untracked, in-tree scratch, on the assumption you will remove it in time
echo "notes" > ./probe-out.txt        # refuses the next preflight before you delete it
cp result.json ./r.json               # same class, same refusal
```

**Extended BLOCKED rationalizations:**

- "It is in `.gitignore` somewhere, probably" — `probably` is the whole defect; `check-ignore -v`
  answers it in one command.
- "It is a dotfile, so it is hidden" — hidden from `ls`, not from `git status --porcelain`.

---

## The sandbox carve-out, in full (MUST 1)

The corpus contains deliberate `/tmp` usage that this rule does **NOT** condemn, and a reader must
not sweep them:

- `rules/deployment.md` — `python -m venv /tmp/verify --clear` for a throwaway install-verification
  venv.
- `rules/build-repo-release-discipline.md` — the same shape (`uv venv /tmp/verify-kaizen`) for a
  release smoke check.
- `rules/worktree-isolation.md` — `/tmp/scratch/fx/repo` as a fixture path in a worked example.
- `rules/enrollment-operations.md` — `node /tmp/scratch/ceremony-step.js`.
- `rules/orchestrator-context-economy.md` — redirecting a gate's output to `/tmp/$g.log`.

These share a shape: a SHORT-LIVED, ISOLATED artifact whose loss costs a re-run, created and
consumed inside one operation. That is what `mktemp -d` is for, and spelling `/tmp` there is a
style blemish, not the defect this rule names. The rule's MUST 1 scopes to a scratch ROOT a session
keeps working in and comes back to.

`rules/state-file-write-guard.md` § Known residuals (k) is the closest existing treatment and is
cited rather than restated: it resolved `/tmp` sandbox paths to `out-of-tree` ("owned by no repo and
not `~/.claude` → no finding"). That clause answers **"can this path WRITE protected state?"**. This
rule answers **"where does scratch LIVE?"** — a different question with a different falsifying
result (`instrument-discipline.md` MUST-4). Neither supersedes the other; (k) is simply silent on
ownership-by-nobody and on durability.

---

## Origin

2026-10-01 — co-owner-directed codify item; receipt
`journal/0631` (authored
`author: agent`; the co-owner directive reached the orchestrator session, and the two facts are
deliberately not collapsed — the split follows `journal/0620`).

The co-owner surfaced the yardstick from a measurement session. Re-derived in this lane: the
`os.tmpdir()` probe, the `/tmp` symlink, `/usr/libexec/tmp_cleaner:8-9`, and all three gitignored
scratch roots against a control. Carried and attributed, not re-derived: the reboot figure (this
lane cannot reboot).

### Budget funding — the number, and the blind class that bounds it

The first registration attempt was REFUSED by `check-rule-injection-budget.mjs` even after
three trimming passes brought the body to 5,980 B: a net rise in always-loaded rules is
refused while any profile is above target, and no flag lifts that. The same rule converted
to path-scoped was refused across five profiles, four of them above target.

**It was funded by paired extraction** (`rule-authoring.md` Rule 10 path (a)): **6,197 B
recovered** from four floor rules, each moved verbatim to its already-existing paired
extract, with the `security.md` heading preserved as a stub because
`check-clause-coverage.mjs`, two handbook files and `completion-criterion.md` cite its
anchor text.

- `security.md` −2,305 B (the Accepted-residual / TOCTOU accounting)
- `zero-tolerance.md` −2,634 B (the 2026-09-08 and 2026-09-02 amendment/emission sections)
- `agents.md` −751 B (the CLI-syntax Examples pointer slot)
- `repo-scope-discipline.md` −507 B (the Origin paragraph)

Result: `always-on-floor` measured **105,228 B** against a 120,000 B target — **217 B BELOW**
the 105,445 B it measured before this 5,980 B rule was added.

**⛔ THE BOUND ON THAT SAFETY ARGUMENT, stated with the number because the number is what
gets quoted.** The anti-de-scoping control is a **text diff of obligation lines**, keyed on
the tokens `MUST`, `MUST NOT` and `BLOCKED`. It is mutation-verified — 4 mutations dropping
obligation text inside a surviving sentence red the text diff 4/4, where a COUNT reds on
only 1/4. **But it is scoped to token-bearing lines: a normative sentence written as plain
prose, carrying none of those three tokens, could have been moved out of a floor rule
without the control noticing.** An instrument's silence about a class it was never built to
observe is not evidence about that class (`instrument-discipline.md` MUST-4,
`conservation-gate.md` MUST-3). What covers the prose class is not the diff but a **human
read** of the four specific blocks before the move — each contained only cross-references to
other rules' clauses and token-census meta-accounting. That reading is a property of four
reviewed blocks, **not** a property of the instrument, and it does not generalize to the
next extraction.

---

## The `/tmp` detector is BLOCKED (moved here 2026-10-01, round 2)

The rule carried this as a `## MUST NOT` until the round-2 funding; it is a real obligation, and it
lives here rather than in the always-on body because the round-2 ruling scoped the rule body to the
five yardstick clauses. **It is not weaker for being here — a MUST NOT is a prohibition on the
SESSION, and the session reads the rule; what follows is the reasoning behind it.**

- **Invent a `/tmp` detector, or read a lexical `/tmp` match as a verdict.** BLOCKED by
  `rules/instrument-discipline.md` § MUST NOT; barred from `severity: block` by
  `rules/hook-output-discipline.md` MUST-2/MUST-5.

**Why:** this rule's failure mode is a path that WORKS. A cheap token detector would fire on the
corpus's deliberate sandbox examples (§ The sandbox carve-out, above) while staying silent on the
session that stored its only copy under a temp root — the exact inverse of the harm. No structural
tool-call-time signal exists: the discriminator is a *lifetime* and an *ownership* question about
the path's TARGET, and neither is observable from the argv of the command that writes there.

## Where the obligation is carried mechanically

The rule states the obligations; this is what carries the one that admits a structural signal.

**The enforceable half is `The Lightest Adequate Copy`.** "Loose in the tracked tree" is decidable:
an untracked, non-gitignored path under the repo root is in-tree state, and `git status --porcelain`
reports it as a parsed structural fact — the class `hook-output-discipline.md` MUST-2 permits to
carry a hard signal (its own worked examples are `git status --porcelain` and a non-zero pre-commit
exit). The other four clauses carry NO mechanical carrier, and none is invented for them:
`The Yardstick`, `The Reboot Clause`, `Per-Session Scratch` and `Never A Standalone Snapshot` are
all lifetime/ownership questions about a path's target, which the section above establishes a token
scan cannot observe.

Three carriers, and two of them are not at session end:

- `scripts/ci/dev-preflight.mjs` — REFUSES a dirty tree (`REFUSING to validate a DIRTY tree`
  locally; `tree is DIRTY` at receipt import), pinned at
  `.claude/test-harness/tests/dev-preflight-receipt-import.test.mjs:1122`. This is a PREFLIGHT: it
  fires when someone runs a preflight, not at session end.
- `git check-ignore -v` — the one-command answer to "is this path declared durable?" (§3 above).
- **The session-end carrier is `.claude/hooks/session-end.js`**, the already-registered `SessionEnd`
  hook: its `looseScratchLine` enumerates untracked-and-not-ignored paths under the session's cwd
  and names them on stderr, so scratch a session meant to throw away is named while the session that
  made it can still remove it. It is ADVISORY — at session end there is nothing left to block, and a
  session ending with a DELIBERATE untracked artifact must not be refused.
  **PRESENT-BUT-INVISIBLE, and NOT a runtime invoker (architect finding HIGH, 2026-10-03):** that
  same hook's own header records that the HOST prints nothing a hook says unless the hook FAILED —
  this advisory writes stderr then exits 0, so at session end nobody sees it — and it is CC-only
  besides. The wiring does NOT book it as a runtime arm; making it visible is the shared-runtime
  work, and until then MUST-5's enforcement is gate-review only, as its Invoker-class field says.

**Why the carrier is that hook and not a new one.** A new `SessionEnd` guard would have to be
registered, and registration is a `.claude/settings.json` change: `dispatch-registry.json` carries a
`--registry-sha256` pin in settings.json (`lib/dispatch-registry.js::DISPATCH_COMMAND_RE`), so a
registry write without a matching re-pin makes `dispatch.js` refuse at PreToolUse once no pinned copy
is left — a hard error on every event, which is exactly what `hook-dispatch-migrate.mjs::pinSettings`
exists to prevent. Extending `session-end.js` needs no registration change at all, and it keeps the
detector on the session-close-out subject that hook already owns.

**Two MEASURED properties of the detector, because its silence must not be over-read:**

- It is READ BEFORE `saveSession`, and the ordering is load-bearing: that call runs
  `ensureLearningDir(cwd)`, which CREATES `.claude/learning/` in the session's cwd. A reading taken
  afterwards reports the hook's OWN write as the session's loose scratch in any repo where
  `.claude/` is neither tracked nor ignored — an instrument measuring its own footprint.
- A path under a DECLARED gitignored root is invisible to it **by construction**. This reports the
  rule's violation, never its compliance. Bipolar control, run this session: a clean tree yielded no
  finding; adding `loose-scratch.txt` named it; moving that same file under a declared-gitignored
  `scratchpad/` removed it from the list again.

## Funding round 2 (2026-10-01) — the per-lang floor, and the principle it buys

**Round 1** (recorded above) funded the rule against the *injection* budget. That budget passed —
and the rule immediately breached the **separate per-lang emission floor**:

```text
lane        before     floor      headroom       after      headroom
codex py    63182 B    61407 B    3.59%  BLOCK   59660 B    8.97%  ok
codex rs    64951 B    61472 B    0.89%  BLOCK   61429 B    6.27%  ok
codex base  63936 B    61407 B    2.44%  BLOCK   60414 B    7.81%  ok
(gemini identical — the two CLIs are parity-locked)
```

Round 2 cut the always-on body to the five yardstick clauses and moved everything else here. The
rule's own emission went **4,235 B → 713 B** (MEASURED by emitting the `codex rs` lane with the rule
present and parked; the two figures are the lane byte counts, and their difference is the rule's
whole emission). Three of the lanes cleared by a wide margin; **`rs` cleared by 43 B** — 6.27%
against a 6.2% floor.

### ⛔ THE PRINCIPLE: the next per-lang breach means REVISIT THE FLOOR, not the rule

**Written down here so the next reader finds a stated position instead of deciding afresh whether to
extract again.** Funding buys emission budget with a reader's inline depth. That trade is good once
and bad repeatedly: enough of it degrades a rule into a pointer, and a pointer is a rule that has
stopped stating its obligation. This rule has now been funded twice and is down to five clauses and
713 B of emission — a third extraction would not be funding, it would be deletion with extra steps.
**So when a per-lang lane breaches again, the opening question is the FLOOR, not this rule.**

### ⛔ THE COUNTER-ARGUMENT, preserved beside it — not the disposition

> **A 6.3% floor is the wrong instrument to price a rule whose whole subject is not leaving scratch
> in the tree.**

It is NOT the disposition adopted above, and it does not repeal the principle — but it is the ground
on which the next breach would be argued, and a principle with its counter-argument attached is one
a later reader can actually EVALUATE rather than merely obey. Stated fairly: the per-lang floor
prices *emitted bytes*, and it cannot tell a rule that adds context cost from a governance
obligation that happens to be long. A floor breach is therefore evidence about a NUMBER, never by
itself a verdict that the rule is over-long. Both halves are true at once — the floor is the
instrument we have, and it is not measuring the thing this rule is about.

The `rs` lane's 43 B of clearance is what makes this concrete rather than theoretical: the next
session that touches any baseline rule pays the breach, and it will be measured against a rule whose
own emission is already 713 B of bare MUST clause.

---

## Funding round 3 (2026-10-02) — the restoration trade, MEASURED, and what fit

**The finding.** A cc-architect review of this branch found the rule shipping **five bare MUST
clauses** — 981 B with zero `**Why:**` lines, zero DO/DO-NOT blocks, zero BLOCKED corpora and no
`Origin:` — against `rules/rule-authoring.md` MUST 3 / MUST 4 / MUST 6 directly. The round-2 trim
below is what produced that state, and it was recorded as a *trade*; this section records the
measurement that decides whether the trade can be reversed.

**Why the answer is not "extract again".** Round 2's own principle stands at the head of the
section below: funding buys emission budget with a reader's inline depth, that trade is good once
and bad repeatedly, and "when a per-lang lane breaches again, the opening question is the FLOOR,
not this rule". Round 3 is that breach, arriving exactly as predicted, and the numbers below are
what the next reader needs to argue it.

**MEASURED, on this tree, with the real abridger** (`emit.mjs::abridgeV6`, applied to the rule file
after `stripRuleFrontmatter` — the same two calls `emitBaseline` makes).

The table below is that run’s output, in bytes:

```text
form                                      raw      abridged   Δ abridged
as shipped (5 bare MUST clauses)          981 B      722 B        —
+ one-line `Origin:` tail                1078 B      722 B      +0 B
minimal honest restore (Why + DO/DO-NOT) 1842 B     1486 B    +764 B
normal restore (Why + DO/DO-NOT + Origin) 2373 B    2114 B   +1392 B
```

The `Origin:` tail is FREE on every lane because an `Origin:` line is a stripped class (v6 strip
list) — so `rule-authoring.md` MUST 6 is satisfiable at zero emission cost, and it now IS satisfied.
The other two clauses are not: `**Why:**` lines are preserved **whole** (loom#2009, pinned by
`emit-shape.test.mjs`), and `DO`/`DO NOT` example blocks under 200 B are preserved too. A restore is
therefore priced in the one currency the abridger refuses to discount.

**The lanes cannot pay it, and that was shown by MUTATION, not by arithmetic.** Applied as a
mutation on this tree, the +1392 B form (`codex`, three lanes):

```text
lane   before            after                      verdict
py     59675 B  8.94%    61067 B  6.82%  floor 6.3%  PASS
rs     61444 B  6.24%    62836 B  4.12%  floor 6.2%  BLOCK  (under by 1364 B)
base   60429 B  7.79%    61821 B  5.67%  floor 6.3%  BLOCK  (under by  414 B)
```

`rs` absorbs **28 B** before it is under its floor; `base` absorbs 978 B; `py` absorbs 1732 B. Even
the most compressed honest restore (+764 B) is ~27× the `rs` allowance. The `rs` and `base` grants
are declared **freezes**, and `sync-manifest.yaml::headroom_floor_exceptions` says so in its own
words — "enough to hold the current corpus, too little to absorb another MUST clause. This is a
FREEZE, not a budget to spend."

**Disposition taken here, and the one NOT taken.** Shipped: the zero-cost `Origin:` tail, which
closes MUST 6 and moves no lane. Held, loudly: MUST 3 and MUST 4, with the numbers above. What is
**BLOCKED** is the third option — re-inflating the rule and letting `rs`/`base` go red, which would
buy the authoring contract by breaking the emission floors it was funded against. The fourth
option, Rule 10 path (a), needs an extraction source of ≈1400 B of *preserved* emission from other
baseline rules; none is inside this rule's own file set, so it is a corpus-level decision, not a
lane's.

**Re-measure, never re-cite.** The figures above are a 2026-10-02 reading at branch tip. The
round-2 text below records 713 B and an `rs` clearance of 43 B; this lane re-measured 722 B and a
28 B clearance fifteen minutes of corpus drift later, which is why both are quoted with their date
rather than as one number.

## Rule 10(b) Trade — The Five MUSTs Ship Without Their Failure Modes

**Operator-ruled 2026-10-02 (`journal/0653`), Rule 10 path (b) named-rationale exception.** The rule's
five MUST clauses ship **WITHOUT per-clause DO/DO-NOT blocks and WITHOUT `**Why:**` lines**, against
`rule-authoring.md` MUST 3/4 and against a corpus whose other rules average roughly eight why-lines each.

**THE PRICE, MEASURED — not the principle.** The rule emits **722 B**. Restoring the omitted material
costs **+764 B minimum, +1,392 B in normal form**, through `abridgeV6`; the `rs` lane's headroom above
its floor absorbs **28 B**. Applied as a mutation it measured **rs 4.12 % and base 5.67 %, BOTH BLOCK**
(under by 1,364 B and 414 B). Rule 10 path (a) would require ~1,400 B of *preserved emission* pulled
from **other baseline rules**, none of them reviewed against this finding — **a corpus-wide reallocation
dressed as a fix.**

**WHAT IS LOST, named rather than implied.** A reader gets the **OBLIGATIONS WITHOUT THE FAILURE MODES**:
the letter of each clause and not the why. A clause can therefore be **satisfied in form while defeating
its purpose**, and the omitted DO/DO-NOT pairs are exactly the material that would have made the wrong
form recognisable at the point of use. That sentence is the trade; it is not a disclaimer.

**THIS IS A RESIDUAL, NOT A RESOLUTION.** The queue row owns the revisit. The trigger is the next
deliberate change to this rule's emission, or the next per-lang headroom re-pricing — whichever comes
first. Until then, a reader who needs the why must come here.

**⚠ AND THE RECORD COULD NOT GO IN THE RULE ITSELF — measured, and the number is why.** An earlier
attempt put a compact version on the rule's `Origin:` line. It was **stripped by `abridgeV6`** (the
rule's *emitted* size stayed at 722 B) but the **injection-budget gate charges RAW bytes**, and the
`always-on-floor` moved **+263 B over its accepted level**. `--update --reason "<rule>=<why>"`, the
gate's own named disposition for accepted growth, **REFUSED at rc=2** — it does not clear the aggregate
tier, whose cap is 0 because four surfaces sit above target. `--raise-ceilings` is the gate's remaining
suggestion and is an **operator act, not taken**. So the rule carries the bare `Origin:` pointer and
this section carries the record: **the two instruments that price a rule — the emitter and the budget
gate — disagree about whether an `Origin:` paragraph is free, and the budget gate is the one that
refuses.**

**⇒ AND THE ONE-SENTENCE VERSION, which is worth more than the exception it forced: THE ABRIDGER
REMOVES TEXT THE BUDGET THEN BILLS FOR.** `abridgeV6` strips an `Origin:` line and its continuation
paragraph, so that text never reaches a consumer — and the injection-budget gate charges it against
`always-on-floor` anyway. The two are not measuring the same artifact, and nothing in either says so.
**A rule author who takes the strip as licence writes bytes they are billed for; one who takes the bill
as authority deletes text that was already free.** That contradiction is a genuine defect inside the
tooling, it is independent of this rule, and it is the reason a permitted, named, ruled exception could
not be recorded where its readers are.

**RESOLVED 2026-10-03 by the fold into `conservation-gate.md` MUST-5.** The folded clause carries a
DO/DO-NOT block and a `**Why:**` line, so the residual above (obligations without failure modes) is
closed for MUST-3/MUST-4 of `rule-authoring.md`. The fold was paid for by retiring the standalone
rule's whole emission (722 B + a 6 B separator) rather than by a corpus-wide reallocation.

---

## Authoring record — the probe suite (restored verbatim)

Restored 2026-10-03 (fold correctness finding IMPORTANT-2): this record lived in `probe-suite-integrity.test.mjs` at HEAD, and the fold REPLACED it there with a pointer to this guide while the guide never received it. The words below are verbatim from that file.

scratch-path-discipline (2026-10-01, co-owner-directed origination, journal/0631).
Authored WITH the rule on exactly the reasoning the orchestrator-context-economy entry
above records: the deferral arm is not self-serviceable — a `probe_authorship_deferrals`
row hits `checkAcceptanceGate`, which requires a `.claude/deferral-acceptance/` receipt
whose `requested_by != accepted_by`, and `completion-criterion.md` MUST-6 forbids
self-acceptance. The authoring lane considered and REFUSED that path for that reason,
which is the right outcome: a deferral written by the agent that owns the rule is the
fabrication the gate exists to catch.

Four firing pairs, one per derived clause (MUST-1 platform-derived scratch path, MUST-2
temp-only storage of a loss-sensitive artifact, MUST-3 gitignored durable root, and the
MUST NOT section as a set — no lexical `/tmp` detector), plus the meta pair; ZERO
deferred clauses.

Clause isolation was engineered rather than asserted: each violating pole's TRANSCRIPT
shows the neighbouring clauses handled correctly in character (the agent verifies the
tracked tree stayed clean, states a deliberate lifetime, declines a lexical check), so a
judge reporting "something is wrong here" without naming the clause under test has not
scored the pair. NOTE the neighbour evidence lives IN the transcript dialogue, never in a
labelled commentary section: an earlier revision of these fixtures appended a
"## Compliance notes" block naming the rationalizations used, which is an ANSWER KEY
sitting inside the judged candidate — it trips none of ANSWER_KEY_MARKERS and would have
made every row vacuous while reading as coverage. It was removed and its content moved to
the `.expected` sidecars, which are the surface never fed to a judge. The MUST-NOT pair is
the load-bearing one and is built against the blind spot
the clause NAMES: BOTH poles run the same grep and print the same 23 hits, and they
separate only on whether the hits were READ — the violating pole reports the tally and
calls two sealed `/tmp/verify` venv sandboxes violations the rule explicitly does not
condemn, while the compliant pole declines the lexical detector for a stated reason.

Those 23 hits are the REAL corpus, not a constructed number, and the compliant pole's
refusal is the correct engineering call: a length/surface channel was measured and closed
during authoring, and the sandbox reading is the rule's own carve-out.

A SHAPE LEAK was found and closed mid-flight, the same class the sync-completeness entry
records. First pass: the compliant pole was the longer file in 5/5 pairs, so a judge
