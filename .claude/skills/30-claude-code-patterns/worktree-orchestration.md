# Worktree Orchestration Reference

Detailed evidence and post-mortems backing the worktree rules in `rules/agents.md`. The rule contains the load-bearing MUST clauses + DO/DO NOT; this file holds the institutional memory (failure stories, counterfactuals, prompt templates) for all ELEVEN — evidence, prompt templates, DO/DO-NOT, BLOCKED corpus, and Trust-Posture Wiring per rule.

## What each rule converts (the failure-mode map)

`rules/agents.md` § Worktree Orchestration states the MUST and names the three rules that fire in EVERY parallel session; the per-rule failure modes it converts live here:

| Rule                            | Silent loss it converts into isolation-or-a-loud-refusal                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1 (isolate compiling agents)    | **lock serialization** — two cargo processes in one dir serialize completely, so "parallel" agents run serial |
| 9 (isolate shared-source editors) | **phantom reads** — a reader sees an editor's mid-edit WIP and reports a defect that does not exist at HEAD  |
| 2 (relative paths)              | **checkout drift** — absolute paths resolve to the main checkout, silently defeating isolation                |
| 3 / 3b (commit per milestone)   | **auto-cleanup loss** — a zero-commit worktree is auto-cleaned and the work is gone                          |
| 4 / 4a (verify + recover)       | **truncated writes** — "Now let me write X…" with no write; the agent reports done with zero files on disk    |
| 5 (one version owner)           | **version clobber** — two shards racing the same version anchor                                              |
| 10 (binding-scoped shard PRs)   | **shard conflicts** — two concurrent shards editing the same sibling-package file, 3-way conflict at merge   |
| 11 (`cp`-backup restore)        | **index-restore destruction** — `git checkout --` restores from the INDEX, destroying unstaged work          |

The always-on trio in the rule body compresses three mechanisms stated fully here: concurrent readers read committed HEAD via `git show HEAD:<path>` (Rule 9); commit per milestone AND verify ≥1 commit exists before exit (Rule 3); take the `cp` backup BEFORE the edit and verify byte-identity after the restore (Rule 11).

## Retiring `isolation: "worktree"` — depth for `rules/worktree-isolation.md` Rule 1

