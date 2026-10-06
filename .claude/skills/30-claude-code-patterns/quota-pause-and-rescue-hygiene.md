# Quota-Pause And Rescue-Checkpoint Hygiene — depth for `orchestration-launch-ledger.md` MUST-4 / MUST-5

Paired depth file for `rules/orchestration-launch-ledger.md` MUST-4 (a quota / rate-limit failure is
a PAUSE, not a death) and MUST-5 (a rescue checkpoint is scanned before it is pushed). The rule body
carries the contract; this file carries the executable checks, the per-tool exit conventions, the
BLOCKED corpora, and the measured origin evidence.

Read this before relaunching into an existing worktree, and before pushing any rescue branch.

## MUST-4 — establishing liveness

**Liveness is established by a PROCESS check, never by a timestamp or a clean tree.** A worktree whose
last commit is old and whose `git status` is empty is equally consistent with "the agent is gone" and
"the agent is 40 minutes into a test run that has written nothing yet" — those observables do not
discriminate.

**The check MUST FAIL CLOSED — and "failed" is defined PER TOOL, never by a blanket exit-code rule.**
An empty result is only an all-clear if the check is shown to have RUN: a `ps` that is
permission-restricted, confined to a container PID namespace, or errored for any reason emits empty
output byte-indistinguishable from a genuine all-clear — and the disposition on empty is "launch", so
a silent failure launches into an occupied worktree. Per `evidence-first-claims.md` MUST-3, that empty
is ZERO EVIDENCE, never confirmation.

