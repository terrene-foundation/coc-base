---
id: "ORCHESTRATOR-CONTEXT-ECONOMY"
paths: [".claude/agents/**", "**/.claude/agents/**", "**/.claude/hooks/**", "**/.claude/settings.json"]
---

# Orchestrator Context Economy — Main-Agent Context Is A Coordination Resource

Depth, worked transcripts, and the six measured instances: `.claude/guides/rule-extracts/orchestrator-context-economy.md`.

Main-agent context is RESERVED for three things: **deciding with the human, consolidating what lanes returned, and work subagents cannot do.** It is not the default execution substrate. Every byte spent exploring, discovering, or bulk-reading in the orchestrator is a byte unavailable to the judgment only the orchestrator can exercise.

`agents.md` § Triad already mandates parallelize-by-default, and its § "Verify Specialist Tool Inventory Before Implementation Delegation" already owns the tool-fitness contract. This rule does NOT restate either (`specs-authority.md` Rule 9). It adds what neither carries: what the orchestrator may spend its OWN context on, what a lane must return, and the delivery contract that varies by DISPATCH SHAPE.

## MUST Rules

### 1. Compose The Probe — One Round-Trip, Not A Dozen

Independent reads, greps, and status checks MUST be issued as ONE composed command or ONE parallel tool block. Serial one-line round-trips to build a picture the orchestrator could have requested at once are BLOCKED.

```bash
# DO — one round-trip, labelled sections, whole picture returned at once
echo "=== A ==="; cat a; echo "=== B ==="; grep -n X b; echo "=== C ==="; ls d/
# DO NOT — twelve turns, each answering one sub-question, each paying a full model turn
cat a      # then: grep -n X b      # then: ls d/      # then: …
```

**BLOCKED rationalizations:** "I'll look at one thing at a time to stay careful" / "each result decides the next command" (when it does not) / "composing is premature optimization" / "it is only a few extra calls" / "I want to see each output cleanly".

**Why:** Each round-trip costs a full model turn plus its output in context, so N serial probes cost N turns to buy what one composed probe buys in one; the cost is paid in the scarce resource and the picture arrives strictly later.

### 2. Discover The VERIFICATION BATTERY Locally, Before The First Push

Before the FIRST push, the agent MUST enumerate the gates the remote will run and run ALL of them locally. Learning the battery one CI round at a time — push, read one failure, fix, push again — is BLOCKED. Extends `git.md` § "Pre-FIRST-Push CI Parity Discipline" from a fixed command list to the OBLIGATION TO ENUMERATE: read the workflow files and the registered checkers, then run the set.

```bash
# DO — enumerate, then run the whole set, capturing each exit code
for g in check-rule-injection-budget registration-preflight validate-emit; do
  node ".claude/bin/$g.mjs" > "/tmp/$g.log" 2>&1; echo "$g EXIT=$?"
done
# DO NOT — push and let the remote name the next gate, four times over
git push   # gate 1 reds → fix → push → gate 2 reds → fix → push → …
```

**BLOCKED rationalizations:** "CI will tell me what else to run" / "I fixed the one it flagged, so it should be green now" / "running them all locally is slower than a push" / "I did not know that gate existed" (the workflow file is readable) / "each round was a different, unrelated failure".

**Why:** A remote that reports one gate per round converts an enumerable local set into N serial network round-trips, each paying full CI wall-clock and orchestrator context to rediscover a fact `.github/workflows/` states for free.

### 3. Delegation Is The DEFAULT, Not An Escalation The Human Requests

Work decomposable into independent parts MUST go to lanes on the orchestrator's own initiative. Waiting to be told to parallelize is BLOCKED — a human asking "why aren't you using lanes?" is evidence the default already failed. The parallelize mandate itself is `agents.md` § Triad; this clause names the TRIGGER: the decomposability of the work, never a human prompt.

