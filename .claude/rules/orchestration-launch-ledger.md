---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/workspaces/**"
  - "**/.session-notes*"
  - "journal/**"
---

# Orchestration Launch-Ledger — Track Spawned Agents In A Durable Artifact That Survives Context Boundaries

An orchestrator that spawns background / parallel agents holds the map of what it launched — track → agent → branch → status — in WORKING MEMORY. A context boundary (compaction, `/clear`, resume, sub-agent handoff) ERASES that memory while the agents keep running. On the far side the orchestrator (a) spawns a DUPLICATE of a track already in-flight, and (b) mis-attributes its OWN already-pushed branches to a "parallel session" it did not launch. The fix is a DURABLE artifact: an on-disk launch-ledger the compaction cannot erase, consulted BEFORE every spawn and matched AGAINST every completion notification.

This rule owns the DURABLE-LEDGER + DEDUP-BEFORE-SPAWN + MATCH-COMPLETION-BEFORE-REACTING discipline. It composes with `wave-loop.md` MUST-6/7, `agents.md` § Triad + § Worktree Orchestration and `knowledge-convergence.md` MUST-1. Depth: `.claude/guides/rule-extracts/orchestration-launch-ledger.md`.

## MUST Rules

### 1. An Orchestrator Spawning Background Agents MUST Maintain A Durable On-Disk Launch-Ledger

Any orchestrator that spawns ≥1 background / parallel / worktree-isolated agent MUST record each launch in a DURABLE on-disk ledger — a table in the active workspace, `.session-notes`, or a workspace ledger file — that SURVIVES compaction. Each row maps: track/shard → agent id-or-name → branch (if any) → status (`in-flight` / `landed` / `stopped`). In-memory-only tracking (relying on the transcript / working memory to remember what was launched) is BLOCKED — the transcript is exactly what the context boundary erases.

```markdown
# DO — durable ledger row per launched agent, written before/at spawn

| track          | agent     | branch        | status    |
| -------------- | --------- | ------------- | --------- |
| engine-feature | W2-engine | feat/engine-x | in-flight |
| store-adapter  | W2-store  | feat/store-y  | in-flight |

# DO NOT — hold the launch map in working memory only

"I've launched the engine + store agents; I'll remember them." (a compaction erases this)
```

**Why:** The launch map in working memory is destroyed by the exact event (compaction / `/clear` / resume) the orchestrator cannot predict; a durable on-disk row is the only copy that survives to the far side of the boundary where dedup and attribution actually happen.

### 2. Check The Ledger BEFORE Spawning — Never Spawn A Track Already Present

Before spawning any agent, the orchestrator MUST consult the launch-ledger and confirm the track is NOT already present as `in-flight` (or `landed`). Spawning a track that the ledger shows already running is BLOCKED — that is the duplicate-agent failure mode directly. If the ledger is absent or stale, RECONCILE it (re-read the workspace / `git branch` / the task registry) BEFORE spawning, not after the collision surfaces.

```markdown
# DO — consult the ledger, find store-adapter already in-flight, do NOT re-spawn

Ledger shows `store-adapter → W2-store → in-flight` → skip; monitor the existing agent.

# DO NOT — spawn without checking → duplicate of an already-running track

Spawn a second store-adapter agent (the first fell out of context after a compaction)
```

**Why:** The duplicate spawn wastes the run, races the original for the same branch/scope, and is invisible until the collision surfaces at merge; a 2-second ledger read before every spawn converts a silent duplicate into a no-op skip.

### 3. Match Every Completion Notification Against The Ledger BEFORE Reacting

When an agent-completion notification arrives, the orchestrator MUST match its agent id/name against the launch-ledger BEFORE reacting to the landed work. A branch/PR the ledger attributes to a SELF-LAUNCHED agent MUST NOT be reasoned about as another session's output. Reacting to a completion (merging, re-launching, re-attributing) WITHOUT the ledger match is BLOCKED.

```markdown
# DO — notification for W2-store → match ledger row → it is MY launch, treat as such

Completion: agent W2-store, branch feat/store-y → ledger row confirms self-launched → merge as planned

# DO NOT — react to a self-launched landed branch as a "parallel session's" work

"feat/store-y appeared — another session must have produced it" (the ledger shows YOU launched it)
```

