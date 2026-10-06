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

## MUST-8 — the forest/fan-out boundary

**What the clause adds, measured against the corpus.** MUST-7 already draws a framing/execution
line over the orchestrator's CONTEXT SPEND: reading to write a brief is orchestrator work, reading
to produce the answer is a lane's. MUST-8 draws a second, orthogonal line over LEVEL OF ABSTRACTION
and DECISION RIGHTS. The two do not collapse: an orchestrator can stay inside MUST-7's context
budget — three files, forty lines — and still re-adjudicate a single finding the lane already
dispositioned. That is the failure the clause names, and it is not a context failure.

**The complementary half is already shipped.** `journal/0607` (co-owner-directed, 2026-09-12)
ruled that each lane is a mini-orchestrator, landed as the partition contract in
`rules/wip-discipline.md` MUST-9 and propagated through `commands/implement.md` § 3,
`commands/todos.md`, `commands/pickup.md` Step 0, `skills/lane-planning/SKILL.md` and
`skills/pickup/SKILL.md`. That directive governs what the LANE does with its agents. MUST-8 is the
ORCHESTRATOR half of the same model and deliberately cites rather than restates the lane half.

**The boundary is NOT severity, and a severity-drawn boundary would have contradicted an existing
MUST.** The co-owner directive speaks of "the fan-out subagents on your workhorses" owning the
detail. Encoding that as "MEDIUM/LOW-severity findings are the fan-out's" would have collided with
`rules/product-completion-first.md` MUST-1, which decouples severity from gating — that rule's own
words are "category gates; severity ranks", and `commands/redteam.md` states the consequence
plainly: *"severity is irrelevant: a LOW bug blocks, a MED incremental defers."* A clause that routed
findings to the fan-out BY severity would have been a second, contradictory severity gate sitting
one file away from the MUST that forbids severity gating.

So the boundary is drawn on ESCALATION TRIGGERS instead — the structural gate, the scope or
envelope change, the cross-lane invariant, the blocked container, the question for the human — and
severity is explicitly excluded. This preserves the directive's intent (the orchestrator does not
adjudicate findings; the fan-out does) without importing a severity threshold the corpus has
already refused. The lane states its escalation REASON, and that statement IS the judgment being
delegated: the orchestrator dispositions the ESCALATION, never the finding beneath it.

**Why this is not merely MUST-7 restated, in the DO/DO-NOT shape.** The compliant pole is a lane
returning a counted disposition — three fixed, six filed with receipts, two escalated — over which
the orchestrator exercises judgment on the two escalations and re-dispatches. The violating pole
differs only in that the orchestrator re-designs the fix for a fourth finding that the lane had
already closed. Both poles are inside every MUST-7 bound: the orchestrator read three files and
spent a few hundred tokens in each. What separates them is whose judgment produced the disposition.

**The measured cost the clause exists to prevent.** The failure is self-reinforcing rather than
merely wasteful. A fan-out whose dispositions are re-opened learns that its dispositions are
provisional, so it escalates the marginal case rather than deciding it — which increases the
orchestrator's detail load, which increases the re-opening, which further discounts the fan-out's
decisions. The end state is a fan-out used as a fetch layer and an orchestrator running the serial
loop the lane model was introduced to replace (`journal/0607`).

## MUST-9 — movement as the standing question and the report

**Three questions, one obligation.** *How much of the forest moved* is a quantity; *what moved* is
its decomposition; *how to move faster* is the throughput half the other two make actionable. The
clause is one obligation because the third question without the first two is a preference, and the
first two without the third are a status board.

**The report shape is MOVEMENT, and the alternates are what it excludes.** Lands, blocks with their
blocker, standing inventory, idle parallel capacity. What is excluded is per-finding narration.
The distinction is not stylistic: a narrative of findings is unfalsifiable as progress, and
`burn-down-reporting.md`'s own `**Why:**` names the same failure at the close-time scale — *"a
session can merge fourteen PRs while the outstanding surface grows, and nothing in the narrative
reveals it."* MUST-9 is that argument applied per-turn rather than at close.