```markdown
# DO — orchestrator decomposes on sight: 3 lanes dispatched, 8 findings closed in parallel

# DO NOT — hours of hand-execution, lanes dispatched only after the human asks
```

**BLOCKED rationalizations:** "the user did not ask me to delegate" / "I'll do this one myself, it's quicker to just look" / "delegation has overhead" / "I need to understand it first before I can brief anyone" / "the lanes would need context I'd have to write up anyway".

**Why:** Human-triggered delegation caps throughput at the human's attention, which is the exact bottleneck autonomous execution exists to remove; the measured gap is hours of serial hand-work against three lanes closing eight findings concurrently.

### 4. Lanes Return CONCLUSIONS; Corpora Stay In The Lane

A dispatch MUST state the return contract as a bounded conclusion — findings, verdicts, paths, exit codes — with an explicit size bound. Pulling a large output into orchestrator context so the orchestrator can read it is BLOCKED; the lane reads it and returns what it MEANS.

```markdown
# DO — "Return under 400 words: the verdict per lane, exit codes, and file paths."

# DO NOT — "Return the full file contents / the whole log / every match" so I can scan it
```

**BLOCKED rationalizations:** "I need to see the raw output to judge it" / "summarizing risks losing something" / "it's only a few thousand lines" / "I'll skim it" / "the lane might miss what matters, so send everything".

**Why:** A corpus in orchestrator context displaces the consolidation the orchestrator alone can do, and the lane that already read it is strictly better placed to say what it means than the orchestrator scanning it second-hand.

### 5. Dispatch With The TOOL SET The Task Needs

A dispatch whose task implies producing or mutating a file MUST name an agent whose declared `tools:` include a write tool (`Write`/`Edit`). Sending write-implying work to a read-only agent is BLOCKED. `agents.md` owns the contract and the read-only roster; this clause is its DISPATCH-TIME form and is structurally detected (§ Detection).

```markdown
# DO — write-implying brief → tdd-implementer (Read, Write, Edit, Bash, Grep, Glob, Task)

# DO NOT — "author the fixtures" → analyst (Read, Grep, Glob) → halts at the first edit
```

**BLOCKED rationalizations:** "it can tell me what to write and I'll apply it" (that is a different, larger task) / "the agent will figure it out" / "it only needs to edit one file" / "I'll re-dispatch if it gets stuck" / "the description sounded read-only".

**Why:** A read-only lane halts at its first file-edit boundary having consumed a full agent turn, and the re-launch costs the whole shard again; the pre-launch check is O(1) against an O(N) re-run.

### 6. The DELIVERY CONTRACT MUST Match The DISPATCH SHAPE

A **NAMED** dispatch creates a PERSISTENT MAILBOX agent that NEVER auto-returns — its brief MUST carry an explicit push instruction (message the orchestrator when done). An **UNNAMED** dispatch auto-returns its final message, and a one-shot "return your findings" contract is correct there. Using the one-shot contract on a NAMED dispatch is BLOCKED: it is a no-op against that shape, and the lane reads as idle.

```markdown
# DO — named lane: "When done, SendMessage the orchestrator with your findings."

# DO NOT — named lane: "Return your findings." → stops, delivers nothing, reads as idle
```

**BLOCKED rationalizations:** "the brief already says to return findings" / "it will report back when it finishes" / "naming it is just for tracking" / "the lane went idle, so it must have had nothing to say" / "I'll ping it if I don't hear back" / "returning is what agents do".

**Why:** Naming a dispatch silently changes its delivery semantics from pull to push, so a contract that is correct for the unnamed shape delivers nothing for the named one — and the failure presents as an idle lane, indistinguishable from a lane that legitimately found nothing.

### 7. The Orchestrator Spends Main-Thread Context ONLY On Orchestrator-Only Work