**Why:** A self-launched branch mis-read as external work leads the orchestrator to either re-do it, abandon it, or reason about phantom concurrent sessions — the mis-attribution half of the amnesia failure; the ledger match is the one check that tells own-work from other-work after the boundary.

### 4. A Quota / Rate-Limit Failure Is A PAUSE, Not A Death — Resume By Name, Or Stand Down And CONFIRM, Before Launching Any Replacement

An agent stopped by a quota, rate-limit, or session-limit failure has NOT terminated: it retains its transcript and RESUMES when addressed by name. Treating that state as death and launching a replacement into the SAME worktree puts two live agents on one directory under ONE git identity, where `--author` cannot separate them. The orchestrator MUST either (a) resume the original by name, or (b) stand it down explicitly AND confirm the stand-down, BEFORE any replacement is launched.

**Liveness is established by a PROCESS check, never by a timestamp or a clean tree.** The check MUST fail CLOSED, and "failed" is defined PER TOOL: `ps` returns non-zero only on genuine failure, but **`lsof` returns 1 when it finds NOTHING**, so a blanket "non-zero means OCCUPIED" doctrine reads its all-clear as OCCUPIED. An unproven empty is ZERO EVIDENCE (`evidence-first-claims.md` MUST-3), never an all-clear. If a concurrent writer IS found, STOP and report — `kill` is a HUMAN gate, never self-authorized. A ledger row moves to `stopped` ONLY on a confirmed stand-down or a process check demonstrated capable of the opposite verdict, NEVER on a quota error. **Runnable check (topology guard, per-tool exit conventions, bounded positive control), full BLOCKED corpus, measured evidence: `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` § MUST-4.**

**A THIRD axis is REQUIRED, and it is not process-based.** Both process sweeps are blind to a harness-driven agent editing through ABSOLUTE paths: `ps` matches nothing, the cwd sweep returns zero hits, the positive control PASSES, and the check reports FREE while the tree is being written. An instrument-SCOPE failure (`evidence-first-claims.md` MUST-6): the paired skill § MUST-4. The third axis is an **mtime look-back over a sampling window** — observing the WRITE, not the writer — and it carries three obligations:

- **Never let the WALK fail silent-empty — the CLASS, not one flag.** A `find` / `bfs` walk whose START POINT is a bare symlink (no trailing slash, no `-H`/`-L`) emits ZERO PATHS at `rc=0` — the path reads as a FILE, so the walk never descends. Byte-identical to a true negative: ZERO EVIDENCE (`evidence-first-claims.md` MUST-3), never an all-clear. **Back-date a reference file, use POSIX `-newer <ref>`, and prove the predicate fires inside the window and stays quiet outside it; anchor the walk on a `realpath` root or a trailing slash, and fire it at a KNOWN file before reading a zero as "nothing was written"** — safe practice even where the walk descends (`ls -R`, `os.walk`, `readdirSync{recursive:true}` DO — measured). `-newermt` stays out as PORTABILITY only: non-POSIX, its argument grammar does not travel, and its rejection is rc-visible. Worked example and per-tool mechanics: the paired skill § MUST-4.
- **Numeric-guard every counter before comparing it** — `[ "$x" -eq 0 ]` on an EMPTY capture exits 2, the `if` reads false, and control falls THROUGH to the free verdict: a fail-OPEN on the one branch that must never have one. One helper, so no counter can later be added without it.
- **Widen the window rather than narrow it** — a harness agent's write cadence is model-latency-bound, so a window shorter than the inter-write gap reports FREE on exactly the population this axis exists to catch. A false OCCUPIED costs a re-check; a false FREE costs a clobber.

**Three axes still do not make FREE proof of absence.** The look-back answers "was anything written in the window", so an agent alive but QUIET across it is not excluded. **OCCUPIED is the only verdict this check produces as EVIDENCE.** FREE may license reading or launching into a genuinely distinct track; it NEVER substitutes for the confirmed stand-down this rule requires before a replacement, and it NEVER by itself authorizes a worktree removal. The verdict is also PERISHABLE — true at its measurement instant only, and invalidated by anything that could WAKE a paused agent (sending it a message above all): stamp it with its time and RE-DERIVE before the launch it authorizes.