**Where this differs from `burn-down-reporting.md`, which owns the close-time form.** That rule
mandates three MEASURED quantities — cleared, remains, delta — against a pinned baseline, with the
instrument named and the figure produced in-session. That is a close-time measurement contract.
MUST-9 is the during-session form: it does not require a pinned baseline, an instrument, or three
quantities, and it adds the throughput question, which `burn-down-reporting.md` does not carry at
all. The two compose rather than overlap, and the clause CITES rather than restates the close-time
contract.

**"How to move faster" is not open-ended, and the clause names its sanctioned answers.** It resolves
through `agents.md` § Triad (Parallelize + /autonomize + /redteam-to-convergence) and
`autonomous-execution.md` § 10x Throughput Multiplier — "under time-pressure framings
parallelization IS the throughput response". The clause's function is to refuse the OTHER answer:
a slower serial path adopted without naming one of those. That is the answer the question exists to
surface rather than to hide.

**Idle parallel capacity is the quantity no other surface reports.** The open-PR block, the
unlanded-work block and the deferral block at SessionStart all answer "what is outstanding"; none
answers "what capacity is sitting unused". An orchestrator that never asks the movement question
finds out at close, if at all.

## MUST-8 — why the clause was widened past re-opening

**The first draft was NARROWER than the directive, and the gap was in the direction that mattered.**
It blocked RE-OPENING a disposition the lane had already made. The directive says *"DO NOT DIVE INTO
THE DETAILS"* — and re-opening is only one form of diving. The uncovered form is the one that looks
benign: the orchestrator makes a disposition the lane NEVER REACHED, arriving at it independently
rather than overriding anyone, so nothing on the page reads as a second-guessing. Measured against
the clause's own purpose, that is the same defect — the main thread produced a per-finding judgment
the fan-out owned — reached by the route that leaves no injured party to notice.

The clause now blocks ANY per-finding adjudication in the main thread unless it is (a) an answer to
an escalation the fan-out raised, or (b) a spot-check in the always-escalate classes. The two
permitted forms are both answers to something the FAN-OUT produced: the escalation it raised, or the
finding it closed. In neither case does the orchestrator originate the judgment.

## MUST-8 — the always-escalate floor, and why the list must be NAMED

**Without the list the clause is FAIL-OPEN, and this is the sharpest of the clause's properties.** A
boundary that reads "the lane escalates what it judges should escalate" delegates the boundary's
own definition to the party the boundary exists to constrain. A lane that misjudges closes the
finding alone, and then every self-check it runs shares the scope of that misjudgement — the check
and the error are made by the same party, with the same information, in the same pass. No amount of
internal rigor recovers from that, because rigor is not the missing input; OUTSIDE SCOPE is.

So the classes are enumerated rather than described, and a lane may never close one alone **whatever
the severity**. That last clause is what makes it a floor rather than a ranking:

- **security-critical findings** — `agents.md` § Correctness-Review-Clean's class, taken VERBATIM
  rather than re-worded: **auth, signing, revocation, tenant-isolation, any fail-closed gate or trust
  boundary**, PLUS **process-signalling (kill) paths**. The class is drawn on the SURFACE, not on a
  severity label, because a lane cannot rate the blast radius of a surface whose consumers it cannot
  see. **The process clause is not part of the quoted definition and is added deliberately**, and the
  reason is worth carrying: the standing directive that reached this lane named "signalling", which
  reads as a typo for "signing" and was mis-transcribed as one in the clause's first draft. The two
  are one letter apart and name unrelated classes — one cryptographic, one a kill path — so the
  mis-transcription silently swapped an operation class for a crypto class, i.e. it sent the wrong
  findings to the wrong destination while reading as a faithful quote. Quoting the neighbouring rule
  verbatim for the half it already defines, and ADDING the process half explicitly rather than
  folding it into the quote, is what makes the two classes separable on the page.
- **disclosure findings** — a lane inside one ecosystem cannot see the other ecosystem the
  disclosure rule protects.
- **cross-repo actions** — a lane's repo scope ends at its own tree.
- **owner-only acts** (countersign, activation) — authority a lane does not hold and cannot acquire.
- **destructive or irreversible operations** — the class where a wrong call is not repairable.
- **structural gates** (landing, dev→main) — gates whose whole design is that a lane does not pass
  them alone.