Main-thread context MUST be spent only on what nothing else can do: deciding with the human, sequencing, dispatching, consolidating what lanes returned, and holding the cross-lane picture no single lane can see. Investigation, enumeration, bulk file-reading and verification runs MUST go to a lane even when the orchestrator could do them faster in isolation. The discriminator is what the reading SERVES: reading to FRAME — enough to write a brief that is correct — IS orchestrator-only work and is not blocked; reading to EXECUTE — producing the answer, the enumeration, or the artifact itself — is a lane's, and continuing past the point where the brief became writable is BLOCKED.

```markdown
# DO — read the two files that fix the surface, write the brief, dispatch the other forty

# DO NOT — read those two, then keep going through the forty because the context is already loaded
```

**BLOCKED rationalizations:** "it's faster if I just look" / "briefing costs more than doing it" / "it's only a couple of files" / "I'm already in the file, I may as well finish reading it" / "this part needs judgment, so it has to be me" (when it is enumeration) / "I still have plenty of context window left" / "I'm the only one who can see the whole picture, so this belongs to me" (the consolidation carve-out covers reconciling what lanes RETURNED, never producing the material yourself) / "the lane will just come back with questions, so I'll answer them by reading it now" / "I'll dispatch the next one, this one is nearly done" / "a lane for something this size is ceremony" / "the lanes are already running, so this is free time". MUST-3's corpus applies here verbatim and is CITED rather than restated (`specs-authority.md` Rule 9) — in particular its understand-it-first and write-up-anyway entries.

**Why:** Main-thread context is the one context that cannot be reconstituted — a lane is re-launchable with a fresh window and the orchestrator is not — so every byte of execution work done inline is taken from the human-facing judgment and cross-lane consolidation nothing else can perform. The framing/execution line is where that spend is decided: reading enough to write a correct brief IS orchestrator-only work, and everything past that point belongs to a lane.

## MUST NOT

