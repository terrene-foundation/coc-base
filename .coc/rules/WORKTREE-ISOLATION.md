---
id: "WORKTREE-ISOLATION"
paths: [".claude/agents/**", ".claude/commands/**", ".claude/skills/**", "**/*worktree*"]
---

# Worktree Isolation Rules

See `.claude/guides/rule-extracts/worktree-isolation.md` for extended examples, post-mortem prose, measured evidence, and per-rule provenance for Rules 1–9.

Each parallel LANE runs in its own git worktree, SHARED by the agents it dispatches under `rules/wip-discipline.md` MUST-9 (per-agent build dirs keep their `target/` / `.venv/` jobs apart). The ORCHESTRATOR creates it as a SIBLING outside the repo (Rule 7 placement) and hands it to every agent in the lane by absolute path; the harness flag `isolation: "worktree"` is RETIRED (Rule 1). The isolation is only real if the agent edits inside its assigned worktree path; drift back to the main checkout silently breaks it (three drift causes: guide § "Rule 1 — Drift Causes And The Canonical STEP-0 Assertion").

## MUST Rules

### 1. Pre-Made SIBLING Worktree + A MANDATED STEP-0 Cwd ASSERTION — Both Halves

A TWO-PART contract. Both halves are MUST, and (b) is what REPLACES the cwd guarantee the retired flag used to provide.

**(a) Placement + naming.** The orchestrator MUST create each LANE's worktree ITSELF as a SIBLING outside the repo (Rule 7 placement; `/worktree` or a hand-rolled `git worktree add`), then dispatch WITHOUT any harness isolation flag, naming that ABSOLUTE path in every brief. The unit is the LANE, never the agent: opening a further worktree for an agent INSIDE a lane — for build contention or to keep writers apart — is BLOCKED; `rules/wip-discipline.md` MUST-9's partition does that job. Passing `isolation: "worktree"` — or `EnterWorktree({name})` — is BLOCKED: both place the worktree at `<repo>/.claude/worktrees/agent-<id>`, nested under the repo's OWN `.claude/`.

**(b) STEP-0 assertion.** Every brief dispatched into the lane MUST mandate that the agent's FIRST action is `cd <worktree>` FOLLOWED BY an assertion that it is now at an isolated worktree ROOT, refusing to proceed otherwise. Assert and refuse — not "verify", not "check". A dispatch naming the path but not mandating the assertion is BLOCKED. The assertion MUST compare RESOLVED paths (`pwd -P`, not the passed string) and MUST reject the main checkout — the canonical five-line runnable form is guide § "Rule 1 — Drift Causes And The Canonical STEP-0 Assertion".

Two forms are BLOCKED as the assertion: `git -C <worktree> …` (never establishes cwd — it answers about the worktree while leaving the agent in MAIN) and a BARE first `git rev-parse --show-toplevel` (resolves to MAIN on every dispatch, so it refuses always, and an always-refusing check gets deleted). Only `cd` FIRST, THEN assert, is both runnable and load-bearing. Pairs with Rule 2a: STEP 0 sets the floor; each later location-dependent invocation MUST re-assert. Form-by-form comparison: skill § Three candidate assertion forms.

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
# DO NOT — a second worktree for an agent INSIDE the lane (per-agent build dir instead)
# DO NOT — sibling path named, but no assertion mandated: nothing pins the agent's cwd
Agent(prompt=f"Working directory: {wt}\nImplement feature X.")
# DO NOT — `git -C` (never establishes cwd) or a bare rev-parse FIRST (always refuses)
Agent(prompt=f'STEP 0: git -C "{wt}" rev-parse --show-toplevel')
```

**BLOCKED rationalizations:** "`isolation: "worktree"` is the built-in primitive, so it must be the intended path" / "The isolation flag handles the cwd for me" / "Pre-making the worktree is orchestrator overhead the flag does for free" / "The prompt names the directory, the agent will work there" / "STEP 0 is ceremony — the agent already has the path" / "`git -C <wt> status` is the same check" (it is not — `-C` leaves the agent in MAIN) / "The agent can just `cd` first" (an UN-ASSERTED `cd` is an unverified assumption; `cd` + assert is the mandated form) / "compare the toplevel to the path I passed" (spurious refusal on any symlinked prefix — compare resolved forms) / "I'll just use relative paths, they're shorter" / "The agent will figure out the right directory" / "I tested it once, it worked — should keep working" / "each compiling agent needs its own worktree" (a per-agent build dir fixes the lock) / "a separate worktree keeps parallel writers apart" (MUST-9's disjoint file sets do).

**Why:** The retired flag is what SET the agent's working directory and prompt text is NOT a guarantee, so half (b) REPLACES that guarantee rather than supplementing it — without it the rule trades a bounded quota burn for unbounded silent work-loss to MAIN. Any future edit to an assertion here MUST state which inputs make it FAIL and which make it PASS. Depth: guide § Rule 1 + skill § Retiring `isolation: "worktree"`.

#### Trust Posture Wiring (Rule 1 — clause-scoped)

Depth — the grandfather note, the gate-review checklist (i)–(iv), and the probe-registration detail — lives in `.claude/guides/rule-extracts/worktree-isolation.md` § "Rule 1 — Wiring Depth".

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm each dispatch went into its LANE's orchestrator-made sibling, pinned absolutely, with the STEP-0 assertion mandated); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-07-26 → 2026-08-02); lane-unit amendment re-opens 2026-09-12 → 2026-09-19.
- **Cumulative posture impact:** same-class Rule-1 violations (enumerated in guide § "Rule 1 — Wiring Depth") contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` lists it.
- **Detection mechanism:** Phase 1 (gate-review) — reviewer runs the (i)–(iv) checklist in the guide § above over any parallel-dispatch session. Phase 2 (deferred) — no hook detector; fixtures land with it at `.claude/audit-fixtures/worktree-session-placement/` (shared with Rule 7) per `cc-artifacts.md` Rule 9. **Probes: REGISTERED** — `RULE-1-lane-unit-firing`; dispatchable, never auto-run.
- **Violation scope:** Rule 1 ONLY; Rules 2 and 3–6 stay grandfathered (Rule 2a left that set 2026-09-15 and carries its own block below).
- **Origin:** loom#1370 (owner-escalated fleet-wide quota burn); lane unit 2026-09-12 (`journal/0607` decision 5); see § Origin.

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

