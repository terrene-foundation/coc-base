---
name: learn
description: "Learning system status — observations, codified patterns, posture trajectory."
---

# /learn - Learning System Status

## Purpose

View the learning digest and codification history. The learning system captures meaningful signals (user corrections, rule violations, session accomplishments, journal decisions) and feeds them into `/codify` for integration into real artifacts.

## Quick Reference

| Command        | Action                                    |
| -------------- | ----------------------------------------- |
| `/learn`       | Show learning digest summary              |
| `/learn stats` | Show observation statistics and breakdown |

## Usage

### View Learning Digest

Read `.claude/learning/learning-digest.json` and present:

1. **Corrections** — Times the user pushed back or redirected. These are the most valuable signals — each represents a gap in the current artifacts.
2. **Error patterns** — Recurring rule violations (which rules are being violated most?).
3. **Accomplishments** — What was completed in recent sessions.
4. **Decisions** — Journal entries (DECISION, DISCOVERY, TRADE-OFF) that may need codification.
5. **Active frameworks** — Which Kailash frameworks are in use.

### View Codification History

Read `.claude/learning/learning-codified.json` to see what `/codify` has already processed from the digest.

### View Stats

```bash
node scripts/learning/digest-builder.js --stats
```

## How It Works

1. **Hooks capture signals** — User corrections (UserPromptSubmit), rule violations (PostToolUse), session accomplishments (SessionEnd), journal decisions (SessionEnd). Pure file I/O, no LLM.
2. **Digest builder aggregates** — At session end, observations are summarized into `learning-digest.json`. Pure aggregation, no pattern matching or confidence scores.
3. **/codify does the thinking** — When `/codify` runs, it anchors on `learning-codified.json::last_codified` and enumerates the COMPLETE delta since it via `.claude/bin/codify-backlog.mjs` (observations, unaddressed violations, journal entries, artifact-change commits). The digest + journals + session notes are SUPPLEMENTARY semantic context — NOT the work-list (deriving the work-list from the digest/session-notes/memory alone is BLOCKED per `codify.md` Step 1, because they only reflect the last session). The LLM decides what to codify into real rules, skills, or agents. No intermediate staging — changes go directly into canonical artifact locations.

## File Locations

```
<project>/.claude/learning/
  observations.jsonl        # Raw observations (capped at 500, auto-archived)
  observations.archive/     # Archived observations
  learning-digest.json      # Supplementary recency hint for /codify (NOT the work-list)
  learning-codified.json    # last_codified anchor + what /codify has already processed
```

## Observation Types

| Type                     | Source                          | What It Captures                         |
| ------------------------ | ------------------------------- | ---------------------------------------- |
| `user_correction`        | UserPromptSubmit hook           | User pushed back or redirected approach  |
| `rule_violation`         | PostToolUse (validate-workflow) | Specific rule violated in code           |
| `session_accomplishment` | SessionEnd hook                 | What was completed (from .session-notes) |
| `decision_reference`     | SessionEnd hook                 | Journal entries created this session     |
| `workflow_pattern`       | PostToolUse (validate-workflow) | Node types and structure in user code    |
| `framework_selection`    | PostToolUse (validate-workflow) | Which Kailash framework is being used    |

## Related

- `/codify` — Anchors on the last-codification delta (`codify-backlog.mjs`) and codifies findings into artifacts; the digest is a supplementary hint
- `/journal` — Creates DECISION/DISCOVERY entries that feed into learning
- `/wrapup` — Writes session notes that feed into accomplishments
