# The Deferral Acceptance Queue — what to do when you hit a residual and no human is there

> **Scope — read this first if you are NOT in loom.** The DECISION below
> (STALL / FABRICATE / FOLD / QUEUE, and why FOLD is the one you will reach for)
> is universal: every repo accumulates residuals and `completion-criterion.md`
> MUST-6 binds everywhere. The TOOLING is not. `deferral-request.mjs`,
> `deferral-queue.mjs` and `deferral-accept.mjs` are loom-side and are NOT
> distributed — they operate over `test-harness/phase2-deferrals.json`, a
> registry only loom holds; a consumer holds `.claude/deferrals.json` instead.
> So in a BUILD repo, a USE template or a project repo the commands below will
> not resolve, and the correct move is the one this page is really about:
> **surface the residual to a human as a PENDING DECISION and do not fold it
> into an acceptance somebody gave for something else.** A consumer-scoped queue
> is an OPEN design question routed to the co-owner, not something to improvise.

Companion to `deferral-registry-locality.md` (which registry a deferral belongs
to) and `completion-criterion-evidence.md` (why a residual needs an acceptor at
all). This page answers the operational question those two leave open: **the
ceremony needs a human and you are running asynchronously — now what?**

## The decision, in one table

You are mid-lane. You find something that cannot be enforced this session and
needs a Phase-2 deferral row. `completion-criterion.md` MUST-6 says a residual
"is not self-accepting" and needs a named human distinct from you.

| move                                                              | verdict                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| STALL — block until a human answers                               | wrong: the lane stops on someone who is not there                       |
| FABRICATE — type `accepted_by: repo-owner` yourself               | BLOCKED: `phase2-deferral-integrity.mjs` refuses it (no receipt)         |
| FOLD — widen an existing accepted row to cover the new gap        | **BLOCKED, and the one you will reach for.** See below.                 |
| **QUEUE** — `deferral-request.mjs`, then keep working             | **correct.** Free, honest, durable, and it does not stall the lane.      |

## Why FOLD is the move to watch for in yourself

FOLD is the only one of the first three that both **ships** and **passes a
gate** — so it is what actually happens under delivery pressure. It happened
twice in the session that produced this queue.

It is also the worst of the three, because it leaves no trace. A fabricated
acceptance is a discrete artifact a reviewer can diff. A folded one looks like an
acceptance a human really gave — it just now covers something they never saw.
It dilutes a real decision instead of forging a fake one.

**BLOCKED rationalizations:**

- "This is basically the same gap as the row already there"
- "The owner accepted the class, not the instance"
- "Widening the existing entry is tidier than a second row"
- "I will note the widening in the PR body"
- "I cannot reach anyone, so the existing acceptance has to do"
- "It expires on the same date anyway"

## The flow

```bash
# You, mid-lane. Do NOT declare the row.
node .claude/bin/deferral-request.mjs \
  --key 'some-rule.md#some-clause' --rule '.claude/rules/some-rule.md' \
  --risk trust --proposed-expires 2026-12-01 --requested-by '<your session id>' \
  --reason '<why enforcement cannot land now>' \
  --graduation '<what discharges it>' --text '<the FULL text being deferred>'
```

Then **keep going**. The residual is recorded, dated, greppable, and visible at
every session start until someone answers it.

The human, later, in one pass:

```bash
node .claude/bin/deferral-queue.mjs list
node .claude/bin/deferral-queue.mjs approve --all \
  --accepted-by 'repo-owner' --instruction '<their verbatim words>'
node .claude/bin/deferral-queue.mjs reject --key '<key>' --reason '<why not>'
```

`approve` execs `deferral-accept.mjs` per row rather than reimplementing it, so
that tool's self-acceptance refusal is preserved rather than forked. The
requester is read **off the request file**, never off the command line — so
approving as the party who asked is refused, and cannot be talked around by
retyping the name.

**`approve` does not declare the row.** Accepting and declaring are separate acts
by separate parties. You declare it afterwards, once the receipt exists.

## The rule you must not talk yourself out of

**A queued request is NOT an acceptance.** Declaring a key in
`phase2-deferrals.json` while its request is still pending is a hard gate ERROR,
by name. Four independent fences, all pinned by
`.claude/test-harness/tests/deferral-queue.test.mjs`:

1. the receipt reader opens a different directory and never reads the queue;
2. the marker tokens are not prefix-related, so a request copied into the receipt
   directory still clears nothing (measured: aliasing the token flips the same
   reader to MATCHED, so the refusal is the token doing work, not a reader that
   can only say no);
3. a request carries no `accepted_by` field for anyone to fill in;
4. `checkPendingRequests` REDs a declared-while-pending key.

Fences 1–3 stop a request from **helping**. Fence 4 makes declaring ahead
actively **hurt** — which is what closes FOLD, since folding is "declare now, get
accepted never".

## What the receipt does and does not establish

`accepted_by` is a **constant** across the whole corpus (measured: 117 of 117
rows read `repo-owner`), so it discriminates nothing on its own. The verbatim
`instruction` is the only field on a receipt whose content can differ between a
real acceptance and a typed one — which is why the gate now enforces a floor on
it and why the drain refuses to write one without it.

None of this is cryptographic. An agent that chose to could run the drain and
write false words, the same residual `/cross-repo-authorize` carries. The claim
is **detectability, not unforgeability**. What the queue changes is that the
honest path no longer requires a human to be present at the moment the residual
is found, so there is no longer a delivery reason to take a dishonest one.

## Silence is not an answer, in either direction

A pending request unanswered for more than 30 days is surfaced as its own
finding by the gate and by the SessionStart block. The queue is a mailbox, not a
parking lot — an unanswered request that ages quietly is the same
permanent-by-default shape the deferral registry itself exists to close.

## Where things live

| artifact                                        | what it is                                            |
| ----------------------------------------------- | ----------------------------------------------------- |
| `.claude/deferral-requests/`                    | the queue (append-only; requests + resolutions)       |
| `.claude/deferral-acceptance/`                  | acceptance receipts — the ONLY thing the gate reads   |
| `.claude/bin/deferral-request.mjs`              | agent-facing: queue a request                         |
| `.claude/bin/deferral-queue.mjs`                | human-facing: list / show / approve / reject          |
| `.claude/bin/deferral-accept.mjs`               | writes the receipt; refuses self-acceptance           |
| `.claude/bin/lib/deferral-queue.mjs`            | marker + digest + `listRequests`; asserts fences 1–2  |
| `.claude/test-harness/phase2-deferrals.json`    | the registry a row is declared in — AFTER acceptance  |

Full mechanics, the fence rationale, and the append-only contract live in
`.claude/deferral-requests/README.md` — loom-side like the tools above, so it is
absent from a consumer tree; there, the scope note at the top of this page is the
whole contract.

Origin: 2026-09-02 — the ceremony's synchronicity was named as the root cause
after an agent folded two new residuals into existing grandfathered rows in one
session rather than stalling a lane. The three-move analysis, the fold evidence,
and the measured `accepted_by` constancy are recorded there and in
`.claude/bin/lib/deferral-queue.mjs`.
