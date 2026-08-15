# Worktree Isolation — Extended Evidence and Examples

Companion reference for `.claude/rules/worktree-isolation.md`. Holds
extended post-mortem prose, full example code blocks, and session
evidence for Rules 1–6 that would exceed the 200-line rule budget.

## Rule 1 — Dispatch Into A Pre-Made Sibling Worktree

Extended example with complete creation + verification protocol:

```bash
# STEP A (orchestrator, once per wave) — derive the SIBLING parent, location-independently.
# --git-common-dir resolves the SHARED .git even when run from inside a linked worktree;
# --show-toplevel would return a worktree's OWN top and doubly-nest.
main_top=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
slug=$(basename -s .git "$(git remote get-url origin)")
WT_PARENT="$(dirname "$main_top")/.${slug}-wt"        # sibling of the repo, NEVER under it
mkdir -p "$WT_PARENT"

# STEP B (per shard) — explicit -b (Rule 6) + explicit base SHA (Rule 5) + sibling path (Rule 1)
git worktree add -b "feat/shard-abc" "$WT_PARENT/shard-abc" "$(git rev-parse origin/main)"
```

```python
# STEP C — dispatch with NO isolation flag; the path is now known, so pin it
worktree = f"{WT_PARENT}/shard-abc"
Agent(
    prompt=f"""
Working directory: {worktree}

STEP 0 — FIRST action, before reading or writing anything. cd, THEN assert:

  cd "{worktree}" || {{ echo "STOP: cannot enter {worktree}"; exit 1; }}
  top=$(git rev-parse --show-toplevel) || {{ echo "STOP: not a git repo"; exit 1; }}
  [ "$top" = "$(pwd -P)" ] || {{ echo "STOP: not a worktree ROOT (top=$top)"; exit 1; }}
  main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
  [ "$top" != "$main" ] || {{ echo "STOP: this IS the main checkout"; exit 1; }}
  git rev-parse --abbrev-ref HEAD          # expect the branch you were given

`cd` FIRST is load-bearing. `git -C {worktree} …` never establishes cwd, so
everything after it still resolves to MAIN; a BARE rev-parse as the first action
resolves to MAIN and refuses on every dispatch. Compare RESOLVED paths (`pwd -P`),
never the string that was passed — `--show-toplevel` resolves symlinks, so a
symlinked prefix refuses on a perfectly correct worktree.

On any STOP, REFUSE to proceed; do NOT fall back to the main checkout.

Every path you write MUST resolve inside {worktree} — absolute rooted there, or
relative with cwd pinned there. An absolute path rooted anywhere else is BLOCKED.
""",
)

# DO NOT — the retired harness flag
Agent(
    isolation="worktree",
    prompt="Implement feature X — use the ml-specialist patterns.",
)
# Two failures at once. (1) PLACEMENT: the harness creates
# <repo>/.claude/worktrees/agent-<id>, nested under the repo's own .claude/ —
# #1370's reported 88,895 duplicate tokens per agent per wave.
# (2) DRIFT: with no pinned path the agent starts in process.cwd() (main
# checkout), edits main's tree, reports success. Worktree empty; main half-done.

# DO NOT — sibling named, assertion NOT mandated. This is the NEW trap the
# retirement creates: the flag used to SET cwd, and prompt text does not.
Agent(prompt=f"Working directory: {worktree}\nImplement feature X.")
```

**Why (extended):** Two independent costs, and the retired flag incurred both.

**Placement.** The flag put every agent worktree under the repo's own `.claude/`. loom#1370 reports an agent rooted there loads path-scoped rules from BOTH its own `.claude/rules/` and the ancestor repo's — a floor of 88,895 tokens / 355,581 B per agent per wave, ~35.6M per wave round at 40 terminals × 10 agents, every token re-loading a corpus already in context. A sibling is structurally immune: no ancestor `.claude/` exists between a sibling directory and `~`. See `skills/30-claude-code-patterns/worktree-orchestration.md` § Retiring `isolation: "worktree"` for why this holds without reconciling #1370 against loom's own subagent measurement (Rule 7 § scope bound).