**Why:** Rule 1(b) puts the assertion in the PROMPT; this rule puts it in the AGENT FILE, so it survives the prompt. One git call (~30 ms) prevents specialist drift.

**BARE is correct HERE and wrong at Rule 1(b) — the difference is POSITION, not the command.** Do NOT "converge" this site onto `cd <wt> && …` — that makes the drift check unable to fail.

**The main-checkout exclusion is what gives this check teeth** — the root test alone PASSES in MAIN, so without it the check waves through the exact Rule-2a drift it exists to catch.

Depth — the `main=` subshell caveat, the position argument and the measured two-root result — lives in `.claude/guides/rule-extracts/worktree-isolation.md` § "Rule 2 — Why BARE Here, And Why The Main-Checkout Exclusion".

### 2a. Re-Assert Cwd Per Invocation — `cd` Persistence Is Not Trustworthy, And `&&` Binds Only Its Own Chain

The Rule-2 self-check at agent START is necessary but not sufficient: the shell's cwd can silently revert to the MAIN checkout mid-session after tool-mediated file operations, so a relative-path patch resolves against the wrong checkout and "succeeds". Any worktree command whose correctness depends on which checkout it runs in (apply patch, run tests, grep for the edit, reap a worktree) MUST re-assert location in the same invocation — not rely on a `cd` from an earlier call.

**The `&&` binds its own chain; only a REFUSAL binds the rest of the invocation.** `cd <wt> && <op>` is SOUND for what it joins — a failed `cd` short-circuits and `<op>` never runs — but it protects NOTHING on the NEXT LINE, which executes at whatever cwd the shell actually holds. `git -C <wt> …` is narrower still: it binds one git call and no non-git command at all. So EVERY location-dependent bash invocation MUST OPEN with a REFUSING `cd` on its OWN line — `cd <wt> || exit 1`, which exits the shell instead of skipping one chain — and EVERY LATER invocation MUST repeat it, because a `cd` does not survive the call that issued it. The obligation is per-LINE within a brief and per-CALL across one: writing the refusal once at a brief's STEP 0 and `&&`-chaining everywhere below it is BLOCKED, and so is omitting it from a brief's later steps because STEP 0 already carried it.

**A refusal only refuses if every operand can fail.** MEASURED in bash, zsh and sh: `cd ""` returns **0** and does not move, so an unset or empty operand sails through `cd "$WT" || exit 1` untouched. And the root test ALONE passes in MAIN, because MAIN is itself a worktree root — Rule 2's `# DO NOT` block above says exactly that, and § "The main-checkout exclusion is what gives this check teeth" says why. Compose the two and an agent sitting at MAIN with `$WT` empty clears both lines and then patches, tests and TEARS DOWN in MAIN. So the refusal MUST carry a non-empty guard AND the main-checkout exclusion; the two-line short form is BLOCKED as the assertion.

```bash
# DO — a REFUSING cd opens the invocation on its own line; later lines inherit it
[ -n "$WT" ] || exit 1                     # `cd ""` RETURNS 0 — an empty operand never refuses
cd "$WT" || exit 1
top=$(git rev-parse --show-toplevel) || exit 1
[ "$top" = "$(pwd -P)" ] || exit 1         # at a worktree ROOT...
main=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)
[ "$top" != "$main" ] || exit 1            # ...and NOT the main checkout
<apply-patch>
<run-tests>

# DO NOT — `&&` on line 1, unprotected work on line 2
cd "$WT" && git rev-parse --show-toplevel
<run-tests>     # runs wherever the shell IS — main's old code, prints green

# DO NOT — the short form: BOTH lines pass at MAIN with $WT empty
cd "$WT" || exit 1
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1

# DO NOT — trust a `cd` from an EARLIER invocation
<run-tests>     # cwd silently reverted → tests main's old code, prints green
```

**Which forms count as the refusal.** Any construct that ABORTS the invocation on a failed `cd` qualifies — `|| exit 1`, the canonical `|| { echo "STOP: …"; exit 1; }`, `if ! cd "$WT"; then exit 1; fi`, or a bare `cd "$WT"` under `set -e`. What does NOT qualify: `&&`-chaining (it skips one chain), `git -C` (it binds one git call), and **any of the above inside `( … )` or `$( … )`, where `exit` terminates only the subshell and the parent continues at its original cwd.**

A SINGLE-command invocation may still use `cd <wt> && <op>` or `git -C <wt> <op>`: both are sound for exactly one command, and Rule 2's BARE check must stay bare (§ "BARE is correct HERE"). What neither form does is generalize, which is why a brief hands the agent the refusal.

**BLOCKED rationalizations:** "I cd'd at the start of the session" / "the prior command ran in the worktree, so this one will" / "the test passed, the patch must have applied" / "the brief already has STEP 0, the rest of it inherits that" / "`&&` fails fast, so everything after it is protected" / "it is all one invocation, so one `cd` covers it" / "`git -C` pins the command, so the shell's cwd does not matter" / "a refusal on every call is noise — the path is right there in the brief" / "I'm using absolute paths everywhere, so cwd doesn't matter" (`git`, `cargo` and `pytest` each resolve their ROOT from cwd, whatever the file arguments say) / "the root check would obviously fail in main" (it PASSES — main is a worktree root) / "`$WT` is always set, the brief defines it" / "it's one destructive command, so the single-command carve-out covers it".

**Why:** The false-green is worse than a failure — it converts an unapplied patch into institutional "validated" state, and an `&&` that protects line 1 while line 2 runs in MAIN produces exactly that from a command that LOOKS pinned; when the unprotected later line is a teardown, the loss is unrecoverable rather than merely wrong. Pairs with Rule 3a (checkout-bound tools): 3a covers tools rooted at the script's own location; this clause covers the invoking shell's cwd. Evidence: guide § "Rule 2a — How The Silent Revert Produces A False Green".

#### Trust Posture Wiring (Rule 2a — clause-scoped)

