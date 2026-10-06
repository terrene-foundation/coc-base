---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/.claude/rules/**"
  - "**/.claude/agents/**"
  - "**/.claude/skills/**"
  - "**/.claude/commands/**"
  - "**/.claude/hooks/**"
  - "**/specs/**"
  - "**/journal/**"
  - "**/.session-notes*"
---

# Artifact Stranding — AUTHORED Is Not IN FORCE

A governed artifact that reaches no default branch exists, is reflog-safe, passes every local check — and governs **nothing** outside the one tree that holds it. This file is the obligation the shipped detector `.claude/hooks/stranded-artifact-guard.js` reports against (`rule_id: artifact-stranding/MUST-1`); the mechanism was written first and this rule closes the dangling reference.

"Governed artifact" is the POSITIVE allowlist in `.claude/hooks/lib/stranded-artifacts.js::ARTIFACT_CLASSES`: rule, agent, skill, command, hook, `sync-manifest.yaml`, audit-fixture, probe, spec, session-notes, burndown, journal. Depth — the three measured instances, the reachability-vs-existence walkthrough, and the full BLOCKED corpora: `.claude/guides/rule-extracts/artifact-stranding.md` (cited below as **extract**).

## MUST Rules

### 1. Land It, Or Record Why It Is Held — Before The Branch Or The Session Ends

When a session commits a governed artifact to a branch that is NOT an ancestor of the default branch, it MUST state the disposition explicitly before session close AND before any branch-ending command (`git branch -D|-d`, `git worktree remove`, `git push --delete`): either LAND it (PR to the default branch) or RECORD, in a durable surface, why it is deliberately held and what will land it. Holding an artifact is legitimate and common. UNSTATED holding is BLOCKED.

```text
# DO — the disposition is stated, and it is a fact about reachability
"rules/artifact-stranding.md is committed on codify/… and is NOT on origin/main.
 Disposition: PR #NNNN opened." | "…HELD pending the M3 probe suite; lands with it."
# DO NOT — commit, report the work complete, and let the branch carry it
"Rule authored and committed." (branch never lands; the rule governs one tree)
```

**BLOCKED rationalizations:**

- "It's committed, so it's safe"
- "It's in the reflog — nothing is lost"
- "The work is done; the PR is a formality"
- "I'll land it next session"
- "The fixtures pass, so the guard is protecting the repo"
- "The branch is pushed — everyone can see it"
- "The orchestrator can read it out of my worktree"
- "Landing it now would widen the PR"
- "The other lanes will pick it up"

**Why:** Reachability, not existence, is what puts an artifact in force — so an unlanded artifact fails exactly where it is trusted most: every local check goes green, the author reports the class defended, and the class stays live in every tree but one. Measured instance: a guard at 27/27 fixtures that protected nothing, because it sat on an unmerged branch (extract § Instance 1).

### 2. An Existence Claim About An Artifact NAMES The Tree It Was Measured In

Any claim that a governed artifact is PRESENT or ABSENT MUST name the tree and ref it was measured against (`git rev-parse --show-toplevel` plus the ref). When two parties disagree about whether an artifact exists, the disagreement MUST be resolved by measuring reachability from the default branch — never by re-asserting, and never by treating either party as mistaken before the refs are compared.

```text
# DO — the claim carries its tree, so it can be checked
"`### 4a.` = 1 on codify/…, 0 on origin/main, 0 in /…/.loom-wt/lane-x
 (control `### 3a.` present in all three)."