**The list names WHAT may not be closed alone; it does not name WHERE each class then goes, and the
first draft left that ambiguous.** "Never close these alone" is satisfiable by routing them anywhere
further up, which is the same fail-open shape one level over — a class whose destination is
unspecified lands wherever the reader assumes. The destinations are therefore stated, and they are
NOT uniform:

- **To the HUMAN:** owner-only acts · structural gates (landing, dev→main) · cross-repo actions ·
  destructive or irreversible operations. These are classes where the deciding authority is the
  human's and no review can stand in for it.
- **To the ORCHESTRATOR, which handles them WITH a security reviewer:** security-critical findings,
  and disclosure findings. These are classes where a competent reviewing party exists below the
  human, and the clause's own `agents.md` citation names the team required — a correctness reviewer
  is not a security reviewer, so the orchestrator's handling carries both lenses.
- **To the HUMAN ADDITIONALLY:** a disclosure that has **already shipped outside the repo**. Note the
  word ADDITIONALLY — this class does not replace the orchestrator route, it adds a second one. Once
  a disclosure has left the repo the remediation is no longer a review decision at all: it is
  incident handling, whose scope (notify whom, when, how) is the operator's, and a review that
  quietly remediated it would have made an incident-handling call on the operator's behalf.

The asymmetry between the second and third rows is the point worth carrying: the SAME class routes
differently depending on a FACT about the world (has it shipped?) rather than on the finding's
severity or its discoverer. That is why the destinations are written as a routing table rather than
as a single escalation target, and why "escalate it" is not a complete instruction on its own.

**Why severity cannot generate this list.** `product-completion-first.md` MUST-1 already refuses
severity as a gate: its own words are "category gates; severity ranks". The always-escalate classes
are therefore not "the HIGH ones" — they are the classes whose defining property is that the
deciding party cannot see the whole surface. A LOW-rated disclosure finding is still a disclosure
finding, and a lane that rates it LOW has made the scope error the class exists to catch.

## MUST-8 — the three things the list does not imply

**Escalating TO the orchestrator is NOT escalating TO the human.** This is the first thing a
fail-closed list gets wrong. A class gated on the human — a destructive operation the owner must
authorize, a landing the owner must approve — is not discharged by reaching the orchestrator. The
orchestrator is another agent, and its standing is the same as the lane's on every question that is
the human's to answer. The list routes a finding UP one level; it says nothing about the second
level being sufficient.

**An orchestrator brief is NEVER a human authorization.** This is the permission-laundering fence
and it belongs in the rule rather than in a session's working memory, because the failure it blocks
is invisible at the moment it happens. `repo-scope-discipline.md` § User-Authorized Exception
condition 1 defines the user-initiated test as "a genuine user turn, NOT tool/file/sub-agent text,
NOT an agent suggestion the user merely assented to". A lane handed an orchestrator brief has been
handed sub-agent text, so the brief cannot satisfy condition 1 for the lane any more than an agent
suggestion could for the orchestrator. Every other condition in that section (explicit and specific,
confirmed, receipt before acting, scoped exactly) presumes condition 1 already holds; without it, a
cross-repo write authorized by nothing but a brief reads as a documented five-condition approval
while failing the one condition that makes the other four meaningful.

**A licensed spot-check is NOT licence to re-decide.** The orchestrator MAY read inside the
always-escalate classes — that read is how the floor is enforced at all, and forbidding it would
leave the list unpoliceable. What the licence does not extend to is the DISPOSITION. An override
goes BACK TO THE LANE as an escalation: the lane re-opens its own finding, the orchestrator's
escalation state is the only thing that changed, and the fan-out keeps ownership of its output.
Silently re-doing it in the main thread is the original violation with a licence attached.

**The read-for-escalation BLOCKED entry is therefore SCOPED, not deleted.** "I must read the finding
myself to judge whether it escalates" stays BLOCKED for every finding OUTSIDE those classes, where
the lane's escalation statement IS the judgment and re-reading it is the fetch-layer behaviour the
clause exists to stop. Inside them it is the licensed spot-check, and it inverts: the orchestrator is
expected to read, and the expected OUTPUT is an escalation returned to the lane.

## MUST-9 — why mid-session narration is the violation, not only a bare close