- Spend orchestrator context on work a lane could do and return a conclusion for — **Why:** it displaces the human-facing judgment and consolidation nothing else can perform.
- Treat an idle NAMED lane as a lane with nothing to report — **Why:** silence under a pull contract is the expected output of the mailbox shape, not evidence of an empty result.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at the hook layer for MUST-5 + MUST-6 (`.claude/hooks/dispatch-contract-guard.js`), and `halt-and-report` at gate-review for all six clauses (cc-architect at `/codify` + reviewer at `/redteam`). `block` is UNAVAILABLE and that is a cap, not a preference: both hook predicates carry a lexical half (brief prose read for a push instruction / for write intent), and `hook-output-discipline.md` MUST-2 forbids `block` on a lexical signal. MUST-5's tool-inventory half is a parsed frontmatter field and would be fencing-grade alone under MUST-5(a), but a detector is no stronger than its weakest half. MUST-3 ALSO carries a hook-layer surface as of loom#1752 — `halt-and-report`/advisory at `Stop` — and its cap is the same shape: the declared-sub-part count is a structural process/tool-event read, but whether those parts are INDEPENDENT is judgment-bearing, so MUST-2 forbids `block` there too. MUST-1, MUST-2 and MUST-4 remain session-history judgments with no tool-call-time structural signal and are review-layer only.
- **Grace period:** 7 days from rule landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a serial probe chain where one composed call was available; a verification battery discovered across successive pushes; a decomposable input executed inline until the human asked for lanes; a corpus pulled into orchestrator context in place of a conclusion; a write-implying dispatch to a read-only agent; a named dispatch briefed with a one-shot return contract) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: context-spend and delegation-shape are judgment-bearing over session history, so they do not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `agents.md` § Triad, `instrument-discipline.md`, and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: orchestrator-context-economy]` IFF `posture.json::pending_verification` includes the `orchestrator-context-economy` rule_id.
- **Detection mechanism:** structural + review. Structural (MUST-5 + MUST-6): `.claude/hooks/dispatch-contract-guard.js` at `PreToolUse:Task|Agent`, whose pure predicates are `.claude/hooks/lib/dispatch-contract.js::detectWriteTaskToReadOnlyAgent` (MUST-5) and `::detectNamedDispatchWithoutDelivery` (MUST-6); bipolar audit fixtures at `.claude/audit-fixtures/dispatch-contract/run.mjs`, registered in `.claude/test-harness/ci-audit-fixtures.json` and executed by `.claude/bin/run-audit-fixtures.mjs`. Structural (MUST-3), SHIPPED loom#1752: `.claude/hooks/delegation-default-guard.js` at `Stop` (lifecycle), whose pure predicate is `.claude/hooks/lib/delegation-default.js::assessDelegationDefault`; bipolar audit fixtures at `.claude/audit-fixtures/delegation-default/run.mjs`, same registry and runner. `Stop` is the ONLY surface that can carry it: MUST-3's failure is the ABSENCE of a dispatch, and neither `PreToolUse:Task|Agent` nor `SubagentStop` — where the pre-existing parallelism rider is read — fires in a session that dispatched nothing. The signal is the dispatch ledger's own `parallelism` rider (`declared_subparts` from a line-anchored list-marker count, vs main-generation `launch` rows after it), consumed verbatim rather than re-derived. Its bounds are ENFORCED, not aspirational: it ADVISES only on the total-absence boundary (`declared >= 2 && dispatched === 0`), the PARTIAL-shortfall arm ships OBSERVING because its ratio is uncalibrated, and the calibration protocol that would promote it is recorded in the library header. It is `advisory`/`halt-and-report` and can never carry `block` — the sub-part count is structural but "are these parts independent" is judgment-bearing, so it will false-positive on legitimately serial work; and it detects idle-serialism, not BAD delegation (a session dispatching five useless lanes passes it). Review (MUST-1/2/4, and the MUST-3/5/6 semantics no predicate reaches): cc-architect at `/codify` + reviewer at `/redteam` inspect the session for composed-probe discipline, a locally-enumerated verification battery before the first push, self-initiated decomposition, and bounded lane return contracts. Semantic tier: `.claude/test-harness/probes/orchestrator-context-economy.probes.json` with candidate + answer-key fixtures at `.claude/audit-fixtures/orchestrator-context-economy`, registered in `.claude/test-harness/eval-manifest.json` (`scanner: null`) and pinned in `.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES`. Probes are DISPATCHABLE, never automatic: no workflow invokes the dispatcher, so a green CI run is never evidence they passed. NOTHING is deferred — no Phase-2 row is filed for this rule, and no detector is claimed that does not exist.
- **Violation scope:** rule-corpus-wide (MUST-1 through MUST-6 + both MUST NOT bullets). MUST-3 (at `Stop`), MUST-5 and MUST-6 (at `PreToolUse:Task|Agent`) additionally carry the hook-layer surface; MUST-1, MUST-2 and MUST-4 are review-layer only. Every `violations.jsonl` row names the clause and the dispatch, command chain, or declared-vs-dispatched pair it fired on.
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-7 (orchestrator-only work)

Applies to **MUST-7** ONLY (added 2026-08-16, co-owner-directed in-session directive); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. MUST-1..6 stay on the rule-wide block above (clause-scoped precedent: `security.md` § Enforcement-Surface Parity, `agents.md` § Correctness-Review-Clean).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` inspect the session for execution-class work run inline that a lane could have returned a conclusion for). BOTH `block` AND `advisory` are UNAVAILABLE at the hook layer, and that is a structural cap rather than a preference: the framing-vs-execution discriminator is the INTENT a read serves, which no tool-call payload carries — a `Read` of two files is byte-identical on the wire whether it is writing a brief or executing the work.
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (an enumeration, bulk read, or verification run executed in the main thread that a lane could have returned a conclusion for; framing reads continued past the point the brief became writable) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the framing/execution boundary is judgment-bearing over session history with no structural signal, so an instant-drop key would fire on a judgment no instrument can confirm, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same disposition MUST-1..6 took above.
- **Receipt requirement:** SessionStart soft-gate `[ack: orchestrator-context-economy]` IFF `posture.json::pending_verification` includes the `orchestrator-context-economy` rule_id (shared rule_id; one ack covers MUST-1..7).
- **Detection mechanism:** review-layer ONLY, and that is the TERMINAL disposition — not a deferral. cc-architect at `/codify` + reviewer at `/redteam` read the session for main-thread work a lane could have done and returned a conclusion for. NO structural detector is named and NONE is filed in `.claude/test-harness/phase2-deferrals.json`, because none can exist at tool-call time: a `Read` payload is identical whether the read frames a brief or executes the work, so a detector built on it would be a non-discriminating instrument in the sense `instrument-discipline.md` MUST-1 blocks, and naming one would be the phantom-detector shape `hook-output-discipline.md` MUST-5 forbids. Semantic tier: the `MUST-7-firing` bipolar pair in `.claude/test-harness/probes/orchestrator-context-economy.probes.json`, candidates + answer keys at `.claude/audit-fixtures/orchestrator-context-economy/`, registered in `.claude/test-harness/eval-manifest.json` (`scanner: null`) and pinned in `.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES` with the rest of the suite. Probes are DISPATCHABLE, never automatic: no workflow invokes the dispatcher, so a green CI run is never evidence they passed. The separate MUST-3 detector work is tracked at loom#1752 and is deliberately NOT in scope here.
- **Violation scope:** MUST-7 ONLY (execution-class work spent in main-thread context, and framing reads continued past the writable-brief point). MUST-1..6 stay on the rule-wide block above.
- **Origin:** See § Origin (the 2026-08-16 co-owner directive quoted there).

