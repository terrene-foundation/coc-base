---
priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - ".claude/commands/**"
  - ".claude/skills/**"
  - "**/*worktree*"
  - "**/workspaces/**"
---

# Worktree Isolation Rules

See `.claude/guides/rule-extracts/worktree-isolation.md` for extended examples, post-mortem prose, and session evidence for all 6 MUST rules.

Parallel agents run in their own git worktree so compile/test jobs do not fight over the same `target/` or `.venv/`. The worktree is created by the ORCHESTRATOR as a SIBLING outside the repo (Rule 7 placement) and handed to the agent by absolute path; the harness flag `isolation: "worktree"` is RETIRED (Rule 1) because it places the worktree under the repo's OWN `.claude/`. The isolation is only real if the agent actually edits files inside its assigned worktree path. When an agent drifts back to the main checkout — because the system prompt didn't pin cwd, because absolute paths were copied from the orchestrator, because the tool defaulted to `process.cwd()` — the isolation silently breaks.

This rule mandates a self-verification step at agent start AND a pre-flight check in the orchestrator's delegation prompt. The verification is cheap (one `git status`) and the failure mode is expensive (a whole session's worth of parallel work corrupted).

## MUST Rules

### 1. Pre-Made SIBLING Worktree + A MANDATED STEP-0 Cwd ASSERTION — Both Halves

A TWO-PART contract. Both halves are MUST, and (b) is what REPLACES the cwd guarantee the retired flag used to provide.

**(a) Placement + naming.** The orchestrator MUST create the agent's worktree ITSELF as a SIBLING outside the repo (Rule 7 placement; `/worktree` or a hand-rolled `git worktree add`), then dispatch WITHOUT any harness isolation flag, naming that ABSOLUTE path in the prompt. Passing `isolation: "worktree"` — or `EnterWorktree({name})` — is BLOCKED: both place the worktree at `<repo>/.claude/worktrees/agent-<id>`, nested under the repo's OWN `.claude/`.

**(b) STEP-0 assertion.** The prompt MUST mandate that the agent's FIRST action is `cd <worktree>` FOLLOWED BY an assertion that it is now at an isolated worktree ROOT, refusing to proceed otherwise. Assert and refuse — not "verify", not "check". A dispatch naming the path but not mandating the assertion is BLOCKED. The assertion MUST compare RESOLVED paths (`pwd -P`, not the passed string) and MUST reject the main checkout:

```bash
cd "$WT" || { echo "STOP: cannot enter $WT"; exit 1; }
top=$(git rev-parse --show-toplevel) || { echo "STOP: not a git repo"; exit 1; }
[ "$top" = "$(pwd -P)" ]  || { echo "STOP: not a worktree ROOT (top=$top)"; exit 1; }
main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
[ "$top" != "$main" ]     || { echo "STOP: this IS the main checkout"; exit 1; }
```

Two forms are BLOCKED as the assertion: `git -C <worktree> …` (never establishes cwd — it answers about the worktree while leaving the agent in MAIN) and a BARE first `git rev-parse --show-toplevel` (resolves to MAIN on every dispatch, so it refuses always, and an always-refusing check gets deleted by the first person it blocks). Only `cd` FIRST, THEN assert, is both runnable and load-bearing. Pairs with Rule 2a: STEP 0 sets the floor; each later location-dependent invocation MUST re-assert. Form-by-form comparison: skill § Three candidate assertion forms.

```python
# DO — pre-made SIBLING, no isolation flag, STEP-0 assertion MANDATED in the prompt
wt = "/Users/me/repos/.myrepo-wt/shard-abc"      # sibling of the repo, NEVER under it
# git worktree add -b feat/shard-abc "$wt" origin/main
Agent(prompt=f"""
Working directory: {wt}
STEP 0 (FIRST action, before reading or writing anything) — cd, THEN assert:
  cd "{wt}" || {{ echo "STOP: cannot enter {wt}"; exit 1; }}
  top=$(git rev-parse --show-toplevel) || {{ echo "STOP: not a git repo"; exit 1; }}
  [ "$top" = "$(pwd -P)" ] || {{ echo "STOP: not a worktree ROOT"; exit 1; }}
Compare RESOLVED paths — never the passed string (a symlinked prefix refuses spuriously).
On mismatch REFUSE to proceed; do NOT fall back to the main checkout.
Every path you write MUST resolve inside {wt}; an absolute path rooted elsewhere is BLOCKED.
""")

# DO NOT — the retired harness flag (lands at <repo>/.claude/worktrees/agent-<id>)
Agent(isolation="worktree", prompt="Implement feature X — use ml-specialist patterns.")
# DO NOT — sibling path named, but no assertion mandated: nothing pins the agent's cwd
Agent(prompt=f"Working directory: {wt}\nImplement feature X.")
# DO NOT — `git -C` (never establishes cwd) or a bare rev-parse FIRST (always refuses)
Agent(prompt=f'STEP 0: git -C "{wt}" rev-parse --show-toplevel')
```

**BLOCKED rationalizations:** "`isolation: "worktree"` is the built-in primitive, so it must be the intended path" / "The isolation flag handles the cwd for me" / "Pre-making the worktree is orchestrator overhead the flag does for free" / "The prompt names the directory, the agent will work there" / "STEP 0 is ceremony — the agent already has the path" / "`git -C <wt> status` is the same check" (it is not — `-C` leaves the agent in MAIN) / "The agent can just `cd` first" (an UN-ASSERTED `cd` is an unverified assumption; `cd` + assert is the mandated form) / "compare the toplevel to the path I passed" (spurious refusal on any symlinked prefix — compare resolved forms) / "I'll just use relative paths, they're shorter" / "The agent will figure out the right directory" / "I tested it once, it worked — should keep working".

**Why:** The retired flag is what SET the agent's working directory and prompt text is NOT a guarantee, so half (b) REPLACES that guarantee rather than supplementing it — without it the rule trades a bounded quota burn for unbounded silent work-loss to MAIN (recorded: 2026-04-19, 2 of 3 shards wrote to MAIN, 300+ LOC lost when a zero-commit worktree auto-cleaned). Any future edit to an assertion here MUST state which inputs make it FAIL and which make it PASS, because both defects found while converging this clause were the same failure at opposite poles: a form that could never fail, and one that could never pass on a symlinked path. Depth: guide § Rule 1 + skill § Retiring `isolation: "worktree"`.

