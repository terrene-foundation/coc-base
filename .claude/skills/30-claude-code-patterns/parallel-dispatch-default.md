# Parallel-Dispatch-Default — The Triad Execution Mode + Brief-Claim Verification (depth)

Companion to `rules/agents.md` § "The Default Execution Mode Is The Triad" and § "Parallel
Brief-Claim Verification". The rule carries the CLI-neutral MUST contracts; this file carries
the DO/DO-NOT blocks, the BLOCKED-rationalization corpora, the bounding-gate enumeration, and
the Why paragraphs the rule points to. Loaded on-demand when orchestrating a wave.

## 1. The Triad Is The Default Execution Mode

The default execution mode for every actionable input is the TRIAD, each DEFAULT-ON:

1. **Parallelize** — dispatch onto the parallel primitive (a Workflow or parallel agent
   delegation) by DEFAULT, not serial/inline, not only under `/autonomize`; wherever the input
   has ≥2 independent sub-parts, decompose onto ONE parallel wave.
2. **/autonomize** — execute autonomously under the permission envelope: recommend AND take the
   optimal, root-cause, evidence-backed fix, no question-spam (`commands/autonomize.md`).
3. **/redteam-to-convergence** — every substantive change is adversarially verified to 2
   consecutive clean rounds before "done" (this REINFORCES, does not restate, `rules/agents.md`
   § Quality Gates + § Holistic Post-Multi-Wave Redteam + `rules/self-referential-codify.md`
   Rule 1).

```text
# DO — actionable input with ≥2 independent sub-parts → ONE parallel wave, autonomized,
#      then redteamed to 2 consecutive clean rounds before calling it done
# DO NOT — execute a decomposable input inline-serially, or idle while an independent
#          shard is dispatchable, or call it "done" before the redteam converges
```

**Serial carve-out (keep).** Drops to SERIAL/inline ONLY for a genuinely-atomic single-item
task (one indivisible unit) OR a factual/confirmation/recommendation reply — a one-liner needs
no workflow and no redteam. Forcing a workflow onto a 1-item serial task is pure latency
overhead; the carve-out is the anti-"always-workflow" gate.

**BLOCKED rationalizations:**

- "the triad needs `/autonomize` to be invoked first" (NO — it is the DEFAULT, not an opt-in)
- "parallel-by-default is my call each session"
- "serial is simpler, I'll decompose later"
- "`/redteam` is a separate phase, not part of doing the work"
- "a clear pick means I can skip the redteam"
- "keep-executing means I override the gate" (NO — the triad fills the default posture; it
  NEVER overrides a gate)

**Bounded by the SAME gates as `rules/wave-loop.md` MUST-6** (cross-ref, not restated): genuine
data/build dependencies; the structural human gates (`rules/autonomous-execution.md` §
Structural vs Execution Gates — plan-approval, release); capacity + throttle
(`rules/autonomous-execution.md` § Per-Session Capacity Budget + `rules/worktree-isolation.md`
Rule 4); prudence/sensitivity confirmation (`commands/autonomize.md` § Prudence +
`rules/recommendation-quality.md` MUST-8); the clean-gate-stop (`rules/recommendation-quality.md`
MUST-3). `/autonomize` is self-bounding — it already mandates confirming destructive /
hard-to-reverse / sensitivity-elevating actions.

**Why:** the triad is the baseline throughput+quality response, not a per-session opt-in; the
atomic/factual serial carve-out prevents over-decomposing a one-liner into a workflow; the
bounding gates ensure "always executing" never degrades into "always overriding a gate".

## 2. Parallel Brief-Claim Verification When Issue Count ≥ 3 (extracted depth)

The rule's MUST: when `/analyze` runs against a brief covering ≥ 3 distinct issues, the
orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to
independently re-grep / re-read every factual claim. Inaccuracies MUST be recorded in the
workspace journal AND the plan's "Brief corrections" section AS THE GATE before `/todos`.
Single-agent analysis on a ≥3-issue brief is BLOCKED.

**BLOCKED rationalizations:**

- "The brief was authored by the user, it must be accurate"
- "Sequential single-agent analysis catches inaccuracies anyway"
- "Three parallel agents triple the cost for the same conclusion"
- "I'll spot-check a couple of claims, that's good enough"
- "Brief verification is /redteam's job, not /analyze's"
- "The brief's claims are 'mostly correct', the rounding errors don't change the plan"
- "If a claim turns out wrong, /todos can correct it"

**Why:** Briefs reflect the author's mental model, which decays as code evolves; single-agent
analysis cannot resist the brief's framing without independent reading. Parallel deep-dive
verification is the structural defense — N agents, N claim-clusters, one wall-clock unit.

## 3. Waiting Is Not Work — The Push-Channel Discriminator

Parallel dispatch creates waits, and the triad says nothing about how to SPEND one. The default
that fills the gap is wrong: a `sleep` loop that burns wall-clock while the orchestrator holds a
turn open. One question discriminates every wait:

> **Does the thing I am waiting on have a PUSH channel back into this session?**

- **Agent completion — YES.** A dispatched agent's completion arrives on its own as a task
  notification; it wakes the orchestrator with the result and no prompting. Polling it is pure
  waste. **END THE TURN** with a status line naming what is in flight; the notification
  interrupts the idle turn for free.