```text
# DO — three axes: argv (corroboration) + cwd + mtime look-back, each numeric-guarded,
#      run from OUTSIDE the worktree, positive control first, verdict stamped with its time
# DO — anchor the look-back's root (`realpath <wt>`, or a trailing slash) and fire it at a KNOWN file
# DO NOT — infer death from the worktree's own state (old last commit; clean `git status`)
# DO NOT — stop at the two PROCESS axes (a harness agent editing by absolute path is invisible
#          to both: measured FREE exit=0 during ~1,100 lines of active edits)
# DO NOT — a bare symlinked start point in a `find`/`bfs` walk: ZERO PATHS at rc=0
```

**Why:** The two observables an orchestrator naturally reaches for — commit recency and tree cleanliness — are precisely the two a long-running agent also produces, so the inference is unfalsifiable at the moment it is made; only the process check separates the cases. The third axis fails in that same direction through its WALK rather than its predicate — a zero-path enumeration is read as FREE, so a blind root reads as an all-clear; the measured instance, its figures and the superseded mechanism: the extract § "Re-anchoring — 2026-09-29".

### 5. A Rescue Checkpoint Is Inspected, Secret-Scanned, And Blob-Scanned BEFORE It Is Pushed

Preserving an interrupted agent's uncommitted work is CORRECT — losing it is worse than any cleanup. But a blanket `git add -A` rescue is indiscriminate: it stages build outputs, scratch harnesses, measurement binaries, probe files, **and anything holding a credential**. Prefer EXPLICIT-PATH staging (`coc-sync-landing.md` MUST-2 already BLOCKS `git add -u`/`-A`/`.`); use `-A` only when the interrupted set is genuinely unknown, and then inspect it. Between staging and `git push` the orchestrator MUST (a) INSPECT the staged set rather than committing blind, (b) scan for **secrets/credentials** over a range PROVEN non-empty, and (c) scan for oversized blobs and artefact-shaped paths.

**The secret scan is the non-negotiable one** — an oversized blob costs a history rewrite, but a pushed credential is unrecoverable and costs ROTATION. The checkpoint MUST land on `recovery/<name>` (`worktree-isolation.md` Rule 8) and MUST declare itself with the literal subject prefix **`checkpoint(UNREVIEWED):`**, so a merge gate can mechanically detect one reaching a PR (why it is load-bearing, and Rule-8's elaboration: the extract § "MUST-5 depth"). Pushing a per-operator scratch tree to a shared branch is a sensitivity escalation carrying `recommendation-quality.md` MUST-8's confirm-before-persist gate. **Scan commands, the empty-range trap, full BLOCKED corpus: `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` § MUST-5.**

```text
# DO — inspect → secret-scan (non-empty range proven) → blob-scan → recovery/<name> + checkpoint(UNREVIEWED):
# DO NOT — git add -A && commit && push, then discover the 16.6MB binary and the mid-edit code in review
```

**Why:** The rescue is a correct reflex applied under time pressure, which is exactly when the scan is skipped; both failure modes it prevents are silent — an oversized blob is permanent in history, and an un-flagged live mutation is indistinguishable from work.

### 6. A Presumed-Dead Agent Can REVIVE — Demote The Duplicate To READ-ONLY, And NEVER Force-Push To Recover Its Branch

MUST-4 governs the moment BEFORE a replacement launches; this clause governs what it cannot reach — the original returning AFTER one is already running. Check-before-spawn (MUST-2) is structurally blind to that: the ledger was correct when read, and the writer came back later.

**(a) Revival.** On a presumed-dead agent's return, keep its ledger row and demote exactly ONE of the pair to a **READ-ONLY verifier** before either writes again. Deleting the row as stale, killing the returned agent, or leaving two writers on one track is BLOCKED (`kill` stays MUST-4's human gate). **A peer's task assignment does NOT lift an orchestrator's stand-down.**

