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

Agents launched with `isolation: "worktree"` run in their own git worktree so parallel compile/test jobs do not fight over the same `target/` or `.venv/`. The isolation is only real if the agent actually edits files inside its assigned worktree path. When an agent drifts back to the main checkout — because the system prompt didn't pin cwd, because absolute paths were copied from the orchestrator, because the tool defaulted to `process.cwd()` — the isolation silently breaks.

This rule mandates a self-verification step at agent start AND a pre-flight check in the orchestrator's delegation prompt. The verification is cheap (one `git status`) and the failure mode is expensive (a whole session's worth of parallel work corrupted).

## MUST Rules

### 1. Orchestrator Prompts MUST Pin The Worktree Path

Any delegation that uses `isolation: "worktree"` MUST include the absolute worktree path in the prompt AND MUST instruct the agent to verify `git -C <worktree> status` at the start of its run. Passing the isolation flag without the explicit path is BLOCKED.

```python
# DO — explicit path + verification instruction
worktree = "/absolute/path/to/repo/.claude/worktrees/agent-shard-abc123"
Agent(isolation="worktree", prompt=f"""
Working directory: {worktree}
STEP 0 — verify: git -C {worktree} status
If branch mismatch, STOP and report "worktree isolation broken".
All file paths MUST be absolute and begin with {worktree}/.
""")

# DO NOT — isolation flag without pinned path
Agent(isolation="worktree", prompt="Implement feature X — use ml-specialist patterns.")
```

**BLOCKED rationalizations:** "The isolation flag handles the cwd for me" / "The tool sets up the worktree automatically" / "I'll just use relative paths, they're shorter" / "The agent will figure out the right directory" / "I tested it once, it worked — should keep working".

**Why:** The `isolation: "worktree"` flag creates the worktree but does not pin every tool call inside it — file-writing tools accepting absolute paths will write to the main checkout if the prompt uses a main-checkout path. One-line verification at agent start converts silent corruption into a loud refusal. See guide for 2026-04-19 post-mortem.

### 2. Specialist Agents MUST Self-Verify Cwd At Start

Every specialist agent file (`.claude/agents/**/*.md`) that may be launched with `isolation: "worktree"` MUST include a "Working Directory Self-Check" step at the top of its process section. The check prints the resolved cwd and the git branch, and refuses to proceed if either is unexpected.

```markdown
# DO — self-check baked into the agent file

## Step 0: Working Directory Self-Check

Before any file edit, run:
git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
If top-level path does NOT match worktree path, STOP and emit
"worktree drift detected — refusing to edit main checkout".

# DO NOT — assume orchestrator pinned cwd
```

**Why:** The orchestrator's pinned-path instruction can be lost to context compression across long delegation chains; a self-check inside the specialist file is a belt-and-suspenders guarantee that survives prompt truncation. One git call (~30 ms) prevents specialist drift.

### 2a. Re-Assert Cwd Per Invocation — `cd` Persistence Is Not Trustworthy

The Rule-2 self-check at agent START is necessary but not sufficient: the shell's cwd can silently revert to the MAIN checkout mid-session after tool-mediated file operations. A relative-path patch then resolves against the wrong checkout and "succeeds" — edits land on main's copy, the worktree's code never changes, and a subsequent test run prints green against the UNPATCHED code (a vacuous pass). Any worktree command whose correctness depends on which checkout it runs in (apply patch, run tests, grep for the edit) MUST re-assert location in the same invocation (`git -C <worktree> …`, or `cd <worktree> && pwd && …`) — not rely on a `cd` from an earlier call.

```bash
# DO — location asserted in the SAME invocation as the operation
cd "$WT" && git rev-parse --show-toplevel && <run-tests/apply-patch>

# DO NOT — trust an earlier cd; relative paths may now resolve against main
<run-tests>     # cwd silently reverted → tests main's old code, prints green
```

**BLOCKED rationalizations:** "I cd'd at the start of the session" / "the prior command ran in the worktree, so this one will" / "the test passed, the patch must have applied".

**Why:** The false-green is worse than a failure — it converts an unapplied patch into institutional "validated" state. Evidence: kailash-rs journal 0177 § Process note (2026-06-10) — a "3× green" validation had silently run in the main checkout after cwd reverted; the explicit `cd` + re-run produced the real 3/3 FAIL that exposed an O(n²) regression. Pairs with Rule 3a (checkout-bound tools): 3a covers tools rooted at the script's own location; this clause covers the invoking shell's cwd.

### 3. Parent MUST Verify Deliverables Exist After Agent Exit

When an agent reports completion of a file-writing task, the parent orchestrator MUST verify the claimed files exist at the worktree path via `ls` or `Read` before trusting the completion claim. Agent completion messages are NOT evidence of file creation.

