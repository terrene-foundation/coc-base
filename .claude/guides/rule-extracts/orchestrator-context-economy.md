# orchestrator-context-economy — depth extract

Depth for `.claude/rules/orchestrator-context-economy.md`, extracted per `rule-authoring.md`
Rule 10 path (a). Not baseline-emitted, not injected by any profile.

## The six measured instances (one session, 2026-08-16)

| # | Instance | Clause |
| - | -------- | ------ |
| 1 | Dozens of one-line Bash round-trips where one composed command would do | MUST-1 |
| 2 | The verification battery discovered ONE CI ROUND AT A TIME — 4 pushes, 4 gates, all runnable locally | MUST-2 |
| 3 | Delegation happened only when the human ASKED; hand-work took hours, then 3 lanes closed 8 findings in parallel | MUST-3 |
| 4 | Large outputs pulled into orchestrator context instead of lanes returning conclusions | MUST-4 |
| 5 | Lanes dispatched WITHOUT the tool set their task needed (notably `Write`) | MUST-5 |
| 6 | Lanes went IDLE without delivering — a NAMED dispatch is a persistent mailbox agent that never auto-returns, briefed with a one-shot "return your findings" contract | MUST-6 |

The co-owner directive that generated the rule: *main-agent context is reserved for discussing
important things with the human, consolidation, and work subagents cannot do.*

## Why this is a NEW rule and not an `agents.md` amendment

`agents.md` is `priority: 0` **baseline** — emitted into every consumer's always-on prompt. At
authoring, `check-rule-injection-budget.mjs` reported the `workspace-note` profile at **43 B** of
margin against its ceiling (`floor(budget × 1.05)`); `loom-command-edit` had 853 B. A baseline
amendment of any useful size was unaffordable, and the *whole point* of the corpus's path-scoped
tier is that a rule which does not apply to a session should not be charged to it.

The `paths:` set was picked to charge **zero** bytes against **all eight** canonical profiles. The
checker's `PROFILES` probes are `.claude/rules/cc-artifacts.md`, `.claude/bin/emit.mjs`,
`.claude/skills/30-claude-code-patterns/sync-flow.md`, `.claude/commands/codify.md`,
`workspaces/example/journal/0001-x.md`, `packages/kailash/src/core/runtime.py`,
`tests/integration/test_runtime.py`, `README.md`. None is matched by `.claude/agents/**`,
`**/.claude/agents/**`, `**/.claude/hooks/**`, or `**/.claude/settings.json`.

## The reachability argument, stated honestly

Path-scoped injection keys on the **touched-file set**. An orchestrator *choosing a dispatch shape*
touches no file — so **no glob, however wide, fires at the moment of the decision.** This is the
same reachability gap `issue-triage-routing.md` records for `gh issue` triage, and the same one the
prior `runtime-enforcement-2026-08-14` workstream measured when it refuted the glob route for its
own T4.

The resolution is not a wider glob. It is the **hook**: `dispatch-contract-guard.js` fires at
`PreToolUse:Task|Agent`, which IS the moment of the decision, and its `additionalContext` advisory
carries the instruction into the exact turn that needs it. The `paths:` globs exist for a different
and smaller job — loading the rule when its own artifacts (agents, hooks, settings) are being
authored. Do not re-derive "the globs provide reachability at dispatch time"; they do not, and the
rule's Origin says so.

## Why the hook cannot carry `block`

Both predicates have a lexical half:

- **MUST-6** reads the brief for a push-delivery instruction. Prose.
- **MUST-5** reads the brief for write intent. Prose. Its *other* half — the target agent's
  frontmatter `tools:` line — is a parsed document field, which `hook-output-discipline.md`
  MUST-5(a) names as fencing-grade. But a detector is no stronger than its weakest half.

So `hook-output-discipline.md` MUST-2 caps both at `halt-and-report`. This is recorded as a **cap,
not a preference**, per MUST-5(b): the hook can annotate a bad dispatch and can never stop one.
Anyone tempted to raise the severity should note that fixture cases 40–41 assert the cap directly.

## Why every unknown fails OPEN

`canWrite` is tri-state (`true` / `false` / `null`), deliberately not a boolean. Built-in agent
types — `general-purpose`, `Explore`, `claude`, `Plan` — have no file under `.claude/agents/`, so
reading their absence as "declares no write tools" would fire the MUST-5 advisory on the single
most common dispatch in the repo. Collapsing the UNKNOWN branch to `false` is mutation **M-c** in
the fixture runner; it reddens cases 19 and 20.

The same reasoning covers an unreadable agents dir, a `tools:`-less frontmatter, an empty prompt,
and a malformed payload. A guard that guesses when it cannot see is a guard the orchestrator learns
to skip past — and an advisory nobody reads is indistinguishable from one that never fired.

## The READ-ONLY withdrawal arm, and the vacuous case it nearly shipped