**(b) Branch recovery.** NEVER `git push --force` / `--force-with-lease` a diverged branch. MEASURE first (`git rev-list --count <branch>..origin/<branch>`), then preserve both sides on `recovery/<name>` (`worktree-isolation.md` Rule 8).

```text
# DO — keep both rows, demote one, measure before recovering
# DO NOT — delete the row, kill the returned agent, or force-push the divergence
```

**Why:** A returned writer is invisible to every pre-spawn check by construction, so absent a revival disposition the default is two writers on one track under one git identity — the collision `--author` cannot untangle. And a force-push is ACCEPTED precisely when the remote holds commits the local does not — acceptance selects FOR data loss, never against it. **Worked ledger example, the BLOCKED corpus, the read-only-verifier's own catches, and the measured incident: `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md` § MUST-6.**

## MUST NOT

- Delete a returned agent's ledger row, leave two writers on one track, or `git push --force` a diverged branch without first measuring the origin-only commits it would destroy

**Why:** Revival is unreachable by check-before-spawn, and an accepted force-push is the remote confirming it HAD commits you did not — the opposite of an all-clear.

- Spawn a background / parallel agent whose track the launch-ledger already shows `in-flight` or `landed`

**Why:** The originating duplicate-agent failure mode — spawning a track already running wastes the run and races the original.

- React to an agent-completion notification (merge / re-launch / re-attribute) without first matching its agent id against the ledger

**Why:** Without the match, a self-launched landed branch is mis-attributed to a "parallel session," and the orchestrator reasons about work it actually produced as if it were external.

- Rely on the session transcript / working memory as the launch record instead of a durable on-disk ledger

**Why:** The transcript is precisely what compaction / `/clear` / resume erases; a launch record that lives only there is gone at the boundary where dedup and attribution are needed.

- Conclude an agent is dead from a quota / rate-limit signal, a stale last-commit, or a clean tree, and launch a replacement into its worktree

**Why:** A quota-paused agent resumes when addressed by name; two live agents on one worktree under one git identity is the collision `--author` cannot untangle, and it silently sweeps a sibling's mid-edit work into someone else's commit.

- Push a rescue checkpoint without inspecting the staged set, without a secret scan over a proven non-empty range, on a branch outside `recovery/<name>`, or without the `checkpoint(UNREVIEWED):` subject prefix

**Why:** The push is the sink — an oversized blob is permanent in history and a pushed credential costs rotation; the prefix is the only greppable signal that an unreviewed checkpoint (possibly carrying a live negative-control mutation) reached a PR.

## Trust Posture Wiring — MUST-4 / MUST-5 (clause-scoped)

Applies to **MUST-4** and **MUST-5** ONLY, both added 2026-08-10; canonical-8-field-compliant per `trust-posture.md` MUST-8. The rule-wide block below governs MUST-1/2/3, unchanged. Why a separate block, and its precedent: the extract § "Wiring depth — MUST-4 / MUST-5".

