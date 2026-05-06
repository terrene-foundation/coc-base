---
priority: 10
scope: path-scoped
paths:
  - "journal/**"
  - "**/journal/**"
---

# Journal Rules


<!-- slot:neutral-body -->

## Naming & Format

Sequential naming: `NNNN-TYPE-topic.md`. Check highest existing number before creating.

```yaml
---
type: DECISION | DISCOVERY | TRADE-OFF | RISK | CONNECTION | GAP
date: YYYY-MM-DD
created_at: [ISO-8601]
author: human | agent | co-authored
session_id: [session ID]
session_turn: [turn number]
project: [project name]
topic: [brief description]
phase: analyze | todos | implement | redteam | codify | deploy
tags: [list]
---
```

**Author decision tree**: `human` — user stated conclusion before AI. `agent` — AI surfaced unprompted. `co-authored` — evolved through exchange (default when uncertain).

## Entry Types

| Type           | When                                                     |
| -------------- | -------------------------------------------------------- |
| **DECISION**   | Architectural, design, strategic, or scope choices       |
| **DISCOVERY**  | Research/analysis reveals new understanding              |
| **TRADE-OFF**  | Balancing competing concerns                             |
| **RISK**       | Stress-testing reveals vulnerabilities                   |
| **CONNECTION** | Cross-referencing reveals relationships                  |
| **GAP**        | Missing data, untested assumptions, unresolved questions |

## Requirements

- Every entry MUST include `## For Discussion` with 2-3 probing questions (at least one counterfactual, at least one referencing specific data)

**Why:** Without discussion questions, journal entries become write-only artifacts that capture decisions but never challenge them.

- Entries MUST be self-contained — readable without other context

**Why:** Entries referenced months later by a different agent are useless if they depend on session context that no longer exists.

- DECISION entries SHOULD include alternatives and rationale
- Entries SHOULD include consequences and follow-up actions

## MUST NOT

- Overwrite existing entries — immutable once created. New entry references the original.

**Why:** Overwriting destroys the audit trail of how decisions evolved, making it impossible to understand why a position changed.

- Create entries without frontmatter

**Why:** Entries without frontmatter cannot be filtered by type, phase, or date, making the journal unsearchable at scale.

<!-- /slot:neutral-body -->