**Drift — and why the STEP-0 assertion is MANDATORY, not optional.** The flag created the worktree but did not pin every tool call inside it, and because the HARNESS chose the path the orchestrator could not pin what it did not know — file-writing tools accepting absolute paths wrote to the main checkout instead. In the 2026-04-19 session, ml-specialist, dataflow-specialist, and kaizen-specialist each drifted back to the main tree at least once; the corruption was only caught by `git status` after the fact.

The flag did, however, SET the agent's cwd. Retiring it gives that up, and a prompt line naming a directory is a request, not a mount point. So the mandated STEP-0 assertion is the REPLACEMENT for that guarantee, not an extra layer: without it the retirement would trade a bounded quota burn for the unbounded write-to-main loss above (2 of 3 shards; 300+ LOC gone to auto-cleanup). Pre-making the worktree makes the path knowable; the bare-`rev-parse` assertion makes the agent's actual location observable; together they convert silent corruption into a loud refusal. `rules/worktree-isolation.md` Rule 2 (in-agent-file self-check) and Rule 3 (post-exit verify) are the layers underneath, and both matter more now than they did under the flag.

## Rule 2 — Specialist Self-Verify

Full specialist agent file pattern:

```markdown
# DO — self-check baked into the agent file

## Step 0: Working Directory Self-Check

Before any file edit — AFTER Rule 1(b)'s STEP-0 `cd` — run BARE (no `-C`):

    top=$(git rev-parse --show-toplevel)
    [ "$top" = "$(pwd -P)" ] || STOP              # at a worktree root
    main=$(cd "$(dirname "$(git rev-parse --path-format=absolute \
      --git-common-dir)")" && pwd -P)
    [ "$top" != "$main" ] || STOP                 # ...and NOT the main checkout
    git rev-parse --abbrev-ref HEAD

The main-checkout exclusion is load-bearing: the root test ALONE passes in
MAIN, because MAIN is itself a valid worktree root. If either check fails,
STOP and emit "worktree drift detected — refusing to edit main checkout".
Do NOT fall back to process.cwd().

# DO NOT — assume orchestrator pinned cwd

## Step 1: Read the task

Read the prompt, start editing files…
```

**Why (extended):** The orchestrator's pinned-path instruction can be lost to context compression across long delegation chains; a self-check inside the specialist file survives prompt truncation. Once Rule 1 retired the flag that used to set cwd, this stopped being belt-and-braces and became the last layer underneath the prompt. Verified cost: one git call (~30 ms). Verified benefit: prevents the ml-specialist / dataflow-specialist / kaizen-specialist drift that shipped during the 2026-04-19 session.

**Why BARE here, when Rule 1(b) forbids a bare first `rev-parse`.** The difference is POSITION, not the command. This check runs AFTER cwd is established, and a bare `rev-parse` is the only form that OBSERVES where the agent actually ended up — `-C` would answer about the worktree instead, and wrapping it in a `cd` would re-establish the very thing under test, making the drift check unable to fail. At Rule 1(b) nothing has set cwd yet, so the identical command resolves to MAIN and refuses on every dispatch. Do not converge the two sites onto one form. (The `cd` inside the `main=` command substitution is a subshell used only to resolve the main repo top; it does not move the agent.)

**Why the main-checkout exclusion, not just the root test.** Measured on a two-root repo: at the MAIN checkout, `--show-toplevel` equals `pwd -P`, so the root test PASSES there. MAIN is a valid worktree root. Since the drift this check exists to catch is precisely a mid-session revert TO MAIN (Rule 2a), the root test alone would wave it through. The `--git-common-dir` comparison is what makes the check able to fail in the case that matters.

## Rule 3 — Parent Verify Deliverables

```python
# DO — verify after agent returns
result = Agent(prompt=f"Write {worktree}/src/feature.py...")   # worktree = pre-made sibling
assert_file_exists(f"{worktree}/src/feature.py")  # parent checks

# DO NOT — trust "done" and proceed
result = Agent(prompt="...")
# Parent commits based on result.completion_message without ls
```