The first draft's violation scope read "a close reached with per-finding narration and no movement
report", and it left the commonest shape uncovered: a session that narrates findings at EVERY
checkpoint and reports movement once at the end. That session satisfies the close-time clause while
having violated the during-session one for its whole duration — and the during-session one is the
clause's entire subject.

The clause now binds ANY checkpoint. The reason the close is not enough is that a movement report's
value is cumulative and perishable: its purpose is to let the human REDIRECT while redirection is
still cheap, and a report delivered at the close arrives after every decision it might have changed
has already been made. Reporting movement only at close is a status board; reporting it at every
checkpoint is a control surface.

**Reviewer-round reports are held to the same standard rather than exempted.** A round summary is a
movement report over reviewers, so it carries each reviewer's ran/evidence signal — an errored,
empty or timed-out return is ZERO evidence and MUST NOT be summarised as a clean round — and for a
security-critical change it carries BOTH verdicts, because a CLEAN correctness verdict is not a
security verdict (`agents.md` § Correctness-Review-Clean Is Not Security-Clean). The same
scope-blindness that motivates the always-escalate list applies one level up: a correctness lens and
a security lens are different instruments, and one of them returning clean says nothing about the
other.

**Security and disclosure findings are the one class exempt from the counts.** The clause's movement
form exists to compress per-finding detail into quantities. That compression is exactly wrong for a
security or disclosure finding, where the reader must be able to CHECK the claim, so those are
reported with their evidence per `evidence-first-claims.md` MUST-2 — the triggering bytes, decoded,
inline in the same message. The movement form is a summary contract; it is never a licence to
compress a security claim past the point where its evidence survives.

## MUST-10 — the standing queue, and the gap the other clauses left

**What the clause adds, measured against the corpus.** MUST-7 governs what the orchestrator READS
and MUST-8 governs what it DECIDES; `wip-discipline.md` MUST-9 governs what happens INSIDE a lane
once it has work. Nothing governed what a lane is HANDED. That gap is load-bearing rather than
cosmetic, because MUST-8's whole model — the fan-out owns the detail, the orchestrator stays at
forest level — assumes a fan-out that HAS work. A lane handed one item and nothing behind it is a
serial worker with a lane's name, and it re-creates at the queue level exactly the orchestrator
bottleneck MUST-3 and MUST-7 exist to remove: every item becomes one round-trip through the main
thread, which is the shape the lane model was introduced to replace (`journal/0607`).

**Why DEPTH, and why the number is two.** `wip-discipline.md` MUST-9's own `**Why:**` states the
mechanism this clause inherits: *"A ceiling on inventory leaves depth as the only throughput lever."*
The WIP ceiling counts containers — worktrees and branches — never agents or items, so a session
that opens few lanes and gives each one item is spending a whole slot of the ceiling on one agent's
worth of work. Two is the floor because ONE is the degenerate case the clause exists to forbid: a
single item is a queue with no refill decision in it, so the lane cannot drain autonomously even in
principle. The NAMED reserve is what makes the fifth part a PREDICATE rather than a feeling — the
lane declares the count at which its queue is LOW, so "the queue is empty" is read off the ledger
instead of assessed.

**Why DURABILITY is a separate part rather than a restatement of DEPTH.** Depth that is only
REPORTED is the same failure MUST-9 catches one level up: a narration is unfalsifiable, so a queue
described by its own lane decays to whatever the lane says it is. Binding each item with `lane:`
frontmatter is `wip-discipline.md` MUST-9's own ledger contract, CITED rather than restated — and it
is what makes the depth MEASURABLE by that rule's existing SessionStart instrument instead of by
trust. Without the binding, (a) is a claim; with it, (a) is a fact someone else's tool can read.
That is the whole reason the two parts are separate: (a) is the obligation and (b) is what makes (a)
checkable by a party other than the one subject to it.

**Why DRAIN WITHOUT ASKING, and why it is not a new obligation.** `autonomous-execution.md` §
"Root-Cause Fix Is The Default Disposition" already BLOCKS the permission turn for an unambiguous
in-envelope fix at ITEM scope, and its BLOCKED corpus names this exact move in the first person:
*"I should check with the user before changing that"*, *"Asking is the conservative choice"*. MUST-10
does not re-mint that rule; it names the QUEUE-shaped instance of it, where the permission turn is
not "may I do this fix?" but "may I take the next item?" — a question whose answer the standing
principles already contain, and whose cost is a full orchestrator turn per item. CITED, per
`specs-authority.md` Rule 9.