**What changed (2026-07-26, loom#1370).** Every worktree in this skill used to be created by the harness from a dispatch flag. It is now created by the ORCHESTRATOR, as a SIBLING outside the repo, and handed to the agent by absolute path. `isolation: "worktree"` and `EnterWorktree({name})` are BLOCKED. Nothing else about the protocol changes — Rules 2–11 are about what the agent DOES in its worktree, not who made it.

### The recipe (replaces the flag everywhere in this file)

```bash
# ONCE per wave — orchestrator derives the sibling parent location-independently
main_top=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
slug=$(basename -s .git "$(git remote get-url origin)"); WT_PARENT="$(dirname "$main_top")/.${slug}-wt"
mkdir -p "$WT_PARENT"
# PER shard — explicit -b (Rule 8) + explicit base SHA (Rule 7), sibling path (Rule 1)
git worktree add -b "feat/${shard}" "$WT_PARENT/${shard}" "$INTEGRATION_TIP"
```

```python
# then dispatch with NO isolation flag: path pinned AND the STEP-0 assertion mandated
wt = f"{WT_PARENT}/{shard}"
Agent(prompt=f"""
Working directory: {wt}
Branch: feat/{shard}

STEP 0 — FIRST action, before reading or writing anything. cd, THEN assert:
  cd "{wt}" || {{ echo "STOP: cannot enter {wt}"; exit 1; }}
  top=$(git rev-parse --show-toplevel) || {{ echo "STOP: not a git repo"; exit 1; }}
  [ "$top" = "$(pwd -P)" ] || {{ echo "STOP: not a worktree ROOT (top=$top)"; exit 1; }}
  main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
  [ "$top" != "$main" ] || {{ echo "STOP: this IS the main checkout"; exit 1; }}
  [ "$(git rev-parse --abbrev-ref HEAD)" = "feat/{shard}" ] || {{ echo "STOP: wrong branch"; exit 1; }}
Compare RESOLVED paths (`pwd -P`), never the passed string. On any STOP, REFUSE to
proceed and report "worktree isolation broken" — do NOT fall back to the main checkout.

Every path you write MUST resolve inside {wt}. Commit after each file (Rule 3).
""")
```

### Three candidate assertion forms; only one works (measured 2026-07-26)

Probed on a synthetic two-root repo — a main checkout, a sibling worktree, a path inside main, and a nonexistent path:

| form | correct sibling | path inside MAIN | missing path | establishes cwd? |
| --- | --- | --- | --- | --- |
| bare `git rev-parse --show-toplevel` FIRST | **refuses** (prints MAIN) | refuses | refuses | no |
| `git -C <wt> rev-parse --show-toplevel` | passes | refuses | refuses | **no** |
| `cd <wt> && git rev-parse --show-toplevel` | passes | refuses | refuses | **yes** |

**Read the last column — that is the whole difference.** `-C` and `cd &&` reject exactly the same bad inputs; `-C` is NOT weaker at detecting a wrong path. Its defect is that it answers a question about the worktree and leaves the agent in MAIN, so every later relative path and bare `git` still resolves to MAIN — the 2026-04-19 write-to-main mode, with a green check above it. (An earlier draft of this section called `-C` "vacuous"/"a tautology". That is imprecise and is withdrawn: it fails correctly on a wrong path. State the real defect — no cwd establishment — or the next author will measure the failure cases, find the stated reason false, and revert to `-C`.)

A **bare** `rev-parse` as the FIRST action is the right question asked too early: nothing has set cwd (that is exactly what retiring the flag gave up), so it resolves to MAIN and refuses on EVERY dispatch. An always-refusing check gets deleted by the first person it blocks.

**Compare RESOLVED paths, never the passed string.** `--show-toplevel` returns the symlink-resolved path: with `WT=/tmp/w/x` on macOS it returns `/private/tmp/w/x`, so `[ "$(git rev-parse --show-toplevel)" = "$WT" ]` refuses on a perfectly correct worktree. Measured. Any symlinked prefix does this — `/tmp`, symlinked homes, corporate-managed macOS, Windows junctions. Compare `--show-toplevel` against `pwd -P`.

**Also reject the main checkout explicitly.** MAIN is itself a valid worktree root, so "am I at a root?" passes there — and MAIN is the one destination the whole rule exists to prevent. The `main=$(… --git-common-dir …); [ "$top" != "$main" ]` guard closes it.

**This does not contradict Rule 2a, which mandates `git -C <worktree> …`.** The two uses are opposite by design: Rule 2a FORCES a later operation to run in the right place (apply a patch, run tests) after cwd may have reverted, where `-C` is exactly right; STEP 0 must ESTABLISH the location, which `-C` never does. Establish with `cd`; re-force later invocations with `-C`.

### Why the assertion is the REPLACEMENT, not an extra

`isolation: "worktree"` did two things: it created the worktree, and it SET the agent's cwd. Retiring it gives up both. Part (a) of Rule 1 replaces the creation; **the STEP-0 assertion replaces the cwd guarantee**, and prompt text alone does not — a prompt is a request, not a mount point.

Ship the retirement without it and the trade is a BOUNDED quota burn for an UNBOUNDED silent loss: work lands in the main checkout, the agent reports success, and its zero-commit worktree is auto-cleaned. That is not speculative — Rule 2 and Rule 3 below record it happening on 2026-04-19: **2 of 3 parallel shards wrote to MAIN; Shard A lost 300+ LOC** of sklearn Array-API work. Rules 2 (path discipline) and 3 (commit-per-milestone) are what caught and bounded that loss, and both are MORE load-bearing now, not less — they are the layers remaining once the harness stops pinning cwd.

### Why placement, not tidiness

The flag places each agent's worktree at `<repo>/.claude/worktrees/agent-<id>` — under the repo's OWN `.claude/`. loom#1370 reports that an agent rooted there loads path-scoped rules from BOTH its own `.claude/rules/` and the ancestor repo's, in full:

| fleet shape | agents | duplicate tokens per wave round |
| --- | --- | --- |
| 40 terminals × 5 agents | 200 | 17.8M |
| 40 terminals × 10 agents | 400 | 35.6M |
| 40 terminals × 20 agents | 800 | 71.1M |

at a measured per-agent-per-wave floor of **88,895 tokens / 355,581 B** (a floor — only 20 of 31 affected files were individually sized). Every one of those tokens re-loads a corpus the agent already has in context.

**A sibling is structurally immune, not merely better:** there is no ancestor `.claude/` anywhere between a sibling directory and `~`, so the ancestor-load has no source to read from. That is a property of the PATH, so it holds regardless of what any harness version does with instruction discovery.

### The dominance argument — why this does not depend on settling the subagent question

`rules/worktree-isolation.md` Rule 7 § scope bound records loom's OWN measurement of the dispatched-subagent path (2/2 runs, CC 2.1.220): a subagent dispatched with the flag inherited the DISPATCHING session's corpus and received no path-scoped injection of its own. loom#1370 reports the opposite from a different repo and harness. **Both were measured; neither has been reconciled, and this section does not attempt it.**

It does not need to be reconciled to act, because the sibling form is correct under EITHER: if #1370 holds, the sibling removes the ancestor the agent would have read; if loom's measurement holds, the wave's cost is whatever the dispatching session carries, and that session is sibling-rooted under Rule 7. The retired flag is the only option that is wrong under one reading and no better under the other. Do NOT cite this section as having settled which measurement is right.

**BLOCKED rationalizations:** "`isolation: "worktree"` is the built-in primitive, so it must be the intended path" / "the flag does the worktree setup for free, pre-making it is overhead" / "loom measured that subagents inherit the parent corpus, so the flag is fine" (that measurement is contested by #1370 and the sibling is correct either way) / "it's gitignored, so nesting is harmless" (gitignore does not stop instruction discovery, nor a parent-repo `grep -r`) / "we'll switch when the harness ships a configurable base directory" (the guidance change cascades today; the harness fix is items 1–2 of #1370 and has no ETA) / "the prompt states the working directory, so the agent is in it" (a prompt is a request, not a mount point) / "STEP 0 is ceremony that burns a turn" (one git call, ~30 ms, against 300+ LOC of recorded loss) / "`git -C <wt> status` already checks it" (it never establishes cwd — see the form table above) / "the agent will `cd` there first" (an UN-ASSERTED `cd` is an unverified assumption, and cwd can revert mid-session per Rule 2a) / "just compare the toplevel to the path I passed" (spurious refusal on any symlinked prefix — measured) / "MAIN would obviously fail the root check" (it would not — MAIN is a valid worktree root; the `--git-common-dir` guard is what rejects it).

## Rule 1 — Worktree Isolation For Compiling Agents

**Rule:** `rules/agents.md` § "MUST: Worktree Isolation for Compiling Agents".

**Why it exists:** Cargo uses an exclusive filesystem lock on `target/`. Two cargo processes in the same directory serialize completely, turning parallel agents into sequential execution. Worktrees give each agent its own `target/` directory.

**Cross-language applicability:** Rust (cargo `target/` lock) is the clearest case. Python does NOT have the same compiler lock, but worktree isolation still prevents agents from stepping on each other's file edits and produces cleanly-merge-able commit branches — both significant benefits. JavaScript/TypeScript also benefit because `node_modules/` can be contention-sensitive during install.

**Full protocol:** an orchestrator-made sibling worktree (§ Retiring `isolation: "worktree"`) is necessary but not sufficient. Combine with:

0. The mandated STEP-0 assertion — `cd <wt>`, then assert `--show-toplevel` equals `pwd -P` and is not the main checkout, else refuse (§ Retiring `isolation: "worktree"`; `rules/worktree-isolation.md` Rule 1(b))
1. Every prompt path resolving inside the worktree (Rule 2 below)
2. Explicit commit-as-you-go discipline (Rule 3 below)
3. Post-exit file existence verification (Rule 4 below)
4. Cross-agent package ownership declared (Rule 5 below)

Without all 6 layers, agents drift back to the main checkout silently, lose work to auto-cleanup, or race on version-bump files. Layer 0 is the one that replaces what the retired flag used to guarantee; the rest were always the agent's own discipline.

## Rule 2 — Worktree Prompts Use Relative Paths Only

**Rule:** `rules/agents.md` § "MUST: Worktree Prompts Use Relative Paths Only".

### Failure mode evidence

Session 2026-04-19 logged: 2 of 3 parallel shards wrote to MAIN before self-correcting (Shard B) or losing work entirely (Shard A's 300+ LOC of sklearn array-API impl was lost when its empty worktree auto-cleaned). Only one self-corrected; the failure mode is not agent-detectable by default.

Post-mortem: `workspaces/kailash-ml-gpu-stack/journal/0004-RISK-torch-lightning-deviceReport-orphan.md` — full post-mortem of the write-to-main leak AND the subsequent spec-compliance finding it masked.

### Why path discipline is load-bearing

The invariant, unchanged since 2026-04-19: **every path in the prompt resolves INSIDE the agent's worktree, and never into the orchestrator's checkout.**

Under the retired `isolation: "worktree"` flag the HARNESS chose the worktree path (`.claude/worktrees/agent-XXXX/`) and set the agent's cwd there. The orchestrator could not name a path it did not know, so RELATIVE paths were the only safe form and any absolute path — necessarily copied from the orchestrator's own checkout — silently defeated isolation. That is the exact shape of the loss recorded above.

With an orchestrator-made SIBLING worktree the path is KNOWN before dispatch, so both forms are safe and the PREFERRED form is absolute-rooted-at-the-sibling: it is self-checking (after the STEP-0 `cd`, the agent can compare `git rev-parse --show-toplevel` to `pwd -P`) and it survives a mid-session cwd revert, which a relative path does not (`rules/worktree-isolation.md` Rule 2a). Relative paths stay valid whenever cwd is pinned to the worktree.

What is BLOCKED in BOTH forms is unchanged: an absolute path rooted at the ORCHESTRATOR's checkout. That was always the real failure; "relative paths only" was the way to state it when the worktree path was unknowable.

### Prompt template (safe)

```python
wt = f"{WT_PARENT}/{shard}"          # pre-made sibling; see § Retiring isolation: "worktree"
Agent(
    prompt=f"""
    Resolve <issue>.

    Working directory: {wt}
    STEP 0 — cd FIRST, then assert (never `git -C`; never a bare first rev-parse):
      cd "{wt}" || {{ echo "STOP: cannot enter {wt}"; exit 1; }}
      [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || {{ echo "STOP: not a worktree root"; exit 1; }}
    Compare RESOLVED paths, never the passed string. On STOP, REFUSE to proceed.

    Files you may edit (each MUST resolve inside {wt}; an absolute path rooted
    anywhere else is BLOCKED):
    - {wt}/the ml package directory src/kailash_ml/foo.py
    - {wt}/the ml package directory tests/integration/test_foo.py

    ...
    """,
)
```

**BLOCKED rationalizations:** "Absolute paths are unambiguous" (only once the orchestrator MADE the worktree and knows its path — an absolute path from the orchestrator's own checkout never was) / "The agent should figure out its own cwd" / "relative is always safer" (it is not, once cwd can revert — Rule 2a) / "This worked the one time I tested it".

## Rule 3 — Worktree Agents Commit Incremental Progress

**Rule:** `rules/agents.md` § "MUST: Worktree Agents Commit Incremental Progress".

### Failure mode evidence

Session 2026-04-19 ML GPU-first Phase 1 parallel-shard experiment:

- Shard A's agent wrote a complete SklearnTrainable Array-API rewrite, then truncated on "Now let me rewrite fit:" with zero commits. Worktree auto-deleted. ~300 LOC of load-bearing work had to be recovered serendipitously from Shard B's scope-creeped worktree.
- Shard C was rescued by an explicit WIP commit from the orchestrator immediately after notification.
- Only Shard B self-corrected — because its prompt happened to emphasize "commit before exit" as a byproduct.

Three of three parallel agents truncated at 250-370k tokens; two lost work to auto-cleanup.

### Why incremental commits are load-bearing

Worktree auto-cleanup silently deletes worktrees with zero commits on their branch. An agent that writes perfect code but truncates mid-message before committing loses 100% of its output. Post-hoc file-existence verification (Rule 4 below) catches orphan files in main but CANNOT recover files that were only in a cleaned-up worktree.

### Prompt template

```python
Agent(
    prompt="""
    ...

    **Commit discipline (MUST):**
    - After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
    - Do NOT hold all work in the worktree's index until the final report.
    - If you exit without committing (budget exhaustion / crash / interruption),
      the worktree is auto-cleaned and ALL work is lost.
    """,
)
```

## Rule 3b — Continuation-Agent Recovery For Mid-Shard Agent Death

When a worktree agent dies mid-shard (server-side throttle, account session limit, swap, crash), Rule 3's commit-per-milestone discipline makes the relaunch LOSSLESS — if the orchestrator follows this recovery protocol instead of relaunching from scratch:

1. **Inspect before relaunching:** `git -C <dead-worktree> log main..HEAD --oneline` (committed milestones) + `git -C <dead-worktree> status --porcelain` (dangling WIP).
2. **Checkpoint the dangling WIP** as a commit in the dead worktree (`git add -A && git commit -m "wip: checkpoint from rate-limited agent"`) so the branch carries EVERYTHING — auto-clean only deletes zero-commit worktrees, and the branch survives even when the worktree is removed.
3. **Launch the continuation agent** (fresh worktree) with an explicit recovery step: `git merge <dead-agent-branch>` as STEP 1, then "READ what it already built before writing anything — audit, fix, fill; do not rewrite working code."
4. **Tell the continuation agent what the predecessor claimed** (its last commit subjects) so the audit is targeted.

Evidence: 2026-06-11 Wave-3 session — a rate-limited agent left 1 commit + uncommitted edits; checkpoint + merge-continuation recovered all of it, and the continuation agent completed the shard auditing rather than re-implementing (~1,400 LOC retained). Same protocol applied across the F16 W2 fix-wave (journal 0178 §FD: 3 of 4 agents died mid-run; resumption lossless).

## Rule 4 — Verify Agent Deliverables Exist After Exit

**Rule:** `rules/agents.md` § "MUST: Verify Agent Deliverables Exist After Exit".

### Failure mode evidence

Session 2026-04-19 logged 2 occurrences (kaizen round 6, ml-specialist round 7) where an agent hit its budget mid-message and reported success with zero files on disk. The agent emitted "Now let me write X..." with no tool call behind it.

The `ls` check is O(1) and converts silent no-op into loud retry.

### Combined protocol

- Rule 3 (commit discipline) protects against worktree auto-cleanup
- Rule 4 (post-exit verify) protects against the main checkout
- Both are needed: Rule 3 alone misses truncated-in-main cases; Rule 4 alone misses truncated-worktree cases
- Rule 4a (below) is the recovery path when Rule 3 was missed and the worktree is already cleaned

## Rule 4a — Recover Orphan Writes From Zero-Commit Worktree Agents

**Rule:** `rules/agents.md` § "MUST: Recover Orphan Writes From Zero-Commit Worktree Agents".

An agent that wrote via ABSOLUTE paths resolves those writes to the MAIN checkout cwd (not its worktree). When such an agent reports done but its branch has zero commits AND the worktree was auto-cleaned, the work is NOT lost — it is orphaned, uncommitted, and reachable in the main checkout.

### 4-step recovery protocol

```bash
git worktree list | grep <expected-branch>     # empty if cleaned
git status --short                              # "??" entries surface the orphans
git checkout -b recovery/<original-branch>      # rescue branch (greppable across history)
git add -- "<orphan-path>" && git commit -m "recover(<branch>): orphaned worktree writes"
```

Quote each orphan path and terminate option parsing with `--` (`git add -- "path/with spaces.py"`) — never substitute an unquoted `$(...)` expansion, which word-splits on spaces/shell-meta. Stage the explicit orphan paths from `git status --short`, NOT `git add .`/`-A` (which would sweep unrelated working-tree state per `git.md` § "Stage Explicit Paths").

### BLOCKED rationalizations

- "The agent said it was done, the work must be committed somewhere"
- "Re-launching is cleaner"
- "If the branch has zero commits, the work is gone"
- "The main checkout is clean"
- "recovery/ branches are a workaround; feat/ is more correct"

### Why it is load-bearing

Re-launching abandons real work every time an absolute-path agent truncates. `git status` reveals the orphans; the `recovery/` branch prefix surfaces this class of rescue across history. PR #574 recovered 1129 LOC of `alignment.py` this way.

## Rule 5 — Parallel-Worktree Package Ownership Coordination

**Rule:** `rules/agents.md` § "MUST: Parallel-Worktree Package Ownership Coordination".

### Positive evidence (coordination succeeded)

Session 2026-04-20 kailash-ml 0.13.0 + kailash 2.8.10 parallel-release cycle (PRs #552, #553). Three parallel worktree agents resolved issues #546 (ONNX matrix), #547+#548 (km.doctor + km.track), and #550 (quote_identifier). Clean integration because:

- **Agent 1** designated version-owner for kailash-ml pyproject.toml + CHANGELOG
- **Agent 2** prompt included the verbatim exclusion: "COORDINATION NOTE: A parallel agent is resolving #546 (ONNX bridge matrix) in another worktree and will ALSO bump version to 0.13.0 + write CHANGELOG. To avoid merge conflicts, you (this agent) MUST NOT edit the ml package directory pyproject.toml, the ml package directory src/kailash_ml/**init**.py::**version**, or the ml package directory CHANGELOG.md."
- **Agent 3** worked on a different package (core kailash/, 2.8.10) — no overlap

Result: merge integration was mechanical. One trivial CHANGELOG conflict on the root file, zero conflicts on package pyproject.toml or package CHANGELOG. Integration step (owned by orchestrator) added `km-doctor` console script + expanded CHANGELOG (which Agent 1 correctly seeded with ONNX entries only) to cover all three issues.

### Counterfactual

Without the exclusion clause, Agent 2 would have independently bumped 0.12.1 → 0.13.0 and written its own top-level `## [0.13.0]` CHANGELOG entry. At merge time git would have picked one agent's version field (arbitrary) and one agent's CHANGELOG header (arbitrary), silently dropping the other's prose. The cost of the exclusion clause is one sentence per sibling prompt; the cost of the collision is manual CHANGELOG reconciliation plus risk of dropped coverage notes.

### Integration step belongs to orchestrator

The post-merge fixup (adding cross-agent artifacts that neither agent owned) is the orchestrator's responsibility, not an agent's:

- `km-doctor` console script entry in `pyproject.toml [project.scripts]` — spans agents 1 and 2's work
- Expanded CHANGELOG entries covering all 3 issues — agent 1 wrote the ONNX section; orchestrator added km.track + km.doctor sections
- Cross-package version floor updates (sibling package bumps, lockstep coordination)

Agents MUST NOT attempt integration work because they cannot see each other's worktrees until the merge lands.

## Reviewer Prompts — Mechanical AST/Grep Sweep

**Rule:** `rules/agents.md` § "MUST: Reviewer Prompts Include Mechanical AST/Grep Sweep".

### Failure mode evidence

Session 2026-04-19 ML GPU-first Phase 1 codify cycle — code reviewer APPROVED 0.12.0 with one minor finding (missing test); the subsequent `/redteam` mechanical sweep caught TorchTrainable + LightningTrainable missing `device=DeviceReport` (2 of 7 return sites). The reviewer never ran the parity grep.

See `workspaces/kailash-ml-gpu-stack/journal/0004-RISK-torch-lightning-deviceReport-orphan.md` § "Why it slipped past the round-3 reviewer" for the full analysis.

### Why mechanical sweeps are load-bearing

Gate reviewers are constrained by the diff they're shown. The orphan failure mode of `rules/orphan-detection.md` §1 is invisible at diff-level — the new entries look complete; the OLD entries that were never updated for the new public surface stay invisible. A 4-second `grep -c` sweep catches what 5 minutes of LLM judgment misses. Without the sweep, the reviewer agent's APPROVE verdict is necessary but not sufficient.

### Reviewer prompt template (with sweeps)

```python
Agent(subagent_type="reviewer", prompt="""
... diff context ...

Mechanical sweeps (run BEFORE LLM judgment):
1. `grep -c "return TrainingResult(" src/...trainable.py` — must equal
   `grep -cE "device=DeviceReport|device=device_report" src/...trainable.py`
2. `pytest --collect-only -q` exit 0 across all test dirs
3. `pip check` — no new conflicts vs main
4. For every public symbol in __all__ added by this PR — verify
   eager import (per orphan-detection §6)
""")
```

## Rule 6 — Parallel-Launch Concurrency Is Throttle-Aware Adaptive (cold-start ~3, back off on signal)

**Rule:** Orchestrators MUST govern concurrent agent launches by an ADAPTIVE back-off model, NOT a fixed cap and NOT the runtime's native ceiling. Cold start (no throttle signal this session): cap the first wave at **~3 Opus-tier agents** — NOT the runtime's native `min(16, cores−2)=14` (empirically too high — it throttles at sub-quota concurrency) and NOT unlimited. Back off to serial waves of ~3 ONLY on the falsifiable throttle signal; do NOT preemptively serialize below ~3, and do NOT assert "no cap." This mirrors `rules/worktree-isolation.md` Rule 4 (the rule body; this depth-file carries the how-to).

### The falsifiable throttle signal

Back off to waves of ~3 when AND ONLY when ≥2 agents in the same wave fail within a **~30–48s synchronized window** AND the failure carries the server string `Server is temporarily limiting requests` with `(not your usage limit)` / `Rate limited`. A single agent dying, an OOM, a 2-minute timeout, or a quota error that says "usage limit" is NOT this signal.

### Failure-mode evidence (two incidents)

1. **2026-04-23 kailash-ml M1:** a 6-agent worktree burst (W31a/b/c + W32a/b/c) — **all 6** returned `Server is temporarily limiting requests` within seconds; two sequential waves of 3 then landed cleanly (6 shards, 189 tests).
2. **2026-06-01 #419:** a **7-agent READ-ONLY fan-out** (zero compile contention, well under the native cap of 14) synchronized-died at ~37–48s with verbatim `(not your usage limit) · Rate limited`; waves-of-3 → 7/7 returned. This is the receipt that the binding constraint is server-side CONCURRENCY (sub-quota, sub-native-cap), NOT account quota and NOT a fixed batch number — #419 falsified #418's "trust the native cap."

### Prompt template

```python
# DO — cold-start wave of ~3; back off to waves of 3 ONLY on the synchronized-throttle signal
wave = launch(shards[:3])                    # cold start ~3, NOT native 14, NOT unlimited
wait_for_all(wave)                           # wave barrier
# if ≥2 of `wave` died within ~30-48s carrying "(not your usage limit)" → keep next waves ≤3
# else (clean) → the SIGNAL is the gate, not a fixed number

# DO NOT — trust the runtime's native min(16,cores-2)=14 cap
agents = [launch(s) for s in all_shards]     # 7 read-only agents synchronized-died at ~37-48s
# DO NOT — hardcode "always waves-of-3" with no throttle signal (over-serializes headroom)
```

**BLOCKED rationalizations:** "The native cap (14) is the ceiling to trust" (7 agents throttled sub-quota) / "It's a quota / usage-limit problem" (the string says `not your usage limit`) / "Always waves-of-3 is the safe rule" (over-serializes) / "A retry loop will handle throttles" / "5 worked last week, 6 should too".

**Why:** The throttle is server-side CONCURRENCY-shaped and time-windowed, NOT quota-shaped and NOT fixed-count. "No cap / trust native 14" re-ships the synchronized burst-death; "always ≤3" wastes the multiplier on low-contention sessions. The adaptive model (cold-start ~3, back off on the falsifiable synchronized-death + `not your usage limit` signal) is neither. Worktree isolation itself is unaffected — only the concurrency-governance mechanism is reframed.

Origin: Session 2026-04-23 kailash-ml-audit M1 (6-agent burst 100% failure, 3+3 success) + 2026-06-01 F110 / #419 reframe (7-read-only-agent sub-quota throttle falsified #418's native-cap trust). Receipts journal/0193 + journal/0194.

## Rule 7 — Pre-Flight Merge-Base Check Before Launch

**Rule:** Before launching parallel worktree agents that will eventually merge back to the same integration branch, the orchestrator MUST verify every worktree's branch is created FROM THE CURRENT TIP of the integration branch — not from an older ancestor. Branching from an older ancestor is silently valid until merge time, at which point the shards diverge from each other AND from intermediate reconciliation commits.

### Failure mode evidence

Session 2026-04-23 M10 wave: **5 of 6 worktree agents** branched their shard from an older ancestor of `feat/kailash-ml-1.0.0-m1-foundations` instead of the current tip. Detected only at post-merge reconciliation (commit fa300831) when `__all__` reconciliation revealed each shard had landed its own version of the canonical list, diverging from the W33 shard that had correctly branched from tip.

### Why the check is load-bearing

`git worktree add` without an explicit base commit uses whatever ref HEAD points at when it runs, which can be stale if the integration branch has advanced since the orchestrator's last `git fetch`. (Under the retired `isolation: "worktree"` flag this was worse still — the harness ran the `add` and the orchestrator had no way to pass a base at all.) The drift is invisible at shard-time because each shard passes its own tests; the collision only surfaces when 6 shards land top-level `__all__` entries on top of 6 different parent trees.

### Prompt template (pre-flight)

```bash
# DO — orchestrator computes the tip explicitly, passes it to each agent
INTEGRATION_TIP=$(git rev-parse feat/kailash-ml-1.0.0-m1-foundations)
for shard in shards; do
  git worktree add -b "feat/${shard}" "$WT_PARENT/${shard}" "${INTEGRATION_TIP}"   # sibling
done

# DO NOT — omit the base and let `git worktree add` pick it silently
# Each worktree branches from whatever HEAD happens to be; 5/6 can
# land on an ancestor that is 2 commits behind the true tip.
```

**BLOCKED rationalizations:** "Worktrees always branch from HEAD" / "Merge reconciliation will surface the drift" / "A git fetch before launch is redundant".

**Why:** The reconciliation cost of 5/6 misaligned shards is a full `__all__` merge pass (commit fa300831 canonical 41 + 7 Phase-1 adapters = 48 total) done manually post-merge. A 1-second `git rev-parse` + explicit base-SHA pass converts it into 0 work.

### Structural enforcement (loom#1501) — the local-vs-`origin` arm ONLY

This rule was authored 2026-04-23 with evidence, a prompt template, and a BLOCKED
corpus, and the failure it names **recurred three more times anyway** — twice
recorded as a session-notes "trap" and once more after that, the last costing a
full reconciliation when a lane did good work on a base 182 commits behind its own
remote tip. Session notes are per-session memory, so recording it there was the
`knowledge-cascade-routing.md` MUST-1 failure; and prose alone, however well
evidenced, did not stop the recurrence. `feedback_rules_not_enforcement.md`: rules
are the lowest leverage — start high.

The structural fence is `violation-patterns.js::detectWorktreeStaleBaseRef`,
dispatched from `validate-bash-command.js` on `PreToolUse(Bash)`. It parses a
`git worktree add [<opts>] <path> <commit-ish>` invocation, and when `<commit-ish>`
is a LOCAL branch whose `refs/remotes/origin/<same-name>` counterpart is ahead of
it, emits `halt-and-report` naming the behind-count and the `origin/<ref>` form to
use instead — BEFORE the tree is created.

**Covered:** an EXPLICIT local base ref that its `origin/` counterpart has moved
ahead of (strictly-behind and diverged both flag; the diverged message names the
ahead-count so a deliberate local-unpushed base can be stated and proceeded with).

**NOT covered, stated so nobody infers a stronger guarantee:**

- `git worktree add <path>` with **no explicit base** — the arm this rule's own
  "DO NOT" block describes. HEAD-staleness is a much noisier proposition and is
  deliberately out of the detector's scope; the pre-flight `git rev-parse` in the
  template above is still the only defence for it.
- A remote **not named `origin`** — the ref simply fails to resolve and the
  detector returns null, so the miss is a silent non-detection, never a false flag.
- Staleness against an **integration branch under a different name** than the base
  ref (this rule's original 5/6-shard case) — the detector compares a ref to its
  OWN remote counterpart, not to some other branch's tip.
- A base ref supplied through a **shell variable** (`git worktree add ../wt $REF`)
  — a `PreToolUse` hook reads the command PRE-expansion, so the operand is
  unknowable and `hook-output-discipline.md` MUST-3 requires skipping it.
- A `cd` the walk **cannot resolve exactly** — bare `cd`, `cd -`, `cd ~`, `cd --`,
  a `$VAR`/glob operand, a `cd` inside a subshell, or anywhere the command
  contains `||` (whether that branch executes depends on an exit status that has
  not happened yet). All of these DECLINE to probe rather than guess: falling back
  to the session cwd would flag a repository the command never enters, which is
  the false positive MUST-2 forbids outright.
- More than **`MAX_REF_PROBES` (4)** `git worktree add`s in one command — the
  hot-path spawn cap stops the walk after the fourth real probe.
- A git invocation the segment walk does not recognise as one, e.g. wrapped in
  `sh -c '…'` — `parseGitInvocation` skips wrapper operands rather than parsing a
  nested command line.

**Severity is `halt-and-report`, not `block`, deliberately.** The verdict is
structural (`git rev-list --left-right --count`, off the operator's own ref
database), so `hook-output-discipline.md` MUST-2 would PERMIT `block`; it is capped
on **proportionality**, because a stale base is recoverable (rebase, or re-create)
unlike the two `block`-severity neighbours in the same hook, which destroy work with
no reflog. The whole cost of this error lives in not knowing, and a PreToolUse halt
fires before the worktree exists. Fixtures: `.claude/audit-fixtures/worktree-stale-base-ref/`
— both polarities across three arms (the injected-reader arg-grammar table, the
env-clamp cases, the real-git reader, and a dispatcher arm that drives the hook as
a subprocess), registered in `ci-audit-fixtures.json` whose `min_cases` is the
authoritative count. The runner prints its own total on every run; that figure is
deliberately not restated here, because the last restatement of it drifted.

Origin: Session 2026-04-23 M10 wave — 5/6 shards branched from older ancestor; post-merge `__all__` reconciliation commit fa300831 required. Structural enforcement added 2026-08-01 (loom#1501, L4 of the enforcement-registration wave) after the third recurrence.

## Rule 8 — Explicit Branch Naming In Prompts

**Rule:** Every worktree-isolation delegation MUST include an explicit `feat/<shard-name>` (or equivalent semantic prefix per `rules/git.md` conventional commits) in the prompt. Omitting the branch name is BLOCKED — the harness falls back to `worktree-agent-<hash>` which is neither greppable nor conventional-commit-compliant, breaking changelog tooling and release-trace auditability.

### Failure mode evidence

Session 2026-04-23 initial launch attempted: `Agent(isolation="worktree", prompt="Implement W33 km.* wrappers...")` — the then-current flag, now retired — without a branch name. Harness assigned `worktree-agent-a3f9c1` as the branch. Post-merge `git log --grep="W33"` returned zero matches; the shard was findable only by commit SHA. Fixed by re-launching with explicit `Branch: feat/W33-km-wrappers` in the prompt header.

### Why the name is load-bearing

Conventional-commit `feat/<shard-name>` branch names serve four downstream consumers:

1. **Release changelog generation** — `git log --grep="^feat(<shard>)"` drives CHANGELOG entries
2. **Traceability** — `git branch --list 'feat/W*'` surfaces all shards in a wave
3. **Reviewer context** — PR titles inherit branch names; `worktree-agent-a3f9c1` communicates nothing
4. **Post-mortem search** — future sessions find this session's work via `git log --grep`

Hash-based names fail all four.

### Prompt template

```python
# DO — explicit branch name in prompt header; worktree pre-made as a sibling
# git worktree add -b feat/W33-km-wrappers "$WT_PARENT/W33-km-wrappers" "$INTEGRATION_TIP"
Agent(prompt=f"""
Branch: feat/W33-km-wrappers
Worktree: {WT_PARENT}/W33-km-wrappers

STEP 0 — cd FIRST, then assert (Rule 1(b); full four-case form in § Retiring):
  cd "{WT_PARENT}/W33-km-wrappers" || exit 1
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1
  [ "$(git rev-parse --abbrev-ref HEAD)" = "feat/W33-km-wrappers" ] || exit 1

Implement W33 km.* public-API wrappers per specs/ml-engines-v2.md §15.9.
Commit discipline: after each file, git commit -m "feat(W33): <what>"
""")

# DO NOT — the retired flag, no branch, no pre-made worktree
Agent(isolation="worktree", prompt="Implement W33 km.* wrappers...")
# → branch = worktree-agent-a3f9c1; grep -irn "W33" in history returns nothing
```

**BLOCKED rationalizations:** "The harness default works" / "We'll rename the branch at merge time" / "The commit bodies mention W33, grep works on those".

**Why:** Grep on commit bodies is slower (scans every commit, not just branch names) and noisier (false positives from unrelated mentions). Branch names are the cheapest index; losing them costs every future `git log --grep` 10× the tokens.

Origin: Session 2026-04-23 — W33 initial launch lost to `worktree-agent-<hash>`; re-launched with explicit `feat/W33-km-wrappers`.

## Rule 9 — Worktree-Isolate Shared-Source Editors; Concurrent Readers Read Committed HEAD

**Rule:** `rules/agents.md` § Worktree Orchestration — shared-source editor isolation. Rule 1's isolation mandate generalizes beyond compilation: ANY background/parallel agent that EDITS shared repo source (`sync-manifest.yaml`, rules, `bin/`, config) MUST be worktree-isolated, even if it never compiles. Any concurrent agent that READS that source MUST read the committed HEAD (`git show HEAD:<path>`), never the working tree.

### Failure mode evidence (2026-05-16 post-mortem)

Three agents ran against the SAME loom checkout: a background agent EDITING `sync-manifest.yaml` (issue #243), and two `/sync` catch-up agents READING loom source. The editor's mid-edit WIP left the manifest with a transient YAML syntax error; both readers flagged "the manifest is broken repo-wide" — correct for the working tree, false at committed HEAD. ~2 agents' analysis cycles were spent reconciling a phantom defect. Root cause: the isolation MUST was framed compiling-only, so the orchestrator launched the editor non-isolated precisely because "it doesn't compile."

### The two structural halves

1. **Editor isolation** — any shared-source editor is worktree-isolated, compiling or not.
2. **Reader discipline** — concurrent readers read committed HEAD; this is the half that actually saved the cycle (once the catch-up agents were told to read `git show HEAD:<path>`, they produced correct plans despite the broken WIP in the shared tree).

### Prompt template

```python
# DO — a background agent that EDITS shared source gets its own (sibling) worktree
# The path pin is necessary but NOT sufficient — STEP 0 is what makes it hold (Rule 1(b)).
Agent(prompt=f"""Working directory: {WT_PARENT}/manifest-edit
STEP 0: cd "{WT_PARENT}/manifest-edit" || exit 1
        [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1
Edit sync-manifest.yaml: add consumer_overlays ...""")
# DO — a concurrent agent that READS that source reads committed HEAD
Agent(prompt="""Catch-up sync. Read loom source via `git show HEAD:.claude/bin/emit.mjs`
(committed HEAD), NOT the working tree — a parallel agent may be mid-edit.""")

# DO NOT — non-isolated editor + working-tree reader, same checkout
Agent(prompt="Edit sync-manifest.yaml ...")          # mid-edit WIP visible to all
Agent(prompt="Catch-up: copy .claude/bin/emit.mjs")  # may copy broken mid-edit state
```

**BLOCKED rationalizations:** "It's not a compiling agent, the worktree rule doesn't apply" / "The edit is quick, a collision is unlikely" / "Both agents are careful" / "I'll serialize them in my head".

**Why:** A non-isolated editor's mid-edit WIP is visible in the shared checkout; a reader copying the working tree mid-edit ships the broken state. Had the editor been isolated (or the readers HEAD-pinned from the start), zero reader cycles would have been spent on a phantom defect.

Origin: 2026-05-16 loom session (issue #243 manifest editor vs py/rs catch-up readers); full post-mortem in `guides/rule-extracts/agents.md` § Post-mortem 2026-05-16.

## Rule 10 — Binding/Package-Scoped Shard PRs Touch Only Their Own Package

**Rule:** `rules/agents.md` § Worktree Orchestration — binding-scope discipline. When ≥2 parallel worktree agents each ship a binding/package-scoped shard, each shard's PR MUST limit its diff to its OWN binding/package directory. Incidental fixes to sibling-package files (clippy lints, fmt drift, doc typos) discovered mid-shard ship as a separate PR or a dedicated cross-package cleanup shard — bundling is BLOCKED. This is the file-overlap variant of Rule 5: that clause forbids two agents editing the version anchor; this one forbids two agents editing the same sibling-package source.

### Failure mode evidence

F9 Wave 3c (2026-05-22): PR #1084 (a Java MCP shard) bundled an incidental Ruby clippy fix on a Ruby binding source file; concurrent PR #1085 (a broader Ruby MCP shard) edited the same file; #1085's auto-merge hit a 3-way conflict resolved mid-flight at merge commit `69bed4e0` (~10 min of churn binding-scope discipline would have prevented). Same trap precedent: Wave 3b PR #1081 on the parity-matrix file.

### Detection sweep (reviewer mechanical sweep at /implement)

`git diff --name-only main...HEAD`, map each changed path to its top-2 directory components, flag any binding-scoped PR (title `feat(go|java|ruby|python|nodejs):`) whose changed-file roots span >1 binding directory WITHOUT a cross-package-cleanup title prefix (`chore(bindings):` / `fix(bindings):` are carved out — they MAY touch multiple binding dirs by design).

**BLOCKED rationalizations:** "It's only a one-liner lint fix" / "Both bindings rebuild anyway" / "Filing a separate PR is overhead for trivial drift" / "I'm already touching the workspace anyway" / "The fix is in a different file from the sibling shard" / "Concurrent PRs on different files don't conflict".

**Why:** When two concurrent binding-scoped shards touch the SAME sibling-package file (one shard's incidental fix + a concurrent shard that owns that file), the second-to-merge hits a 3-way conflict the orchestrator resolves mid-flight. Trust Posture Wiring for this clause: `guides/rule-extracts/agents.md` § Binding-Scoped Shard PRs.

Origin: F9 Wave 3c (2026-05-22), PR #1084/#1085 conflict on a Ruby binding source file.

## Rule 11 — Shared-Worktree Mutation Agents Restore Via `cp` Backup, Never `git checkout --`

**Rule:** `rules/agents.md` § Worktree Orchestration — shared-tree restore discipline. An agent asked to MUTATE-AND-RESTORE a file in a SHARED worktree (mutation testing, fault injection, "break it and confirm the test catches it") MUST take a `cp` backup before the edit and restore from that backup. `git checkout -- <file>` and `git restore <file>` are BLOCKED for this purpose.

### Mechanism — why `checkout` is the wrong instrument

`git checkout -- <file>` restores from the **INDEX** when the file has staged content, and from HEAD only when it does not. It therefore destroys UNSTAGED work — which includes work that was staged and then further edited. The restore silently succeeds; the loss is invisible until someone reads the diff.

### Why the rule must be UNCONDITIONAL

An agent cannot determine, from outside, which state a shared file is in at the moment it restores — clean, staged, staged-then-edited, or dirty. "Use `cp` only for uncommitted files" is therefore not a statable rule, because the agent cannot evaluate the condition. `cp` unconditionally is statable, and costs one command.

```bash
# DO — backup before mutating; restore from the backup; verify byte-identity
cp "$F" "/tmp/bak.$$"
<mutate "$F">
<run ONE targeted test file>
cp "/tmp/bak.$$" "$F"
shasum "$F" "/tmp/bak.$$"        # both digests MUST match before reporting done

# DO NOT — restore via git; silently reverts to INDEX content, not your pre-edit content
git checkout -- "$F"     # or: git restore "$F"
```

### Two companion clauses — each a full MUST (they are what made the loss compound)

Both are scored into Rule 11's Trust-Posture cumulative math below, so both are stated as MUSTs:

1. **The dispatcher MUST commit its own work BEFORE dispatching any mutator into a shared tree.** Uncommitted edits in a tree where mutation agents run are the material the restore destroys. Dispatching a mutator into a tree holding your own uncommitted edits is BLOCKED.
2. **Full-suite verification MUST be serialized until mutation agents finish.** While a mutator is live, only targeted single-file test runs are permitted; launching a full suite concurrently with a live mutator is BLOCKED — it observes half-applied mutants and produces phantom failures that read exactly like regressions.

**BLOCKED rationalizations:** "`git checkout --` is the standard way to discard a change" / "the file was clean when I started, so checkout is equivalent" / "I'll check `git status` first and branch on it" (the state can change between the check and the restore — and staged-then-edited is not distinguishable at a glance) / "`cp` litters `/tmp`" / "the mutation is tiny, restoring it by hand is fine" / "the test passed after restore, so the restore worked" (the suite passing says nothing about whether YOUR pre-edit content came back).

**Why:** In one mutation-testing round, seven `checkout` calls across three files destroyed the same edit TWICE — first an uncommitted edit reverted to HEAD, then the re-applied edit reverted to older STAGED content. The second loss shipped a commit whose body described a change absent from its own diff, requiring a follow-up commit to deliver what the message had already claimed (a `git.md` § Discipline commit-message-accuracy breach caused purely by the restore mechanism). Evidence the rule holds: a later round planted and restored 17 mutants across two files `cp`-only with sha1 verification that both files were byte-identical to their pre-round backups afterward — zero loss.

### Trust Posture Wiring (Rule 11 — clause-scoped)

Lands post-`trust-posture.md`-MUST-8-cutoff, so it ships canonical-8-field-compliant; Rules 1–10 stay grandfathered until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm any mutate-and-restore round in a shared tree used a `cp` backup with a digest check, not `git checkout --`/`git restore`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (whether a `git checkout --` is a mutation-restore or an ordinary discard is judgment-bearing, not structurally decidable at tool-call time).
- **Grace period:** 7 days from clause landing (2026-07-26 → 2026-08-02).
- **Cumulative posture impact:** same-class violations (a shared-tree mutate-and-restore round restored via `git checkout --`/`git restore`; a mutator dispatched into a tree holding the dispatcher's uncommitted edits; a full suite run concurrently with a live mutator) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a restore-mechanism property is review-layer plus advisory-hook and does not warrant an instant-drop key; the universal trigger covers it). Named deviation from the key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same disposition Rule 7 and `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: agents]` IFF `posture.json::pending_verification` includes the `agents` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any session that mutated and restored a shared-tree file, reviewer confirms a `cp` backup preceded the edit and a digest comparison followed the restore; a `git checkout --`/`git restore` on a file the same session edited is a finding. Phase 2 (deferred) — no hook detector; audit fixtures land with it at `.claude/audit-fixtures/shared-worktree-restore/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 11 ONLY; Rules 1–10 stay grandfathered.
- **Origin:** loom#1362 (proposal filed from a BUILD repo after the seven-checkout round described above).

## Ancestor-Load Measurement — the sentinel protocol (depth for `rules/worktree-isolation.md` Rule 7)

**What Rule 7 asserts, and on what evidence.** Measured 2026-07-26 on **CC 2.1.220** against a synthetic two-root repo, because a synthetic repo can carry planted markers that a production checkout cannot.

### The instrument, and why the previous one was blind

The 2026-07-22 amendment compared aggregate TOKEN COUNTS across nested / main / sibling roots (75,173 / 75,348 / 75,095), found them roughly equal, and concluded no double-load. **A size comparison cannot detect duplication when the two corpora are byte-identical** — loading the same bytes twice from two roots is precisely what "roughly equal" looks like to that instrument. The instrument could not have returned a different answer under either hypothesis, so it was evidence for neither.

The sentinel protocol makes the two roots DISTINGUISHABLE:

1. Build an outer git repo with a committed `.claude/` corpus (`CLAUDE.md`, a `priority: 0` baseline rule, a `priority: 10` path-scoped rule), each carrying a unique token. Commit.
2. `git worktree add .claude/worktrees/w1` — the nested worktree now holds the COMMITTED copies.
3. At the OUTER root only, plant **untracked** ancestor-only counterparts (a baseline rule, a path-scoped rule) with distinct tokens, and append an ancestor-only token to the outer `CLAUDE.md`. Untracked/unstaged ⇒ **no worktree checkout can contain them**. Plant BEFORE any session starts — this is what defeats the "baseline is snapshotted at session start" confound.
4. Confirm the on-disk asymmetry: `grep -rl 'TOKEN-ANC-' <worktree>/` MUST exit 1.
5. Start a TOP-LEVEL session rooted at the nested worktree. Have it read a file matching the path-scoped glob, then report **by introspection** (never by grep) every injected block's verbatim absolute path and every token — including whether any token appears under MORE THAN ONE path.
6. Repeat rooted at a SIBLING worktree outside the repo as the control.

### Measured matrix (2/2 runs each, CC 2.1.220)

| Class | Session rooted at NESTED `.claude/worktrees/w1` | Session rooted at SIBLING (outside repo) |
| --- | --- | --- |
| `CLAUDE.md` | own copy only; ancestor token ABSENT | own copy only |
| baseline rule (`priority: 0`) | own copy only; ancestor token ABSENT **even though planted before session start** | own copy only |
| path-scoped rule (`priority: 10`) | **own copy AND ancestor copy — same rule, TWICE, under two distinct paths**; plus the ancestor-ONLY rule in FULL | own copy only, exactly ONCE |

Path-scoped blocks appeared only AFTER the triggering read, each with its own path header. **What that does NOT establish — UNRESOLVED.** The observation is equally consistent with (a) injection per matching touch and (b) lazy injection once, on the FIRST matching touch, sticky thereafter. A one-touch protocol cannot distinguish them; distinguishing them needs a SECOND matching touch and a re-count. An earlier draft of this section asserted (a) — that assertion is WITHDRAWN as unsupported, and a two-touch probe attempted 2026-07-26 returned a non-zero exit with empty output, i.e. ZERO evidence (`evidence-first-claims.md` MUST-3), so it settles nothing either way.

**The standing corpus says (b), and nothing here contradicts it.** Four shipped artifacts state path-scoped rules inject once per session, sticky: `guides/claude-code/08-the-rule-system.md:87` ("Injected once per session when a matching path is touched (sticky)"), `skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md:138`, `rules/time-pressure-discipline.md:19`, and `rules/value-prioritization.md:22`. Treat (b) as the operative model until a two-touch measurement says otherwise. **This does not weaken the duplication finding**, which is about HOW MANY ROOTS a matching rule loads from (measured: two), not how often injection fires — the per-session cost is the duplicated set once, not once per touch.

### What this settles, and what it does not

- **SETTLED:** path-scoped rules ancestor-load and double-load under nesting; sibling placement eliminates both. `CLAUDE.md` and baseline rules do NOT ancestor-load — loom#1368 marked baseline INCONCLUSIVE on the theory that the baseline set is snapshotted at session start; the pre-session plant excludes that theory, and baseline still did not load. Negative result, now grounded.
- **MEASURED SEPARATELY (loom, 2/2 runs):** a subagent dispatched with `isolation: "worktree"` gets its worktree under the MAIN checkout (`<main>/.claude/worktrees/agent-<hash>`), NOT under the dispatching session's cwd; and 13/13 of its injected blocks were anchored at the **dispatching session's launch root** — neither its own root nor an ancestor of it. It received NO path-scoped injection at all, despite reading files matching three declared globs. Subagents inherit the parent session's corpus; `isolation: "worktree"` does not re-resolve it.
- **NOT MEASURED (inference only):** that a wave dispatched FROM a nested-rooted session inherits that session's duplicated corpus. It follows from the two results above but was not run as a composed test. Labelled as inference in Rule 7; do not restate it as measurement.
- **NOT MEASURED HERE:** loom#1368's downstream figure of 20 rules ≈ 85,000 tokens per agent per wave. That is the reporter's `.rs` repo, a different harness. Loom's own duplicated cost, computed from its corpus, is below.

### Cost at loom

74 path-scoped rules totalling 1,185,700 B (exact — frontmatter scan of `.claude/rules/*.md`). Per-touch subsets, computed with a REIMPLEMENTED glob matcher (an approximation of CC's matcher, not CC's own — treat as indicative):

| Touched file | Matching path-scoped rules | Bytes duplicated under nesting |
| --- | --- | --- |
| `.claude/rules/agents.md` | 13 | 291,914 B (~73k tokens) |
| `.claude/skills/30-claude-code-patterns/worktree-orchestration.md` | 10 | 254,637 B (~64k tokens) |
| `.claude/bin/emit.mjs` | 7 | 194,259 B (~49k tokens) |

### Re-test discipline

Any future re-litigation of this claim MUST use a root-distinguishing instrument. A "did not reproduce" verdict produced by comparing aggregate sizes is a finding about the instrument, not a clearance for the claim.

**The instrument is committed — do not re-derive it.** `bin/probe-ancestor-load.mjs` implements steps 1–4 + 6a above (scaffold the two-root repo, plant the UNTRACKED ancestor sentinels, create the nested worktree and the sibling control, then ASSERT the on-disk asymmetry) and prints the two launch commands plus the verbatim introspection prompt for steps 5 + 6b, which need live top-level sessions and cannot be driven from inside another session.

```bash
node .claude/bin/probe-ancestor-load.mjs --help            # protocol + what is / is not automated
node .claude/bin/probe-ancestor-load.mjs --build           # scaffold + assert asymmetry (exit 0 = sound)
node .claude/bin/probe-ancestor-load.mjs --verify <dir>    # re-assert the step-4 gate alone
node .claude/bin/probe-ancestor-load.mjs --clean <dir>
```

A non-zero exit means the instrument is NOT sound and any measurement taken with it is ZERO evidence (`rules/evidence-first-claims.md` MUST-3) — notably if the sentinels ever end up TRACKED, which would materialise them into every worktree checkout and destroy the one property that makes an appearance unambiguous. Re-derivation from prose is exactly how the disqualified 2026-07-22 instrument was chosen; the script exists so the choice is not remade each time. The structural half of this contract (Rule 1 dispatch discipline, Rule 1(b) STEP-0 in worked examples, Rule 7 placement) is locked by `tests/integration/multi-operator/worktree-double-load-1370.test.js`.

## Related rules & skills

- `rules/agents.md` § Worktree Orchestration — the load-bearing MUST cluster this skill carries the depth for (one structural assertion per clause in the rule; protocol, templates, BLOCKED corpora + post-mortems here)
- `rules/orphan-detection.md` — §1 (facade call site) and §6 (`__all__` eager import) are what the mechanical sweep verifies
- `skills/30-claude-code-patterns/parallel-merge-workflow.md` — merge-step patterns for collecting worktree branches into an integration branch
- `guides/deterministic-quality/02-session-architecture.md` — session-level architecture for multi-agent orchestration