- **CI / remote job status — NO.** Nothing pushes a workflow-run result into the session; the
  orchestrator must ask GitHub. So asking is legitimate — but ask ONCE and block SERVER-side
  (`gh run watch <run-id> --exit-status`), which returns the moment the run resolves. A
  fixed-interval loop is interval-GUESSING on top of a channel that already supports blocking.

```text
# DO — agent wait: end the turn; the completion notification is the wake-up
"3 shards dispatched (W1/W2/W3). Ending turn — will resume on completion."   # costs zero
# DO — CI wait: one server-side blocking call, event-driven, no interval to guess
gh run watch "$run_id" --exit-status     # returns the instant the run resolves

# DO NOT — sleep-wait for an agent that will notify (this was run EIGHT times in one session)
sleep 600; uptime; echo "waiting"        # 10 min burned; uninterruptible by the notification
# DO NOT — fixed-interval CI polling
while :; do gh run list --limit 1; sleep 120; done   # guesses an interval the API does not need
```

**Third clause — do not block on CI AT ALL while other work exists.** A run's result is needed at
the point of USE (merge time), not continuously. Dispatch the next shard, then check CI when the
merge decision actually arrives. `gh run watch` is the right instrument for a wait you genuinely
cannot avoid, not a license to create one.

**Resolves against § 1 (not a conflict).** The triad BLOCKS idling while independent work is
DISPATCHABLE. When nothing is dispatchable, ending the turn is the CORRECT move and is not
idling — the blocked-idle clause targets undispatched work, not an open turn. A `sleep` satisfies
neither: it dispatches nothing AND holds the turn.

**BLOCKED rationalizations:**

- "I need to wait for the agent anyway" (the wait happens either way; the sleep adds nothing to it)
- "sleep is simpler than tracking notifications" (there is nothing to track — the notification
  arrives unprompted)
- "ending the turn looks like I stopped working" (optics; the notification resumes the lane)
- "polling every 10 min is cheap" (it is a 10-minute UNINTERRUPTIBLE block, the most expensive
  possible way to do nothing)
- "I'll just check once more" (the rationalization that ran eight times)
- "the notification might not fire" (unfalsifiable, and a sleep would not rescue it — a work
  budget would; see § 3a)
- "the sleep gives the agents time to finish" (a sleep grants compute to no one; the agents run
  on their own clock either way)
- "CI usually takes ~8 minutes, so a 10-minute sleep is right-sized" (interval-guessing IS the
  failure mode; `--exit-status` needs no estimate)
- "CI polling is legitimate, so the same pattern is fine for the agent wait" (the exact
  conflation this section exists to break — CI has no push channel, agent completion does)

**Why:** a blocking sleep burns wall-clock that the notification would have returned for free,
and — the load-bearing half — it CANNOT BE INTERRUPTED BY THE VERY EVENT IT IS WAITING FOR. The
agent finishing at second 30 of a 600-second sleep buys 570 seconds of nothing. Ending the turn
is free, and is the only wait whose cost is exactly the wait.

### 3a. Every Dispatched Agent Carries An Explicit Work Budget

Ending the turn is safe only if a lane that goes wrong SURFACES. It does not by default: a wedged
agent produces silence, and silence is indistinguishable from "still working." So every dispatch
prompt MUST carry an explicit budget and a return contract:

```text
# DO — budget + coverage contract in the dispatch prompt itself
"WORK BUDGET: ~25 tool calls. On reaching it, STOP and return what you have with an explicit
 coverage statement naming what you did and did not get to."

# DO NOT — unbounded prompt; a wedged lane returns silence and the orchestrator cannot tell
"Review the changes and report findings."     # three lenses ran 3+ hours, produced nothing
```

**BLOCKED rationalizations:**

- "a budget will make the agent stop before it finishes" (it returns a PARTIAL report, which is
  recoverable; silence is not)
- "the agent will tell me if it gets stuck" (a wedged lane does not know it is wedged)
- "it's a small task, it can't wedge" (task size does not bound wedge risk)
- "I'll notice if it takes too long" (that noticing is exactly what the eight sleeps were)

**Why:** a wedged lane is not a slow lane — it will never return, and without a budget the
orchestrator learns this only by giving up. The budget converts an unbounded silence into a
bounded partial report. Complement to `redteam-dispatch-evidence-gate.md` Axis 1, which governs a
return that carries NO EVIDENCE; this governs a lane that never returns AT ALL — the evidence gate
cannot fire on an agent that never reports.

**Origin (§ 3 + § 3a):** an orchestration session that ran `sleep 600; uptime; echo "waiting"`
roughly eight times waiting on background agents whose completions had ALREADY been arriving as
notifications unprompted earlier in the same session — the CI polling pattern misapplied to a
push-channel wait. The same session dispatched three unbudgeted redteam lenses that ran past three
hours and produced nothing.

## CLI dispatch syntax

The concrete `Agent(subagent_type=…)` (CC) / `bin/coc` inline-cat (Codex) / `@specialist`
(Gemini) delegation code lives in `specialist-delegation-syntax.md` (the `examples` slot
target). This file is CLI-neutral depth; that file is the per-CLI mapping.