**Why (extended):** Agents hit their budget mid-message and emit "Now let me write X..." without having written X. The 2026-04-19 session saw 2 occurrences (kaizen round 6, ml-specialist round 7); both reported success, both produced zero files. An `ls` check is O(1) and converts "silent no-op" into "loud retry".

## Rule 4 — Parallel-Launch Concurrency (cold-start ~3, adaptive back-off)

**Reframed 2026-06-01 (F110 / loom#418+#419):** the fixed "waves of ≤3" cap this section originally taught is NOT the rule. The rule is a cold start of ~3 with back-off ONLY on a falsifiable synchronized-throttle signal — see `rules/worktree-isolation.md` Rule 4 and `skills/30-claude-code-patterns/worktree-orchestration.md` Rule 6 for the signal definition and the BLOCKED corpus. The 2026-04-23 evidence below is what established that the runtime's native cap is too high; it is not authority for a fixed batch number.

Full example with wave pattern:

```python
# DO — wave of 3, wait, then next wave (each shard's sibling worktree pre-made per Rule 1)
# Every prompt below opens with STEP 0 verbatim (shown once here, elided in the bodies
# for width) — the assertion is what replaces the retired flag's cwd guarantee:
#   cd "{WT_PARENT}/<shard>" && [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1
wave1 = [
    Agent(prompt=f"Working directory: {WT_PARENT}/W31a ... W31a+d ..."),
    Agent(prompt=f"Working directory: {WT_PARENT}/W31b ... W31b ..."),
    Agent(prompt=f"Working directory: {WT_PARENT}/W31c ... W31c ..."),
]
# wait for wave1 to complete (or fail) before launching wave2
wave2 = [
    Agent(prompt=f"Working directory: {WT_PARENT}/W32a ... W32a ..."),
    Agent(prompt=f"Working directory: {WT_PARENT}/W32b ... W32b ..."),
    Agent(prompt=f"Working directory: {WT_PARENT}/W32c ... W32c ..."),
]

# DO NOT — burst of 6 simultaneous Opus worktree agents
for shard in [W31a, W31b, W31c, W32a, W32b, W32c]:
    Agent(prompt=f"... {shard} ...")
# ↑ all 6 rate-limited at 34-45s, zero commits across all worktrees,
#   every shard's work is lost. Empirical: 2026-04-23 M10 launch.
```

**Why (extended):** Anthropic's server-side throttle on simultaneous Opus session starts is not documented as a hard limit, but empirically 4–6 concurrent Opus worktree agents from one parent exceeds it and every agent in the burst dies before committing. Recovery is worse than serialization: the orchestrator MUST re-launch every failed shard, and without commits (see § Rule 5) there is no partial-progress to salvage. Waves of ≤3 complete cleanly; the latency cost of waiting one wave is strictly less than the cost of a full re-launch plus orphan recovery.

**Evidence:** kailash-ml-audit 2026-04-23 M10 launch — 6 Opus worktree agents (`ab9c2f7213c4a82ab`, `ae2f048829aa941a2`, `af15e0f9c3f2d16a3`, `a823d7ed912137852`, `a0e76f0996d1d9a4e`, `ad10591aa614deeae`) launched simultaneously, ALL 6 died at 34–45s with rate-limit error; fallback waves of 3 (`a506217c8640af1c0`, `a0831fc0ca6b9f6ae`, `a1027b84cb7c4f9d2` + `aa7fb6a6`, `a69473b3`, `aaecc695`) all completed and merged successfully.

### The 2026-06-01 reframe — why the cap became adaptive (depth for the rule's Rule-4 `**Why:**`)

The binding constraint is a server-side CONCURRENCY throttle that bites far below the runtime's native cap — NOT account quota, and NOT a fixed batch count. Both extremes are wrong: asserting "no cap / trust the native 14" re-ships the synchronized-burst death, while hardcoding "always ≤3" wastes the throughput multiplier on low-contention sessions.

**Both throttle measurements.** 2026-04-23 M10 (above): 6 agents synchronized-died at 34–45s; waves-of-3 ran clean. 2026-06-01 loom#419: 7 READ-ONLY agents synchronized-died at ~37–48s carrying the verbatim string `(not your usage limit) · Rate limited` — sub-quota, which is what falsified #418's "trust the native cap (14)"; re-run as waves-of-3, 7/7 returned. Receipts: `journal/0193` (ablation + throttle evidence), `journal/0194` (F110 DECISION).

**Why the signal cannot be gamed, and what a suppressed one costs.** The back-off signal originates at the Anthropic server boundary, not anywhere repo-controllable, so an in-repo actor cannot spoof it. The worst case of a SUPPRESSED signal is bounded by the cold-start cap of ~3 — there is no back-off below an already-safe ceiling, so the failure mode is a throughput slowdown, never an over-concurrency breach.

**What the reframe left unchanged.** Worktree isolation per compiling agent — the whole of the rest of the rule — is RETAINED verbatim. Only the concurrency-governance mechanism was reframed, from the hardcoded "waves of ≤3" cap to the throttle-aware adaptive model.

## Rule 5 — Pre-Flight Merge-Base Check

Full bash example:

```bash
# DO — pin the base SHA at launch, verify merge-base matches HEAD
target_branch="feat/kailash-ml-1.0.0-m1-foundations"
target_head=$(git rev-parse "$target_branch")
git worktree add -b "feat/w31-core-ml-nodes" "$WT_PARENT/w31a" "$target_head"   # sibling (Rule 1)
merge_base=$(git merge-base "feat/w31-core-ml-nodes" "$target_branch")
[ "$merge_base" = "$target_head" ] || { echo "base drift — ABORT"; exit 1; }

# DO NOT — stale default base AND nested inside the repo (both wrong)
git worktree add .claude/worktrees/w31a  # branches from whatever HEAD happens to be
# Agent's branch now forks from an OLD commit; merge silently picks
# either side on conflicts; package overlap = data loss.
```

**Why (extended):** `git worktree add` without an explicit base defaults to whatever branch HEAD was last set — which for a long-running session can be a pre-merge commit from hours ago. Worktrees created from a stale base merge cleanly ONLY when the packages they touch don't overlap; the moment two shards touch the same `pyproject.toml`, same `__init__.py`, or same CHANGELOG, the 3-way merge silently discards one shard's edits (see `rules/agents.md` § "MUST: Worktree Orchestration", Rule 5 in `skills/30-claude-code-patterns/worktree-orchestration.md`). The merge-base check converts an invisible drift risk into a loud pre-flight abort.

**Evidence:** kailash-ml-audit 2026-04-23 M10 launch — 5 of 6 worktrees branched from `899ce3e5` (pre-W30-merge), only 1 branched from feat tip `41a217dc`. Worked this time only because packages didn't overlap; failure mode is permanent until structurally prevented.

## Rule 6 — Worktree Branch Name Matches Prompt

Full example:

```python
# DO — explicit branch name on worktree creation
worktree = f"{WT_PARENT}/w31a"          # sibling outside the repo (Rule 1)
branch = "feat/w31-core-ml-nodes-observability"
subprocess.run(["git", "worktree", "add", "-b", branch, worktree, target_head])
Agent(
    prompt=f"""Working directory: {worktree}
Branch: {branch}

STEP 0 — verify branch name matches:
  cd "{worktree}" || {{ echo "cannot enter worktree"; exit 1; }}
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || {{ echo "cwd drift"; exit 1; }}
  actual=$(git rev-parse --abbrev-ref HEAD)     # after the cd, never -C
  [ "$actual" = "{branch}" ] || {{ echo "branch-name drift"; exit 1; }}
""",
)

# DO NOT — the retired flag; harness default assigns worktree-agent-<hash>
Agent(isolation="worktree", prompt="Implement W31... use feat/w31-core-ml-nodes")
# ↑ 3 of 6 shards in the M10 launch ended up on worktree-agent-<hash>
#   branches because the prompt name-reference didn't force creation.
#   Post-merge grep for feat/w31-* missed those three. Pre-making the worktree
#   with -b (Rule 1) removes the harness from the naming path entirely.
```

**Why (extended):** Branch names are the primary `git log --grep` surface for tracing a shard back to its plan — `feat/w31-core-ml-nodes-observability` instantly surfaces in history; `worktree-agent-aa7fb6a6` surfaces only as a meaningless hash. When half the shards in a release wave use harness-default names, post-merge audits cannot enumerate "did every planned shard land?" via grep — they have to cross-reference the worktree list (which has already been auto-cleaned).

**Evidence:** kailash-ml-audit 2026-04-23 — 3 of 6 M10 shards honored `feat/<shard>` names (`feat/w31-core-ml-nodes-observability`, `feat/w31b-dataflow-ml-bridge`, `feat/w31c-nexus-ml-bridge`, `feat/w33b-migration-readme-regression`) while 3 got `worktree-agent-aa7fb6a6`, `worktree-agent-a69473b3`, `worktree-agent-aaecc695`, `worktree-agent-aa8e8995`, `worktree-agent-af0e8132`. Audit had to pull from the orchestrator's working-memory table.

## Relationship To Other Rules

- `rules/agents.md` § "MUST: Worktree Orchestration" (Rule 1 in `skills/30-claude-code-patterns/worktree-orchestration.md`) — companion rule; the worktree-isolation file is the verification layer for the isolation directive there.
- `rules/zero-tolerance.md` Rule 2 — a completed-looking file that doesn't exist is a stub under a different name.
- `rules/testing.md` § "Verified Numerical Claims In Session Notes" — same principle, applied to file deliverables.

## Origin

Session 2026-04-19 — ml-specialist, dataflow-specialist, and kaizen-specialist each drifted back to the main tree during PRs #502-#508; kaizen round 6 and ml-specialist round 7 reported "Now let me write X..." completions with no actual file writes. The self-verify + parent-verify protocol closed both failure modes. Rules 4–6 added 2026-04-23 from the kailash-ml-audit M10 release wave (6-agent burst rate-limit + 5-of-6 stale-base-SHA + 3-of-6 branch-name-default).

Rule 2a added 2026-06-11 — the Rust SDK `journal/0177` § Process note: cwd silently reverted to the main checkout mid-session, and a "3× green" validation had therefore run against unpatched main code rather than the worktree's patch.

Rule 4 reframed 2026-06-01 (F110 / loom#418 + #419) from the hardcoded "Waves of ≤3" cap to the throttle-aware adaptive model. #419's 7-read-only-agent synchronized throttle — sub-quota, verbatim `(not your usage limit)` — falsified #418's "trust the native cap (14)". Receipts: `journal/0193` (ablation + throttle evidence), `journal/0194` (F110 DECISION). Full reframe depth: § Rule 4 above.

Rule 1 rewritten 2026-07-26 (loom#1370, owner-escalated): `isolation: "worktree"` is RETIRED in favour of an orchestrator-made SIBLING worktree pinned by absolute path — the flag placed every agent worktree under the repo's own `.claude/`, which #1370 reports costs 88,895 duplicate tokens per agent per wave (~35.6M per wave round at 40 terminals × 10 agents) in the reporting repo. Half (b), the mandated STEP-0 cwd assertion, was added in the same cycle on owner correction: the flag was ALSO what set the agent's working directory, so retiring it without a prompt-mandated assertion would have traded a bounded quota burn for the unbounded write-to-main loss already recorded at 2026-04-19 (2 of 3 shards to MAIN, 300+ LOC lost to auto-cleanup). Every example in this file is updated to that form — the examples above are the CURRENT protocol, not a historical record. Where a retired-flag call still appears it is a labelled DO-NOT or a dated quotation of what the 2026-04-19 / 2026-04-23 sessions actually ran.

Rule 8 added 2026-07-30 (co-owner-directed) as the THIRD half loom#1370 left homeless: the retired flag also AUTO-CLEANED its worktree, and the Rule-1 rewrite re-homed creation onto the orchestrator and the cwd assertion into the prompt, but nothing at all onto teardown. Measured at 20 worktrees / 1.0 GB (83% volume capacity) on one canon clone, with zero `worktree remove` / `worktree prune` hits anywhere in `.claude/rules/`. Teardown depth: `skills/30-claude-code-patterns/worktree-orchestration.md` § Teardown.
