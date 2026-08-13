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

```bash
# DO — per-tool failure convention; positive control before trusting either result.
# A FUNCTION, not a loose snippet: `return` is only valid inside one, and it gives the
# topology guard a home. Run it from the MAIN checkout, never from inside the worktree.
check_worktree_free() {
  wt="$1"                                            # absolute path to the worktree

  # (0) TOPOLOGY GUARD — this check is only sound from OUTSIDE the target. Run from inside,
  #     the pipeline's OWN processes (the $( ) subshell, awk, grep) have cwd there and are
  #     counted as occupants, so a free worktree reports OCCUPIED with a confident wrong count.
  #     `cd /` does NOT fix it — the invoking shell still sits there (measured: hits drops 3 -> 1).
  case "$PWD/" in "$wt"/*)
    echo "run this from OUTSIDE $wt — the check's own processes would be counted"; return 1;; esac

  # (1) argv sweep — ps: non-zero rc IS failure
  out=$(ps -eo pid,lstart,command 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then echo "ps DID NOT RUN -> treat as OCCUPIED"; return 1; fi
  printf '%s\n' "$out" | grep -- "<worktree-slug>" | grep -v grep      # must be EMPTY

  # (2) cwd sweep (PRIMARY — catches relative-path builds). lsof rc=1 means NOT-FOUND, not failure:
  #     discriminate on line count, and exclude lsof's own entries + this shell.
  hits=$(lsof -a -d cwd -w +D "$wt" 2>/dev/null \
          | awk -v me=$$ -v pp=$PPID 'NR>1 && $1!="lsof" && $2!=me && $2!=pp' | grep -c .)
  #     POSITIVE CONTROL — bounded, O(1): lsof MUST be able to report a cwd it certainly can (this shell's).
  #     Do NOT use `+D "$HOME"` as the control — it walks the whole home tree and hangs.
  ctl=$(lsof -a -d cwd -w -p $$ 2>/dev/null | grep -c .)
  if [ "$ctl" -eq 0 ]; then echo "lsof cannot report even this shell's cwd -> instrument suspect -> OCCUPIED"; return 1; fi
  if [ "$hits" -ne 0 ]; then echo "OCCUPIED: $hits process(es) with cwd inside the worktree"; return 1; fi
  return 0
}

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