Origin: 2026-08-16 — co-owner-directed origination (O1 class). Six instances measured in ONE session: serial one-line probes where one composed command sufficed; a verification battery discovered across four pushes and four different gates, every one runnable locally; delegation occurring only when the human asked, after hours of hand-execution that three lanes then closed in parallel; large outputs pulled into orchestrator context instead of lanes returning conclusions; lanes dispatched without the tool set their task required; and lanes going idle because a NAMED dispatch — a persistent mailbox agent that never auto-returns — was briefed with a one-shot return contract. Authored as a NEW path-scoped rule rather than an `agents.md` amendment: `agents.md` is `priority: 0` baseline and the `workspace-note` injection profile carries 43 B of margin (`check-rule-injection-budget.mjs`, measured at authoring), so a baseline amendment was unaffordable. The `paths:` set was chosen to charge ZERO bytes against all eight canonical profiles — verified against the checker's own `PROFILES` probes, none of which `.claude/agents/**`, `**/.claude/hooks/**` or `**/.claude/settings.json` match. **Path-scoped injection is NOT this rule's reachability mechanism for the dispatch moment** — an orchestrator choosing a dispatch shape touches no file, the same reachability gap `issue-triage-routing.md` records; the HOOK is what fires at that moment, and the globs exist so the rule loads when its ARTIFACTS are being authored. Depth: `.claude/guides/rule-extracts/orchestrator-context-economy.md`.

**MUST-7** — 2026-08-16, a SECOND co-owner directive in the same session, verbatim: _"Together with the main agent always discuss and take on main agent-only work, to preserve the context in main thread. This is critical throughput blocker as you have just experienced."_ MUST-4 governs what comes BACK into orchestrator context; nothing governed what the orchestrator SPENDS its own context on in the first place, which is the gap this closes. The clause deliberately does NOT forbid orchestrator investigation — a brief cannot be written for work that cannot yet be framed — so the contract turns on what a read SERVES (framing vs execution) and on the STOP point (the moment the brief became writable), not on whether the orchestrator read anything at all. Depth: extract § "MUST-7 — the framing/execution boundary".
