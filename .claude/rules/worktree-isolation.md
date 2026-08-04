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

Two forms are BLOCKED as the assertion. `git -C <worktree> …` does NOT establish cwd — it answers a question about the worktree while leaving the agent in MAIN, so every later relative path and bare `git` still resolves to MAIN. A BARE `git rev-parse --show-toplevel` as the FIRST action resolves to MAIN on every dispatch (nothing set cwd — that is what retiring the flag gave up), so it refuses always, and an always-refusing check gets deleted by the first person it blocks. Only `cd` FIRST, THEN assert, is both runnable and load-bearing. Pairs with Rule 2a: `cd` at STEP 0 sets the floor, and each later invocation whose correctness depends on location MUST re-assert (cwd can revert mid-session).

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

**Why:** The retired flag is what SET the agent's working directory, and prompt text is NOT a guarantee — so half (b) is the REPLACEMENT for that guarantee, not belt-and-braces. Without it the rule trades a BOUNDED quota burn for UNBOUNDED silent work-loss to the main checkout (recorded, not hypothetical: 2026-04-19, 2 of 3 shards wrote to MAIN, 300+ LOC lost when a zero-commit worktree auto-cleaned). A pre-made SIBLING is STRUCTURALLY immune to the #1370 placement cost — no ancestor `.claude/` exists between a sibling and `~`. **Both defects found while converging this clause were the SAME failure at opposite poles** — a chained `-C`/root-only form that could never FAIL, and a passed-string comparison that could never PASS on a symlinked path; a check that always refuses gets deleted by the first person it blocks just as surely as one that never fires gets trusted, so any future edit to an assertion here MUST state which inputs make it fail AND which make it pass. Depth (the #1370 measurement, the 2026-04-19 post-mortem, why Rules 2–3 are now MORE load-bearing): guide § Rule 1 + skill § Retiring `isolation: "worktree"`.

#### Trust Posture Wiring (Rule 1 — clause-scoped)

Rule 1 is `/codify`-touched here, so it leaves the Rules 1–6 grandfather set and ships canonical-8-field-compliant; Rules 2–6 stay grandfathered until each is itself touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every parallel dispatch went into an orchestrator-made sibling worktree pinned by absolute path, with no `isolation:` flag, AND mandated the STEP-0 bare-`git rev-parse` cwd assertion); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (a dispatch argument is not structurally decidable as agent-wave vs other at tool-call time).
- **Grace period:** 7 days from clause landing (2026-07-26 → 2026-08-02).
- **Cumulative posture impact:** same-class violations (a dispatch carrying `isolation: "worktree"` / `EnterWorktree({name})`; a pre-made-worktree dispatch with no absolute path pinned; a dispatch omitting the STEP-0 assertion mandate; or an assertion written with `git -C <worktree> …`, with a bare first `rev-parse`, or by string-comparing against the passed path) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a dispatch-argument property is review-layer plus advisory-hook; the universal trigger covers it). Named deviation from the key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same disposition Rule 7 and `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any session that dispatched parallel agents, reviewer confirms (i) each worktree path lies OUTSIDE the repo top-level (never under `.claude/worktrees/`), (ii) no dispatch carried an isolation flag, and (iii) each prompt mandates a STEP-0 `cd <worktree>` FOLLOWED BY an assertion that `git rev-parse --show-toplevel` equals `pwd -P` (and is not the main checkout), with an explicit refusal — a `-C`-qualified form, a bare first `rev-parse`, or a string comparison against the passed path are each a finding, not a pass. Phase 2 (deferred) — no hook detector; audit fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` (shared with Rule 7) per `cc-artifacts.md` Rule 9.
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

**BARE is correct HERE and wrong at Rule 1(b) — the difference is POSITION, not the command.** This check runs AFTER cwd is established, where a bare `rev-parse` is the only form that OBSERVES where the agent actually ended up (`-C` would answer about the worktree instead, and a `cd` would re-establish the very thing being tested). At Rule 1(b) nothing has set cwd yet, so the same bare command resolves to MAIN and refuses always. Do NOT "converge" this site onto `cd <wt> && …`; that would make the drift check unable to fail. The `cd` inside the `main=` command substitution is a SUBSHELL used only to resolve the main repo top — it does not move the agent, and removing it reintroduces the symlink false-refusal.

