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

# STEP B (per LANE) — explicit -b (Rule 6) + explicit base SHA (Rule 5) + sibling path (Rule 1)
git worktree add -b "feat/shard-abc" "$WT_PARENT/shard-abc" "$(git rev-parse origin/main)"
```

```python
# STEP C — dispatch EACH agent the lane carries with NO isolation flag; the path is now known, so pin it
# (several agents share {worktree} under rules/wip-discipline.md MUST-9 — never a worktree each)
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

The flag did, however, SET the agent's cwd. Retiring it gives that up, and a prompt line naming a directory is a request, not a mount point. So the mandated STEP-0 assertion is the REPLACEMENT for that guarantee, not an extra layer: without it the retirement would trade a bounded quota burn for the unbounded write-to-main loss above (2 of 3 shards; 300+ LOC gone to auto-cleanup). Pre-making the worktree makes the path knowable; the `cd`-then-assert STEP-0 form makes the agent's actual location observable; together they convert silent corruption into a loud refusal. `rules/worktree-isolation.md` Rule 2 (in-agent-file self-check) and Rule 3 (post-exit verify) are the layers underneath, and both matter more now than they did under the flag.

## Rule 1 — The Unit Is The LANE, Not The Agent

Added 2026-09-12 under `journal/0607` decision 5 (co-owner-directed: "The ceilings explicitly bind
worktrees and branches AND NOT AGENTS"). Rule 1 used to read as one orchestrator-made worktree per
parallel AGENT. That charged every added agent against the WIP ceiling — the coupling the directive
rejects — and in practice pushed orchestrators to brief each lane as a single serial worker.

**What Rule 1 now governs.** The orchestrator creates one sibling worktree per LANE (worktree +
branch, the unit `rules/wip-discipline.md` counts). Every agent the lane dispatches is briefed into
that one tree with the absolute-path pin and the STEP-0 assertion, and the lane's agents are kept
apart by `rules/wip-discipline.md` MUST-9's partition contract rather than by further trees. Opening
a further worktree for an agent inside a lane is BLOCKED.

**Why a second worktree is the wrong remedy for build contention.** The cargo lock that motivated
per-agent worktrees is on the TARGET DIRECTORY, not on the checkout, so a per-agent
`CARGO_TARGET_DIR` (or the toolchain's equivalent output-directory setting) removes the contention
inside one tree. The extra worktree is a second tree and a second branch against the ceiling for
work that ships as one PR, plus a merge to reconcile.

**What did NOT change.** Sibling placement, the retired flag, the absolute-path pin, the STEP-0
cd-then-assert form and its BLOCKED variants hold exactly as before; they now describe how a LANE's
worktree is created and how each agent entering it asserts its location.

**Terminology in Rules 3b, 4a and 10 (2026-09-12).** Those rules were written when each dispatched
agent had its own worktree, and they said "lane" for that one agent. Under `rules/wip-discipline.md`
MUST-9 a lane is a worktree + branch carrying many agents, so the two readings collided. The three
rules, their Wiring blocks and this extract now say "agent" / "dispatched agent" wherever they meant
the one agent, and keep "lane" only for the worktree + branch. Rule 4a(4) therefore briefs "every
lane's committer" — the one agent MUST-9 lets commit, which under the old one-agent-per-tree model
was every dispatched agent. No obligation moved: each clause binds the same actor as before, named
without the collision. Proper names keep their historical form: the `lane-delivery-verification`
fixture directory, the `lane-output-loss` codification, the `S22-*` lane IDs, and the probe ids.
The skill section these rules point at is now § Agent-Delivery Verification. The renames were paid
for by moving Rule 3b's BLOCKED-entry gloss (the `S22-SWEEP-PCF.md` settled-mitigation record) into
that skill section. Measured with `check-rule-injection-budget.mjs` on the 2026-09-12 lane working
tree: this rule's per-rule movement +1798 B → +1754 B, `loom-skill-edit` profile 390,024 B →
389,980 B; MUST / MUST NOT / BLOCKED / `**Why:**` / Wiring counts unchanged (95 / 12 / 24 / 22 / 56,
`check-descoping.mjs::extractInventory`).

**Probes.** The bipolar `RULE-1-lane-unit-firing` pair in this rule's suite and
`MUST-Worktree-Orchestration-lane-unit-firing` in `agents.md`'s suite share their candidates:
`.claude/audit-fixtures/agents/flag-lane-agents-given-separate-worktrees.txt` and
`.claude/audit-fixtures/agents/clean-lane-agents-share-partitioned-worktree.txt`. Both poles create
the lane tree correctly and state the same cargo-lock sentence, separating ONLY on whether the remedy
is a second worktree or a per-agent build directory. Registration buys DISPATCHABILITY, never
execution: no workflow invokes the dispatcher.

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
# DO — wave of 3, wait, then next wave (each shard here is a one-agent LANE, its sibling worktree
#       pre-made per Rule 1; the ~3 cold-start cap counts AGENTS, the WIP ceiling counts LANES)
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

**What the reframe left unchanged.** Worktree isolation — the whole of the rest of the rule — was RETAINED verbatim by that reframe; only the concurrency-governance mechanism changed, from the hardcoded "waves of ≤3" cap to the throttle-aware adaptive model. The unit of isolation has since moved from the compiling agent to the LANE (§ "Rule 1 — The Unit Is The LANE, Not The Agent").

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

## Rule 1 — Drift Causes And The Canonical STEP-0 Assertion

Extracted from the rule body 2026-08-19 (structural cleanup; the rule keeps Rule 1(a)/(b)'s MUST
clauses, its BLOCKED corpus, its DO/DO-NOT block and its `**Why:**` line verbatim).

**The three drift causes the rule's preamble names.** An agent drifts back to the main checkout
because the system prompt didn't pin cwd, because absolute paths were copied from the orchestrator,
or because the tool defaulted to `process.cwd()`. The verification the rule mandates is cheap (one
`git status`) and the failure mode is expensive (a whole session's worth of parallel work corrupted).

**The canonical five-line assertion form** (the runnable realization of Rule 1(b)'s "MUST compare
RESOLVED paths (`pwd -P`, not the passed string) and MUST reject the main checkout" — moved here as
runnable detail; the same root + main-checkout pair is shown in the rule's Rule-2 DO block):

```bash
cd "$WT" || { echo "STOP: cannot enter $WT"; exit 1; }
top=$(git rev-parse --show-toplevel) || { echo "STOP: not a git repo"; exit 1; }
[ "$top" = "$(pwd -P)" ]  || { echo "STOP: not a worktree ROOT (top=$top)"; exit 1; }
main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
[ "$top" != "$main" ]     || { echo "STOP: this IS the main checkout"; exit 1; }
```

## Rule 2 — Why BARE Here, And Why The Main-Checkout Exclusion

Extracted from the rule body 2026-08-19. The rule keeps the position rule and its `Do NOT
"converge"` prohibition; the argument for it lives here.

**Why BARE is correct at Rule 2 and wrong at Rule 1(b).** This check runs AFTER cwd is established,
where a bare `rev-parse` is the only form that OBSERVES where the agent ended up; at Rule 1(b)
nothing has set cwd, so the same command refuses always.

**Why the main-checkout exclusion, measured.** The root test alone PASSES in MAIN (measured — MAIN
is itself a valid worktree root), so on the Rule 2a path, where cwd silently reverts mid-session, it
would wave through the exact drift this rule catches. Had the exclusion been absent and the
measurement come out the other way — i.e. had `--show-toplevel` differed from `pwd -P` at the main
checkout — the root test alone would have sufficed and this clause would not exist.

## Rule 2a — How The Silent Revert Produces A False Green

Extracted from the rule body 2026-08-19. The rule keeps the MUST, its BLOCKED corpus and its
`**Why:**` line. **The MUST was AMENDED 2026-09-15 and this line was stale for it** — it read
"re-assert location in the same invocation", which is verbatim the phrasing the amendment narrowed
and which the next section quotes as WHAT WAS WRONG. Corrected here rather than left, because a
reader hit the superseded contract nine lines before the correction. The current obligation: a
REFUSING `cd` on its own line, carrying a non-empty guard and the main-checkout exclusion, opening
every location-dependent invocation and repeated on each later one.

A relative-path patch resolves against the wrong checkout and "succeeds" — edits land on main's
copy, the worktree's code never changes, and a subsequent test run prints green against the
UNPATCHED code (a vacuous pass).

### Rule 2a — The 2026-09-15 Per-Line Amendment (Origin, And What Was NOT Claimed)

**What was wrong, stated precisely.** Rule 2a mandated re-asserting location "in the same
invocation" and named two acceptable forms: `git -C <worktree> …`, or `cd <worktree> && pwd && …`.
Both bind a COMMAND. `git -C` binds one git call and no non-git command at all; `cd X && op` binds
the chain it joins. Neither binds the INVOCATION — and a brief body, or an agent's own bash call,
is routinely multi-line. So line 1 was protected and every line below it ran at whatever cwd the
shell actually held. The incident: a lane's shell silently relocated, and a teardown on an
unprotected later line destroyed work — unrecoverable, because unstaged modifications and
untracked-not-ignored files have no reflog (`git.md` § Destructive Working-Tree Ops).

**What was explicitly NOT claimed, and why that matters.** The amendment does NOT say the `&&` form
is broken, and an earlier framing of this work that did say so was refuted by this corpus's own
measurement. `cd X && op` short-circuits correctly: a failed `cd` makes the chain false and `op`
never runs. The four-case probe table at
`skills/30-claude-code-patterns/worktree-orchestration.md` measured `-C` and `cd &&` rejecting
exactly the same bad inputs, and that result stands — it was taken over a SINGLE command, which is
the scope it reports on and the only scope it reports on. Rewriting a measured result to agree with
a rule would have been the defect, not the fix. The true statement is narrower and is what the
clause now carries: the `&&` binds its own chain and nothing below it.

**What the amendment does NOT narrow.** The corpus's deliberate TWO-POSITION split survives intact
— STEP 0 ESTABLISHES the location (which `-C` can never do), and each later invocation
RE-ESTABLISHES it. Only the FORM of the second position changed: from a per-command pin to a
refusing `cd` on its own line. A reader who takes the amendment as collapsing the two positions has
over-read it.

**The first fence this amendment shipped FAILED OPEN, and two independent reviewers caught it.**
Recorded rather than smoothed, because it is the more instructive half. The replacement fence was
`cd "$WT" || exit 1` followed by the root test — and BOTH lines fail open. MEASURED in bash, zsh and
sh: `cd ""` returns **0** and does not move, so an unset or empty `$WT` clears line 1. And the root
test ALONE passes in MAIN, because MAIN is itself a worktree root — which the rule's own Rule 2
`# DO NOT` block states twenty lines above, and which § "The main-checkout exclusion is what gives
this check teeth" explains. Composed: an agent at MAIN with `$WT` empty clears both assertions and
then patches, tests and TEARS DOWN in MAIN — verbatim the incident the clause exists to prevent,
reached through the clause's own exemplar. The lesson generalises past this fence: a refusal is only
a refusal if EVERY operand can make it fire, and a form copied from a neighbouring position inherits
that position's assumptions. The corrected fence carries a non-empty guard plus the canonical
`--git-common-dir` main-checkout exclusion, and the short two-line form is now itself a `# DO NOT`.

**Corpus reach — the first count was an UNDERCOUNT.** The amendment initially named three mirror
sites. The sweep that followed found **five** fail-open fences plus one shipped `Agent(prompt=…)`
template carrying no refusal at all, and two exemplar briefs whose later commit steps inherited
STEP 0's refusal rather than carrying their own — the exact practice the amendment forbids, inside
the file that states the prohibition. All were reconciled. Left deliberately alone, each for a
position-specific reason: `worktree-isolation.md`'s "do NOT converge Rule 2's site onto
`cd <wt> && …`" prohibition (it governs Rule 2's BARE in-agent-file check); Rule 4a's recovery recipe
and the operator `cp`-backup protocols (they run in MAIN by design, so a fence would be wrong); and
genuinely single-command invocations, which remain compliant. Note that
`quota-pause-and-rescue-hygiene.md`'s `cd "$wt" && check_…` — cited in an earlier revision here as a
compliant example — is a `# DO NOT` fence entry blocked for an unrelated reason, so citing it as
evidence of compliance was reading an instrument for a question it was not built for; the claim is
withdrawn.

**Why no Phase-2 detector is booked.** The clause splits on mechanizability. Whether an invocation
holds ≥2 top-level lines, and whether its first establishes cwd by `&&`-chain rather than by a
refusal, is decidable off a real shell parse — structural, so declaring the clause permanently
advisory would be false. Whether a given later line's correctness DEPENDS on which checkout it runs
in is not decidable that way, so a detector on the structural half alone would fire on benign
multi-line commands. No detector is BUILT and none is booked AS A DEFERRAL — the non-fence is DATED
instead, at `phase2-deferrals.json::acknowledged_non_deferrals["worktree-isolation.md#rule-2a-per-line-refusal"]`,
the bucket six sibling clauses in the rule file already use. That row is what discharges
`completion-criterion.md` MUST-6: a declared omission is a RESIDUAL whether or not it is written
down, so deleting the note would hide it rather than discharge it. The structural half is a live
detector CANDIDATE proposed to the platform owner rather than a scheduled fence.

**Superseded readings, moved here 2026-10-01 from the rule body's wiring field (injection-budget
pass).** Three corrections were previously recorded inline in the rule:

- On the `**Severity:**` cap: "An earlier revision of this field cited MUST-2 the other way round and
  is corrected here." MUST-2 caps a LEXICAL signal, and this one is parsed, so the cap comes from the
  judgment-bearing semantic conjunct instead.
- On the booking question: "An earlier revision of this field argued the opposite — that booking
  nothing AT ALL was correct because a deferral is not self-accepting — which inverted MUST-6 and
  left `phase2-deferral-integrity.mjs` RED; the acceptor question governs an EXPIRY, which this row
  deliberately does not claim."
- On the semantic tier: the rule now reads "a declared gap with an expiry rather than a bare
  UNCOVERED", where an earlier revision of that line had claimed the bare UNCOVERED was the honest
  state.

## Rule 3b — Probe Registration And The CI Boundary

Extracted from the rule body's Rule-3b Trust-Posture-Wiring `**Detection mechanism:**` field
2026-08-19; the field keeps its normative statement (Phase-1 gate-review procedure, the
permanently-advisory declaration, and the scanner / fixtures / probes binding).

`.claude/test-harness/probes/worktree-isolation.probes.json` carries 8 rows in 4 bipolar pairs as
counted from that file on 2026-09-12 (the RULE-3b, RULE-4a and RULE-1-lane-unit firing pairs plus the
RULE-3b meta pair — re-count from the file rather than citing this figure),
registered `scanner: null` in `eval-manifest.json`, pinned in
`probe-suite-integrity.test.mjs::PINNED_SUITES`, dispatched via `/test-harness-probe --artifacts`
and NOT in CI — the boundary `instrument-discipline.md` records in full. Registration buys
DISPATCHABILITY, never automatic execution: a green CI run is never evidence these probes passed.

## Rule 7 — Ancestor-Load Scope Bound (Measured)

Extracted from the rule body 2026-08-19; the rule keeps the placement MUST and the scope-bound
statement.

**The per-touch digits are INDICATIVE, not exact.** A nested ROOT duplicates the matching
path-scoped set at hundreds of KB per touch; the magnitude is measured, but the per-touch digits are
indicative — two independent glob reimplementations disagree ~14%. The requirement binds on
PLACEMENT, so it holds whether or not the CLI's loading behaviour changes.

**The subagent scope bound, and where measurement stops and inference starts.** MEASURED (2/2, CC
2.1.220): a dispatched subagent inherits the DISPATCHING session's corpus wholesale and receives NO
path-scoped injection of its own, so a wave does not itself double-load — its exposure is whatever
the dispatching session already carries, which makes rooting THAT session in a sibling the lever
(INFERENCE; the composed case was never run). Had the 2/2 measurement gone the other way — a
subagent receiving its OWN path-scoped injection — the quota reason WOULD have extended to every
dispatched wave and Rule 7's placement mandate would have had to cover hand-rolled agent-wave
worktrees on duplication grounds rather than on grounds (b) and (c).

## Rule 7 — The Nested-Worktree Guard, Measured At Loom 2026-08-19

Extracted from the rule body 2026-08-19, VERBATIM. The rule keeps the two-override-channel MUST, the
receipt-vs-env-var normative statement, and a re-measure warning; the measurement and its
instruments live here. **Whether the guard is present is MUTABLE deployment state — re-measure it
rather than citing this section.**

**Why the env var alone does not answer the MUST NOT** (mechanism, moved from the rule body): a hook
inherits the CLI parent's environment and a shell `export` dies with the child shell, so an env-only
override is unreachable from inside a session, i.e. documented but not usable at the moment the
block fires.

**Measured at loom (2026-08-19): the guard IS present here, and it honors both channels.**
`grep -rn 'nested-worktree-guard' .claude/` returns hits in `.claude/hooks/nested-worktree-guard.js`,
`.claude/settings.json` (registered on the `PreToolUse` matcher `Task|Agent|EnterWorktree`),
`.claude/sync-manifest.yaml`, `.claude/audit-fixtures/nested-worktree-guard/` and
`.claude/test-harness/ci-audit-fixtures.json`. It refuses a delegation carrying
`isolation: "worktree"` and an `EnterWorktree` whose RESOLVED target is a nested placement, at
`severity: block` on the structural parameter-value + resolved-path-ancestry signal
`hook-output-discipline.md` MUST-2 permits — discriminating on the resolved target rather than on
which key carries it, as that section requires. Measured the same day:
`node .claude/audit-fixtures/nested-worktree-guard/run.mjs` reports 35/35 cases matching expectation
and `--mutation-check` 13/13 mutants killed. Both overrides are implemented — the one-shot receipt at
`.claude/worktree-authz/nested-worktree-allow` (CONSUMED as it is honored, so an override cannot
silently disarm the gate for later calls) and `COC_ALLOW_NESTED_WORKTREE=1` — each surfacing an
`advisory` into the agent-visible context, so no override is silent. `.claude/worktree-authz/` exists
and is EMPTY: no standing override is in force. **This supersedes the earlier same-day measurement**
recording zero hits, an absent `worktree-authz/`, and a REVIEW-LAYER-ONLY posture; that reading was
true when written and was falsified hours later by the guard landing — re-measure rather than citing
either line.

**The falsifying context, stated so the numbers are readable.** The instrument for presence is the
`grep -rn 'nested-worktree-guard' .claude/` sweep: had the guard been absent it would have returned
ZERO hits, which is exactly what the superseded earlier same-day measurement recorded — so the
instrument demonstrably discriminates, and both poles of it were observed on the same tree hours
apart. The instrument for correctness is the fixture runner: had the guard mis-discriminated (keyed
on `name`-without-`path`, or compared lexical rather than resolved paths) `run.mjs` would have
reported fewer than 35/35 cases matching expectation, and had the fixtures been vacuous
`--mutation-check` would have reported fewer than 13/13 mutants killed. `.claude/worktree-authz/`
being EMPTY is the reading that says no standing override is in force; a non-empty directory would
have said one was.

## Rule 7 — Wiring Origin: The Withdrawn 2026-07-22 Measurement

Extracted from the Rule-7 Trust-Posture-Wiring `**Origin:**` field 2026-08-19; the field keeps its
provenance statement and the `journal/0565` forward-marker.

The 2026-07-22 amendment asserted from an aggregate token-count on CC 2.1.216 that no double-load
occurs; loom#1368 reported the opposite and named that method's blindness. Re-measured 2026-07-26 on
CC 2.1.220 with an untracked-sentinel probe: path-scoped rules DO ancestor-load, `CLAUDE.md` and
baseline do NOT (closing #1368's INCONCLUSIVE). The 2026-07-22 conclusion is WITHDRAWN as
unsupported, NOT refuted — 2.1.216 is not re-testable here, and an aggregate size comparison could
not have returned a different answer under either hypothesis, so it was evidence for NEITHER. Full
matrix: `skills/30-claude-code-patterns/worktree-orchestration.md` § Ancestor-Load Measurement.

## Rule 8 — The Unattended SessionEnd Reaper

Extracted from Rule 8(b) 2026-08-19, and re-extracted 2026-10-01 (injection-budget pass funding the
`coc-owner.json` ownership contract); the rule keeps every MUST, the normative contract
(NOT-MINE IS A REFUSAL, the no-session-identity refusal, creation-records-ownership,
reap-on-delivery), the kill switch, and the `/sweep` Sweep-6 backstop.

**The invocation shape, moved here 2026-10-01 verbatim from the rule body.** So
`worktree-forest-guard.js` runs `worktree-reap.mjs` at SessionEnd with
`--apply --zero-loss-only --reap-owned-by <this session>` and reports what it removed; it waives
nothing but the idle floor for a tree this session created, and TAG-FIRST is left for an operator.
The pass books no `--min-age-hours`, no `--only`, no `--force`, so every KEEP guard stands and
TAG-FIRST stays an operator action because its durability would depend on a tag the unattended pass
mints unseen. Affordance: `node .claude/bin/worktree-reap.mjs` (report-only; `--apply` to reap).

**Creation and the ownership record, moved here 2026-10-01 verbatim from the rule body.** Every
orchestration path creates with `--create`, which locks the tree and writes the creating session
into the per-worktree git dir (`coc-owner.json`, plus a `coc-session=` token in the lock reason).
"Reap on delivery" is `--deliver <path>`: unlock, reap on evidence, re-lock if KEPT.

**How the record is RESOLVED — read off `worktree-reap.mjs`, not inferred.** `adminDirFor()`
(`.claude/bin/worktree-reap.mjs`, the `OWNER_FILE = "coc-owner.json"` / `SESSION_REASON_RE =
/(?:^|\s)coc-session=([^\s]+)/` block) reads `<path>/.git` — a FILE for a linked worktree — and takes
its `gitdir:` line as the per-worktree admin dir, falling back to
`<git-common-dir>/worktrees/<basename>` only when that file is unreadable (a prunable tree whose
directory is already gone). Nothing reconstructs the path from a basename, so the read survives any
layout and any reader cwd. The `coc-session=<id>` fallback lives in the lock reason, which git
stores at `<per-worktree git dir>/locked` and prints as `locked <reason>` in
`git worktree list --porcelain`; it is consulted only when the owner record is absent, and only to
ACCEPT a tree as ours. Absent means NOT ours — the fail-closed direction, never a vacancy.

Why (a) alone is insufficient: an operator-invoked `/sweep` cannot cover "nobody was watching", and
the orchestrator-dies-mid-wave case is the one that leaks most.

**Extracted from Rule 8 2026-09-13 (paired extraction funding the citation-restoration pass).** The
rule body keeps the mechanism — a worktree's removal deletes the DIRECTORY, never
`refs/heads/<branch>`, so committed work re-materialises and ZERO-LOSS rests on that, while
never-committed work and a detached HEAD no ref reaches do NOT survive. The generalization that
moved here: reaping is safe in proportion to committing, which is what makes Rule 3 (commit and push
incrementally) load-bearing for TEARDOWN and not only for crash-recovery.

## Rule 8 — Wiring Detection And Origin Depth

Extracted from the Rule-8 Trust-Posture-Wiring `**Detection mechanism:**` and `**Origin:**` fields
2026-08-19; both fields keep their normative statements.

**What the two suites pin.** `.claude/bin/worktree-reap.test.mjs` pins classifier verdict
discrimination; `.claude/test-harness/tests/worktree-forest-guard.test.mjs` pins the detector and the
unattended reap, including a real end-to-end removal at the production 12h floor, the kill switch
and its fail-direction, and the subprocess-budget regression lock. Consumer note: neither suite ships
to use/base, build/base, use/py, build/py, use/rs or build/rs (MEASURED: `skip` on all six), so no
consumer receives them and at those targets the suites are not a live gate — what DOES reach every
lane is the guard and the reaper themselves, both on `ALWAYS_INCLUDE`.

**Superseded reading.** The Detection field formerly read "deferred — no hook detector"; the
2026-08-04 landing of `.claude/hooks/worktree-forest-guard.js` + `lib/worktree-forest.js` superseded
it, and the 2026-08-12 change moved it from reporting to enforcing.

**Verbatim originating directive (co-owner, 2026-07-30):** "why are we not actively clearing
worktrees that are completed? Its leaving them behind and we run out of disk space very fast".

## Rule 9 — Wiring Depth (Severity, Detection, Origin)

Extracted from the Rule-9 Trust-Posture-Wiring block 2026-08-19; the Severity, Detection-mechanism
and Origin fields keep their normative statements in the rule body.

**Why the shipped register is `pre-action`, not `advisory`.** The shipped register is `pre-action`,
`instruct-and-wait.js`'s NON-BLOCK PreToolUse head — same advisory class, exit 0; `advisory` there
renders "the action proceeded", which is false before the call runs (loom#1715 H-1).

**Fixture arms.** `.claude/audit-fixtures/worktree-stash-collision/` carries 40 bipolar cases across
a selector arm, a real-hook TWO-worktree arm and a ONE-worktree arm that must go silent; the
`worktree-stash-collision` runner is registered in `ci-audit-fixtures.json` with `min_cases: 105`.

**What the detector CANNOT see, stated rather than implied:** a verb produced by `$VAR`/`$(…)`, a
shell alias or function, an unresolvable `-C` target, or a stash inside a script file the hook never
reads — all outside the Bash-boundary vantage point, so Phase 1 stays the backstop.

**A pre-existing sibling this rule does NOT fix, recorded rather than left silent:**
`instrument-discipline.md` still uses `git stash && pytest -k …` as an establish-the-red example. It
was out of that lane's scope — the file was held by a concurrent lane — and is surfaced for its owner
rather than edited there.

**Origin depth.** Landed at loom 2026-08-11 via `/sync-from-use` Gate-1 placement of a
downstream-relayed upflow entry (`origin: downstream, via: kailash-coc-rs`, manifest idx 100 at
pinned SHA `8d141d3d`; hop-level provenance only, the originating consumer deliberately not
identified). Its paired entry (idx 99) removed the `git stash -u` endorsement from `git.md`
§ Destructive Working-Tree Ops in the same change. Both premises were re-verified at loom before
placement: the endorsement was present verbatim in `git.md`, and this rule's highest heading was
Rule 8 — had either premise failed, the entry would have been placed differently or not at all.

## Origin Chain — Per-Rule Provenance

Extracted from the rule body's `Origin:` line 2026-08-19. **AMENDED 2026-09-13 (injection-budget
pass): the dated chain itself now lives HERE, not in the rule**, which keeps a one-line `Origin:`
plus this pointer per `rule-authoring.md` MUST-6. The chain, verbatim as the rule carried it:

> Session 2026-04-19 specialist drift + 2026-04-23 kailash-ml-audit M10 release wave (Rules 4–6) +
> Rule 2a 2026-06-11 + Rule 4 reframed 2026-06-01 (F110 / loom#418+#419) + Rule 1 rewritten
> 2026-07-26 (loom#1370, owner-escalated) + Rule 8 added 2026-07-30 (co-owner-directed) + Rule 3b
> added 2026-08-10 + Rule 9 landed 2026-08-11 + Rule 4a added 2026-08-20 (co-owner-directed,
> receipt-first `journal/0584`) + Rule 1's unit made the LANE 2026-09-12 (`journal/0607`).

Per-rule narratives, in the order the rules landed:

- **Rules 1–3 (2026-04-19)** — specialist drift: ml-specialist, dataflow-specialist and
  kaizen-specialist each drifted back to the main tree during PRs #502–#508; kaizen round 6 and
  ml-specialist round 7 reported "Now let me write X…" completions with no actual file writes.
- **Rules 4–6 (2026-04-23)** — the kailash-ml-audit M10 release wave: a 6-agent burst rate-limit, a
  5-of-6 stale-base-SHA launch, and 3-of-6 harness-default branch names.
- **Rule 2a (2026-06-11)** — the Rust SDK `journal/0177` § Process note: cwd silently reverted to the
  main checkout mid-session, so a "3× green" validation had run against unpatched main code.
- **Rule 4 reframed (2026-06-01, F110 / loom#418+#419)** — from the hardcoded "waves of ≤3" cap to
  the throttle-aware adaptive model. Receipts `journal/0193` (ablation + throttle evidence) and
  `journal/0194` (F110 DECISION).
- **Rule 1 rewritten (2026-07-26, loom#1370, owner-escalated)** — the `isolation: "worktree"` flag
  RETIRED; half (b)'s STEP-0 assertion added on owner correction, because the flag was ALSO what set
  the agent's working directory.
- **Rule 8 added (2026-07-30, co-owner-directed)** — the THIRD half #1370 left homeless: the retired
  flag also AUTO-CLEANED, and the rewrite re-homed creation and the cwd assertion but nothing for
  teardown.
- **Rule 3b added (2026-08-10)** — skeleton-first briefing made Rule 3's existence check
  NON-DISCRIMINATING; four dispatched agents in one session exited leaving placeholder-only reports, three
  committed and their surfaces recorded as covered. Per-occurrence evidence:
  `skills/30-claude-code-patterns/worktree-orchestration.md` § Agent-Delivery Verification.
- **Rule 4a added (2026-08-20, co-owner-directed origination)** — receipt-first `journal/0584`:
  eight downstream agents died inside three minutes on one quota exhaustion, every notification
  carrying `"idleReason":"failed","failureReason":"You've hit your session limit"`, while the
  orchestrator kept reporting agents running and re-dispatching; two dead worktrees held 23 and 25
  modified files uncommitted, saved only by a hand-check.
- **Rule 9 landed (2026-08-11)** — see § "Rule 9 — Wiring Depth (Severity, Detection, Origin)".
- **Rule 1 amended (2026-09-12, co-owner-directed, `journal/0607` decision 5)** — the unit of isolation
  became the LANE: the agents a lane dispatches share its worktree under `rules/wip-discipline.md`
  MUST-9, and a further worktree for an agent inside a lane is BLOCKED. Depth: § "Rule 1 — The Unit
  Is The LANE, Not The Agent".

## Rule 7 — Methodological Lesson, Placement Grounds, Guard State (extracted 2026-08-21)

Relocated from the rule body under the loom#1597-class injection-budget pressure that reds any
PR adding ~1.2 KB to a `workspace-note`-profile rule. ZERO de-scoping: every MUST, MUST NOT,
BLOCKED entry, DO/DO-NOT block and `**Why:**` failure-mode statement stayed in the rule.

### The methodological lesson — the durable part

The 2026-07-22 "no double-load" conclusion is **WITHDRAWN as unsupported**, NOT refuted: its
aggregate-token-count instrument could not have returned a different answer under either
hypothesis, so it was evidence for NEITHER (`evidence-first-claims.md` MUST-3/4). Any re-test
MUST use a root-distinguishing instrument — an UNTRACKED sentinel at one root only — never an
aggregate size; the committed instrument is `bin/probe-ancestor-load.mjs`, do NOT re-derive it
from prose.

### The placement conclusion holds a fortiori on THREE grounds

(a) the measured double-load; (b) clutter — a full nested checkout in the working tree; (c) glob
range — a nested worktree sits inside the repo's own `.claude/**`, so parent-repo recursive
tooling descends into it and pulls a duplicate corpus in as TOOL OUTPUT. The distinction is
PLACEMENT; `/worktree` encodes it. Withdrawn-run numbers, sentinel protocol, full matrix:
skill § Ancestor-Load Measurement.

### Guard presence at loom is MUTABLE STATE — re-measure, never cite

**At loom the guard IS present and honors both channels — MEASURED 2026-08-19, superseding an
earlier same-day measurement that read the opposite.** Whether the guard is present in a given
deployment is MUTABLE state: re-measure it, never cite that line. The measurement, its
instruments, and the superseded reading: § "Rule 7 — The Nested-Worktree Guard, Measured At
Loom 2026-08-19".

### Why the receipt channel is load-bearing and the env var alone is not

An env-only override is unreachable from inside a session — documented but not usable at the
moment the block fires. The receipt (`.claude/worktree-authz/nested-worktree-allow`, CONSUMED
as it is honored) is the channel that answers `hook-output-discipline.md` MUST NOT § "Detectors
that block work the agent has been instructed to perform". Mechanism: § "Rule 7 — The
Nested-Worktree Guard, Measured At Loom 2026-08-19".

## Wiring Depth — Detection mechanisms, Rules 1/3b/4a/7/8/9 (extracted 2026-08-21)

Relocated from the six clause-scoped Wiring blocks under injection-budget pressure. ZERO
de-scoping: each block keeps all eight canonical `trust-posture.md` MUST-8 field labels with
their normative statements — which tier enforces, what the reviewer confirms, and whether
Phase 2 is LANDED / RETIRED / deferred. Only mechanism narrative and superseded-reading history
moved here.

### Rule 3b — why detection is PERMANENTLY advisory

The placeholder vocabulary is brief-defined and open, so the signal is irreducibly lexical.
Per `hook-output-discipline.md` MUST-5(b), booking a Phase-2 detector would promise teeth that
cannot arrive — so none is claimed and none is deferred. Row shape, probe pinning and the CI
boundary: § "Rule 3b — Probe Registration And The CI Boundary".

### Rule 4a — the affordance/detector distinction, and why Phase 2 is RETIRED

`.claude/bin/worktree-triage.mjs` classifies the forest and exits 3 on any SALVAGE tree, giving
obligation (2) a runnable, citable instrument instead of a prose instruction. Its bipolar
fixtures at `.claude/audit-fixtures/worktree-triage/` are a RED pole (a forest holding
uncommitted lane work, asserted on the failure IDENTITY — which worktree, which class, never a
bare exit code) and a GREEN pole (the same forest committed), registered in
`ci-audit-fixtures.json` and run by `run-audit-fixtures.mjs`.

**Vocabulary (consolidated 2026-08-22).** Until that date this tool emitted its four recovery
classes under the field name `verdict` — the SAME field name `.claude/bin/worktree-reap.mjs`
emits `ZERO-LOSS`/`TAG-FIRST`/`KEEP` into. One field, one question ("is this tree safe to
remove?"), two vocabularies: an operator reading both reports had no way to reconcile them, and
two answers to one question teach an operator to trust neither. The four classes were DEMOTED to
a subordinate `recoverability` field — every class, reason string, fail-closed direction and exit
code intact — and `verdict` now carries the shared word, derived at one seam
(`withSharedVerdict`) and never measured twice. Mapping, fail-closed: SALVAGE and UNPUSHED ⇒
`KEEP`; PUSHED and LOST ⇒ `ZERO-LOSS`. `TAG-FIRST` is deliberately not minted here — only a tool
that REMOVES a tree can act on "tag it first", and this tool removes nothing. Five fixture checks
pin the mapping, including a one-run bipolar pole pair that reds if the mapping ever returns a
constant (verified by mutation: constant-`ZERO-LOSS` reds 2 checks by identity, naming the tree).

**The tool is an AFFORDANCE, not a detector** — it answers "what is at risk here", never "did
the orchestrator look". Phase 2 is RETIRED rather than deferred: whether a notification field
was READ is not observable from any argv token, AST node or git-object fact at tool-call time,
and a lexical detector over orchestrator prose could not carry `block`. No `phase2-deferrals`
row is owed and no hook fixtures are. Probes: the bipolar `RULE-4a-firing` pair (efficacy
violation pole + no-false-positive compliant pole) with `.expected` sidecars at the same
fixture dir. Registration buys DISPATCHABILITY, never execution — no workflow invokes the
dispatcher, so a green CI run is NEVER evidence these probes passed.

### Rule 8 — what each suite pins, and the superseded "deferred" reading

Phase 2 LANDED 2026-08-04 (`worktree-forest-guard.js` + `lib/worktree-forest.js`) and since
2026-08-12 it ENFORCES rather than only reports: PreToolUse(Bash) surfaces the backlog before a
new tree is added; SessionEnd reaps ZERO-LOSS unattended. Suites: `.claude/bin/worktree-reap.test.mjs`

- `.claude/test-harness/tests/worktree-forest-guard.test.mjs`. Placement fixtures remain at
  `.claude/audit-fixtures/worktree-session-placement/` (shared with Rules 1 and 7). The field
  formerly read "deferred"; that reading is superseded. Detail: § "Rule 8 — Wiring Detection And
  Origin Depth".

### Rule 9 — the detector's enumerated blind spots

Phase 2 LANDED 2026-08-18 (loom#1795), superseding the field's former "deferred" and deleting
its `phase2-deferrals.json` row. `validate-bash-command.js` pairs a MUTATING `git stash` form
with a `git worktree list` count > 1 and emits the non-blocking finding, via
`hooks/lib/stash-collision.js` (`selectStashHazard` + `countWorkingTrees`). Reads
(`stash list`/`show`) and `stash create` stay SILENT — a guard that trips on INSPECTING gets
switched off. Not-measured ⇒ silent, never asserted (`cc-artifacts.md` Rule 7). Fixtures
`.claude/audit-fixtures/worktree-stash-collision/`, registered in `ci-audit-fixtures.json`.
**Blind spots are enumerated, not implied** — four command shapes sit outside the Bash-boundary
vantage point, so Phase 1 stays the backstop. Full list, fixture-arm counts, and the
pre-existing sibling this rule does NOT fix: § "Rule 9 — Wiring Depth (Severity, Detection,
Origin)".

## Wiring Depth — the shared no-dedicated-key rationale (extracted 2026-08-21)

Rules 1, 3b, 4a, 7, 8 and 9 each route a same-class regression-within-grace violation through
the GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1
posture) with NO dedicated per-clause key, each recording the deviation per `trust-posture.md`
Rule 8. The reasoning is shared and is stated once here rather than six times in the rule body:

- Each property is review-layer plus advisory-hook — a dispatch-argument shape, a
  did-you-read-the-field judgment, a placement decision, a delivery-verification reading, a
  shared-state-primitive use. None is a corrupting or irrecoverable outcome, so none warrants
  an instant-drop key.
- Minting a key would require editing `trust-posture.md`, which is a
  `self-referential-codify.md` allowlist file — dragging a governance rule into a
  self-referential edit to register a trigger the universal one already covers.
- The universal `regression_within_grace` trigger already covers every one of them.

Rule 4a carries one ADDITIONAL note that is NOT shared: its loss corrupts nothing and is
bounded to re-work, which is the specific reason its key stays generic. Do not read that
recoverability argument onto the other five.

## Rule 10 — Wiring Depth (Detection, Origin) (extracted 2026-09-12)

Relocated VERBATIM from the Rule-10 (MUST-10) Trust-Posture-Wiring `**Detection mechanism:**` and
`**Origin:**` fields on 2026-09-12, to pay for the lane-unit amendment to Rule 1 in the same change:
before this extraction that amendment had grown this path-scoped rule by 1,412 B and put the
`loom-skill-edit` and `loom-command-edit` injection profiles over their ceilings
(`check-rule-injection-budget.mjs`, measured). Both fields keep their normative statements — the
predicate, its severity ceiling, the RETIRED Bash-layer Phase 2 and the scope.

**Fixture pole inventory.** Bipolar fixtures are the `22`-series cases in
`.claude/audit-fixtures/dispatch-contract/run.mjs`, in two groups; read the case ids from the runner
rather than a count here. The runner's § 6b (2026-09-06): the accept pole (the incident's own brief
shape), both reject poles, two over-match refusals, a fail-open pole, a severity-ceiling pole, and a
WIRING pole asserting `inspectDispatch` actually surfaces the finding — a predicate no aggregator
calls is inert. Its § 6c (2026-09-12, when the PIN test stopped accepting only a literal `-C /abs`
token and `fixtureContainmentOf` began classifying `pin` / `pin-without-assertion` / `forbid` /
`none`): the canonical containment clause is a PIN only WITH its STEP-0 assertion and fires naming the
missing half without one; a path-bound `-C <p> rev-parse --show-toplevel` satisfies the assertion and
a bare worktree STEP-0 does not; a negated, partial, lowercase or relative `-C` pins nothing; a
hard-wrapped clause, a `--git-dir` pin and the FORBID form are recognised; and the wiring pole is
asserted on both sides. Registered `{mode: run}` in `ci-audit-fixtures.json`; each group raised the
`min_cases` floor in the change that landed it, so its cases cannot be deleted silently.

**Incident record.** The incident is recorded in `.session-notes.d/<operator>.handoff-s91.md` § 4: a
security lens building adversarial git fixtures ran unpinned commands that resolved to the loom
checkout. Repaired in-session with every tip recorded before deletion, so it reads as a near-miss
rather than a loss. Folded into THIS rule rather than shipped as a new one because the corpus sits
at its declared ceiling, where `check-corpus-growth.mjs` requires retiring a rule to add one — and
retiring a rule removes an obligation, which is the co-owner's call, not the orchestrator's.

**Why the Bash-layer Phase 2 is RETIRED (moved from the Detection field).** A hook refusing an
unpinned git write at `PreToolUse:Bash` would have to know the call came from a DELEGATED agent rather
than the orchestrator, and no such signal exists at tool-call time — an orchestrator's own
`git commit` is the identical shape. The semantic tier is stated as UNCOVERED plainly, rather than
named as a phantom path.

**Rule 7 BLOCKED-corpus gloss (moved 2026-09-12).** The rule's "the double-load was already tested
and did not reproduce" entry carried this gloss inline: the 2026-07-22 test compared aggregate TOKEN
COUNTS, an instrument structurally blind to duplication of byte-identical corpora; its conclusion is
WITHDRAWN as unsupported — re-test with a root-distinguishing sentinel or do not claim a result.

**The Length rationale's lifecycle list (moved 2026-09-12).** placement + cwd assertion →
re-assertion → deliverable verification → concurrency → fleet-death triage → base pinning → branch
naming → session placement → teardown → stash hazard → dispatched-agent git target. The rationale
formerly counted "six post-MUST-8 rules"; Rule 10's own clause-scoped Wiring made it seven, corrected
in the same edit.

## Rule 1 — Wiring Depth

Extracted 2026-09-13 (rule-injection-budget pass) from the rule's `#### Trust Posture Wiring
(Rule 1 — clause-scoped)` block, verbatim where the sentence survived the move.

**Grandfather note.** Rule 1 is `/codify`-touched at its 2026-07-26 rewrite, so it leaves the
Rules 1–6 grandfather set and ships canonical-8-field-compliant; Rules 2–6 stay grandfathered until
each is itself touched.

**Severity — the full gate-review predicate.** Reviewer at `/implement` + cc-architect at `/codify`
confirm every parallel dispatch went into its LANE's orchestrator-made sibling worktree pinned by
absolute path, with no `isolation:` flag and no further worktree opened for an agent inside the
lane, AND mandated the STEP-0 `cd`-then-assert cwd assertion. The hook layer stays advisory because
a dispatch argument is not structurally decidable as agent-wave vs other at tool-call time.

**Detection — the (i)–(iv) gate-review checklist.** For any parallel-dispatch session, the reviewer
confirms (i) each worktree path lies OUTSIDE the repo top-level, (ii) no dispatch carried an
isolation flag, (iii) each prompt mandates STEP-0 `cd <worktree>` THEN an assertion that
`--show-toplevel` equals `pwd -P` and is not the main checkout, with explicit refusal — a `-C` form,
a bare first `rev-parse`, or a passed-string comparison are each a finding, and (iv) no lane opened
a further worktree for one of its own agents. The registered probe pair is
`RULE-1-lane-unit-firing`; its poles are described in § "Rule 1 — The Unit Is The LANE, Not The
Agent" above. The Phase-2 fixture directory `.claude/audit-fixtures/worktree-session-placement/` is
shared with Rules 7 and 8 per `cc-artifacts.md` Rule 9.

**Cumulative posture impact — the enumerated same-class set.** An `isolation:`/`EnterWorktree({name})`
dispatch; a further worktree opened for an agent inside a lane; a pre-made-worktree dispatch with no
absolute path pinned; an omitted STEP-0 assertion mandate; or an assertion written with `git -C`, a
bare first `rev-parse`, or a passed-string comparison.

**Rule 1's `**Why:**` measurement (moved 2026-09-13).** Recorded 2026-04-19: 2 of 3 shards wrote to
MAIN, 300+ LOC lost when a zero-commit worktree auto-cleaned. Both defects found while converging
the clause were the same failure at opposite poles — a form that could never fail, and one that
could never pass on a symlinked path — which is why any future edit to an assertion states which
inputs make it FAIL and which make it PASS.

## Rule 3a — The Checkout-Bound Tool Example

Extracted 2026-09-13 from the rule's Rule-3a `**Why:**` line.

Source-of-truth example: `tools/sweep-redteam.py:65` sets
`ROOT = Path(__file__).resolve().parent.parent`, so an in-worktree invocation scans the main
checkout and reports gaps the worktree's own edits already closed. The post-merge re-run is the only
invocation where the script's resolved ROOT and the verified state actually coincide.

## Rule 3b — The Four Skeletal Lanes

Extracted 2026-09-13 from the rule's Rule-3b `**Why:**` line.

Measured across one session: four lanes exited leaving reports whose every section was still a
placeholder, and the loss surfaced only when a human re-read the files. Skeleton-first was adopted
to make an agent's silence visible, and it does — but it also guarantees the file exists before any
work happens, so it defeats the existence check Rule 3 mandates.

The Rule-3b Wiring block's probe/CI detail (`scanner: null`, gate-review, NOT in CI) and the
non-discriminating-instrument argument that the skeleton is "manufactured by the mitigation itself"
also live here rather than in the rule body.

## Rule 4a — The Triage Affordance And Its Submodule Gap

Extracted 2026-09-13 from the rule's Rule-4a obligation (2) and its Wiring block.

**The affordance's reported vocabulary.** `node .claude/bin/worktree-triage.mjs` is read-only; every
record carries the SHARED removal-safety `verdict` (`ZERO-LOSS` / `KEEP` — the same vocabulary
`worktree-reap.mjs` reports, so the two collate) plus the finer `recoverability` class (SALVAGE /
PUSHED / UNPUSHED / LOST); it exits 3 when work is at risk, and `--capture <dir>` writes the patches
outside the forest.

**Why a dirty submodule reaches no patch.** `git diff HEAD` over a gitlink whose recorded SHA is
unchanged emits NOTHING, and `ls-files --others` never descends into one, so a dirty submodule's
uncommitted files reach no patch. The tool says so LOUDLY — it names the submodule, reports
`capture_complete: false`, prints the `INCOMPLETE` manifest section and exits 2 — but a loud gap is
still a gap.

**The tool is an AFFORDANCE, not a detector** — it answers "what is at risk here", never "did the
orchestrator look". That is why no `phase2-deferrals.json` row is owed for the clause and no hook
fixtures are: whether a notification field was read is not observable at tool-call time. The
registered `RULE-4a-firing` probe pair buys DISPATCHABILITY, never execution — no workflow invokes
the dispatcher, so a green CI run is NEVER evidence it passed.

**Obligation (3)'s boundary sentence.** This clause chooses WHICH tree; `orchestration-launch-ledger.md`
MUST-4 governs WHEN.

**Cumulative posture impact — the enumerated same-class set.** An idle notification counted as a
finished agent; a dead agent's worktree reused, re-entered or removed before its uncommitted work
was captured; a replacement re-dispatched into a fresh tree that abandoned in-flight work; a wave
briefed with no incremental-commit instruction.

## Extraction Record

**2026-09-13 rule-injection-budget pass (this pass).** The rule file was reduced by paired
extraction per `rule-authoring.md` Rule 10 path (a): depth moved OUT, obligation left IN. ZERO
de-scoping — every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT fenced block, `**Why:**` line and
canonical Trust-Posture-Wiring field bullet stayed in the rule, and the enforcement-token census was
measured flat across the whole pass. What moved: per-instance measurement history, correction and
provenance narrative, probe-registration boilerplate, gate-review checklists restating obligations
already stated in the rule body, and enumerated same-class violation sets whose members are each
already a MUST clause above.

**Why `rule-authoring.md` Rule 10 / Rule 11 do NOT fire on this file.** Rule 10 § "Trigger scope"
limits the proximity-band gate to `priority: 0` + `scope: baseline` rules; `worktree-isolation.md`
is `priority: 10` + `scope: path-scoped`, so it pays no baseline-emission cost. Both the 2026-08-19
and 2026-09-13 passes are therefore STRUCTURAL CLEANUP, not Rule-10 paired extractions, and neither
is Rule-11 recurrence input — the same disposition `journal/0148` recorded.

## Rule-Body Extracts — 2026-09-13 Injection-Budget Pass

Paragraphs moved out of the rule in the same pass, grouped by the rule section they came from. Each
is kept verbatim where the sentence survived the move.

### Rule 2 — the prompt-level pin is lossy; the `main=` subshell

That redundancy became load-bearing when Rule 1 retired the flag: the orchestrator's pinned-path
instruction can be lost to context compression across long delegation chains, and with no harness
setting cwd there is nothing else underneath. The `cd` inside the `main=` substitution is a
SUBSHELL; removing it reintroduces the symlink false-refusal.

### Rule 2a — the Rust SDK false-green evidence

The Rust SDK journal 0177 § Process note (2026-06-10): a "3× green" validation had silently run in
the main checkout after cwd reverted; the explicit `cd` + re-run produced the real 3/3 FAIL that
exposed an O(n²) regression.

### Rule 4 — the suppressed-signal bound

A SUPPRESSED throttle signal is bounded to the cold-start cap: a throughput slowdown, never an
over-concurrency breach. The native `min(16, cores−2)` cap is empirically too high — it throttles at
sub-quota concurrency.

### Rule 5 — the M10 stale-base evidence

2026-04-23 M10 launch: 5 of 6 worktrees branched from a pre-W30-merge SHA.

### Rule 6 — the M10 hash-default-name evidence

2026-04-23: 3 of 6 M10 shards got `worktree-agent-<hash>` default names; the post-merge audit had to
pull from a working-memory table instead of `git log --grep`.

### Rule 7 — the measured ancestor-load result, and the placement-cost digits

Measured 2/2 (CC 2.1.220, sentinel probe): the same rule arrived TWICE, and an ancestor-ONLY rule
provably absent from the worktree checkout arrived in full, while a SIBLING-rooted session loaded
each exactly once with zero ancestor content. `CLAUDE.md` and baseline rules do NOT ancestor-load,
which settles the question #1368 left open. A nested ROOT duplicates the matching path-scoped set at
hundreds of KB per touch; the 2026-07-22 "no double-load" conclusion is WITHDRAWN as unsupported,
not refuted. The scope bound: a dispatched subagent receives NO path-scoped injection of its own, so
a wave does not itself double-load, and for hand-rolled agent-wave worktrees nobody roots a session
at, grounds (b) and (c) govern rather than duplication.

The nested-guard resolution requirement carries one further clause moved from the rule body: the
resolution follows `security.md` § Path Containment with BOTH candidate and boundary root through
the SAME resolver, OS-normalized, FAILING CLOSED when either will not resolve.

### Rule 8 — the measured forest, and the one-sided-discipline diagnosis

Measured: one clone reached 20 worktrees / 1.0 GB at 83% volume capacity while a corpus grep for
`worktree remove|worktree prune` across `.claude/rules/` returned ZERO hits. The ENOSPC fact was
stated only inside the paired skill's rate-limit-recovery clause, so it reached the reader least
likely to need it. The SessionEnd reaper waives nothing — every KEEP guard and the idle floor stand
— and an unrecognised `COC_WORKTREE_AUTOREAP` value stays ON.

### Rule 9 — the corpus-level survival of `git stash -u`

`git stash -u` survived as a recommendation inside the corpus's own destructive-ops rule until a
downstream consumer hit the collision. The Phase-2 landing superseded that field's former "deferred"
reading and deleted its `phase2-deferrals.json` row; "not-measured ⇒ silent, never asserted" is the
`cc-artifacts.md` Rule 7 disposition the detector honours. The hop-level provenance of the
2026-08-11 landing deliberately does not identify the originating consumer.

### Rule 10 — the measured blast radius, and the twenty-third brief

Measured once at nine fixture commits on the repo, nine junk branches, a working tree moved off its
branch, `origin` repointed at a non-existent path, and seven branches pushed to the real remote. The
originating incident was one missing sentence in the twenty-third brief of an orchestrator that had
written it correctly twenty-two times — which is why the instruction must ride a mechanism rather
than a memory. The clause's regression-key rationale: the loss is recoverable — every tip was
recorded before deletion and every pushed ref archived — so it does not warrant an instant-drop key,
and minting one would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a
self-referential edit. Verbatim originating direction: "for the 3 decisions, choose the root cause
long term fix"; a security lens building adversarial git fixtures ran unpinned commands that
resolved to the loom checkout.