The exit-code convention DIFFERS by tool, so a single "non-zero means OCCUPIED" doctrine is wrong for
half the toolkit: `ps` returns non-zero only on genuine failure, but **`lsof` returns 1 when it finds
NOTHING** (`man lsof`: _"returns a one (1) if any error was detected, including the failure to locate
… files"_ — locate-failure and error share the code). Applying a blanket rule to `lsof` reads its
genuine all-clear as OCCUPIED, and a gate that can never return free is the gate that gets commented
out. So: for `ps`, `rc != 0` → OCCUPIED. For `lsof`, `rc ∈ {0,1}` both mean it RAN — discriminate on
LINE COUNT, and prove the instrument can see a process with a separate POSITIVE CONTROL.

An argv substring match is incomplete on its own — a compiler or build driver started with the
worktree as cwd and relative paths carries no slug in its command line — so the CWD-based check is
PRIMARY and the argv match is corroboration, never a substitute.

**A THIRD axis is required, because the first two see only what is RUNNING RIGHT NOW.** An agent
between tool calls — waiting on a model response, on a network round-trip, on a human — owns no
process and holds no cwd, so both sweeps report clean while it is very much alive. The `mtime`
look-back is what covers that gap: it asks whether anything under the worktree was WRITTEN inside
a recent window, which is a trace the agent leaves whether or not it currently holds a PID.

**The look-back MUST back-date a REFERENCE FILE and use POSIX `find -newer <ref>`. `-newermt` is
BLOCKED in every spelling.** It is a non-POSIX extension whose ARGUMENT grammar differs per
implementation: GNU findutils accepts a relative string, `bfs` carries it but accepts only
ISO-8601-like timestamps, and whether macOS BSD `find` carries it at all is RELEASE-dependent —
MEASURED 2026-09-29 on Darwin 25.6.0, `/usr/bin/find` DOES carry it and accepts BOTH forms at
rc 0, so a session testing there would wrongly conclude the predicate is safe. **Measured on the
authoring host, whose `find` is `bfs`:** `find <dir> -type f -newermt '-45 minutes'` →
`bfs: error: Invalid timestamp`, rc 1; the SAME command under `2>/dev/null` → **empty output,
rc 1** — byte-indistinguishable from "nothing was written". Every such pipeline carries that
`2>/dev/null` to suppress permission noise, and the disposition on empty is FREE, so the
portability failure launches into an OCCUPIED worktree. Read that measurement precisely: it is
silent to a counter that discards BOTH stderr and rc — the rejection IS rc-visible, so this is a
PORTABILITY hazard, **NOT the silent class below, which no rc check can catch**.
`touch -t` + `-newer` is POSIX and behaves identically on all three.

**The SILENT class is the WALK's START POINT — a different failure DIRECTION from `-newermt`.**
A `find` / `bfs` walk whose start point is ITSELF a symlink and is written WITHOUT a trailing slash
(and without `-H`/`-L`) emits ZERO PATHS at `rc=0` and prints no stderr, because the symlinked
directory is read as a FILE and the walk never descends. MEASURED 2026-09-29 on Darwin 25.6.0,
reproduced on BOTH the shell's `bfs 4.1.1` and `/usr/bin/find`, with a firing control in each
direction — and SCOPED by a control in the other: `ls -R`, `python3 os.walk` and
`node fs.readdirSync(..., {recursive:true})` all DO descend that same bare symlink (measured), so
"any equivalent walk goes silent" is FALSE:

    ls -ld /tmp                                   ->  /tmp -> private/tmp
    find /tmp  -maxdepth 1 -name 'loomfindprobe'  ->  (nothing)                  rc=0
    find /tmp/ -maxdepth 1 -name 'loomfindprobe'  ->  /tmp/loomfindprobe         rc=0
    find "$(realpath /tmp)" -maxdepth 1 -name …   ->  /private/tmp/loomfindprobe rc=0

A rejection at rc 1 is a failure you can SEE; a symlinked start point is a success you CANNOT —
zero output at a clean rc is byte-identical to a true negative, so it is ZERO EVIDENCE
(`evidence-first-claims.md` MUST-3) and never an all-clear. **Anchor the look-back on a
NON-SYMLINK root — `realpath <wt>`, or a trailing slash — and fire the enumeration at a file you
KNOW is there BEFORE reading a zero as "nothing was written".** The predicate control in the
runnable check below cannot catch this: its own root is a `mktemp -d` path, which is never a
symlink, so it passes while the real sweep is blind. This is the shape that cost a day: a
complete, verified 1,833-line implementation was declared LOST because the gate searched a
symlinked `/tmp` start point, a duplicate agent was briefed onto the same track, and ~40 minutes
of agent time re-derived work that had sat on disk for over an hour.

**Every counter MUST be numerically guarded before it is compared.** An empty capture makes
`[ "$x" -eq 0 ]` exit 2 with a `not a valid identifier`-class error on stderr; the enclosing `if`
reads that as FALSE, and control falls through to the next statement — which on this check's happy
path is the FREE return. That is a fail-OPEN on the one branch that must not have one, and it is
silent, because the error text goes to a stderr nobody reads.

```bash
# DO — three axes, each fail-closed, each numerically guarded, mtime proven to discriminate.
# A FUNCTION, not a loose snippet: `return` is only valid inside one, and it gives the
# topology guard a home. Run it from the MAIN checkout, never from inside the worktree.
check_worktree_free() {
  wt="$1"; back_min="${2:-45}"        # absolute worktree path; look-back window in minutes

  # NUMERIC GUARD — an empty capture makes `[ "$x" -eq 0 ]` exit 2, the `if` reads FALSE,
  # and control falls through toward FREE. Nothing below is compared before it passes this.
  isnum() { case "${1-}" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

  # (0) TOPOLOGY GUARD — this check is only sound from OUTSIDE the target. Run from inside,
  #     the pipeline's OWN processes (the $( ) subshell, awk, grep) have cwd there and are
  #     counted as occupants, so a free worktree reports OCCUPIED with a confident wrong count.
  #     `cd /` does NOT fix it — the invoking shell still sits there (measured: hits drops 3 -> 1).
  case "$PWD/" in "$wt"/*)
    echo "run this from OUTSIDE $wt — the check's own processes would be counted"; return 1;; esac

  # (1) ARGV SWEEP (corroboration) — ps: a non-zero rc IS failure.
  out=$(ps -eo pid,lstart,command 2>/dev/null); rc=$?
  isnum "$rc" || { echo "ps rc unreadable -> OCCUPIED"; return 1; }
  [ "$rc" -eq 0 ] || { echo "ps DID NOT RUN -> OCCUPIED"; return 1; }
  argv_hits=$(printf '%s\n' "$out" | grep -F -- "$(basename "$wt")" | grep -v '[ /]grep ' | grep -c .)
  isnum "$argv_hits" || { echo "argv sweep unreadable -> OCCUPIED"; return 1; }

  # (2) CWD SWEEP (PRIMARY — catches relative-path builds). lsof rc=1 means NOT-FOUND, not
  #     failure: discriminate on LINE COUNT, and exclude lsof's own entries + this shell.
  #     POSITIVE CONTROL — bounded, O(1): lsof MUST report a cwd it certainly can (this shell's).
  #     Do NOT use `+D "$HOME"` as the control — it walks the whole home tree and hangs.
  ctl=$(lsof -a -d cwd -w -p $$ 2>/dev/null | grep -c .)
  isnum "$ctl" || { echo "lsof control unreadable -> OCCUPIED"; return 1; }
  [ "$ctl" -gt 0 ] || { echo "lsof cannot report even this shell's cwd -> suspect -> OCCUPIED"; return 1; }
  cwd_hits=$(lsof -a -d cwd -w +D "$wt" 2>/dev/null \
              | awk -v me=$$ -v pp=$PPID 'NR>1 && $1!="lsof" && $2!=me && $2!=pp' | grep -c .)
  isnum "$cwd_hits" || { echo "cwd sweep unreadable -> OCCUPIED"; return 1; }

  # (3) MTIME LOOK-BACK — covers the agent that is ALIVE but between tool calls (no PID, no cwd).
  scratch=$(mktemp -d) || { echo "cannot create scratch dir -> OCCUPIED"; return 1; }
  # Back-date a reference file. BSD `date -v` first, GNU `date -d` second; neither -> fail closed.
  stamp=$(date -v-"${back_min}"M +%Y%m%d%H%M 2>/dev/null) \
    || stamp=$(date -d "-${back_min} minutes" +%Y%m%d%H%M 2>/dev/null)
  older=$(date -v-"$((back_min * 3))"M +%Y%m%d%H%M 2>/dev/null) \
    || older=$(date -d "-$((back_min * 3)) minutes" +%Y%m%d%H%M 2>/dev/null)
  if [ -z "$stamp" ] || [ -z "$older" ]; then
    rm -rf "$scratch"; echo "cannot back-date (neither BSD -v nor GNU -d) -> OCCUPIED"; return 1; fi
  ref="$scratch/ref"; : > "$ref"; touch -t "$stamp" "$ref" \
    || { rm -rf "$scratch"; echo "touch -t rejected -> OCCUPIED"; return 1; }
  # POSITIVE CONTROL — bounded, two files: the predicate MUST find one INSIDE the window and
  # MUST NOT find one OUTSIDE it. A control that fires on both, or on neither, cannot
  # discriminate, and its later silence over $wt would carry no information at all.
  mkdir -p "$scratch/ctl"
  : > "$scratch/ctl/inside"                                        # written now  -> MUST be found
  : > "$scratch/ctl/outside"; touch -t "$older" "$scratch/ctl/outside"  # older    -> MUST NOT be
  seen=$(find "$scratch/ctl" -type f -newer "$ref" -print 2>/dev/null)
  hit_in=$(printf '%s\n' "$seen" | grep -c '/inside$')
  hit_out=$(printf '%s\n' "$seen" | grep -c '/outside$')
  if ! isnum "$hit_in" || ! isnum "$hit_out" || [ "$hit_in" -ne 1 ] || [ "$hit_out" -ne 0 ]; then
    rm -rf "$scratch"
    echo "-newer does not discriminate here (in=$hit_in out=$hit_out) -> suspect -> OCCUPIED"; return 1; fi
  # Only now is a silence from the real sweep readable. Prune only `.git` (our own git calls
  # touch it); a build-output directory is exactly the signal we WANT, so never prune it.
  # ANCHOR THE ROOT: `find` and `bfs` read a symlinked START POINT as a FILE and never descend,
  # emitting ZERO PATHS at rc=0 — a silent zero the control above CANNOT catch, its own root being a
  # mktemp path and never a symlink. The class is find/bfs-scoped (`ls -R`, `os.walk`,
  # `readdirSync{recursive:true}` DO descend — measured); the anchor stays general safe practice.
  # realpath normalizes the parent components; a trailing slash alone still forces the descent, so
  # the fallback stays safe where realpath is absent.
  wt_root=$(realpath "$wt" 2>/dev/null) || wt_root="$wt"
  drawn=$(find "${wt_root%/}/" -name .git -prune -o -type f -newer "$ref" -print 2>/dev/null)
  sweep_rc=$?
  [ "$sweep_rc" -eq 0 ] || { rm -rf "$scratch"; echo "mtime sweep exited $sweep_rc -> OCCUPIED"; return 1; }
  mtime_hits=$(printf '%s\n' "$drawn" | grep -c .)
  rm -rf "$scratch"
  isnum "$mtime_hits" || { echo "mtime sweep unreadable -> OCCUPIED"; return 1; }

  # VERDICT — any axis non-zero is OCCUPIED. All three must be zero to return FREE.
  [ "$argv_hits"  -eq 0 ] || { echo "OCCUPIED: $argv_hits process(es) name the worktree in argv"; return 1; }
  [ "$cwd_hits"   -eq 0 ] || { echo "OCCUPIED: $cwd_hits process(es) with cwd inside the worktree"; return 1; }
  [ "$mtime_hits" -eq 0 ] || { echo "OCCUPIED: $mtime_hits file(s) written in the last ${back_min}m"; return 1; }
  echo "FREE as of $(date -u +%Y-%m-%dT%H:%M:%SZ) (window ${back_min}m) — PERISHABLE, not proof of absence"
  return 0
}

# DO NOT — a bare symlinked START POINT: find reads it as a FILE, never descends, and returns
#          ZERO PATHS at rc=0 — silent at a CLEAN rc, so even an rc check reads it as FREE
find /tmp -type f -newer "$ref" 2>/dev/null   # /tmp -> private/tmp; use realpath /tmp, or /tmp/
# DO NOT — `-newermt` in any spelling; the argument grammar does not travel across bfs / GNU /
#          BSD, and under the 2>/dev/null every such pipeline carries the rejection reads as FREE
find "$wt" -type f -newermt '-45 minutes' 2>/dev/null   # and -newermt "@$(...)", and -newerm t
# DO NOT — compare a counter that was never proven numeric (the fail-OPEN this check exists to avoid)
hits=$(... | grep -c .); if [ "$hits" -eq 0 ]; then return 0; fi   # empty $hits -> exit 2 -> FREE
# DO NOT — run the check from inside the worktree it is checking
cd "$wt" && check_worktree_free "$wt"   # the guard refuses; without it, hits=3 on an EMPTY dir
# DO NOT — one blanket exit-code rule across tools with opposite conventions
[ $? -ne 0 ] && echo OCCUPIED        # correct for ps; for lsof this reads the ALL-CLEAR as occupied
# DO NOT — read an unproven empty as an all-clear
ps -eo command | grep <slug>      # errors, PID-namespace confinement, and "no match" all look identical
# DO NOT — infer death from the worktree's own state
git -C <wt> log -1 --format=%ad   # old  ) neither of these
git -C <wt> status --porcelain    # clean) discriminates
```

**FREE is a bound, never a proof — and it expires.** All three axes are existence checks: each can
demonstrate that something IS there, and none can demonstrate that nothing is. A FREE verdict says
only _no process named the worktree, no process held a cwd inside it, and nothing was written in
the last `back_min` minutes_ — it is consistent with an agent idle longer than the window, with a
writer on a filesystem whose mtimes are coarse or disabled, and with a process the running user
cannot see. It is also **PERISHABLE**: it describes the instant it ran, and a sibling can claim the
worktree in the second after. Re-run it IMMEDIATELY before the launch it authorizes, never once at
the top of a wave, and never cache the result across a plan step.

`+D` walks the tree and is the correct choice (`+d` is one level deep and misses a process whose cwd
is a nested subdirectory); it costs seconds on a large build-output tree — measured ~9s on a 12 GB
tree — which is the right trade for the class of loss it prevents.

**If a concurrent writer IS found: STOP and report. Do NOT `kill` it** — terminating another agent's
in-flight run destroys a measurement with no reflog, killing by a grep-matched pid is independently
unsound (pid reuse, over-broad slug match), and the orchestrator is not positioned to know what was
mid-flight. **If the writer is genuinely stuck, that is a HUMAN gate, never self-authorized**
(`autonomous-execution.md` § Structural vs Execution Gates): report the pid, its `lstart`, and its
full command line, and let the human authorize termination.

**This composes with MUST-1's ledger rather than sitting beside it:** a row moves to `stopped` ONLY on
a confirmed stand-down or a process check demonstrated capable of the opposite verdict — NEVER on a
quota error. Without that binding an orchestrator writes `stopped` on the strength of the limit
message, and then satisfies MUST-2's no-duplicate-spawn check legitimately, because the ledger now
says the track is free.

**BLOCKED rationalizations:** "the limit error means it is finished" / "the worktree is clean so
nothing is running" / "its last commit is hours old" / "I will just relaunch and let them sort it out"
/ "the ledger says `stopped`" (who wrote that, and on what evidence?).

**Why:** the two observables an orchestrator naturally reaches for — commit recency and tree
cleanliness — are precisely the two a long-running agent also produces, so the inference is
unfalsifiable at the moment it is made; only the process check separates the cases.

## MUST-5 — scanning a rescue checkpoint

Preserving an interrupted agent's uncommitted work is CORRECT — losing it is worse than any cleanup.
But a blanket `git add -A` rescue is indiscriminate: it stages build outputs, scratch harnesses,
measurement binaries, probe files — **and anything holding a credential**. **Prefer EXPLICIT-PATH
staging**, matching `coc-sync-landing.md` MUST-2, which already BLOCKS `git add -u`/`-A`/`.` for
exactly this reason; use `-A` only when the interrupted set is genuinely unknown, and then inspect it.

**The secret scan is the non-negotiable one.** A `git push` is the sink: an oversized blob costs a
history rewrite, but a pushed credential is unrecoverable and costs ROTATION. "Declares itself
UNREVIEWED" mitigates the live-mutation half; it does nothing for a secret, which is already published
by the time anyone reads the declaration.

**Pushing a per-operator scratch tree to a shared branch is a sensitivity escalation** (local →
committed shared surface), so it carries `recommendation-quality.md` MUST-8's confirm-before-persist
gate. "Losing the work would be worse" is a reason to CHECKPOINT, never a reason to skip the scan.

```bash
# DO — scan between add and push; secrets FIRST; prove the range is non-empty before trusting a clean scan
n=$(git -C <wt> rev-list --count <base>..HEAD)
if [ "$n" -eq 0 ]; then echo "empty range -> the scan below inspects NOTHING; fix <base>"; return 1; fi
git -C <wt> diff --cached --name-only | grep -EI '\.env|\.pem$|credential|secret|token|\.log$'   # must be EMPTY
git -C <wt> diff --cached | <repo secret scanner>                                                # must be clean
git -C <wt> rev-list --objects <base>..HEAD \
  | git -C <wt> cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob" && $3>10485760'          # must be EMPTY
# DO NOT — git add -A && git commit && git push, then discover it in review
# DO NOT — trust an empty scan without the range count: `rev-list <wrong-base>..HEAD` over an empty
#          range emits nothing, awk emits nothing, and "must be EMPTY" reads PASS on a scan of zero commits
```

**BLOCKED rationalizations:** "it's just a checkpoint, review comes later" / "a follow-up commit will
delete the binary" (it will not — the blob stays in history) / "the scan costs time the agent does not
have" (the scan is seconds; a rotation is not) / "nothing sensitive lives in a scratch dir" (an
unexamined tree is the definition of not knowing that) / "the scan came back clean" (over WHICH range?
an empty range scans nothing and reports clean).