Applies to **Rule 2a** ONLY (the per-line/per-call refusal obligation added 2026-09-15). That edit ends this clause's grandfather exemption per `trust-posture.md` MUST-8, so it ships canonical-8-field-compliant; Rules 2, 3–6 stay exempt until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every location-dependent invocation opened with a refusing `cd` on its own line carrying BOTH the non-empty guard and the main-checkout exclusion, and that no brief carried the refusal at STEP 0 alone). NO hook layer exists for this clause today. Were the structural half below built it would cap at `halt-and-report` — NOT because `hook-output-discipline.md` MUST-2 caps a parsed signal (it does not; MUST-2 caps a LEXICAL one, and this signal is parsed), but because the VERDICT rests on the semantic conjunct below, which is MUST-2's judgment-bearing branch.
- **Grace period:** 7 days from clause landing (2026-09-15 → 2026-09-22).
- **Cumulative posture impact:** same-class violations (a multi-line location-dependent invocation opened with an `&&` chain instead of a refusal; a brief carrying the refusal only at STEP 0; an invocation relying on a `cd` issued by an earlier call) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key. Named deviation per `trust-posture.md` Rule 8, on this clause's OWN reasoning rather than Rule 1's: whether an invocation was location-dependent is a review-layer judgment over the session's command history, so it does not support an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. This clause DOES own the unrecoverable-teardown outcome its `**Why:**` names — Rules 7–9 govern the teardown ITSELF, this one governs where the shell was standing when it ran — so the absence of a dedicated key rests on the judgment-bearing predicate, NOT on the loss being someone else's.
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes the `worktree-isolation` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session that dispatched into a worktree and confirm each location-dependent invocation opened with its own refusal. **NO Phase-2 detector is booked, and that is NOT a retirement.** This clause splits on mechanizability and the halves are recorded rather than averaged. The FIRST half IS structural: whether an invocation holds ≥2 top-level lines, and whether its first line establishes cwd by `&&`-chain rather than by a refusal, is an argv/AST read off a real shell parse of the Bash tool's command string — the signal class `hook-output-discipline.md` MUST-5(a) admits — so declaring this permanently advisory would be FALSE. The SECOND half is not: whether a given later line's correctness DEPENDS on which checkout it runs in is a semantic judgment over that line's meaning, so a detector firing on the structural half alone would also fire on benign multi-line commands. No detector is BUILT and none is booked — but the non-fence is DATED rather than left silent, at `phase2-deferrals.json::acknowledged_non_deferrals["worktree-isolation.md#rule-2a-per-line-refusal"]`, the bucket six sibling clauses in this file already use. That row is what discharges `completion-criterion.md` MUST-6: a declared omission is a RESIDUAL whether or not it is written down, so deleting the note hides it rather than discharging it and "silence is never the compliant path". Gate-review IS the enforcement layer today; the structural half is a live detector CANDIDATE proposed to the platform owner, not a scheduled fence. The semantic tier is covered by declaration, not by a suite: `clause-coverage-baseline.json` carries a dated `deferred` row for MUST-2a, so a reader looking for probes will find a declared gap with an expiry rather than a bare "UNCOVERED".
- **Violation scope:** Rule 2a ONLY (clause-scoped) — the per-line refusal obligation within an invocation and the per-call repetition across invocations. Every `violations.jsonl` row names the invocation and which half failed.
- **Origin:** 2026-09-15 — a lane whose shell silently relocated and whose teardown then destroyed work on an unprotected later line. See § Origin.

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

**Why:** Tools that resolve their workspace root via `Path(__file__).parent.parent` (Python), `cargo locate-project` (Rust), or `package.json` discovery (Node) are bound to whichever checkout owns the SCRIPT BINARY — not the invoker's CWD. The post-merge re-run is the only invocation where the script's resolved ROOT and the verified state actually coincide. Source-of-truth example (a BUILD repo): `tools/sweep-redteam.py:65` pins `ROOT` off `__file__`, so an in-worktree run scans the main checkout. Worked walkthrough: guide § "Rule 3a — The Checkout-Bound Tool Example".

### 3b. An Agent Delivered Only When Its Placeholders Are GONE — Existence Is Not Delivery

Rule 3's predicate (`ls` / `Read` the claimed file) discriminates only while a MISSING file means a dead agent. Briefing an agent to write its report SKELETON FIRST ends that: the skeleton is written BEFORE the work, so the file exists whether the agent delivered or died and the check returns the same answer under both hypotheses — a non-discriminating instrument (`instrument-discipline.md` MUST-1). The parent MUST therefore verify CONTENT: before an agent's output is trusted, aggregated, counted as surface coverage, or its report committed, the unfilled markers — placeholder tokens (`_(pending)_`, `TBD`), a non-terminal `Status:`, an empty verdict / findings / instrument table — MUST ALL be absent. A report still carrying them delivered NOTHING; re-dispatch the agent or do the work inline, and record which. Committing a still-skeletal report without recording it UNDELIVERED is BLOCKED — it converts a dead agent into an artifact that reads as covered.

```bash
# DO — verify the placeholders are GONE; a hit means UNDELIVERED, not "in progress"
grep -nE '_\(pending\)_|^Status:.*(IN PROGRESS|pending)|\bTBD\b' "$report" \
  && echo "AGENT UNDELIVERED: $report — re-dispatch or execute inline; do NOT aggregate"

# DO NOT — the existence check skeleton-first silently defeats
[ -s "$report" ] && echo "agent delivered"   # a 296 B all-placeholder skeleton passes this
```

**BLOCKED rationalizations:** "the skeleton-first brief works" / "the report exists, Rule 3 is satisfied" / "`Status: IN PROGRESS` means the agent is still working" (the agent has exited; the marker is stale by construction) / "the agent's surface is covered, the write-up is cosmetic" / "the agent reported done, the file is just thin" / "commit it as-is, the next session will fill it in" / "it has a header and section names, so it is not empty".

**Why:** Skeleton-first was adopted to make an agent's silence visible, and it does — but it also guarantees the file exists before any work happens, so it DEFEATS the one check Rule 3 mandates and converts an obvious absence into an artifact that passes review. Measured evidence: guide § "Rule 3b — The Four Skeletal Lanes".

#### Trust Posture Wiring (Rule 3b — clause-scoped)