**The main-checkout exclusion is what gives this check teeth.** The root test alone PASSES in MAIN (measured), because MAIN is itself a valid worktree root — so on the Rule 2a path, where cwd silently reverts to MAIN mid-session, the root test would wave through the exact drift this rule exists to catch.

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

### 4. Parallel-Launch Concurrency Is Throttle-Aware Adaptive (Not A Fixed Cap)

When launching multiple Opus-tier agents in one orchestration turn — worktree-isolated OR plain parallel / deterministic-orchestration subagents — the parent MUST govern concurrency by an ADAPTIVE back-off model, NOT a fixed number and NOT the runtime's native ceiling. Cold start (no throttle signal yet this session): cap the first wave at **~3 concurrent Opus-tier agents** — NOT the runtime's native `min(16, cores−2)` cap (empirically too high — it throttles at sub-quota concurrency) and NOT unlimited. Back off to serial waves of ~3 ONLY on the falsifiable throttle signal below; do NOT preemptively serialize below ~3, and do NOT assert "no cap."

**The falsifiable throttle signal (back off ONLY on this):** ≥2 agents in the same launch wave fail within a **~30–48s synchronized window** AND the failure carries the server string `Server is temporarily limiting requests` with `(not your usage limit)` / `Rate limited`. A single agent dying, an OOM, a 2-minute timeout, or a quota error that says "usage limit" is NOT this signal and MUST NOT trigger concurrency back-off.

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

**Why:** The binding constraint is a server-side CONCURRENCY throttle that bites far below the runtime's native cap — NOT account quota and NOT a fixed batch count. Asserting "no cap / trust native 14" re-ships the synchronized-burst death; hardcoding "always ≤3" wastes the throughput multiplier on low-contention sessions. The adaptive model (cold-start ~3, back off on the falsifiable synchronized-death-at-30-48s + `not your usage limit` signal) is neither extreme, and a SUPPRESSED signal is bounded to the cold-start cap — a throughput slowdown, never an over-concurrency breach. Depth (both throttle measurements, the spoofing bound, what the reframe left unchanged): guide § Rule 4 + journal/0193/0194.

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

Rules 1–6 govern the TRANSIENT **agent-wave** worktree — since Rule 1 that is an ORCHESTRATOR-made sibling too (the harness flag that placed it at `.claude/worktrees/<hash>` is retired), still scratch, still auto-cleaned. A DURABLE **session/operator** worktree — one a human or a session ROOTS INTO and works from across a task (parallel development alongside another operator on the same clone) — is a DIFFERENT artifact and MUST be created OUTSIDE the repo working tree, as a SIBLING in the MAIN repo's parent dir (e.g. `<main-repo-parent>/.<repo-slug>-wt/<name>`), NEVER nested under the repo's own `.claude/worktrees/` (or anywhere below the repo root). The canonical mechanism is the **`/worktree` command**; a hand-rolled `git worktree add` MUST still obey the placement rule. Root the session at the sibling by LAUNCHING the CLI with the sibling as cwd (robust — no caveats), OR — under Claude Code only — `EnterWorktree({path: <sibling>})` on FIRST entry from the launch directory (a worktree already in `git worktree list`). `EnterWorktree({name})` MUST NOT be used for durable session work (it creates under `.claude/worktrees/` — the nesting trap; Rule 1 blocks it for agent waves too). Every task: branch off `origin/<default>`, PR to main, admin-merge, return.