**The checkpoint commit MUST declare itself UNREVIEWED with the literal subject-line prefix
`checkpoint(UNREVIEWED):`** — a greppable token, per the `trust-posture.md` MUST-8 anchor precedent, so
a merge gate can mechanically detect that a checkpoint reached a PR. **A PR MUST NOT be opened or
merged from a `checkpoint(UNREVIEWED):` commit until the resumer's diff-and-confirm pass has run**; one
such checkpoint reached a PR in the Origin below and reddened a required format check, and a
checkpoint carrying a live negative-control mutation that gets merged ships a deliberately-broken
mechanism. The prefix is required because a negative-control pass mutates the mechanism under test,
asserts RED, then reverts — an agent killed in between leaves a **deliberately-broken mechanism that
reads as a normal edit**. Whoever resumes MUST diff against the base and confirm each change is an
intended fix before building on it or trusting any green.

**The rescue lands on `recovery/<name>` and is PUSH-VERIFIED**, per `worktree-isolation.md` Rule 8,
which owns WHEN a rescue is mandatory (a wave is not closed while it still holds worktrees) and
requires `git ls-remote --heads origin 'refs/heads/recovery/*'` as the proof it landed — the push
command's own output is not that proof. MUST-5 owns only WHAT to inspect between staging and push; an
agent following it alone would push a checkpoint to an arbitrary branch and silently fail Rule 8's
wave-close gate.