# DO NOT — an unqualified claim that both parties can honestly assert
"There is no Rule 4a." / "I wrote Rule 4a today — re-read the file."
```

**BLOCKED rationalizations:**

- "I just wrote it, it's there"
- "The lane must not have looked properly"
- "grep returned 0, so it does not exist"
- "We're in the same repo"
- "The file is on disk — I checked"
- "The other agent's context is stale"
- "Re-read it, it's right there"

**Why:** An unqualified existence claim is unfalsifiable across trees — both parties measure honestly, get opposite answers, and the question resolves toward whoever is more insistent instead of toward the ref that actually governs. Measured instance: a lane correctly reported "there is no Rule 4a" and the orchestrator correctly reported having written it, on the same day (extract § Instance 2).

### 3. A Shipped Mechanism Names Its PRODUCER, Or Records Its Inertness At The Mechanism

A COC mechanism (hook, `bin/` script, library entry point, command step) MUST, in the change that ships it, EITHER name the caller that invokes it — a `settings.json` hook registration, a `sync-manifest.yaml` declaration, an invoking command step, a workflow step — OR record AT the mechanism that it is deliberately inert and what would activate it. Discriminating arms and green fixtures are NOT a producer.

```text
# DO — the producer is named in the same change, or the inertness is
# recorded: "no caller yet; activated by /worktree Step 3, lane N."
# DO NOT — ship open/retire/gate/invariant, all discriminating, all
# fixture-covered, and no caller anywhere in the repo.
```

**BLOCKED rationalizations:**

- "The API is complete; callers come later"
- "The fixtures prove it works"
- "Wiring it up is a follow-up"
- "It's available for whoever needs it"
- "The design is done — the call site is trivial"
- "27/27 pass, so the mechanism is doing its job"

**Why:** A mechanism with no producer is the strongest form of authored-but-not-in-force, and the one that reports health loudest — tests, fixtures and coverage all go green precisely because the thing under test is never asked to do anything. Measured instance (2026-08-20): a worktree-lifecycle mechanism shipped `open`/`retire`/`gate`/`invariant` with no caller. It was DELETED on that finding (2026-08-22) rather than wired, so the path no longer resolves and the evidence is read at the last SHA that carried it — `git show d0c3d64d:.claude/bin/worktree-lifecycle.mjs` (extract § Instance 3). This is the COC-artifact-surface sibling of `orphan-detection.md` Rule 1, which owns the same class in SDK code (`packages/**`, `src/**`, `crates/**`) and whose globs do not reach `.claude/**`.

## MUST NOT

- Cite a green fixture run, a passing suite, or a clean local check as evidence that a mechanism is IN FORCE.

**Why:** Those instruments measure the code, not its reachability or its invocation — they return the identical green whether the artifact governs the whole repo or one worktree, which is `instrument-discipline.md` MUST-1's non-discriminating instrument.

- Run a branch-ending command (`git branch -D`, `git worktree remove`, `git push --delete`) without first naming the governed artifacts that stop being reachable with it.

**Why:** Branch deletion is the one loss in this class with no reflog on the other side of a clone; naming the artifacts costs one report and is the last moment the choice is reversible.

## Trust Posture Wiring

- **Severity:** `pre-action` at the destructive surface (`PreToolUse:Bash` on a branch-ending command); `advisory` at session close (`SessionEnd`); `halt-and-report` at gate-review. **The two hook surfaces carry DIFFERENT registers because severity here names the ACTION'S FATE — whether the command has run yet — not the finding's importance.** The finding is the same finding at both: same rule_id, same artifact paths, same count. What differs is the sentence `instruct-and-wait.js` puts above it, selected from `{severity, hookEvent}`. At `PreToolUse` the branch-ending command has NOT run, and `pre-action` is the only register that says so ("the action has NOT run yet. Read this, then decide") — which is exactly the decision this rule asks for. `halt-and-report` renders "the action ALREADY RAN", false there, and it contradicts this rule's own closing instruction to proceed if that is still what the operator wants: an action said to have already run has no proceed left in it. At `SessionEnd` the tool calls are done, so "the action proceeded" is the honest head and `advisory` is correct; `pre-action` is gated to `PreToolUse` and would be a strict no-op there anyway. Reading a lower rank as a softer finding is the error this bullet exists to pre-empt. **NEVER `block` at either surface, and the refusal is deliberate, not a default.** The signal IS structural — `merge-base --is-ancestor` is reachability, `diff --name-only base...HEAD` is a three-dot git-object fact (`evidence-first-claims.md` MUST-5 — the two-dot form is BLOCKED here), and classification is a positive path allowlist — so `hook-output-discipline.md` MUST-2 would PERMIT `block`. It is refused because whether THIS branch should land is a judgment about the operator's plan, not a fact about the repo: deliberately abandoning a branch and holding an artifact pending review are both legitimate, so blocking would be MUST-2's own MUST NOT ("detectors that block work the agent has been instructed to perform"). The structural signal buys CONFIDENCE IN THE NAMES — the report states artifact paths as fact — not teeth.
- **Grace period:** 7 days from rule landing (2026-08-20 → 2026-08-27).
- **Cumulative posture impact:** same-class violations (a governed artifact left on an unlanded branch at session close with no stated disposition; a branch-ending command run without naming the artifacts it strands; an unqualified present/absent claim that names no tree; a mechanism shipped with neither a producer nor a recorded inertness) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the loss is non-corrupting and recoverable (the commits exist and remain landable), so it does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `instrument-discipline.md`, `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-stranding]` IFF `posture.json::pending_verification` includes the `artifact-stranding` rule_id (shared rule_id; one ack covers MUST-1..3).
- **Detection mechanism:** **MUST-1 — structural, SHIPPED.** `.claude/hooks/stranded-artifact-guard.js` (predicate `.claude/hooks/lib/stranded-artifacts.js`) is registered on `PreToolUse:Bash` and `SessionEnd`; it emits this rule_id with `pre-action` at the destructive surface and `advisory` at session close (the FATE split above, `severity-rank.js` registering `pre-action` alongside `advisory` so it is neither dropped in selection nor coerced back on delivery), and fails OPEN on any unanswerable reachability question. Bipolar fixtures at `.claude/audit-fixtures/stranded-artifacts/run.mjs` — 6 pole pairs plus a fail-open pair, measured 32 pass / 0 fail (34 once loom#1868 lands), each RED pole asserting a failure IDENTITY (rule_id + artifact kind + path) per `instrument-bipolarity.md` MUST-2. **MUST-2 and MUST-3 — Phase 1, gate-review, and PERMANENTLY so.** No Phase-2 detector is booked for either and none will be: whether an existence claim names its tree is a property of agent prose, and a lexical detector over prose could carry no more than `advisory` while manufacturing findings on every quoted claim; whether a mechanism has a producer is decidable structurally in principle but not at tool-call time, since the change that ships the mechanism and the change that ships its caller are the same reviewable diff. Booking teeth here would be `hook-output-discipline.md` MUST-5(b) and `rule-authoring.md` MUST NOT § "`**Detection mechanism:**` row filing `Phase 2 (deferred)`". Gate-review IS the enforcement layer for MUST-2/3, permanently — cc-architect at `/codify` and reviewer at `/implement` confirm each present/absent claim named its tree and each shipped mechanism named a caller or recorded its inertness. **Probes: REGISTERED** — `.claude/test-harness/probes/artifact-stranding.probes.json` (8 rows, 4 bipolar pairs; fixtures `.claude/audit-fixtures/artifact-stranding/`; probe-only in `eval-manifest.json`, pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`). Registration buys DISPATCHABILITY, never execution — a green CI run is NEVER evidence these probes passed. **No `phase2-deferrals.json::probe_authorship_deferrals` row was ever minted, and that decision stands vindicated rather than merely unpunished:** a new registry key sits outside the digest-pinned grandfathered population and needs an acceptance receipt whose `requested_by` differs from `accepted_by`, which `completion-criterion.md` MUST-6 forbids the proposing agent from writing for itself. What DOES reach a consumer is MUST-1's structural tier — the shipped guard and its bipolar fixtures — so the rule is enforced there, just not by this suite. Depth — the probe-tier registration narrative, the consumer-lane measurement and the detector-distribution declaration — lives in `.claude/guides/rule-extracts/artifact-stranding.md` § Probe-tier registration narrative.
- **Violation scope:** rule-corpus-wide (MUST-1..3 and both MUST NOT bullets). Every `violations.jsonl` row names the artifact path(s), the branch, the base ref measured against, and which clause fired.
- **Origin:** See § Origin.

## Distinct From / Cross-References

Distinct from `orphan-detection.md` (same class, SDK-code globs — MUST-3 is its `.claude/**` sibling) and from `worktree-isolation.md` (which governs where parallel work RUNS, not whether its output lands). Pairs with `instrument-discipline.md` MUST-1 (a green that cannot discriminate) and `evidence-first-claims.md` MUST-5 (the two-dot diff this rule's predicate refuses).

Origin: 2026-08-20 — authored to close a dangling cross-reference. `.claude/hooks/stranded-artifact-guard.js` shipped (`7f221e94`) emitting `rule_id: "artifact-stranding/MUST-1"` against a rule that did not exist — itself an instance of this rule's class (a mechanism whose stated obligation is unwritten), and a `cc-artifacts.md` MUST NOT § No Dangling Cross-References defect. Three independent instances were measured in one session, none found by review: a 27/27-fixture guard on an unmerged branch; `worktree-isolation.md` Rule 4a present on exactly ONE branch (`### 4a.` = 1 on the codify branch, 0 on `origin/main`, 0 in the lane worktree, with `### 3a.` present in all three as the control); and a worktree-lifecycle mechanism with `open`/`retire`/`gate`/`invariant` and no caller. **Classified `path-scoped`, not `baseline`, on the mechanism's own coverage:** the two moments that touch no glob — a branch-ending command and session close — are exactly the two the SHIPPED hook fires on, delivering the instruction inline at the decision, so the reachability gap that made `issue-triage-routing.md` baseline does not exist here; the globs above cover the AUTHORING moment, which is where the stranding is created. Per `rule-authoring.md` Rule 10 § Trigger scope this classification means the proximity-band gate does not fire; the classification was chosen for the coverage reason and NOT for that relief. Depth, per-instance narrative and full BLOCKED corpora: `.claude/guides/rule-extracts/artifact-stranding.md`.