#### Trust Posture Wiring (Rule 1 — clause-scoped)

Rule 1 is `/codify`-touched here, so it leaves the Rules 1–6 grandfather set and ships canonical-8-field-compliant; Rules 2–6 stay grandfathered until each is itself touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every parallel dispatch went into an orchestrator-made sibling worktree pinned by absolute path, with no `isolation:` flag, AND mandated the STEP-0 bare-`git rev-parse` cwd assertion); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (a dispatch argument is not structurally decidable as agent-wave vs other at tool-call time).
- **Grace period:** 7 days from clause landing (2026-07-26 → 2026-08-02).
- **Cumulative posture impact:** same-class violations (an `isolation:`/`EnterWorktree({name})` dispatch; a pre-made-worktree dispatch with no absolute path pinned; an omitted STEP-0 assertion mandate; or an assertion written with `git -C`, a bare first `rev-parse`, or a passed-string comparison) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key (a dispatch-argument property is review-layer plus advisory-hook). Named deviation per `trust-posture.md` Rule 8, as Rule 7 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (gate-review) — for any parallel-dispatch session, reviewer confirms (i) each worktree path lies OUTSIDE the repo top-level, (ii) no dispatch carried an isolation flag, (iii) each prompt mandates STEP-0 `cd <worktree>` THEN an assertion that `--show-toplevel` equals `pwd -P` and is not the main checkout, with explicit refusal — a `-C` form, a bare first `rev-parse`, or a passed-string comparison are each a finding. Phase 2 (deferred) — no hook detector; fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` (shared with Rule 7) per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 1 ONLY; Rules 2–6 stay grandfathered.
- **Origin:** loom#1370 (owner-escalated fleet-wide quota burn); see § Origin.

### 2. Specialist Agents MUST Self-Verify Cwd At Start

Every specialist agent file (`.claude/agents/**/*.md`) that may be dispatched into a worktree MUST include a "Working Directory Self-Check" step at the top of its process section. The check prints the resolved cwd and the git branch, and refuses to proceed if either is unexpected.

```markdown
# DO — self-check baked into the agent file

## Step 0: Working Directory Self-Check

Before any file edit — AFTER Rule 1(b)'s STEP-0 `cd` — run BARE (no `-C`):
top=$(git rev-parse --show-toplevel)
[ "$top" = "$(pwd -P)" ] || STOP                 # at a worktree root
main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
[ "$top" != "$main" ] || STOP # ...and NOT the main checkout
git rev-parse --abbrev-ref HEAD
If either check fails, STOP and emit
"worktree drift detected — refusing to edit main checkout".

# DO NOT — the root check alone; MAIN is itself a worktree root, so it PASSES there