- **Severity:** `halt-and-report` at gate-review (confirmations in § Detection mechanism below); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a liveness inference was sound is judgment over the session's command history, not a tool-call-time structural signal.
- **Grace period:** 7 days from clause landing at loom (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (§ Violation scope below) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; named deviation recorded per `trust-posture.md` Rule 8 (rationale + precedent: the extract § "Wiring depth — MUST-4 / MUST-5"). A pushed CREDENTIAL additionally routes to the pre-existing `critical` (secret leak → L1) trigger, unchanged; this clause mints no second key.
- **Receipt requirement:** SessionStart soft-gate `[ack: orchestration-launch-ledger]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; one ack covers MUST-1..5).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` inspect any session that relaunched, stood down, marked a track `stopped`, or pushed a rescue branch, and confirm every item of § Violation scope below was satisfied (full (d)/(e) checklist: the extract § "Wiring depth — MUST-4 / MUST-5"). **Semantic tier: PARTIALLY CLOSED.** MUST-4 and MUST-5 are now covered by the bipolar `MUST-4-firing` and `MUST-5-firing` pairs in `.claude/test-harness/probes/orchestration-launch-ledger.probes.json`, fixtures at `.claude/audit-fixtures/orchestration-launch-ledger/`. What is STILL uncovered is the paired skill `skills/30-claude-code-patterns/quota-pause-and-rescue-hygiene.md`, which carries no probe tier of its own — an eval-coverage omission per `coc-artifact-eval-coverage.md` MUST-1. **Graduation of the remaining half:** remove this sentence in the same change that registers a probe tier for that skill. DISPATCH-ONLY: a green CI run is never evidence it passed. Phase 2 (deferred) — a merge-gate grep for `checkpoint(UNREVIEWED):` in PR commit subjects; fixtures land with it at `.claude/audit-fixtures/orchestration-launch-ledger/rescue-checkpoint/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-4 (death inferred from a quota signal, a timestamp, or a clean tree; a process-check result banked without its positive control; `kill` of a discovered writer without the human gate) + MUST-5 (rescue pushed without inspection / secret scan / non-empty-range proof / `recovery/<name>` branch / `checkpoint(UNREVIEWED):` prefix). MUST-1/2/3 keep their scope below.
- **Origin:** See § Origin (2026-08-10, BUILD stream).

## Trust Posture Wiring — MUST-6 (clause-scoped)

Applies to **MUST-6** ONLY (2026-08-11). MUST-4/5's block above cannot supply `regression_within_grace` teeth to a clause landing today. Canonical-8-field per `trust-posture.md` MUST-8.

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — demotion is session-history judgment. `git push --force` IS lexically detectable but MUST NOT carry `block`: a force-push to an operator's own `recovery/<name>` is legitimate.
- **Grace period:** 7 days (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (row deleted as stale; two writers left on one track; a peer's assignment treated as lifting a stand-down; a force-push without the origin-only measurement) route to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger (1× = drop 1 posture) — NO dedicated key; named deviation per `trust-posture.md` Rule 8, as MUST-4/5 took. A force-push that DESTROYS commits additionally routes to the pre-existing `critical` data-loss trigger, unchanged.
- **Receipt requirement:** as the MUST-4 / MUST-5 block above (one ack covers MUST-1..6).
- **Detection mechanism:** Phase 1 (gate-review) — for any session where a presumed-dead agent resumed, confirm (a) its row survived, (b) one of the pair was demoted before either wrote, (c) no self-authorized `kill`, (d) any recovery cited `git rev-list --count <branch>..origin/<branch>` rather than a force-push. Scanner: none (semantic). **A probe suite and audit fixtures NOW SHIP for this clause** — the `MUST-6-firing` pair in `.claude/test-harness/probes/orchestration-launch-ledger.probes.json`, poles at `.claude/audit-fixtures/orchestration-launch-ledger/`; pole design + the discrimination `instrument-discipline.md` MUST-3 asks for: the extract § "Wiring depth — MUST-4 / MUST-5". DISPATCH-ONLY: a green CI run is never evidence it passed. **The force-push half of MUST-6(b) has a structural detector that is ARMED AT LOOM and FENCED FROM CONSUMERS — a co-owner-approved STAGED rollout (2026-09-13); the `Scanner: none` above still describes every consumer, and no longer describes loom.** `.claude/hooks/force-push-recovery-guard.js` (predicate in `.claude/hooks/lib/force-push-recovery-scope.js`) **IS registered** in `.claude/settings.json` at `PreToolUse`, matcher `Bash`. **It reaches NO consumer:** the hook file is deliberately fenced `loom_only` in `sync-manifest.yaml` with its required twin in `validate-emit.mjs::LOOM_ONLY_TIER_CARVEOUTS`, so it does not ship — a consumer receives this RULE and not this DETECTOR, enforcement for MUST-6(b) at those targets is the Phase-1 GATE-REVIEW sweep above and nothing else, its silence there is the ABSENCE OF AN INSTRUMENT rather than evidence that no force-push destroyed origin-only commits, and the gap is DECLARED in the detector-distribution baseline registry rather than left silent. Severity is **`pre-action`, whose enforcement class is ADVISORY** (non-blocking, exit 0). The signal is PARSED, never lexical — force flags and the DESTINATION come from `git-command-parse.js` argv TOKENS. A destination that cannot be resolved is **UNKNOWN, never clean**. Fixtures: `.claude/audit-fixtures/force-push-recovery-scope/`, registered in `.claude/test-harness/ci-audit-fixtures.json`; `run-audit-fixtures.mjs` executes the registered set; `audit-fixture-runners.mjs::discoverRunners` walks `.claude/audit-fixtures/` DEPTH-1 only (a nested `orchestration-launch-ledger/revival-and-force-push/` is inert); arming is CC-only (zero in `.claude/codex-templates/hooks.json`, `.claude/gemini-templates/settings.json`). Narrative: the extract § "MUST-6(b) force-push detector — arming, fencing and fixture provenance". The two-writer revival half — the class MUST-6 exists for — stays gate-review-only, covered by the probe pair above and by no hook.
- **Violation scope:** MUST-6 ONLY; MUST-1/2/3 and MUST-4/5 keep their own blocks.
- **Origin:** relayed use-rs idx 10 residual half; see § Origin.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (confirmations in § Detection mechanism below); `advisory` at the hook layer — whether a spawn was ledger-checked and a completion ledger-matched is a session-history judgment per `hook-output-discipline.md` MUST-2, so no `block`.
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (§ Violation scope below) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key (a launch-tracking property is a session-history judgment; the universal trigger covers it). Named deviation recorded per `trust-posture.md` Rule 8; precedent: the extract § "Wiring depth — rule-wide".
- **Receipt requirement:** as the clause-scoped blocks above (soft-gate `[ack: orchestration-launch-ledger]`).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` inspect any session that spawned background agents and confirm (a) a durable on-disk launch-ledger exists with a row per launched agent, (b) the transcript shows a ledger consult before each spawn, (c) each completion was matched against the ledger before the orchestrator reacted; **Probes: REGISTERED — `.claude/test-harness/probes/orchestration-launch-ledger.probes.json`**, 16 rows in 8 bipolar `pair_id` pairs: one firing pair per derived clause (MUST-1..MUST-6, plus the `## MUST NOT` section read as a SET) and a surface-equalized meta-compliance pair, with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/orchestration-launch-ledger/`. Registered in `eval-manifest.json` (probe-only), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; no workflow invokes `coc-probe-dispatch.mjs`, and `.claude/test-harness/**` is never-synced. Depth — that bookkeeping and the detector shape — lives in `.claude/guides/rule-extracts/orchestration-launch-ledger.md` § "Rule-wide Wiring — probe registration bookkeeping". Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `Stop`/`PostToolUse` detector; fixtures land with it at `.claude/audit-fixtures/orchestration-launch-ledger/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (no durable ledger) + MUST-2 (duplicate spawn of an in-flight track) + MUST-3 (completion reacted to without a ledger match).
- **Origin:** See § Origin.

## Origin

**MUST-4 / MUST-5 — 2026-08-10, BUILD stream.** Incident narrative, measured figures, landing and classification (**GLOBAL on both axes**): the extract § "Origin depth — MUST-4 / MUST-5" and § "Origin depth — landing + classification".

**2026-07-19 — GitHub issue #1232**, from an orchestrator session in a downstream consumer repo. Landed via `/sync-from-build` Gate-1 classification (journal/0552); the generic principle cascades, the downstream-consumer identifier stays in the local `/codify` receipt per `upstream-issue-hygiene.md` MUST-2. Originating incident and headroom constraint: the extract § "Origin depth — 2026-07-19 (GH #1232)".

**Length rationale (`rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Body is UNDER the 200-line guidance; recorded rationale: the extract § "Length rationale".

**Extraction record — 2026-08-19 structural cleanup, ZERO de-scoping** (every MUST / MUST NOT / BLOCKED entry and DO/DO-NOT block stayed verbatim; the same-day MUST-4 third-axis obligation 1 was re-anchored 2026-09-29). `rule-authoring.md` Rule 10 / Rule 11 do **NOT** fire (path-scoped, not `priority: 0` baseline; `journal/0148`). Full record: the extract § "Extraction record".
