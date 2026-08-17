---
priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - "**/.claude/hooks/**"
---

# Lane Return Contract — What A Dispatched Lane Owes Its Orchestrator

Every dispatch MUST state what the lane returns and how big it may be. A lane that returns a corpus
has moved the reading cost, not removed it.

## MUST Rules

### 1. Every Dispatch States An Explicit SIZE BOUND

A dispatch brief MUST name a size bound for the return — a word count, a row count, or an
enumerated field list. A brief that names no bound is BLOCKED. The bound is stated in the brief
itself, never assumed from the task's apparent size.

```markdown
# DO — bound named in the brief, and it bounds the RETURN, not the work

"Search every rule file. Return under 300 words: the matching rule names and one line each."

# DO NOT — unbounded return; the lane's whole reading lands in orchestrator context

"Search every rule file and report what you find."
```

**BLOCKED rationalizations:** "the task is small, so the answer will be small" / "I'd rather have
too much than too little" / "the lane knows what matters" / "a bound might cut off the important
part" / "I'll skim whatever comes back" / "adding a word count to every brief is ceremony".

**Why:** An unbounded return is an unbounded charge against the one context the orchestrator cannot
replace. The bound is the only part of the contract the lane cannot infer from the task.

### 2. A Lane Returns CONCLUSIONS, And Names Its Evidence By PATH

A return MUST carry the lane's verdict plus the paths and line ranges backing it — never the file
contents themselves. Pasting a file, a log, or a full match set into the return is BLOCKED, even
when the orchestrator asked for it.

```markdown
# DO — verdict plus a citable pointer the orchestrator can open if it disagrees

"Tier `coc-core` reaches rs, py and base. sync-manifest.yaml:4994-5070 (repos.*.subscriptions)."

# DO NOT — the corpus, relayed, with the verdict buried in it

"Here is sync-manifest.yaml lines 4994-5300: [280 lines pasted]"
```

**BLOCKED rationalizations:** "the orchestrator asked for the raw output" / "summarizing risks
losing something" / "I'm not confident enough to give a verdict" / "the orchestrator can judge
better than I can" / "it's only a few hundred lines" / "pasting is faster than citing".

**Why:** The lane that already read the file is better placed to say what it means than an
orchestrator scanning it second-hand. A path lets the orchestrator disagree at full fidelity for
the cost of one line.

## MUST NOT

- Return a file's contents when a path and a verdict would answer the question — **Why:** it
  relocates the reading cost to the scarcest context in the session.
- Accept a return that names no evidence and re-dispatch instead of asking for the citation —
  **Why:** a second full dispatch costs more than one clarifying message.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each dispatch
  brief named a size bound and each return cited paths rather than contents); `advisory` at the
  hook layer per `hook-output-discipline.md` MUST-2 — whether a return is a conclusion or a corpus
  is judgment-bearing over its prose, with no structural tool-call-time signal.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (an unbounded dispatch brief; a return
  relaying file contents in place of a verdict) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` trigger per
  `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated per-clause key, since return
  shape is a review-layer judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: lane-return-contract]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects every dispatch brief
  in the session for a named size bound, and every return for path-anchored evidence. Audit
  fixtures at `.claude/audit-fixtures/lane-return-contract/`; no hook detector is claimed.
- **Violation scope:** MUST-1 (no size bound) + MUST-2 (corpus in place of a conclusion) and both
  MUST NOT bullets.
- **Origin:** See § Origin.

## Origin

2026-08-16 — authored alongside `orchestrator-context-economy.md` MUST-4, which names the
orchestrator's side of the same contract. This file states the LANE's side, so a brief and a return
can be checked against one another rather than against the orchestrator's intent alone.