**Placement is a MUST for any worktree a SESSION ROOTS INTO — the reason is quota, not tidiness.** A worktree a session roots into (an operator worktree, or one an orchestrator hand-creates and then roots a session at) MUST be a sibling outside the repo, because a nested ROOT duplicates the matching path-scoped set (measured below; at loom a `.claude/rules/**` touch matched 13 rules ≈ 292 KB by a REIMPLEMENTED glob matcher — indicative, not CC's own; an independent reimplementation got 15 rules / 333,521 B, ~14% apart, so treat the magnitude, not the digits). This requirement is STRUCTURAL: it binds on PLACEMENT, so it holds whether or not the CLI's loading behaviour changes.

**Scope bound — the quota reason does NOT extend to a dispatched subagent.** MEASURED (2/2 runs, CC 2.1.220): a subagent dispatched with `isolation: "worktree"` inherits the DISPATCHING session's corpus wholesale (13/13 injected blocks anchored at the parent session's launch root — neither the subagent's own root nor an ancestor of it) and received NO path-scoped injection at all, despite reading files matching three declared globs. So a dispatched wave does not itself double-load; its exposure is whatever the dispatching session already carries. INFERENCE, not separately measured (the composed case was never run): rooting the DISPATCHING session in a sibling is therefore the lever that bounds a wave's cost. For hand-rolled agent-wave worktrees nobody roots a session at, the governing reasons are (b) and (c) below — NOT duplication. Rule 1 nonetheless retires the flag on the independent grounds in its own **Why:**; that retirement neither rests on nor disturbs this measurement.

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

**Why (measured — supersedes the 2026-07-22 amendment, which asserted the opposite):** Sentinel probe, 2026-07-26, CC 2.1.220; full matrix + verbatim repro in `skills/30-claude-code-patterns/worktree-orchestration.md` § Ancestor-Load Measurement. A session rooted at a NESTED worktree loads **path-scoped** rules from BOTH roots — the same rule arrived TWICE under two distinct paths (its own + the ancestor's), and an ancestor-ONLY rule (untracked, therefore provably absent from the worktree checkout — `grep` exit 1) arrived in FULL under the ancestor's path. Reproduced 2/2 runs. A SIBLING-rooted session loaded each rule exactly ONCE, with zero ancestor content. **`CLAUDE.md` and baseline (`priority: 0`) rules do NOT ancestor-load** — this SETTLES the question #1368 left open: an ancestor-only baseline sentinel planted BEFORE the session started never appeared, which excludes the "baseline set is snapshotted at session start" explanation by construction. The quota cost is real in ORDER OF MAGNITUDE (hundreds of KB per touch), NOT in exact digits: a `.claude/rules/agents.md` touch matched 13 path-scoped rules ≈ 292 KB under a REIMPLEMENTED glob matcher — an approximation of CC's, not CC's own. An independent reimplementation got 15 rules / 333,521 B (~14% apart), so the per-touch subset is INDICATIVE. Only the corpus total (74 path-scoped rules, 1,185,700 B) is exact.

**The methodological lesson — the durable part.** The 2026-07-22 amendment's "no double-load" conclusion is **WITHDRAWN as unsupported** — NOT refuted: its aggregate-token-count instrument could not have returned a different answer under either hypothesis (byte-identical corpora make loading twice look like loading once), so it was evidence for NEITHER (`evidence-first-claims.md` MUST-3/MUST-4). Any future re-test of this claim MUST use a root-distinguishing instrument — an UNTRACKED sentinel planted at one root only — never an aggregate size. The committed instrument is `bin/probe-ancestor-load.mjs`; do NOT re-derive it from prose. Depth (the withdrawn run's numbers, the sentinel protocol, the measured matrix): skill § Ancestor-Load Measurement.

The placement conclusion (session/operator worktrees live OUTSIDE the repo) therefore holds a fortiori, on THREE grounds: (a) the measured path-scoped double-load above; (b) clutter — a full nested checkout sits in the working tree; (c) glob range — a nested worktree is inside the repo's own `.claude/**`, so parent-repo recursive tooling (`grep -r`, a validator's `--root .`) descends into it and pulls a duplicate corpus in as TOOL OUTPUT. The distinction is PLACEMENT; `/worktree` encodes it so it is reliable rather than reconstructed each session.

#### Trust Posture Wiring (Rule 7 — clause-scoped)