Investigation briefs are the correct, common use of a read-only agent, and they routinely describe
write work in the *caller's* scope ("report on the rule files I am writing"). Without a withdrawal
arm, that class would be the detector's loudest false positive. `READ_ONLY_SCOPE_RX` withdraws a
write-intent match when the brief is explicitly scoped read-only.

Worth recording because it nearly went wrong: fixture case 12 originally used the brief *"READ-ONLY
investigation. Report on the rule files I am writing."* — and `\bwrite\b` does not match `writing`,
so `impliesWrite` returned `false` **whether or not the withdrawal arm existed**. The case passed
under mutation M-b and proved nothing. It was caught by RUNNING the mutation, not by reading the
code, and the brief was rewritten to carry a live write-intent match. Two live hypotheses (vacuous
case OR inert mutation) is exactly what `instrument-discipline.md` MUST-2(b) says a non-reddening
mutation leaves you with.

## Relationship to the T1 telemetry pair

`emit-dispatch-ledger.js` + `reconcile-dispatch-delivery.js` (T1, `runtime-enforcement-2026-08-14`)
RECORD dispatches and reconcile them at `SubagentStop`. They tell you a lane went idle — after it
did. `dispatch-contract-guard.js` inspects the brief BEFORE the dispatch is issued and tells you it
was *going* to go idle. Complementary, not duplicative: T1 owns the sink and the reconciliation,
this hook writes nothing and owns the pre-flight.

## Composed-probe worked shape (MUST-1)

```bash
# One round-trip, labelled, whole picture at once — and note the exit-code capture:
# `cmd | tail` reports TAIL's status, so a piped gate silently always "passes".
node .claude/bin/check-rule-injection-budget.mjs > /tmp/a.log 2>&1; echo "budget EXIT=$?"
node .claude/bin/registration-preflight.mjs      > /tmp/b.log 2>&1; echo "preflight EXIT=$?"
```

## MUST-7 — the framing/execution boundary

The directive that generated MUST-7, verbatim (2026-08-16, same session as the six instances
above): *"Together with the main agent always discuss and take on main agent-only work, to preserve
the context in main thread. This is critical throughput blocker as you have just experienced."*

MUST-4 already governs what comes BACK into orchestrator context — a lane returns a conclusion, not
a corpus. Nothing governed what the orchestrator SPENDS its own context on before any lane exists.
That is the whole gap: an orchestrator can hold MUST-4 perfectly, never pull a single corpus into
its window, and still burn the thread doing the enumeration itself.

**The boundary, stated so it cannot be read as "never look at anything."** Some investigation IS
orchestrator-only, and a clause that forbade all of it would be wrong on its face — you cannot write
a correct brief for work you cannot yet frame, and a brief written from a guess costs a whole lane.
The discriminator is not WHETHER the orchestrator reads but what the reading SERVES:

| Reading serves | Class | Disposition |
| -------------- | ----- | ----------- |
| Deciding which lanes exist, what each is scoped to, what its brief must say | FRAMING | orchestrator-only; not blocked |
| Deciding a trade-off the human will be asked to ratify | FRAMING | orchestrator-only; not blocked |
| Reconciling what two lanes returned against each other | CONSOLIDATION | orchestrator-only by definition |
| Producing the enumeration, the verdict, the file, the exit code | EXECUTION | goes to a lane |

The failure mode the table is drawn against is not "the orchestrator read a file". It is the
**overshoot**: framing reads that were correct for the first two files and simply did not stop —
the brief became writable and the reading continued, because the context was already loaded and
finishing felt cheaper than dispatching. So the clause carries a STOP point, not just a category.
The moment the brief is writable, the remainder is a lane's.

**Why the hook layer carries nothing here — not even `advisory`.** MUST-5 and MUST-6 are detectable
because the dispatch payload contains the evidence (a `name=` argument; a target agent's declared
`tools:`). MUST-7's evidence is the INTENT behind a `Read`, and a `Read` of two files is byte-
identical whether it frames a brief or executes the work. A detector built on that payload could
not produce a different result if the proposition were false, which is exactly the instrument
`instrument-discipline.md` MUST-1 refuses. Naming one anyway — even as a deferral — would be the
phantom-detector shape `hook-output-discipline.md` MUST-5 forbids, so the rule states review-layer
as the TERMINAL disposition and files no `phase2-deferrals.json` row. This preserves the rule-wide
Wiring block's "NOTHING is deferred" property rather than quietly breaking it.

## Cross-references

- `agents.md` § Triad — parallelize-by-default (the mandate; MUST-3 names the trigger).
- `agents.md` § Verify Specialist Tool Inventory — the tool-fitness contract and read-only roster
  (MUST-5 is its dispatch-time, structurally-detected form).
- `git.md` § Pre-FIRST-Push CI Parity Discipline — the fixed command list MUST-2 generalises into
  an obligation to ENUMERATE.
- `hook-output-discipline.md` MUST-2 + MUST-5 — the severity cap and the signal-selection contract.
- `instrument-discipline.md` MUST-2 — established red, and the non-reddening-mutation trap above.
- `issue-triage-routing.md` § Origin — the same path-scoped reachability gap.