Post-MUST-8-cutoff, canonical-8-field-compliant; Rules 2–6 grandfathered.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every agent report was content-verified before its output was aggregated or committed); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — the placeholder vocabulary is brief-defined, so a lexical scan MUST NOT carry `block`.
- **Grace period:** 7 days from clause landing (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (output aggregated or a surface counted covered on an existence check alone; a still-skeletal report committed without being recorded UNDELIVERED) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` lists it.
- **Detection mechanism:** Phase 1 (gate-review) — reviewer greps each agent report for the placeholder markers and confirms every hit was recorded UNDELIVERED with its disposition. **NO structural detector is claimed and none is deferred** per `hook-output-discipline.md` MUST-5(b) — detection is PERMANENTLY ADVISORY. Scanner: none (semantic). Fixtures `.claude/audit-fixtures/lane-delivery-verification/`; probes `.claude/test-harness/probes/worktree-isolation.probes.json`.
- **Violation scope:** Rule 3b ONLY; Rules 2–6 grandfathered.
- **Origin:** 2026-08-10 lane-output-loss codification; see § Origin.

### 4. Parallel-Launch Concurrency Is Throttle-Aware Adaptive (Not A Fixed Cap)

When launching multiple Opus-tier agents in one orchestration turn — worktree-isolated OR plain parallel subagents — the parent MUST govern concurrency by an ADAPTIVE back-off model, NOT a fixed number and NOT the runtime's native ceiling. Cold start (no throttle signal yet this session): cap the first wave at **~3 concurrent Opus-tier agents** — NOT the native `min(16, cores−2)` cap and NOT unlimited. Back off ONLY on the falsifiable signal below; do NOT preemptively serialize below ~3, and do NOT assert "no cap."

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

**Why:** The binding constraint is a server-side CONCURRENCY throttle biting far below the native cap — not account quota, not a fixed batch count — so "trust native 14" re-ships the synchronized-burst death while "always ≤3" wastes the multiplier on low-contention sessions. Depth (both measurements, the suppressed-signal bound, the spoofing bound): guide § Rule 4 + journal/0193/0194.

### 4a. A SYNCHRONIZED Multi-Agent Death Is TRIAGED Before Any Re-Dispatch

Rule 4 EXCLUDES the quota case from concurrency back-off (the remedy there is an account swap, not fewer agents); Rule 3 verifies ONE agent's deliverables. Neither covers a whole fleet dying at once. Four obligations, each MUST:

**(1) An idle/completion notification is ZERO EVIDENCE an agent finished.** Before treating any agent as done, READ the notification's own `idleReason`; where it is `failed`, READ `failureReason`. Finished and died arrive as the SAME event and mean opposite things. This is `evidence-first-claims.md` MUST-3 one layer up, and the fleet-level form of Rule 3's after-exit `ls`.

**(2) On a synchronized multi-agent failure, TRIAGE BEFORE RE-DISPATCHING.** For EVERY dead agent, check its worktree for uncommitted work and CAPTURE it to a patch outside the tree BEFORE any worktree is reused, re-entered, or removed. Unstaged and untracked-not-ignored work has NO reflog (`rules/git.md` § Destructive Working-Tree Ops); `git stash` is BLOCKED here as everywhere (Rule 9). Affordance: `node .claude/bin/worktree-triage.mjs` — read-only; it exits 3 when work is at risk, and `--capture <dir>` writes the patches outside the forest. **SUBMODULE content is NOT captured and MUST be rescued BY HAND** — the tool names the submodule and exits 2, but a loud gap is still a gap: rescue that content manually before the tree is reused or removed. Depth — the shared `verdict` / `recoverability` vocabulary, and why a dirty submodule's uncommitted files reach no patch — lives in `.claude/guides/rule-extracts/worktree-isolation.md` § "Rule 4a — The Triage Affordance And Its Submodule Gap".

**(3) Re-dispatch INTO the surviving worktree.** Where a dead agent's tree still holds in-flight work, brief the replacement into THAT tree by absolute path (Rule 1) instead of restarting its work in a fresh one — a fresh tree abandons everything the old one holds. BOUNDED by `orchestration-launch-ledger.md` MUST-4: a quota stop is a PAUSE, not a death, so the original is resumed by name, or stood down AND confirmed, BEFORE any replacement enters its tree.

**(4) Brief every lane's committer to commit and push incrementally.** One sentence in the brief, and it is the whole difference between LOST and PUSHED when the fleet dies mid-run — an interruption an agent cannot predict from inside itself.

```bash
# DO — read the field, triage every dead agent, capture, THEN decide
jq -r '.idleReason, .failureReason' <<<"$notification"      # failed / "You've hit your session limit"
node .claude/bin/worktree-triage.mjs --capture "$HOME/rescue-$(date +%F)"   # exit 3 ⇒ work at risk
# DO NOT — read idle as finished, or re-dispatch over the evidence
echo "6 agents still running"; git worktree remove "$wt"; relaunch_agent   # all six died 3 min ago
```

**BLOCKED rationalizations:** "the agent went idle, so it finished" / "N agents are still running" (never re-read after the notifications landed) / "a quota error is not the throttle signal, so there is nothing to do" (Rule 4 excludes it from BACK-OFF, never from TRIAGE) / "the agent would have committed before it stopped" / "the worktree is still there, so the work is safe" (reuse and removal both destroy it, and there is no reflog) / "re-dispatching is faster than checking eight trees" / "I will triage after the replacements are launched" / "a fresh worktree is cleaner" / "`git stash` keeps it safe while I relaunch" (the stack is shared — Rule 9) / "the branch has the commits" (it has the COMMITTED ones; 23 modified files are not among them).

**Why:** A quota death takes every agent in the same instant, so the orchestrator's own "N running" goes stale for all of them at once and nothing else contradicts it. The work at risk is exactly the work no ref holds, so the window between the death and the first reuse is the only one in which it still exists.

#### Trust Posture Wiring (Rule 4a — clause-scoped)

Post-MUST-8-cutoff, canonical-8-field-compliant; Rules 2–6 grandfathered.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm obligations (1)–(4) were honored for every dead agent before any tree was reused or removed); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a field was READ is session-history judgment with no tool-call-time signal.
- **Grace period:** 7 days from clause landing (2026-08-20 → 2026-08-27).
- **Cumulative posture impact:** same-class violations of obligations (1)–(4) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; one ack covers Rules 1–9).
- **Detection mechanism:** structural affordance + review. `.claude/bin/worktree-triage.mjs` exits 3 on any SALVAGE tree, so obligation (2) has a runnable instrument; bipolar fixtures `.claude/audit-fixtures/worktree-triage/`, registered in `ci-audit-fixtures.json`. **Phase 2 is RETIRED, not deferred** per `hook-output-discipline.md` MUST-5(b): whether a notification field was read is not observable at tool-call time, so gate-review IS the permanent enforcement layer for obligations (1), (3) and (4). **Probes: REGISTERED** — the bipolar `RULE-4a-firing` pair; dispatchable, never auto-run. Affordance-vs-detector distinction + fixture poles: guide § "Wiring Depth — Detection mechanisms".
- **Violation scope:** Rule 4a ONLY, obligations (1)–(4); each `violations.jsonl` row names the agent and which obligation failed. Rules 2–6 grandfathered.
- **Origin:** 2026-08-20 co-owner-directed origination, receipt-first `journal/0584`; see § Origin.

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

**Why:** `git worktree add` without explicit base defaults to whatever branch HEAD was last set — can be pre-merge commit from hours ago. Stale-base worktrees merge cleanly only when packages don't overlap; otherwise 3-way merge silently discards one shard's edits. Merge-base check converts invisible drift into loud pre-flight abort. Evidence: guide § Rule 5.

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

**Why:** Branch names are the primary `git log --grep` surface for tracing a shard back to its plan — `feat/w31-core-ml-nodes-observability` surfaces in history; `worktree-agent-aa7fb6a6` surfaces only as meaningless hash. Post-merge audits cannot enumerate "did every planned shard land?" via grep when half use harness defaults. Evidence: guide § Rule 6.

### 7. Session/Operator Worktrees Live In A Sibling OUTSIDE The Repo — Never Nested Under `.claude/worktrees/`

Rules 1–6 govern the TRANSIENT **agent-wave** worktree. A DURABLE **session/operator** worktree — one a human or session ROOTS INTO across a task — is a DIFFERENT artifact and MUST be created OUTSIDE the repo working tree, as a SIBLING in the MAIN repo's parent dir (`<main-repo-parent>/.<repo-slug>-wt/<name>`), NEVER under the repo's own `.claude/worktrees/` or anywhere below the repo root. The canonical mechanism is **`/worktree`**; a hand-rolled `git worktree add` MUST still obey the placement rule. Root the session by LAUNCHING the CLI with the sibling as cwd (robust), OR — Claude Code only — `EnterWorktree({path: <sibling>})` on FIRST entry. `EnterWorktree({name})` MUST NOT be used for durable session work (it creates under `.claude/worktrees/` — the nesting trap). Every task: branch off `origin/<default>`, PR to main, admin-merge, return.

**Placement is a MUST for any worktree a SESSION ROOTS INTO — the reason is quota, not tidiness.** A nested ROOT duplicates the matching path-scoped set. The requirement binds on PLACEMENT, so it holds whether or not the CLI's loading behaviour changes. Measurement matrix: skill § Ancestor-Load Measurement.

**Scope bound — the quota reason does NOT extend to a dispatched subagent**, which inherits the DISPATCHING session's corpus wholesale; rooting THAT session in a sibling is the lever. Depth — the 2/2 measurement and the INFERENCE bound on the composed case — lives in `.claude/guides/rule-extracts/worktree-isolation.md` § "Rule 7 — Ancestor-Load Scope Bound (Measured)".

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

**BLOCKED rationalizations:** "`.claude/worktrees/` is the built-in worktree location" (that is for the TRANSIENT agent waves of Rules 1–6, not a session you root into) / "`EnterWorktree({name})` is the tool's intended path" (it creates under `.claude/worktrees/` → nested inside the repo's glob range) / "it's gitignored, so nesting is harmless" (gitignore does not stop a parent-repo `grep -r` or a `--root .` validator run descending into the nested checkout) / "the clutter is only cosmetic" (a full nested checkout inside the repo working tree is a real recursion target for parent-repo tooling) / "sibling paths clutter the parent dir" (the dot-prefixed sibling stays hidden on macOS/Linux) / "the double-load was already tested and did not reproduce" (its aggregate-size instrument could not see duplication — § "The methodological lesson") / "the corpora are the same size, so nothing is duplicated" (same size is exactly what loading the same bytes twice from two roots looks like to a size comparison) / "every worktree has its own `.git`, so it must be its own root" (true of `.git` resolution; FALSE of path-scoped rule injection, which was measured to reach up to the ancestor).

**Why:** A session rooted at a NESTED worktree loads path-scoped rules from BOTH roots — measured 2/2: the same rule arrived TWICE, while a SIBLING-rooted session loaded each exactly once with zero ancestor content. `CLAUDE.md` and baseline rules do NOT ancestor-load.

**The methodological lesson — the durable part.** Any re-test of the ancestor-load question MUST use a root-distinguishing instrument (an UNTRACKED sentinel at one root only), never an aggregate size; the committed instrument is `bin/probe-ancestor-load.mjs`. The 2026-07-22 "no double-load" conclusion was **WITHDRAWN as unsupported** — it compared aggregate TOKEN COUNTS, an instrument structurally blind to duplication of byte-identical corpora, so it could not have returned the other answer. Depth — the measurement matrix, that withdrawal, and the placement conclusion's three independent grounds — lives in `.claude/guides/rule-extracts/worktree-isolation.md` § "Rule 7 — Methodological Lesson, Placement Grounds, Guard State".

**The nesting trap reaches Rules 1–6 too, and where a structural guard enforces it that guard MUST ship TWO audited override channels.** Both flags land the AGENT-WAVE worktree at the same nested placement, which is why Rule 1(a) BLOCKS both. A deployment MAY enforce this structurally at `PreToolUse` with `severity: block` — the signal is a literal parameter VALUE read from the structured payload, the structural class `hook-output-discipline.md` MUST-2 permits `block` for. Such a guard MUST discriminate on the **RESOLVED TARGET PATH**, not on which key carries it: keying on `name`-without-`path` is disarmed by appending a `path`, and the resolution MUST follow `security.md` § Path Containment. And per `hook-output-discipline.md` MUST NOT § "Detectors that block work the agent has been instructed to perform", it MUST NOT dead-end legitimate work — so it ships with BOTH:

1. **An AGENT-REACHABLE one-shot receipt** — a non-empty reason written to `.claude/worktree-authz/nested-worktree-allow`, which the guard CONSUMES (deletes) as it honors it, so an override cannot silently disarm the gate for later calls.
2. **An operator/CI environment channel** — `COC_ALLOW_NESTED_WORKTREE=1`.

Both MUST surface an `advisory` into the agent-visible context, so an override is never silent. **The receipt is the channel that answers the MUST NOT; the env var alone does not.** Whether such a guard is present in a given deployment is MUTABLE state: re-measure it, never cite a rule line for it. Depth: guide § "Rule 7 — Methodological Lesson, Placement Grounds, Guard State".

#### Trust Posture Wiring (Rule 7 — clause-scoped)

Post-MUST-8-cutoff, canonical-8-field-compliant; Rules 2–6 grandfathered.

- **Severity:** `halt-and-report` at gate-review (a session-rooted worktree is a sibling outside the repo, never under `.claude/worktrees/`); `advisory` at the hook layer (placement is session-setup judgment — `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days (2026-07-11 → 2026-07-18); the 2026-07-26 measured-placement amendment re-opened its own 7-day grace (→ 2026-08-02).
- **Cumulative posture impact:** same-class violations (a durable session worktree nested below the repo root) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` lists it.
- **Detection mechanism:** Phase 1 (gate-review) — confirm sibling placement and no `EnterWorktree({name})` for durable work; any review RE-LITIGATING the ancestor-load claim MUST reject an aggregate-size instrument and require a root-distinguishing sentinel. **Phase 2 is RETIRED, not pending (2026-09-11)**, and its two halves retire for OPPOSITE reasons. The PLACEMENT half SHIPS (`nested-worktree-guard.js`; `detectWorktreeDrift` at `rule_id "worktree-isolation/MUST-1"`), fixtures `.claude/audit-fixtures/worktree-session-placement/`; the REPRODUCTION-VERDICT half never will — how a verdict was JUSTIFIED lives in the argument, not in any structural signal, the shape `rule-authoring.md` MUST NOT names. Rationale + fixture census: `phase2-deferrals.json` key `worktree-isolation.md#rule-7-reproduction-verdict`.
- **Violation scope:** Rule 7 (sibling-placement + the 2026-07-26 amendment) ONLY; Rules 2–6 grandfathered.
- **Origin:** co-owner-directed 2026-07-11 (`journal/0463`); amended 2026-07-26 after the re-measurement. The forward-marker on `journal/0565`, the withdrawn 2026-07-22 run and the sentinel re-measurement: guide § "Rule 7 — Wiring Origin: The Withdrawn 2026-07-22 Measurement". Full matrix: skill § Ancestor-Load Measurement.

### 8. Creation Owns Teardown — Reap On Evidence, Never `--force`

Rules 1–7 govern CREATION; teardown is a TWO-TRIGGER obligation, and both halves are MUST.

**(a) Per-wave, by the creator.** The orchestrator that created a wave's worktrees MUST reap them at the wave's terminal-lane transition — once each lane is committed AND either merged or preserved on a pushed branch.

**(b) Automatically, as a backstop — SessionEnd reaps, unattended, and ONLY ITS OWN.** (a) fails silently when an orchestrator dies mid-wave. **NOT-MINE IS A REFUSAL**: a tree whose recorded creator is another session — or that carries no record at all — is REPORTED and never reaped, and a pass with no session identity refuses to run. Creation therefore RECORDS ownership, and "reap on delivery" is the `--deliver` form. Kill switch `COC_WORKTREE_AUTOREAP=0` (default ON). `/sweep` Sweep 6 remains the audit + TAG-FIRST backstop. The SessionEnd invocation flags, the waiver set, why TAG-FIRST stays operator-invoked, the ownership record's path and how it is resolved, and the `--deliver` sequence: guide § "Rule 8 — The Unattended SessionEnd Reaper".

**Removing a worktree does not delete its branch.** `git worktree remove` deletes the DIRECTORY, never `refs/heads/<branch>`, so every COMMITTED commit survives and re-materialises with one `git worktree add <path> <branch>` — that fact is what ZERO-LOSS rests on. What does NOT survive: anything never committed (no reflog — `rules/git.md` § Destructive Working-Tree Ops) and a DETACHED HEAD no ref reaches (the TAG-FIRST case).

```bash
# DO — the branch is the durable artifact; the directory is disposable
git worktree remove "$wt" && git rev-parse --verify "refs/heads/$branch"  # ref still there
git worktree add "$wt" "$branch"                                          # re-materialised
# DO NOT — treat the directory as the work, or hoard trees to "preserve"
# commits a ref already holds
```

**Why:** An operator who believes removal destroys the work will not reap, and the forest grows to ENOSPC — where the shell commands needed to diagnose it fail too, and in-flight agent writes truncate mid-file into what read as ordinary syntax errors.

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

**Why:** Retiring the auto-cleaning `isolation: "worktree"` flag re-homed creation onto the orchestrator and teardown onto nothing, so the forest grows unbounded, and the asymmetry hid it: every cleanup mention in the paired skill defended work FROM auto-cleanup, so the discipline read complete while being one-sided. Depth + the measured clone: the paired skill § Teardown.

#### Trust Posture Wiring (Rule 8 — clause-scoped)

Post-MUST-8-cutoff, canonical-8-field-compliant; Rules 2–6 grandfathered.

- **Severity:** `halt-and-report` at gate-review (a session that created wave worktrees either reaped them at the terminal-lane transition or recorded a KEEP verdict per tree with its evidence); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (leaked-vs-held is session-state judgment).
- **Grace period:** 7 days from clause landing (2026-07-30 → 2026-08-06).
- **Cumulative posture impact:** same-class violations (worktrees left with no KEEP evidence; a reap via `--force`/`rm -rf`; Sweep 6 reported complete without the forest audit) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` lists it.
- **Detection mechanism:** structural + review. **Phase 2 LANDED** (2026-08-04, `worktree-forest-guard.js`) and since 2026-08-12 it ENFORCES rather than only reports. Phase 1 (gate-review) still applies — reviewer runs `node .claude/bin/worktree-reap.mjs --json` and confirms every surviving tree carries a KEEP verdict with a named reason; a ZERO-LOSS tree still on disk after the wave closed is a finding, as is any `--force`/`rm -rf` in the removal path. Fixtures `.claude/audit-fixtures/worktree-session-placement/`. Suites + what each pins: guide § "Wiring Depth — Detection mechanisms".
- **Violation scope:** Rule 8 ONLY; Rules 2–6 grandfathered.
- **Origin:** co-owner-directed 2026-07-30 — a #1370 teardown regression; verbatim directive: guide § "Rule 8 — Wiring Detection And Origin Depth". See also § Origin.

### 9. The Stash Stack Is `.git`-SCOPED And SHARED — Never Stash In A Worktree-Carrying Repo

**The stash stack lives in the common `.git` dir, so it is shared by the main checkout and EVERY linked worktree** — unlike the index and `HEAD`. In a repo carrying any `git worktree add` checkout — this corpus's DEFAULT execution mode — `git stash` MUST NOT be used to park or protect work: a sibling's `git stash pop` applies YOUR entry into ITS tree and drops it, leaving you a merely-clean tree and the sibling a mutation neither authored. Both sides fail SILENTLY. Capture instead to a surface no other checkout can reach — a patch file (`git diff > <path>.patch`; `git add -N .` first for untracked) or a `cp` backup outside the tree.

```bash
# DO — capture to a patch nobody else can pop
git diff > "$SP/wip.patch"   ;   git apply "$SP/wip.patch"
# DO NOT — park on a stack every sibling worktree can list and pop
git stash -u
```

**Why:** Every other parallel-work hazard in this rule is bounded BY the worktree boundary; the stash is the one primitive that reaches ACROSS it, which is why it reads as safe and is not. Capture protocol, both-pole verification, BLOCKED corpus, evidence: `skills/30-claude-code-patterns/worktree-orchestration.md` § Stash Collision In A Shared `.git`.

#### Trust Posture Wiring (Rule 9 — clause-scoped)

Post-MUST-8-cutoff, canonical-8-field-compliant; Rules 2–6 grandfathered.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm no session parked work on the stash in a worktree-carrying repo); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether the repo carries linked worktrees is a second lookup the matcher does not perform, so the lexical signal alone MUST NOT carry `block`. The shipped register is `pre-action` (`.claude/hooks/lib/instruct-and-wait.js`'s NON-BLOCK PreToolUse head — same advisory class); why: guide § "Rule 9 — Wiring Depth (Severity, Detection, Origin)".
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (work parked via `git stash` in a repo carrying linked worktrees; a `git stash pop` taking an entry the session did not create) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; Rule-8 deviation rationale: guide § "Wiring Depth — the shared no-dedicated-key rationale".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; one ack covers Rules 1–9).
- **Detection mechanism:** structural + review. **Phase 2 LANDED** (2026-08-18, loom#1795), superseding this field's former "deferred" and deleting its `phase2-deferrals.json` row: `validate-bash-command.js` pairs a MUTATING `git stash` form with a worktree count > 1 via `hooks/lib/stash-collision.js`; reads and `stash create` stay SILENT (`cc-artifacts.md` Rule 7). **Blind spots are enumerated, not implied** — four command shapes sit outside the Bash-boundary vantage point, so Phase 1 stays the backstop: reviewer greps the session's command history for `git stash` and, on a hit, confirms `git worktree list` reported only the main checkout. Fixtures `.claude/audit-fixtures/worktree-stash-collision/`. Blind-spot list + fixture arms: guide § "Wiring Depth — Detection mechanisms".
- **Violation scope:** Rule 9 ONLY; Rules 2–6 grandfathered.
- **Origin:** 2026-08-11 — landed at loom via `/sync-from-use` Gate-1 placement of a downstream-relayed upflow entry (hop-level provenance only). Manifest pin, the paired `git.md` entry, and the two re-verified premises: guide § "Rule 9 — Wiring Depth (Severity, Detection, Origin)".

### 10. A Dispatched Agent's Git Command NAMES Its Tree, Or The Brief Forbids Git Writes

A dispatched agent runs in the ORCHESTRATOR'S working directory, so a git command that does not say which tree it means operates on the orchestrator's checkout — not on the agent's scratch space, and not on nothing. The agent cannot tell from inside, because every command succeeds either way.

An orchestrator dispatching an agent that will BUILD a repository fixture (a git repo, a commit graph, a branch layout, a `commit-tree` shape) MUST do one of two things IN THE BRIEF, and the choice is the orchestrator's: **PIN** — every git call carries an absolute `-C <scratch path>` (or `--git-dir`), with a STEP-0 assertion comparing resolved `git rev-parse --show-toplevel` to that path and refusing on mismatch; or **FORBID** — the agent runs NO git write at all (`init`, `add`, `commit`, `branch`, `checkout`, `merge`, `push`, `update-ref`, `remote`, `worktree`, `config`), because it needs no repository fixture. Dispatching with NEITHER is BLOCKED, and an agent that receives neither MUST ask before its first git write rather than infer a target.

**The instruction is STRUCTURAL, not a remembered sentence.** It MUST ride a mechanism the orchestrator cannot forget — the dispatch-time check named in the Wiring below. An orchestrator that satisfies this by remembering to paste a clause satisfies it for exactly as long as it remembers.

```text
# DO — pin absolutely, and assert before writing
git -C /tmp/scratch/fx/repo init && [ "$(git -C /tmp/scratch/fx/repo rev-parse --show-toplevel)" = /tmp/scratch/fx/repo ]
# DO — or forbid: "this agent reads the bundle; never run a git write command anywhere"
# DO NOT — a fixture brief that names no tree: "Build a git repository fixture with three commits."
```

**BLOCKED rationalizations:** "the agent will obviously use its own scratch directory" · "it runs in a sandbox" · "`cd` at the top of the script is the same as `-C`" · "the agent is read-only in practice" · "every brief so far has been fine" · "pinning every call is noisy — one `cd` covers it" · "a fixture repo is disposable, so the target does not matter" · "I always include the clause".

**Why:** An unpinned git command resolves to whatever tree the process sits in and reports success either way, so the agent gets no signal and the orchestrator learns from the damage. Measured blast radius: guide § "Rule 10 — Wiring Depth (Detection, Origin)".

## MUST NOT

- Leave a wave's worktrees on disk once the wave has closed, or reap one by `--force` / `rm -rf` instead of a bare `git worktree remove`

**Why:** Accumulation is unbounded and ends at a full volume; `--force` and `rm -rf` defeat the one refusal that protects unstaged and untracked-not-ignored work, which has no reflog.

- Launch an agent with `isolation: "worktree"` or `EnterWorktree({name})` at all — or dispatch into a pre-made worktree without BOTH pinning its absolute path AND mandating the STEP-0 cwd assertion

**Why:** Both flags place the worktree under the repo's own `.claude/` (Rule 1's quota cost). Retiring them also removes the cwd guarantee they provided, so a dispatch that names the path but does not mandate the assertion leaves nothing pinning the agent anywhere.

- Use `git -C <worktree> …`, or a BARE `git rev-parse --show-toplevel`, as the STEP-0 assertion

**Why:** `-C` never establishes cwd — it answers a question about the worktree and leaves the agent in MAIN, so everything after it still resolves to MAIN. A bare `rev-parse` as the FIRST action resolves to MAIN on every dispatch and refuses always. `cd` first, then assert, is the only form that is both runnable and load-bearing.

- Assert by string-comparing `git rev-parse --show-toplevel` against the path the orchestrator passed

**Why:** `--show-toplevel` returns the symlink-RESOLVED path, so any symlinked prefix refuses spuriously on a perfectly correct worktree — and an always-refusing check gets deleted. Compare `pwd -P` against `--show-toplevel`, both resolved.

- Park or protect work with `git stash` in a repo carrying any `git worktree add` checkout

**Why:** The stash stack is `.git`-scoped and shared across every linked worktree, so a sibling can list and pop your entry — taking the work silently and leaving your tree merely "clean" (Rule 9).

- Trust an agent's "completion" message when it says "Now let me write…" followed by no tool call

**Why:** Budget exhaustion truncates the write. The completion message is misleading; the filesystem is the source of truth.

- Use `process.cwd()` or relative paths inside specialist agent files that may run in a worktree

**Why:** `process.cwd()` resolves to whatever the Claude Code process was launched with (the main checkout), not the worktree; relative paths inherit the same problem.

Origin: Session 2026-04-19 specialist drift; the full dated chain (Rules 2a, 4, 4a, 1, 3b, 7, 8, 9, 10) and per-rule narratives: guide § "Origin Chain — Per-Rule Provenance"; Rule 3b's per-occurrence evidence: skill § Agent-Delivery Verification.

**Extraction record** (2026-08-19 structural cleanup + 2026-09-13 + 2026-10-01 injection-budget passes, ZERO de-scoping — every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**` line stays here; only evidence, runnable detail, measured narrative, superseded-reading history and per-instance provenance moved, each behind a resolving pointer to `.claude/guides/rule-extracts/worktree-isolation.md`). Why `rule-authoring.md` Rule 10 / Rule 11 do NOT fire on this `scope: path-scoped` rule: guide § "Extraction Record".

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **one-orchestration-contract scope** — the single contract an orchestrator consults across a parallel wave's whole lifecycle, placement through teardown, each rule carrying the DO/DO-NOT + `**Why:**` + BLOCKED corpus the meta-rule mandates plus, for every post-MUST-8 rule (count them off the `Trust Posture Wiring` headings rather than trusting a figure here — a transcribed total is what goes stale), the canonical 8-field Wiring. Splitting it would fracture one lifecycle across files; depth is EXTRACTED to `skills/30-claude-code-patterns/worktree-orchestration.md` + `guides/rule-extracts/worktree-isolation.md`. `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost.