Rule 7 lands post-`trust-posture.md`-MUST-8-cutoff, so it ships canonical-8-field-compliant; Rules 1–6 remain grandfathered until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`/`security.md`/`git.md`).

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm a session-rooted worktree is a sibling outside the repo, never nested under `.claude/worktrees/`); `advisory` at the hook layer (placement is judgment-bearing over session setup, no structural tool-call signal — `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-07-11 → 2026-07-18); the 2026-07-26 measured-placement amendment re-opens a 7-day grace on its own new obligation (sibling placement wherever author-controlled): 2026-07-26 → 2026-08-02.
- **Cumulative posture impact:** same-class violations (a durable session worktree nested under `.claude/worktrees/` or below the repo root) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a worktree-placement property is review-layer setup judgment; the universal trigger covers it). Named deviation from the key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same disposition `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session that created a session-rooted worktree and confirm sibling placement (path NOT under the repo top-level; NOT under `.claude/worktrees/`) + no `EnterWorktree({name})` for durable work. ADDED 2026-07-26: any review that RE-LITIGATES the ancestor-load claim MUST reject an aggregate-size instrument (token counts, corpus bytes) as structurally incapable of detecting duplication, and require a root-distinguishing sentinel per the § Ancestor-Load Measurement protocol; a "did not reproduce" verdict from a size comparison is a finding, not a clearance. Phase 2 (deferred) — no hook detector; audit fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 7 (session/operator sibling-placement + the 2026-07-26 measured-placement amendment) ONLY; Rules 1–6 stay grandfathered until each is itself `/codify`-touched.
- **Origin:** co-owner-directed origination 2026-07-11 (`journal/0463`); tested evidence (`EnterWorktree({path})` sibling re-root) in that receipt. The 2026-07-22 amendment then asserted, from an aggregate token-count comparison on CC 2.1.216, that no double-load occurs; loom#1368 (filed from a Rust BUILD repo) reported the opposite for path-scoped rules and named the token-count method's blindness. That 2026-07-22 conclusion is WITHDRAWN as unsupported (its instrument cannot detect duplication), NOT refuted — 2.1.216 is not re-testable here. Re-measured at loom 2026-07-26 on CC 2.1.220 with an untracked-sentinel probe (matrix in the skill): path-scoped rules DO ancestor-load and DO arrive twice; `CLAUDE.md` and baseline rules do NOT — the latter settled with a pre-session plant, which closes #1368's own INCONCLUSIVE on baseline. Placement conclusion unchanged; rationale now measured rather than inferred. **Forward-marker:** `journal/0565` records the superseded 2026-07-22 conclusion and is NOT amended by this change — read it together with this Rule-7 body, which supersedes it.

### 8. Creation Owns Teardown — Reap On Evidence, Never `--force`

Rules 1–7 govern CREATION; nothing governed TEARDOWN, so every wave left its worktrees behind until the volume filled. Teardown is a TWO-TRIGGER obligation; both halves are MUST.

**(a) Per-wave, by the creator.** The orchestrator that created a wave's worktrees MUST reap them at the wave's terminal-lane transition — once each lane is committed AND either merged or preserved on a pushed branch.

**(b) Periodically, as a backstop.** `/sweep` Sweep 6 MUST run a forest audit — (a) fails silently whenever an orchestrator dies mid-wave, the case that leaks most. Affordance: `node .claude/bin/worktree-reap.mjs` (report-only; `--apply` to reap).

**Removing a worktree does not delete its branch.** `git worktree remove` deletes the DIRECTORY and the per-worktree administrative files; it never touches `refs/heads/<branch>`. Every COMMITTED commit on a named branch therefore survives removal and re-materialises with a single `git worktree add <path> <branch>` — that fact, not a judgement about the work's importance, is what the ZERO-LOSS verdict rests on, and it is why an operator may reap a forest without adjudicating each tree. What does NOT survive is what was never committed (unstaged modifications and untracked-not-ignored files have NO reflog — `rules/git.md` § Destructive Working-Tree Ops) and a DETACHED HEAD no ref reaches, which is exactly the TAG-FIRST case below. Reaping is safe in proportion to committing, which makes Rule 3's commit-per-milestone discipline load-bearing for TEARDOWN and not only for crash recovery.

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

Rule 8 lands post-`trust-posture.md`-MUST-8-cutoff, so it ships canonical-8-field-compliant; Rules 2–6 stay grandfathered until each is itself `/codify`-touched (precedent: this file's own Rules 1 and 7).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a session that created wave worktrees either reaped them at the terminal-lane transition or recorded a KEEP verdict per tree with its evidence); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (leaked-vs-deliberately-held is judgment-bearing over session state, with no tool-call-time signal).
- **Grace period:** 7 days from clause landing (2026-07-30 → 2026-08-06).
- **Cumulative posture impact:** same-class violations (worktrees left behind with no KEEP evidence; a reap via `--force` or `rm -rf` rather than `git worktree remove`; Sweep 6 reported complete without the forest audit) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (teardown hygiene is review-layer plus advisory-hook; the universal trigger covers it). Named deviation from the key-per-clause shape, recorded per `trust-posture.md` Rule 8 — as Rules 1 and 7 took.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any session that created worktrees, reviewer runs `node .claude/bin/worktree-reap.mjs --json` and confirms every surviving tree carries a KEEP verdict with a named reason; a ZERO-LOSS tree still on disk after the wave closed is a finding, as is any `--force` / `rm -rf` in the removal path. Phase 2 (deferred) — no hook detector; fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` (shared with Rules 1 and 7) per `cc-artifacts.md` Rule 9. Classifier discrimination is locked by `.claude/bin/worktree-reap.test.mjs` (one positive-control fixture per verdict).
- **Violation scope:** Rule 8 ONLY; Rules 2–6 stay grandfathered, Rules 1 and 7 keep their own wiring above.
- **Origin:** co-owner-directed 2026-07-30 ("why are we not actively clearing worktrees that are completed? Its leaving them behind and we run out of disk space very fast") — a #1370 teardown regression; see § Origin.

