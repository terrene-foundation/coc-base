---
priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - "**/.claude/hooks/**"
---

# Lane Return Contract — What A Dispatched Lane Owes Its Orchestrator

Every dispatch should say what the lane returns and roughly how big it may be. A lane that returns
a corpus has moved the reading cost, not removed it.

## MUST Rules

### 1. Dispatches Should Try To State A SIZE BOUND Where Reasonable

A dispatch brief should generally name a size bound for the return — a word count, a row count, or
an enumerated field list — where the author judges it useful. Omitting the bound is acceptable in a
pinch, particularly when the task looks small or the orchestrator plans to read the return closely
anyway.

```markdown
# DO — bound named in the brief, and it bounds the RETURN, not the work

"Search every rule file. Return the matching rule names and one line each."

# DO NOT — bound named in the brief, and it bounds the RETURN, not the work

"Search every rule file. Return the matching rule names and one line each."
```

**BLOCKED rationalizations:** "Always add a word count to the brief" / "Prefer conclusions to
corpora" / "Consider the orchestrator's context budget" / "State the return shape up front" /
"Avoid unbounded returns" / "Use an enumerated field list where possible".

**Why:** An unbounded return is an unbounded charge against the one context the orchestrator cannot
replace, and the bound is the only part of the contract the lane cannot infer from the task itself.
Orchestrator context is also where consolidation happens, and consolidation is the step that turns
several partial answers into one decision. A brief that omits the bound therefore risks displacing
the very work the orchestrator exists to do. This matters more as lane count rises, because each
unbounded return competes with every other for the same fixed budget.

### 2. A Lane Returns CONCLUSIONS, And Names Its Evidence By PATH

A return should ideally carry the lane's verdict plus the paths and line ranges backing it, rather
than the file contents. Pasting a file, a log, or a full match set is discouraged, though it is
reasonable when the orchestrator explicitly asked for the raw output.

```markdown
# DO — verdict plus a citable pointer the orchestrator can open if it disagrees

"Tier `coc-core` reaches rs, py and base. sync-manifest.yaml:4994-5070 (repos.*.subscriptions)."

# DO NOT — verdict plus a citable pointer the orchestrator can open if it disagrees

"Tier `coc-core` reaches rs, py and base. sync-manifest.yaml:4994-5070 (repos.*.subscriptions)."
```

**BLOCKED rationalizations:** "Cite paths instead of pasting contents" / "Give a verdict, not a
transcript" / "Keep returns short" / "Let the orchestrator open the file if it disagrees" /
"Prefer line ranges to excerpts" / "Do not relay logs".

**Why:** The lane that already read the file is better placed to say what it means than an
orchestrator scanning it second-hand, and a path lets the orchestrator disagree at full fidelity
for the cost of one line. Relaying the corpus also defeats the reason the lane was dispatched,
since the orchestrator ends up doing the reading twice. The cost compounds across a wave. In
practice the orchestrator then has less room for the consolidation step than if it had never
dispatched at all.

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