[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || STOP
```

**Why:** Rule 1(b) puts the assertion in the PROMPT; this rule puts it in the AGENT FILE, so it survives the prompt. That redundancy became load-bearing when Rule 1 retired the flag: the orchestrator's pinned-path instruction can be lost to context compression across long delegation chains, and with no harness setting cwd there is nothing else underneath. One git call (~30 ms) prevents specialist drift.

**BARE is correct HERE and wrong at Rule 1(b) — the difference is POSITION, not the command.** This check runs AFTER cwd is established, where a bare `rev-parse` is the only form that OBSERVES where the agent ended up; at Rule 1(b) nothing has set cwd, so the same command refuses always. Do NOT "converge" this site onto `cd <wt> && …` — that makes the drift check unable to fail. The `cd` inside the `main=` substitution is a SUBSHELL resolving the main repo top; removing it reintroduces the symlink false-refusal.

**The main-checkout exclusion is what gives this check teeth.** The root test alone PASSES in MAIN (measured — MAIN is itself a valid worktree root), so on the Rule 2a path, where cwd silently reverts mid-session, it would wave through the exact drift this rule catches.

### 2a. Re-Assert Cwd Per Invocation — `cd` Persistence Is Not Trustworthy

The Rule-2 self-check at agent START is necessary but not sufficient: the shell's cwd can silently revert to the MAIN checkout mid-session after tool-mediated file operations. A relative-path patch then resolves against the wrong checkout and "succeeds" — edits land on main's copy, the worktree's code never changes, and a subsequent test run prints green against the UNPATCHED code (a vacuous pass). Any worktree command whose correctness depends on which checkout it runs in (apply patch, run tests, grep for the edit) MUST re-assert location in the same invocation (`git -C <worktree> …`, or `cd <worktree> && pwd && …`) — not rely on a `cd` from an earlier call.

```bash
# DO — location asserted in the SAME invocation as the operation
cd "$WT" && git rev-parse --show-toplevel && <run-tests/apply-patch>

# DO NOT — trust an earlier cd; relative paths may now resolve against main
<run-tests>     # cwd silently reverted → tests main's old code, prints green
```

**BLOCKED rationalizations:** "I cd'd at the start of the session" / "the prior command ran in the worktree, so this one will" / "the test passed, the patch must have applied".

**Why:** The false-green is worse than a failure — it converts an unapplied patch into institutional "validated" state. Evidence: the Rust SDK journal 0177 § Process note (2026-06-10) — a "3× green" validation had silently run in the main checkout after cwd reverted; the explicit `cd` + re-run produced the real 3/3 FAIL that exposed an O(n²) regression. Pairs with Rule 3a (checkout-bound tools): 3a covers tools rooted at the script's own location; this clause covers the invoking shell's cwd.

### 3. Parent MUST Verify Deliverables Exist After Agent Exit

When an agent reports completion of a file-writing task, the parent orchestrator MUST verify the claimed files exist at the worktree path via `ls` or `Read` before trusting the completion claim. Agent completion messages are NOT evidence of file creation.

```python
# DO — verify after agent returns
result = Agent(prompt=f"Write {worktree}/src/feature.py...")   # worktree = pre-made sibling
assert_file_exists(f"{worktree}/src/feature.py")  # parent checks

# DO NOT — trust "done" and proceed
```

**BLOCKED rationalizations:** "The agent said 'done', that's good enough" / "Verifying every file slows the orchestrator" / "The agent would have errored if the write failed" / "Now let me write the file..." followed by no actual write.

**Why:** Agents hit budget mid-message and emit "Now let me write X..." without having written X. Kaizen round 6 and ml-specialist round 7 both reported success with zero files on disk. `ls` check is O(1) and converts silent no-op into loud retry.

### 3a. Tool-Output Verification Claims Require Post-Merge Re-Run For Checkout-Bound Tools

When a worktree-isolated agent makes a verification claim citing a tool whose workspace root resolves via `__file__` / `Cargo.toml` / `package.json` (NOT the invoking CWD or an explicit `--root` flag), the parent orchestrator MUST re-run that tool from the main checkout AFTER merge before accepting the claim as institutional truth. In-worktree pre-merge verification of checkout-bound tools is structurally vacuous — the tool scans whichever checkout owns the script binary, not the worktree the agent compiled in.

```bash
# DO — re-run the tool from main after merge
git checkout main && git pull --ff-only
python3 tools/sweep-redteam.py --json specs/core-runtime.md  # authoritative

# DO NOT — accept the in-worktree agent claim as the verdict
# (agent ran tool inside worktree CWD; tool scanned main checkout files;
#  worktree-added files were invisible; "0 gaps" reported was vacuous)
```

**BLOCKED rationalizations:** "The tool ran from the worktree CWD, so it must have seen the worktree files" / "The agent reported clean, that's good enough" / "Re-running post-merge is duplicate work" / "We trust the worktree's CI checks".

**Why:** Tools that resolve their workspace root via `Path(__file__).parent.parent` (Python), `cargo locate-project` (Rust), or `package.json` discovery (Node) are bound to whichever checkout owns the SCRIPT BINARY — not the invoker's CWD. Source-of-truth example: `tools/sweep-redteam.py:65` sets `ROOT = Path(__file__).resolve().parent.parent`, so an in-worktree invocation scans the main checkout and reports gaps the worktree's own edits already closed. The post-merge re-run is the only invocation where the script's resolved ROOT and the verified state actually coincide.

### 3b. A Lane Delivered Only When Its Placeholders Are GONE — Existence Is Not Delivery

Rule 3's predicate (`ls` / `Read` the claimed file) discriminates only while a MISSING file means a dead lane. Briefing a lane to write its report SKELETON FIRST ends that: the skeleton is written BEFORE the work, so the file exists whether the lane delivered or died and the check returns the same answer under both hypotheses — a non-discriminating instrument per `instrument-discipline.md` MUST-1, manufactured by the mitigation itself. The parent MUST therefore verify CONTENT: before a lane's output is trusted, aggregated, counted as surface coverage, or its report committed, the unfilled markers — placeholder tokens (`_(pending)_`, `TBD`), a non-terminal `Status:`, an empty verdict / findings / instrument table — MUST ALL be absent. A report still carrying them delivered NOTHING; re-dispatch the lane or do the work inline, and record which. Committing a still-skeletal report without recording it UNDELIVERED is BLOCKED — it converts a dead lane into an artifact that reads as covered.

```bash
# DO — verify the placeholders are GONE; a hit means UNDELIVERED, not "in progress"
grep -nE '_\(pending\)_|^Status:.*(IN PROGRESS|pending)|\bTBD\b' "$report" \
  && echo "LANE UNDELIVERED: $report — re-dispatch or execute inline; do NOT aggregate"

# DO NOT — the existence check skeleton-first silently defeats
[ -s "$report" ] && echo "lane delivered"   # a 296 B all-placeholder skeleton passes this
```

**BLOCKED rationalizations:** "the skeleton-first brief works" (recorded as a settled mitigation in `S22-SWEEP-PCF.md` while three unfilled skeletons sat in that same directory) / "the report exists, Rule 3 is satisfied" / "`Status: IN PROGRESS` means the lane is still working" (the lane has exited; the marker is stale by construction) / "the lane's surface is covered, the write-up is cosmetic" / "the agent reported done, the file is just thin" / "commit it as-is, the next session will fill it in" / "it has a header and section names, so it is not empty".

**Why:** Skeleton-first was adopted to make a lane's silence visible, and it does — but it also guarantees the file exists before any work happens, so it DEFEATS the one check Rule 3 mandates and converts an obvious absence into an artifact that passes review. Measured across one session: four lanes exited leaving reports whose every section was still a placeholder, and the loss surfaced only when a human re-read the files.

#### Trust Posture Wiring (Rule 3b — clause-scoped)

Post-MUST-8-cutoff, so canonical-8-field-compliant; Rules 2–6 stay grandfathered (precedent: Rules 1, 7, 8 here).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every lane report was content-verified before its output was aggregated, its surface counted covered, or the report committed); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — the placeholder vocabulary is brief-defined, so a lexical scan MUST NOT carry `block`.
- **Grace period:** 7 days from clause landing (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (output aggregated or a surface counted covered on an existence check alone; a still-skeletal report committed without being recorded UNDELIVERED) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key (a delivery-verification property is review-layer plus advisory-hook). Named deviation per `trust-posture.md` Rule 8, as Rules 1, 7 and 8 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (gate-review) — reviewer greps each lane report for the placeholder markers and confirms every hit was recorded UNDELIVERED with its disposition. **NO structural detector is claimed and none is deferred** per `hook-output-discipline.md` MUST-5(b): the vocabulary is brief-defined and open, so the signal is irreducibly lexical and detection is PERMANENTLY ADVISORY — booking a Phase-2 detector would promise teeth that cannot arrive. Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/lane-delivery-verification/`. Probes: `.claude/test-harness/probes/worktree-isolation.probes.json` (4 rows, 2 bipolar pairs), registered `scanner: null` in `eval-manifest.json`, pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, dispatched via `/test-harness-probe --artifacts` and NOT in CI — the boundary `instrument-discipline.md` records in full.
- **Violation scope:** Rule 3b ONLY; Rules 2–6 grandfathered, Rules 1, 7, 8 keep their own wiring.
- **Origin:** 2026-08-10 lane-output-loss codification; see § Origin.

### 4. Parallel-Launch Concurrency Is Throttle-Aware Adaptive (Not A Fixed Cap)

When launching multiple Opus-tier agents in one orchestration turn — worktree-isolated OR plain parallel subagents — the parent MUST govern concurrency by an ADAPTIVE back-off model, NOT a fixed number and NOT the runtime's native ceiling. Cold start (no throttle signal yet this session): cap the first wave at **~3 concurrent Opus-tier agents** — NOT the native `min(16, cores−2)` cap (empirically too high; it throttles at sub-quota concurrency) and NOT unlimited. Back off ONLY on the falsifiable signal below; do NOT preemptively serialize below ~3, and do NOT assert "no cap."

**The falsifiable throttle signal (back off ONLY on this):** ≥2 agents in the same wave fail within a **~30–48s synchronized window** AND carry the server string `Server is temporarily limiting requests` with `(not your usage limit)` / `Rate limited`. A single agent dying, an OOM, a timeout, or a quota error saying "usage limit" is NOT this signal and MUST NOT trigger back-off.

```python
# DO — cold-start wave of ~3; back off to waves of 3 ONLY on the synchronized-throttle signal
wave = launch(min(3, len(shards)))          # cold start ~3, NOT native 14, NOT unlimited
# if ≥2 of `wave` die within ~30-48s carrying "(not your usage limit)" → next waves stay ≤3
# else (wave returns clean) → proceed; the SIGNAL is the gate, not a fixed batch number

# DO NOT — trust the runtime's native min(16,cores-2)=14 cap
for shard in shards: launch(shard)          # 2026-06-01: 7 read-only agents synchronized-died ~37-48s
# DO NOT — hardcode "always waves-of-3" when no throttle signal has fired (over-serializes headroom)
```

**BLOCKED rationalizations:** "The runtime's native cap (14) is the ceiling to trust" (FALSE — 7 agents throttled sub-quota) / "It's a quota / usage-limit problem, wait for that signal" (FALSE — the string says `not your usage limit`) / "Always waves-of-3 is the safe rule" (over-serializes low-contention sessions) / "Rate limits only kick in on sustained load" / "If any fail we'll just retry" / "The earlier tests with 4 agents worked fine".

**Why:** The binding constraint is a server-side CONCURRENCY throttle biting far below the native cap — not account quota, not a fixed batch count — so "trust native 14" re-ships the synchronized-burst death while "always ≤3" wastes the multiplier on low-contention sessions. A SUPPRESSED signal is bounded to the cold-start cap: a throughput slowdown, never an over-concurrency breach. Depth (both measurements, the spoofing bound): guide § Rule 4 + journal/0193/0194.

### 5. Pre-Flight Merge-Base Check Before Worktree Launch

Before launching a worktree agent, the orchestrator MUST create the worktree's branch from the current `HEAD` of the feat/main branch the work will merge back into — NOT from a stale commit the agent happens to pick up. The orchestrator MUST verify `git merge-base <new-branch> <target-branch>` equals the CURRENT tip of `<target-branch>` at launch time. Launching without the merge-base check is BLOCKED.

```bash
# DO — pin the base SHA at launch, verify merge-base matches HEAD
target_head=$(git rev-parse feat/kailash-ml-1.0.0-m1-foundations)
git worktree add -b "feat/w31-core-ml-nodes" "$WT_PARENT/w31a" "$target_head"   # sibling, outside the repo
merge_base=$(git merge-base "feat/w31-core-ml-nodes" feat/kailash-ml-1.0.0-m1-foundations)
[ "$merge_base" = "$target_head" ] || { echo "base drift — ABORT"; exit 1; }

# DO NOT — no explicit base (stale tip) AND nested inside the repo (Rule 1 placement)
git worktree add .claude/worktrees/w31a  # branches from whatever HEAD happens to be
```

**BLOCKED rationalizations:** "The worktree defaults handle the base SHA" / "Git will rebase at merge time" / "The packages don't overlap so stale base is fine" / "It worked this time, the failure mode is theoretical".

**Why:** `git worktree add` without explicit base defaults to whatever branch HEAD was last set — can be pre-merge commit from hours ago. Stale-base worktrees merge cleanly only when packages don't overlap; otherwise 3-way merge silently discards one shard's edits. Merge-base check converts invisible drift into loud pre-flight abort. Evidence: 2026-04-23 M10 launch — 5 of 6 worktrees branched from pre-W30-merge SHA. See guide.

### 6. Worktree Branch Name MUST Match Prompt's Declared Name

When the orchestrator prompt specifies a branch name (e.g. `feat/w31-core-ml-nodes`), the worktree MUST be created with that exact branch name — NOT the harness default `worktree-agent-<hash>`. The orchestrator MUST pass `-b <branch>` explicitly to `git worktree add`, AND the agent prompt MUST verify `git rev-parse --abbrev-ref HEAD` matches the declared name before committing.

```python
# DO — explicit branch name on worktree creation
branch = "feat/w31-core-ml-nodes-observability"
subprocess.run(["git", "worktree", "add", "-b", branch, worktree, target_head])  # worktree = sibling
Agent(prompt=f"""Branch: {branch}
STEP 0 — cd first, THEN assert root + branch (never -C, never a bare first rev-parse)
cd "{worktree}" || exit 1
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1
[ "$(git rev-parse --abbrev-ref HEAD)" = "{branch}" ] || exit 1""")

# DO NOT — omit -b (or use the retired flag) and inherit a worktree-agent-<hash> default
Agent(isolation="worktree", prompt="Implement W31... use feat/w31-core-ml-nodes")
```

**BLOCKED rationalizations:** "The branch name is only for bookkeeping" / "Harness default names are fine, I'll rename at merge" / "The prompt mentions the name, the agent will set it" / "Hash-based names are more unique".

**Why:** Branch names are the primary `git log --grep` surface for tracing a shard back to its plan — `feat/w31-core-ml-nodes-observability` surfaces in history; `worktree-agent-aa7fb6a6` surfaces only as meaningless hash. Post-merge audits cannot enumerate "did every planned shard land?" via grep when half use harness defaults. Evidence: 2026-04-23 — 3 of 6 M10 shards got hash-default names; audit had to pull from working-memory table.

### 7. Session/Operator Worktrees Live In A Sibling OUTSIDE The Repo — Never Nested Under `.claude/worktrees/`

Rules 1–6 govern the TRANSIENT **agent-wave** worktree (since Rule 1, an orchestrator-made sibling too). A DURABLE **session/operator** worktree — one a human or session ROOTS INTO across a task — is a DIFFERENT artifact and MUST be created OUTSIDE the repo working tree, as a SIBLING in the MAIN repo's parent dir (`<main-repo-parent>/.<repo-slug>-wt/<name>`), NEVER under the repo's own `.claude/worktrees/` or anywhere below the repo root. The canonical mechanism is **`/worktree`**; a hand-rolled `git worktree add` MUST still obey the placement rule. Root the session by LAUNCHING the CLI with the sibling as cwd (robust), OR — Claude Code only — `EnterWorktree({path: <sibling>})` on FIRST entry. `EnterWorktree({name})` MUST NOT be used for durable session work (it creates under `.claude/worktrees/` — the nesting trap). Every task: branch off `origin/<default>`, PR to main, admin-merge, return.

**Placement is a MUST for any worktree a SESSION ROOTS INTO — the reason is quota, not tidiness.** A nested ROOT duplicates the matching path-scoped set (hundreds of KB per touch; the magnitude is measured, the per-touch digits are INDICATIVE — two independent glob reimplementations disagree ~14%). The requirement binds on PLACEMENT, so it holds whether or not the CLI's loading behaviour changes. Measurement matrix + digits: skill § Ancestor-Load Measurement.

**Scope bound — the quota reason does NOT extend to a dispatched subagent.** MEASURED (2/2, CC 2.1.220): a dispatched subagent inherits the DISPATCHING session's corpus wholesale and receives NO path-scoped injection of its own, so a wave does not itself double-load — its exposure is whatever the dispatching session already carries, which makes rooting THAT session in a sibling the lever (INFERENCE; the composed case was never run). For hand-rolled agent-wave worktrees nobody roots a session at, grounds (b) and (c) below govern, NOT duplication.

```bash
# DO — sibling worktree in the MAIN repo's parent (location-independent even from inside a worktree), PR-to-main loop
main_top=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # main repo top (SHARED .git)
git worktree add -b feat/x "$(dirname "$main_top")/.loom-wt/x" origin/main        # sibling, OUTSIDE the repo
cd "$(dirname "$main_top")/.loom-wt/x" && claude              # launch rooted (or first-entry EnterWorktree({path:...}))
# ...work... → gh pr merge <N> --admin --merge --delete-branch → return, re-cut off origin/main
# Canonical location: <main-repo-parent>/.<slug>-wt/<name> — derived location-independently from the SHARED
# .git via `git-common-dir` (NOT `show-toplevel`, which returns a linked worktree's OWN top → doubly-nested),
# NOT a hardcoded ~/repos; <slug> sanitized for Windows reserved names/trailing dots; dot-prefix hides on
# macOS/Linux and is cosmetic-only (harmless) on Windows.

# DO NOT — nest a session-rooted worktree inside the repo
git worktree add .claude/worktrees/x    ;  EnterWorktree({name: "x"})   # both land under .claude/worktrees/
# → TWO costs, BOTH measured: (1) path-scoped rules arrive TWICE (own + ANCESTOR `.claude/rules/`);
#   (2) the nested checkout sits inside the repo's own `.claude/**` glob range. Both detailed below.
```

**BLOCKED rationalizations:** "`.claude/worktrees/` is the built-in worktree location" (that is for the TRANSIENT agent waves of Rules 1–6, not a session you root into) / "`EnterWorktree({name})` is the tool's intended path" (it creates under `.claude/worktrees/` → nested inside the repo's glob range) / "it's gitignored, so nesting is harmless" (gitignore does NOT stop a parent-repo `grep -r` / a validator run with `--root .` from descending into the nested checkout and pulling a duplicate corpus in as tool output) / "the clutter is only cosmetic" (a full ~24MB nested checkout inside the repo working tree is a real human-org burden and a real recursion target for parent-repo tooling) / "sibling paths clutter the parent dir" (dot-prefixed `<main-repo-parent>/.<slug>-wt/` stays hidden on macOS/Linux and out of the orchestration-root repo enumeration) / "the double-load was already tested and did not reproduce" (the 2026-07-22 test compared aggregate TOKEN COUNTS, an instrument structurally blind to duplication of byte-identical corpora; its conclusion is WITHDRAWN as unsupported — re-test with a root-distinguishing sentinel or do not claim a result) / "the corpora are the same size, so nothing is duplicated" (same size is exactly what loading the same bytes twice from two roots looks like to a size comparison) / "every worktree has its own `.git`, so it must be its own root" (true of `.git` resolution; FALSE of path-scoped rule injection, which was measured to reach up to the ancestor).

**Why:** A session rooted at a NESTED worktree loads path-scoped rules from BOTH roots — measured 2/2 (CC 2.1.220, sentinel probe): the same rule arrived TWICE, and an ancestor-ONLY rule provably absent from the worktree checkout arrived in full, while a SIBLING-rooted session loaded each exactly once with zero ancestor content. `CLAUDE.md` and baseline rules do NOT ancestor-load, which settles the question #1368 left open.

**The methodological lesson — the durable part.** The 2026-07-22 "no double-load" conclusion is **WITHDRAWN as unsupported**, NOT refuted: its aggregate-token-count instrument could not have returned a different answer under either hypothesis, so it was evidence for NEITHER (`evidence-first-claims.md` MUST-3/4). Any re-test MUST use a root-distinguishing instrument — an UNTRACKED sentinel at one root only — never an aggregate size; the committed instrument is `bin/probe-ancestor-load.mjs`, do NOT re-derive it from prose.

The placement conclusion holds a fortiori on THREE grounds: (a) the measured double-load; (b) clutter — a full nested checkout in the working tree; (c) glob range — a nested worktree sits inside the repo's own `.claude/**`, so parent-repo recursive tooling descends into it and pulls a duplicate corpus in as TOOL OUTPUT. The distinction is PLACEMENT; `/worktree` encodes it. Withdrawn-run numbers, sentinel protocol, full matrix: skill § Ancestor-Load Measurement.

#### Trust Posture Wiring (Rule 7 — clause-scoped)

Post-MUST-8-cutoff, so canonical-8-field-compliant; Rules 2–6 stay grandfathered until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (a session-rooted worktree is a sibling outside the repo, never under `.claude/worktrees/`); `advisory` at the hook layer (placement is session-setup judgment — `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days (2026-07-11 → 2026-07-18); the 2026-07-26 measured-placement amendment re-opened its own 7-day grace (→ 2026-08-02).
- **Cumulative posture impact:** same-class violations (a durable session worktree nested below the repo root) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (gate-review) — confirm sibling placement and no `EnterWorktree({name})` for durable work. ADDED 2026-07-26: any review RE-LITIGATING the ancestor-load claim MUST reject an aggregate-size instrument as structurally incapable of detecting duplication and require a root-distinguishing sentinel; a "did not reproduce" from a size comparison is a finding, not a clearance. Phase 2 (deferred) — no hook detector; fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 7 (sibling-placement + the 2026-07-26 amendment) ONLY; Rules 2–6 grandfathered.
- **Origin:** co-owner-directed 2026-07-11 (`journal/0463`). The 2026-07-22 amendment asserted from an aggregate token-count on CC 2.1.216 that no double-load occurs; loom#1368 reported the opposite and named that method's blindness. Re-measured 2026-07-26 on CC 2.1.220 with an untracked-sentinel probe: path-scoped rules DO ancestor-load, `CLAUDE.md` and baseline do NOT (closing #1368's INCONCLUSIVE). The 2026-07-22 conclusion is WITHDRAWN as unsupported, NOT refuted — 2.1.216 is not re-testable here. **Forward-marker:** `journal/0565` records the superseded conclusion and is NOT amended by this change; read it with this Rule-7 body, which supersedes it. Full matrix: skill § Ancestor-Load Measurement.

### 8. Creation Owns Teardown — Reap On Evidence, Never `--force`

Rules 1–7 govern CREATION; nothing governed TEARDOWN, so every wave left its worktrees behind until the volume filled. Teardown is a TWO-TRIGGER obligation; both halves are MUST.

**(a) Per-wave, by the creator.** The orchestrator that created a wave's worktrees MUST reap them at the wave's terminal-lane transition — once each lane is committed AND either merged or preserved on a pushed branch.

**(b) Automatically, as a backstop — SessionEnd reaps, unattended.** (a) fails silently whenever an orchestrator dies mid-wave, the case that leaks most, and an operator-invoked `/sweep` cannot cover "nobody was watching". So `worktree-forest-guard.js` runs the reaper at SessionEnd with `--apply --zero-loss-only` and reports what it removed. It waives nothing: no `--min-age-hours`, no `--only`, no `--force`, so the 12h idle floor and every KEEP guard stand, and TAG-FIRST is left for an operator because its durability would depend on a tag the unattended pass mints unseen. Kill switch `COC_WORKTREE_AUTOREAP=0` (default ON; an unrecognised value stays ON). `/sweep` Sweep 6 remains the audit + TAG-FIRST backstop. Affordance: `node .claude/bin/worktree-reap.mjs` (report-only; `--apply` to reap).

**Removing a worktree does not delete its branch.** `git worktree remove` deletes the DIRECTORY, never `refs/heads/<branch>`, so every COMMITTED commit survives and re-materialises with one `git worktree add <path> <branch>` — that fact, not a judgement about the work's importance, is what ZERO-LOSS rests on. What does NOT survive: anything never committed (no reflog — `rules/git.md` § Destructive Working-Tree Ops) and a DETACHED HEAD no ref reaches (the TAG-FIRST case). Reaping is safe in proportion to committing, which makes Rule 3 load-bearing for TEARDOWN too.

```bash
# DO — the branch is the durable artifact; the directory is disposable
git worktree remove "$wt" && git rev-parse --verify "refs/heads/$branch"  # ref still there
git worktree add "$wt" "$branch"                                          # re-materialised
# DO NOT — treat the directory as the work, or hoard trees to "preserve"
# commits a ref already holds
```

**Why:** An operator who believes removal destroys the work will not reap, and the forest grows to ENOSPC — where the shell commands needed to diagnose it fail too, and in-flight agent writes truncate mid-file into what read as ordinary syntax errors. Stated only inside the paired skill's rate-limit-recovery clause, the fact reached the reader least likely to need it.

**Reap on mechanical evidence, tiered — never on a guess.** Two INDEPENDENT axes both MUST clear: DURABILITY (do the commits survive removal?) and OCCUPANCY (is anyone working there now?). Three verdicts — **ZERO-LOSS** (reap), **TAG FIRST** (tag the detached SHA, then reap), **KEEP** (never reap); evidence per verdict: the paired skill § Teardown.

**`--force` is BLOCKED**, as is checking `git status` and then forcing — state can change between check and removal, and unstaged plus untracked-not-ignored work has NO reflog (`rules/git.md` § Destructive Working-Tree Ops). A bare `git worktree remove` already REFUSES a dirty tree; that refusal IS the mechanism.

```bash
# DO — classify on evidence, report first, reap only what a ref preserves
node .claude/bin/worktree-reap.mjs              # report-only; changes nothing
node .claude/bin/worktree-reap.mjs --apply      # ZERO-LOSS + TAG-FIRST only; KEEP untouched

# DO NOT — force past the refusal, or sweep the forest by path glob
git worktree remove --force "$wt"   ;   rm -rf "$WT_PARENT"/*
```

**BLOCKED rationalizations:** "the branch is unmerged, so the tree must stay" (`git cherry origin/<default> <branch>` decides — `-` means the patch is ALREADY upstream under another name) / "I checked it was clean, so `--force` is safe" / "the next session will clean up" / "the worktree is durable, so it is permanent" (durable means "not deleted BETWEEN tasks"). Full corpus: the paired skill § Teardown.

**Why:** Retiring the auto-cleaning `isolation: "worktree"` flag re-homed creation onto the orchestrator and teardown onto nothing — measured, one clone reached 20 worktrees / 1.0 GB at 83% volume capacity while a corpus grep for `worktree remove|worktree prune` across `.claude/rules/` returned ZERO hits. The asymmetry hid it: every cleanup mention in the paired skill defended work FROM auto-cleanup, so the discipline read complete while being one-sided. Depth: the paired skill § Teardown.

#### Trust Posture Wiring (Rule 8 — clause-scoped)

Post-MUST-8-cutoff, so canonical-8-field-compliant; Rules 2–6 stay grandfathered (precedent: Rules 1, 3b, 7 here).

- **Severity:** `halt-and-report` at gate-review (a session that created wave worktrees either reaped them at the terminal-lane transition or recorded a KEEP verdict per tree with its evidence); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (leaked-vs-held is session-state judgment).
- **Grace period:** 7 days from clause landing (2026-07-30 → 2026-08-06).
- **Cumulative posture impact:** same-class violations (worktrees left with no KEEP evidence; a reap via `--force`/`rm -rf`; Sweep 6 reported complete without the forest audit) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; named deviation per `trust-posture.md` Rule 8, as Rules 1 and 7 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** structural + review. **Phase 2 LANDED** (2026-08-04, `.claude/hooks/worktree-forest-guard.js` + `lib/worktree-forest.js`; superseding this field's former "deferred — no hook detector") and since 2026-08-12 it ENFORCES rather than only reports: PreToolUse(Bash) surfaces the backlog before a new tree is added, SessionEnd reaps ZERO-LOSS unattended. Phase 1 (gate-review) still applies — reviewer runs `node .claude/bin/worktree-reap.mjs --json` and confirms every surviving tree carries a KEEP verdict with a named reason; a ZERO-LOSS tree still on disk after the wave closed is a finding, as is any `--force`/`rm -rf` in the removal path. Suites: `.claude/bin/worktree-reap.test.mjs` (classifier verdict discrimination) + `.claude/test-harness/tests/worktree-forest-guard.test.mjs` (detector + the unattended reap, incl. a real end-to-end removal at the production 12h floor, the kill switch and its fail-direction, and the subprocess-budget regression lock). Fixtures for the placement rules remain at `.claude/audit-fixtures/worktree-session-placement/` (shared with Rules 1 and 7) per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 8 ONLY; Rules 2–6 grandfathered, Rules 1, 3b, 7 keep their own wiring.
- **Origin:** co-owner-directed 2026-07-30 ("why are we not actively clearing worktrees that are completed? Its leaving them behind and we run out of disk space very fast") — a #1370 teardown regression; see § Origin.

### 9. The Stash Stack Is `.git`-SCOPED And SHARED — Never Stash In A Worktree-Carrying Repo

Rules 1–8 govern creation, cwd, delivery and teardown; none covers the SHARED-STATE hazard `git stash` is. **The stash stack lives in the common `.git` dir, so it is shared by the main checkout and EVERY linked worktree** — unlike the index and `HEAD`, which are per-worktree. In a repo carrying any `git worktree add` checkout — this corpus's DEFAULT execution mode — `git stash` MUST NOT be used to park or protect work: a sibling's `git stash pop` applies YOUR entry into ITS tree and drops it, leaving you a merely-clean tree and the sibling a mutation neither authored. Both sides fail SILENTLY. Capture instead to a surface no other checkout can reach — a patch file (`git diff > <path>.patch`; `git add -N .` first for untracked) or a `cp` backup outside the tree.

```bash
# DO — capture to a patch nobody else can pop
git diff > "$SP/wip.patch"   ;   git apply "$SP/wip.patch"
# DO NOT — park on a stack every sibling worktree can list and pop
git stash -u
```

**Why:** Every other parallel-work hazard in this rule is bounded BY the worktree boundary; the stash is the one primitive that reaches ACROSS it, which is why it reads as safe and is not — and why `git stash -u` survived as a recommendation inside the corpus's own destructive-ops rule until a downstream consumer hit it. Capture protocol, both-pole verification, BLOCKED corpus, evidence: `skills/30-claude-code-patterns/worktree-orchestration.md` § Stash Collision In A Shared `.git`.

#### Trust Posture Wiring (Rule 9 — clause-scoped)

Post-MUST-8-cutoff, so canonical-8-field-compliant; Rules 2–6 stay grandfathered (precedent: Rules 1, 3b, 7, 8 here).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm no session parked work on the stash in a worktree-carrying repo); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — a `git stash` invocation IS structurally visible at the Bash boundary, but whether the repo carries linked worktrees is a second lookup the matcher does not perform, so the lexical signal alone MUST NOT carry `block`. The shipped register is `pre-action`, `instruct-and-wait.js`'s NON-BLOCK PreToolUse head — same advisory class, exit 0; `advisory` there renders "the action proceeded", which is false before the call runs (loom#1715 H-1).
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (work parked via `git stash` in a repo carrying linked worktrees; a `git stash pop` taking an entry the session did not create) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; a shared-state-primitive property is review-layer plus advisory-hook, and minting a key would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit. Named deviation per `trust-posture.md` Rule 8, as Rules 1, 7 and 8 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; one ack covers Rules 1–9).
- **Detection mechanism:** structural + review. **Phase 2 LANDED** (2026-08-18, loom#1795), superseding this field's former "deferred" and its `phase2-deferrals.json` row, now deleted: `validate-bash-command.js` pairs a MUTATING `git stash` form with a `git worktree list` count > 1 and emits the non-blocking finding, via `hooks/lib/stash-collision.js` (`selectStashHazard` + `countWorkingTrees`). Reads (`stash list`/`show`) and `stash create` stay SILENT — a guard that trips on INSPECTING gets switched off. Not-measured ⇒ silent, never asserted (`cc-artifacts.md` Rule 7). Fixtures at `.claude/audit-fixtures/worktree-stash-collision/` per `cc-artifacts.md` Rule 9: 40 bipolar cases across a selector arm, a real-hook TWO-worktree arm and a ONE-worktree arm that must go silent; registered in `ci-audit-fixtures.json` (`min_cases: 105`). **What it CANNOT see, stated rather than implied:** a verb produced by `$VAR`/`$(…)`, a shell alias or function, an unresolvable `-C` target, or a stash inside a script file the hook never reads — all outside the Bash-boundary vantage point, so Phase 1 stays the backstop. Phase 1 (gate-review) — reviewer greps the session's command history for `git stash` and, on a hit, confirms `git worktree list` reported only the main checkout at that moment. **A pre-existing sibling this rule does NOT fix, recorded rather than left silent:** `instrument-discipline.md:38` still uses `git stash && pytest -k …` as an establish-the-red example. It is out of THIS lane's scope — that file is held by a concurrent lane — and is surfaced for its owner rather than edited here.
- **Violation scope:** Rule 9 ONLY; Rules 2–6 grandfathered, Rules 1, 3b, 7, 8 keep their own wiring.
- **Origin:** 2026-08-11 — landed at loom via `/sync-from-use` Gate-1 placement of a downstream-relayed upflow entry (`origin: downstream, via: kailash-coc-rs`, manifest idx 100 at pinned SHA `8d141d3d`; hop-level provenance only, the originating consumer deliberately not identified). Its paired entry (idx 99) removed the `git stash -u` endorsement from `git.md` § Destructive Working-Tree Ops in the same change. Both premises were re-verified at loom before placement: the endorsement was present verbatim at `git.md:60`, and this rule's highest heading was Rule 8.

## MUST NOT

- Leave a wave's worktrees on disk once the wave has closed, or reap one by `--force` / `rm -rf` instead of a bare `git worktree remove`

**Why:** Accumulation is unbounded and ends at a full volume; `--force` and `rm -rf` defeat the one refusal that protects unstaged and untracked-not-ignored work, which has no reflog.

- Launch an agent with `isolation: "worktree"` or `EnterWorktree({name})` at all — or dispatch into a pre-made worktree without BOTH pinning its absolute path AND mandating the STEP-0 cwd assertion

**Why:** Both flags place the worktree under the repo's own `.claude/` (Rule 1's quota cost). Retiring them also removes the cwd guarantee they provided, so a dispatch that names the path but does not mandate the assertion leaves nothing pinning the agent anywhere — the 2026-04-19 write-to-main loss.

- Use `git -C <worktree> …`, or a BARE `git rev-parse --show-toplevel`, as the STEP-0 assertion

**Why:** `-C` never establishes cwd — it answers a question about the worktree and leaves the agent in MAIN, so everything after it still resolves to MAIN. A bare `rev-parse` as the FIRST action resolves to MAIN on every dispatch and refuses always. `cd` first, then assert, is the only form that is both runnable and load-bearing.

- Assert by string-comparing `git rev-parse --show-toplevel` against the path the orchestrator passed

**Why:** `--show-toplevel` returns the symlink-RESOLVED path, so any symlinked prefix (`/tmp` → `/private/tmp` on macOS, symlinked homes, Windows junctions) refuses spuriously on a perfectly correct worktree — and an always-refusing check gets deleted. Compare `pwd -P` against `--show-toplevel`, both resolved.

- Park or protect work with `git stash` in a repo carrying any `git worktree add` checkout

**Why:** The stash stack is `.git`-scoped and shared across every linked worktree, so a sibling can list and pop your entry — taking the work silently and leaving your tree merely "clean" (Rule 9).

- Trust an agent's "completion" message when it says "Now let me write…" followed by no tool call

**Why:** Budget exhaustion truncates the write. The completion message is misleading; the filesystem is the source of truth.

- Use `process.cwd()` or relative paths inside specialist agent files that may run in a worktree

**Why:** `process.cwd()` resolves to whatever the Claude Code process was launched with (the main checkout), not the worktree; relative paths inherit the same problem.

Origin: Session 2026-04-19 specialist drift + 2026-04-23 kailash-ml-audit M10 release wave (Rules 4–6) + Rule 2a 2026-06-11 (the Rust SDK journal 0177 § Process note) + Rule 4 reframed 2026-06-01 (F110 / loom#418+#419; journal/0193 + journal/0194) + Rule 1 rewritten 2026-07-26 (loom#1370, owner-escalated: the `isolation: "worktree"` flag RETIRED, half (b)'s STEP-0 assertion added on owner correction) + Rule 8 added 2026-07-30 (co-owner-directed — the THIRD half #1370 left homeless: the retired flag also AUTO-CLEANED, and the rewrite re-homed creation and the cwd assertion but nothing for teardown) + Rule 3b added 2026-08-10 (skeleton-first briefing made Rule 3's existence check NON-DISCRIMINATING; four lanes in one session exited leaving placeholder-only reports, three committed and their surfaces recorded as covered). Depth: guide § Origin; Rule 3b's per-occurrence evidence: skill § Lane-Delivery Verification.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **one-orchestration-contract scope** — this is the single contract an orchestrator consults across a parallel wave's whole lifecycle (placement + cwd assertion → re-assertion → deliverable verification → concurrency → base pinning → branch naming → session placement → teardown), each rule carrying the DO/DO-NOT + `**Why:**` + BLOCKED corpus the meta-rule mandates plus, for the four post-MUST-8 rules (1, 3b, 7, 8), the canonical 8-field Wiring. Splitting it would fracture one lifecycle across files and force cross-rule lookups at every dispatch. Depth is EXTRACTED: `skills/30-claude-code-patterns/worktree-orchestration.md` carries the measurement matrices, recovery protocols, prompt templates and per-occurrence evidence. `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and Rule 10's proximity-band gate does NOT fire. Sibling precedent: `wave-loop.md` + `multi-operator-coordination.md`.