## MUST NOT

- Leave a wave's worktrees on disk once the wave has closed, or reap one by `--force` / `rm -rf` instead of a bare `git worktree remove`

**Why:** Accumulation is unbounded and ends at a full volume; `--force` and `rm -rf` defeat the one refusal that protects unstaged and untracked-not-ignored work, which has no reflog.

- Launch an agent with `isolation: "worktree"` or `EnterWorktree({name})` at all — or dispatch into a pre-made worktree without BOTH pinning its absolute path AND mandating the STEP-0 cwd assertion

**Why:** Both flags place the worktree under the repo's own `.claude/` (Rule 1's quota cost). Retiring them also removes the cwd guarantee they provided, so a dispatch that names the path but does not mandate the assertion leaves nothing pinning the agent anywhere — the 2026-04-19 write-to-main loss.

- Use `git -C <worktree> …`, or a BARE `git rev-parse --show-toplevel`, as the STEP-0 assertion

**Why:** `-C` never establishes cwd — it answers a question about the worktree and leaves the agent in MAIN, so everything after it still resolves to MAIN. A bare `rev-parse` as the FIRST action resolves to MAIN on every dispatch and refuses always. `cd` first, then assert, is the only form that is both runnable and load-bearing.

- Assert by string-comparing `git rev-parse --show-toplevel` against the path the orchestrator passed

**Why:** `--show-toplevel` returns the symlink-RESOLVED path, so any symlinked prefix (`/tmp` → `/private/tmp` on macOS, symlinked homes, Windows junctions) refuses spuriously on a perfectly correct worktree — and an always-refusing check gets deleted. Compare `pwd -P` against `--show-toplevel`, both resolved.

- Trust an agent's "completion" message when it says "Now let me write…" followed by no tool call

**Why:** Budget exhaustion truncates the write. The completion message is misleading; the filesystem is the source of truth.

- Use `process.cwd()` or relative paths inside specialist agent files that may run in a worktree

**Why:** `process.cwd()` resolves to whatever the Claude Code process was launched with (the main checkout), not the worktree; relative paths inherit the same problem.

Origin: Session 2026-04-19 specialist drift + 2026-04-23 kailash-ml-audit M10 release wave (Rules 4–6) + Rule 2a 2026-06-11 (the Rust SDK journal 0177 § Process note) + Rule 4 reframed 2026-06-01 (F110 / loom#418+#419; journal/0193 + journal/0194) + Rule 1 rewritten 2026-07-26 (loom#1370, owner-escalated: the `isolation: "worktree"` flag RETIRED, half (b)'s STEP-0 assertion added on owner correction) + Rule 8 added 2026-07-30 (co-owner-directed — the THIRD half #1370 left homeless: the retired flag also AUTO-CLEANED, and the rewrite re-homed creation and the cwd assertion but nothing for teardown). Full per-rule provenance + post-mortem evidence: guide § Origin.