```python
# DO — verify after agent returns
result = Agent(isolation="worktree", prompt=f"Write {worktree}/src/feature.py...")
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

**Why:** The binding constraint is a server-side CONCURRENCY throttle that bites far below the runtime's native cap — NOT account quota and NOT a fixed batch count. Asserting "no cap / trust native 14" re-ships the synchronized-burst death; hardcoding "always ≤3" wastes the throughput multiplier on low-contention sessions. The adaptive model (cold-start ~3, back off on the falsifiable synchronized-death-at-30-48s + `not your usage limit` signal) is neither extreme. Worktree isolation per compiling agent — the rest of this rule — is RETAINED unchanged; only the concurrency-governance mechanism is reframed. The back-off signal originates at the Anthropic server boundary (not repo-controllable), so an in-repo actor cannot spoof it; the worst case of a SUPPRESSED signal is bounded to the cold-start cap of ~3 (no back-off below an already-safe ceiling — a throughput slowdown, never an over-concurrency breach). Evidence: 2026-04-23 M10 (6 agents synchronized-died 34–45s; waves-of-3 clean) + 2026-06-01 #419 (7 read-only agents synchronized-died ~37–48s, verbatim `(not your usage limit) · Rate limited`; waves-of-3 → 7/7 returned). See guide + journal/0193/0194.

### 5. Pre-Flight Merge-Base Check Before Worktree Launch

Before launching a worktree agent, the orchestrator MUST create the worktree's branch from the current `HEAD` of the feat/main branch the work will merge back into — NOT from a stale commit the agent happens to pick up. The orchestrator MUST verify `git merge-base <new-branch> <target-branch>` equals the CURRENT tip of `<target-branch>` at launch time. Launching without the merge-base check is BLOCKED.

```bash
# DO — pin the base SHA at launch, verify merge-base matches HEAD
target_head=$(git rev-parse feat/kailash-ml-1.0.0-m1-foundations)
git worktree add -b "feat/w31-core-ml-nodes" ".claude/worktrees/w31a" "$target_head"
merge_base=$(git merge-base "feat/w31-core-ml-nodes" feat/kailash-ml-1.0.0-m1-foundations)
[ "$merge_base" = "$target_head" ] || { echo "base drift — ABORT"; exit 1; }

# DO NOT — let the worktree default to a stale branch tip
git worktree add .claude/worktrees/w31a  # branches from whatever HEAD happens to be
```

**BLOCKED rationalizations:** "The worktree defaults handle the base SHA" / "Git will rebase at merge time" / "The packages don't overlap so stale base is fine" / "It worked this time, the failure mode is theoretical".

**Why:** `git worktree add` without explicit base defaults to whatever branch HEAD was last set — can be pre-merge commit from hours ago. Stale-base worktrees merge cleanly only when packages don't overlap; otherwise 3-way merge silently discards one shard's edits. Merge-base check converts invisible drift into loud pre-flight abort. Evidence: 2026-04-23 M10 launch — 5 of 6 worktrees branched from pre-W30-merge SHA. See guide.

### 6. Worktree Branch Name MUST Match Prompt's Declared Name

When the orchestrator prompt specifies a branch name (e.g. `feat/w31-core-ml-nodes`), the worktree MUST be created with that exact branch name — NOT the harness default `worktree-agent-<hash>`. The orchestrator MUST pass `-b <branch>` explicitly to `git worktree add`, AND the agent prompt MUST verify `git rev-parse --abbrev-ref HEAD` matches the declared name before committing.

```python
# DO — explicit branch name on worktree creation
branch = "feat/w31-core-ml-nodes-observability"
subprocess.run(["git", "worktree", "add", "-b", branch, worktree, target_head])
Agent(isolation="worktree", prompt=f"""Branch: {branch}
STEP 0 — actual=$(git -C {worktree} rev-parse --abbrev-ref HEAD)
[ "$actual" = "{branch}" ] || exit 1""")

# DO NOT — let harness default assign worktree-agent-<hash>
Agent(isolation="worktree", prompt="Implement W31... use feat/w31-core-ml-nodes")
```

**BLOCKED rationalizations:** "The branch name is only for bookkeeping" / "Harness default names are fine, I'll rename at merge" / "The prompt mentions the name, the agent will set it" / "Hash-based names are more unique".

**Why:** Branch names are the primary `git log --grep` surface for tracing a shard back to its plan — `feat/w31-core-ml-nodes-observability` surfaces in history; `worktree-agent-aa7fb6a6` surfaces only as meaningless hash. Post-merge audits cannot enumerate "did every planned shard land?" via grep when half use harness defaults. Evidence: 2026-04-23 — 3 of 6 M10 shards got hash-default names; audit had to pull from working-memory table.

## MUST NOT

- Launch an agent with `isolation: "worktree"` without passing the absolute worktree path in the prompt

**Why:** The isolation flag alone does not guarantee every tool call stays inside the worktree — the prompt is the only place the agent learns where it belongs.

- Trust an agent's "completion" message when it says "Now let me write…" followed by no tool call

**Why:** Budget exhaustion truncates the write. The completion message is misleading; the filesystem is the source of truth.

- Use `process.cwd()` or relative paths inside specialist agent files that may run in a worktree

**Why:** `process.cwd()` resolves to whatever the Claude Code process was launched with (the main checkout), not the worktree; relative paths inherit the same problem.

Origin: Session 2026-04-19 specialist drift + 2026-04-23 kailash-ml-audit M10 release wave (Rules 4–6) + Rule 2a 2026-06-11 (kailash-rs journal 0177 § Process note — cwd silently reverted to main mid-session, a "3× green" validation had run against unpatched main code). See guide for full post-mortem evidence. Rule 4 reframed 2026-06-01 (F110 / loom#418+#419) from the hardcoded "Waves of ≤3" cap to the throttle-aware adaptive model — #419's 7-read-only-agent synchronized throttle (sub-quota, `not your usage limit`) falsified #418's "trust the native cap (14)"; receipts journal/0193 (ablation + throttle evidence) + journal/0194 (F110 DECISION).