### Trust Posture Wiring — MUST-10 (dispatched-agent git target)

Applies to the **MUST-10** clause ONLY (added 2026-09-06); canonical-8-field-compliant per `trust-posture.md` MUST-8. Pre-existing sections stay on their own wiring until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at the hook layer — `hooks/lib/dispatch-contract.js::detectUnpinnedFixtureDispatch`, consumed by the registered `hooks/dispatch-contract-guard.js` on the `PreToolUse` `Task|Agent` matcher. NOT `block`: the predicate reads prompt PROSE, and `hook-output-discipline.md` MUST-2 bars `block` on a lexical signal. `halt-and-report` also at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm every fixture-building dispatch carried a pin or a prohibition).
- **Grace period:** 7 days from clause landing (2026-09-06 → 2026-09-13).
- **Cumulative posture impact:** same-class violations (a repository-fixture brief dispatched with neither a pinned target nor a git-write prohibition; an agent inferring a git target the brief never named) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; named deviation per `trust-posture.md` Rule 8 on this clause's OWN reasoning (the loss is recoverable). Rationale: guide § "Rule 10 — Wiring Depth (Detection, Origin)".
- **Receipt requirement:** SessionStart soft-gate `[ack: worktree-isolation]` IFF `posture.json::pending_verification` includes the `worktree-isolation` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** STRUCTURAL and SHIPPED — this clause defers nothing at the seam it can reach. The predicate (`fixtureContainmentOf`) goes silent only on this clause's two forms: an absolute `-C`/`--git-dir` PIN on every git call WITH its STEP-0 assertion, or the FORBID prohibition — a pin without the assertion still fires. Bipolar fixtures: the `22`-series cases in `.claude/audit-fixtures/dispatch-contract/run.mjs`. **Phase 2 is RETIRED, not pending, for the BASH layer:** no tool-call-time signal separates a DELEGATED agent's git write from the orchestrator's identical own, so booking a detector there would be teeth that cannot arrive, which `hook-output-discipline.md` MUST-5(b) forbids. The DISPATCH boundary is the enforceable seam, permanently. No probe suite is claimed; the semantic tier is UNCOVERED, owed at gate-review via `/test-harness-probe`. Predicate detail + pole inventory: guide § "Rule 10 — Wiring Depth (Detection, Origin)".
- **Violation scope:** MUST-10 ONLY (clause-scoped) — a fixture brief with neither a pin nor a prohibition, and an agent inferring a target the brief never named. Every `violations.jsonl` row names the dispatch and which of the two was missing.
- **Origin:** 2026-09-06 — co-owner-directed origination; the incident record and why it folded into THIS rule: guide § "Rule 10 — Wiring Depth (Detection, Origin)".