```text
# DO — Rule-8 branch convention + the prefix, then verify it landed
git -C <wt> commit -m "checkpoint(UNREVIEWED): T3 mid-edit; may contain a live negative-control mutation"
git -C <wt> push -u origin recovery/s24-t3-eatp
git ls-remote --heads origin 'refs/heads/recovery/*'    # the proof; push output is not

# DO NOT — an ordinary subject on an arbitrary branch
git -C <wt> commit -m "wip: save work" && git push -u origin scratch-t3
# (no greppable marker, so a merge gate cannot see a checkpoint reached a PR;
#  wrong branch namespace, so Rule 8's wave-close ls-remote check never finds it)
```

**Why:** the rescue is a correct reflex applied under time pressure, which is exactly when the scan is
skipped; and the two failure modes it prevents are both silent — an oversized blob is permanent, and
an un-flagged live mutation is indistinguishable from work.

## Origin — the measured evidence

**2026-08-10, a sixteen-track BUILD-repo wave that hit three account quota-limits in one session.**
Both clauses are orchestrator errors, both measured:

- **MUST-4, twice from one false premise.** After the first limit, ten tracks were relaunched under
  new names into the SAME worktrees; the originals resumed on the account swap, giving each track two
  live agents under one git identity, where `--author` cannot separate them. Measured damage on one
  branch: a commit swept in a sibling's in-flight edit and pushed it unverified, and a negative
  control run minutes later was **vacuous** because the sibling's `git checkout HEAD --` restored the
  very inventory entry the control meant to remove — a vacuous control reports SUCCESS, which is the
  dangerous half. The same false premise then repeated on two tracks left alone as "never resumed":
  one was alive and mid-measurement, and the agent launched into it ran `kill <pid>` on the other's
  in-flight test run, truncating the output at 120,867 bytes with no terminal marker. The inference in
  both cases came from a worktree's own state — old last-commit, clean tree — which a long-running
  agent also produces.