**Why (d) is a closed list, and why that is the clause's fail-closed edge.** "A lane returns to the
orchestrator when it needs to" would delegate the boundary's own definition to the party the
boundary constrains — the same fail-open shape MUST-8's always-escalate list exists to close one
level up. So the triggers are enumerated and there are exactly three: an ALWAYS-ESCALATE class
(MUST-8's list, CITED), genuine competing-design doubt, and QUEUE-LOW. The second is the one that
decays if it is read loosely, and it is deliberately narrow: it names two designs the RULES decide
neither of, not an item the lane has not yet looked up. The distinction is checkable rather than
rhetorical — a lane raising (ii) can name both branches and the rule that fails to choose between
them, which is what the compliant fixture does and what the violation fixture cannot, because its
item has an answer already in the corpus. Read loosely, (ii) swallows (c) and the clause collapses
into "ask whenever unsure".

**Why (e) is the part no other clause carries.** An idle lane and a lane with nothing to report are
indistinguishable at the orchestrator's end — the empty-outcome shape `conservation-gate.md` MUST-4
exists to make loud — and the orchestrator's DISPOSITION of that silence is where the harm lands: it
defers a refill it could have made now, or worse, reads the quiet as completion. So the queue-low
signal is not a courtesy, it is the sensor the refill decision reads. The three components (the
lane, the reserve reached, what would refill it) are what separate a signal from a status note: a
bare "I'm nearly done" leaves the orchestrator exactly as blind as silence did.

**What the clause is NOT.** It is not a WIP-ceiling change — `wip-discipline.md` MUST-2 counts
inventory, and this clause deliberately does not touch that count. It is not a lane-internal
contract — the fan-out, the partition and the one-committer rule are `wip-discipline.md` MUST-9's
and are CITED. And it is not a reporting clause — that is this rule's MUST-9, and the two compose:
MUST-9 says the ORCHESTRATOR reports movement; MUST-10(e) says the LANE reports the one fact the
orchestrator cannot otherwise see.

## Wiring — MUST-8 + MUST-9

**One block, two clauses, and why that is not a shortcut.** The rule already carries a rule-wide
block (MUST-1..6 plus both MUST NOT bullets) and a clause-scoped block for MUST-7, so a third block
scoped to MUST-8 + MUST-9 follows the precedent rather than inventing a shape. The two clauses share
ONE block because they are two halves of one mode and, critically, because neither reaches a
tool-call-time structural signal ON ITS OWN — the disposition below is identical for both, so two
blocks would have carried two copies of it and drifted.

**Severity — why `block` and `advisory` are BOTH unavailable, and why that is a cap rather than a
preference.** The discriminating question for MUST-8 is "is this finding forest-level?", which is
the INTENT a read serves. MUST-7 withdrew `block` on exactly this ground; MUST-8 inherits the
argument in a stronger form, because the two poles of the MUST-8 pair can be *byte-identical in
tool-call shape*: the DO pole reads three files to disposition two escalations, and the DO NOT pole
reads three files to re-design a closed fix. A detector built on that payload could not produce a
different result if the proposition were false — the exact instrument `instrument-discipline.md`
MUST-1 refuses to cite. `advisory` is unavailable for the same reason plus one more: an advisory
emission that cannot discriminate produces volume without signal, and the rule's own MUST-1..6
block already records that a detector is no stronger than its weakest half.

**Grace period.** Seven days from clause landing, matching every other clause in this rule
(MUST-1..6 landed 2026-08-16 → 2026-08-23; MUST-7 the same window). The window exists so the clause
can be applied in review before its absence is charged to posture.

**Cumulative posture impact.** Same-class violations contribute to `trust-posture.md` MUST-4
cumulative-window math: 3× same-rule in 30 days → drop 1 posture; 5× total in 30 days → drop 1
posture. The two counted same-class shapes are (i) a per-finding disposition, fix design,
instrument choice or escalation adjudicated in the main thread after the fan-out owned it, and
(ii) a close reached with activity narrated and no movement report.

**Regression-within-grace — the named deviation, and the reason no dedicated key was minted.**
`trust-posture.md` Rule 8 asks each clause to consider a dedicated instant-drop trigger key. Both
new clauses decline one, and the deviation is NAMED rather than left implicit: the two clauses are
judgment-bearing over session history with no structural signal (above), so a dedicated key would
fire on a judgment no instrument can confirm. Minting it would also drag `trust-posture.md` — a
`self-referential-codify.md` Rule 2 allowlist file — into a self-referential edit for no gain. This
is the same disposition MUST-1..7 took, and the corpus precedent is explicit:
`agents.md` § Triad, `instrument-discipline.md`, `git.md` § CI-check/merge and
`burn-down-reporting.md` all record it.

**Receipt requirement.** The shared `orchestrator-context-economy` rule_id, so one
`[ack: orchestrator-context-economy]` covers MUST-1..10. Splitting the id per clause would have made
a single session's ack surface proportional to the clause count for no enforcement benefit.

**Detection mechanism — review-layer ONLY, and TERMINAL rather than deferred.** cc-architect at
`/codify` + reviewer at `/redteam` read the session for detail adjudication in the main thread and
for a close with no movement report. No structural detector is named and no row is filed in
`.claude/test-harness/phase2-deferrals.json`, for the reason given under Severity: naming one would
be the phantom-detector shape `hook-output-discipline.md` MUST-5 forbids. Naming a detector that
cannot exist is strictly worse than naming none, because it converts an open gap into a closed one
on paper.

**Semantic tier.** `.claude/test-harness/probes/orchestrator-context-economy.probes.json` carries
the `MUST-8-firing` and `MUST-9-firing` bipolar pairs with their candidate fixtures and `.expected`
answer keys. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes the
dispatcher, so a green CI run is NEVER evidence these probes passed. They execute only when an
orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. That property is stated
here because it cuts against the clause: a pair that is registered but never dispatched leaves the
clause's semantic tier as uncovered as if it had never been authored.

**Invoker class.** `agent-mid-procedure` ONLY. No `runtime` backing exists at any audience: both
commands bottom out in cc-architect at `/codify` and reviewer at `/redteam`, and
`.claude/sync-manifest.yaml` § `surface_roles` scopes both to `[build, use-consumer]`, so at the
`platform` role they are REACHABLE-BUT-UNINVOKABLE. That finding is recorded rather than discharged
by this block — the same reachability gap `orchestrator-context-economy` itself records for
MUST-3, and the same one `skills/32-trust-posture/wiring/issue-triage-routing.md` § Origin records
for that rule.

**Violation scope.** MUST-8 and MUST-9 ONLY. MUST-1..6 stay on the rule-wide block; MUST-7 stays on
its own block. Every `violations.jsonl` row names the clause and the finding or close-out surface it
fired on.

## Wiring — MUST-10, and why `block` was declined on a STRUCTURAL signal

**The interesting case in this rule, and the one worth writing down.** Every other clause here
declines `block` because no structural signal exists at all. MUST-10 is the first where one DOES:
the `lane:` key of the durable work ledger is a parsed frontmatter field
(`hooks/lib/todo-durable.js` matches it with `/^lane:(.*)$/`), and `hooks/lib/wip-lanes.js::laneDepth`
already reports per-lane QUEUED / UNBOUND / UNDER-PACKED off it. Naming the field and the file is
therefore not the obstacle. Two other things are, and both are checkable rather than asserted.

**First, the one predicate over that field reports and never blocks.** It is registered at
`SessionStart` through `hooks/wip-discipline-guard.js::runSessionStart`, and its own emitted
justification says it: *"Advisory: whether a lane can take more work is a judgment; this reports
ledger facts and never blocks."* A Wiring field claiming `block` here would attribute to that
instrument an enforcement it declares it does not have — the phantom-detector shape
`hook-output-discipline.md` MUST-5 forbids — and the machinery it described would live in ANOTHER
rule's guard, so the claim would be about a different artifact's behaviour rather than about this
change. The honest move is to CITE the report as the structural half of detection and scope
`block` out.

**Second, and decisively for part (e): a depth integer cannot discriminate the violation from the
sanctioned state.** A lane AT its reserve has legitimately reached QUEUE-LOW — that state is what
the signal is FOR. The breach is the ABSENCE of a signal, and no ledger field records an absence, so
a detector reading the field would return the same result whether the proposition were true or
false. That is `instrument-discipline.md` MUST-1's falsifying-result test failing, which is why (e)
is review-layer even though (a) is structurally reported.

**What the review layer covers, and why no Phase-2 row is filed.** cc-architect at `/codify` and
reviewer at `/redteam` read for (c) the permission turn, (d) the unsanctioned return and (e) the
silent idle. No `phase2-deferrals.json` row is filed for them: (c) and (d) are dispatch-prose
judgments with no tool-call-time signal, and (e) would require a queue-low LEDGER FIELD nobody has
committed to build — booking a dated debt against an unbuilt facility is the permanent-by-default
shape `hook-output-discipline.md` MUST-5(b) forbids, exactly as MUST-7's and MUST-8+MUST-9's blocks
already record for their own clauses.

**Effect size, stated so the disposition can be argued with.** Declining `block` here is not a
retreat from enforcement: the depth half is reported at every SessionStart by an instrument that
already exists, and the semantic half is covered by two bipolar pairs. What is NOT covered is
automated refusal — nothing refuses a one-item queue — and that is stated here rather than left for
a reader to infer from a Wiring field that names a report as if it were a fence.

## Cross-references

- `agents.md` § Triad — parallelize-by-default (the mandate; MUST-3 names the trigger).
- `agents.md` § Verify Specialist Tool Inventory — the tool-fitness contract and read-only roster
  (MUST-5 is its dispatch-time, structurally-detected form).
- `git.md` § Pre-FIRST-Push CI Parity Discipline — the fixed command list MUST-2 generalises into
  an obligation to ENUMERATE.
- `hook-output-discipline.md` MUST-2 + MUST-5 — the severity cap and the signal-selection contract.
- `instrument-discipline.md` MUST-2 — established red, and the non-reddening-mutation trap above.
- `skills/32-trust-posture/wiring/issue-triage-routing.md` § Origin — the same path-scoped reachability gap.
- `journal/0607` + `wip-discipline.md` MUST-9 — the LANE half of the same model (each lane is a
  mini-orchestrator); MUST-8 is the orchestrator half and CITES rather than restates it.
- `product-completion-first.md` MUST-1 — severity is decoupled from gating ("category gates;
  severity ranks"), which is why MUST-8's boundary is drawn on escalation triggers rather than a
  severity threshold, and why a severity-drawn boundary would have contradicted that MUST.
- `burn-down-reporting.md` MUST-1 — the close-time three measured quantities (cleared / remains /
  delta against a pinned baseline). MUST-9 cites it for the close-time form and adds only the
  during-session form and the throughput question.
- `agents.md` § Triad + `autonomous-execution.md` § 10x Throughput Multiplier — the two named
  answers to MUST-9's "how to move faster"; a slower serial path adopted without one of them is the
  answer the question exists to refuse.
- `governed-throughput.md` MUST-1 — the curated-slice obligation that carries these clauses into a
  shard; `autonomous-execution.md` § "Root-Cause Fix" is the same carry-into-delegation path.
- `wip-discipline.md` MUST-9 — the LANE half (fan-out, partition contract, one committer) and the
  `lane: <branch>` ledger binding MUST-10 cites for DURABILITY; its `laneDepth` SessionStart report
  is the structural half of MUST-10's detection. MUST-2 counts containers, never items, which is why
  a three-item lane is not a ceiling breach.
- `conservation-gate.md` MUST-4 — an empty outcome must be LOUD, because it is byte-identical to a
  successful one. MUST-10(e) is that clause at queue scope: an idle lane and a lane with nothing to
  report are indistinguishable at the orchestrator's end.
- `autonomous-execution.md` § "Root-Cause Fix Is The Default Disposition" — the permission turn is
  already BLOCKED at item scope; MUST-10(c) names the QUEUE-shaped instance ("shall I take the next
  item?"), CITED rather than re-minted.
- `journal/0630` — the MUST-10 receipt (co-owner-directed, 2026-10-01; receipt-first: the entry
  lands BEFORE the artifact edits it authorizes).