- **MUST-5.** The rescue checkpoint used a blanket `git add -A` and pushed. It swept in two **16.6MB**
  A/B measurement binaries (violating the repo's >10MB rule, requiring a history rewrite), a scratch
  probe file into a sibling package's test directory, and unformatted mid-edit code that reddened the
  repo's required format check on a PR. A later checkpoint, run WITH inspection and an artefact scan,
  was clean — which is the whole clause.

The checkpoint reflex itself was CORRECT and is not what the clauses discourage: ~10,400 lines across
twelve branches were preserved and nothing was lost. What the clauses add is the scan between staging
and push, and the process check before relaunching.

**Ingest note.** Landed at loom 2026-08-10 via `/sync-from-build` Gate-1 classification of the
`kailash-rs` BUILD proposal `ORCHESTRATION-QUOTA-PAUSE-AND-RESCUE-HYGIENE-2026-08-10`, classified
GLOBAL on both axes (the quota-pause and rescue-scan contracts reference no language runtime and no
CLI-native delegation primitive). The originating repo's language-specific tooling names were
genericized at placement per the sync-reviewer BUILD-internal-reference contract; the measured byte
counts and the failure sequence are carried verbatim because they are the evidence. Depth was split
from the rule body under `rule-authoring.md` Rule 10 path (a) — the `workspace-note` path-scoped
injection profile had 9,013 B of headroom against ~20 KB of authored clause text, so the executable
checks and BLOCKED corpora live here and the rule body carries the thin contract.

## MUST-6 — revival, and the force-push that "succeeds"

Depth for `orchestration-launch-ledger.md` MUST-6. MUST-4 covers the moment before a
replacement launches; this covers the original coming BACK after one is already running.
Check-before-spawn cannot see it: the ledger was correct when it was read.

```text
# DO — keep both rows, demote one to READ-ONLY before either writes again
ledger: track-A → agent-1 in-flight (RETURNED) · agent-2 in-flight → DEMOTE agent-2 to read-only verifier
git rev-list --count feat/x..origin/feat/x    # 5 → a force-push WOULD destroy five commits
git push origin feat/x:refs/heads/recovery/feat-x-agent1   # preserve BOTH sides instead

# DO NOT — any of these
git branch -D feat/x            # the "stale" row was a live writer
git push --force origin feat/x  # accepted precisely BECAUSE origin had commits you did not
kill <pid>                      # kill is a human gate, never self-authorized
```

**BLOCKED rationalizations:** "the ledger row is stale, it died" / "two agents on one track is
fine, they coordinate" / "a peer assigned me this track, so the stand-down is lifted" / "the
force-push was accepted, so nothing was lost" / "the branch is orphaned, there is nothing to
preserve" / "--force-with-lease is the safe variant" (it guards against a ref moving under you,
not against destroying commits you never fetched).

**Why the read-only demotion rather than a kill.** The duplicate is not merely tolerated — in the
originating incident the demoted verifier caught a three-way resolver divergence and a
deny-by-default regression that neither implementing agent could see. A second reader on a track
is an asset; a second WRITER is the collision `--author` cannot untangle.

**What the detector does NOT give you, in one line.** The force-push half of MUST-6(b) has a
structural hook armed at loom and deliberately fenced from consumers, so at a consumer this clause
is enforced by the gate-review sweep and by nothing else: the hook's silence there is the ABSENCE OF
AN INSTRUMENT, never evidence that no force-push destroyed origin-only commits. Fixture
registration, the DEPTH-1 fixture-slug requirement and the CC-only arming measurement — with the
sibling-guard control that proves the arming cloud is not a dead grep — are in the extract,
`guides/rule-extracts/orchestration-launch-ledger.md` § "MUST-6(b) force-push detector — arming,
fencing and fixture provenance".

**Measured evidence.** A session-limited agent was replaced and then returned, creating two writers
on one track. Separately, a recovered agent held 15 unpushed commits that could not fast-forward; a
force-push would have been accepted and would have destroyed five origin-only commits differing by
744 and 768 lines. Acceptance is the remote answering about refs, never about content.
