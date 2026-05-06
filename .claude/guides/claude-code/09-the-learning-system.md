# Guide 09: The Learning System

## Introduction

The learning system enables **continuous improvement** of this setup. It captures observations from your sessions, aggregates them into a structured digest, and uses `/codify` to analyze patterns with LLM reasoning and produce real artifacts (skills, rules).

By the end of this guide, you will understand:

- How observations are captured
- How the digest builder aggregates them
- How `/codify` turns patterns into real artifacts
- The commands for interacting with learning
- The learning directory structure

---

## Part 1: The Learning Loop

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     LEARNING LOOP                            │
│                                                              │
│   ┌──────────────┐                                          │
│   │  OBSERVATIONS │ ◄───── During sessions                  │
│   │  Corrections  │        Hooks capture events              │
│   │  Violations   │        /learn for manual input           │
│   │  Decisions    │                                          │
│   └───────┬──────┘                                          │
│           │                                                  │
│           ▼                                                  │
│   ┌──────────────┐                                          │
│   │    DIGEST     │ ◄───── digest-builder.js                │
│   │  Structured   │        Aggregates observations          │
│   │  summary      │        Frequency analysis               │
│   └───────┬──────┘                                          │
│           │                                                  │
│           ▼                                                  │
│   ┌──────────────┐                                          │
│   │  CODIFICATION │ ◄───── /codify command                  │
│   │  Skills       │        LLM semantic analysis            │
│   │  Rules        │        Produces real artifacts           │
│   │  Agents       │                                          │
│   └──────────────┘                                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### What Gets Learned

| Category                    | Examples                                         |
| --------------------------- | ------------------------------------------------ |
| **User Corrections**        | When the user corrects Claude's approach         |
| **Rule Violations**         | Patterns that triggered rule enforcement         |
| **Session Accomplishments** | What was achieved in each session                |
| **Decision References**     | Framework/approach decisions and their rationale |
| **Workflow Patterns**       | Common workflow structures, node combinations    |
| **Error Fixes**             | Errors encountered and their solutions           |

---

## Part 2: Observations

### What Are Observations?

Observations are **raw data points** captured during sessions:

```json
{
  "id": "obs_1706720400000_abc123def",
  "timestamp": "2024-01-31T12:00:00.000Z",
  "type": "user_correction",
  "data": {
    "what_happened": "Used raw SQL instead of DataFlow",
    "correction": "Always use DataFlow for database operations",
    "context": "User pointed out the pattern violation"
  },
  "context": {
    "session_id": "session_xyz",
    "cwd": "/project/path"
  }
}
```

### Observation Types

| Type                     | What It Captures                    |
| ------------------------ | ----------------------------------- |
| `user_correction`        | When the user corrects Claude       |
| `rule_violation`         | Patterns that triggered rule checks |
| `session_accomplishment` | Key outcomes from a session         |
| `decision_reference`     | Framework/approach decisions made   |
| `workflow_pattern`       | Workflow structures used            |
| `error_occurrence`       | Errors encountered                  |
| `error_fix`              | How errors were resolved            |

### Observation Storage

Observations are stored **per-project** in `<project>/.claude/learning/`:

```
<project>/.claude/learning/
├── observations.jsonl          # Current observations (JSONL format)
├── observations.archive/       # Archived when > 1000 observations
│   ├── observations_1706720400000.jsonl
│   └── observations_1706806800000.jsonl
├── learning-digest.json        # Aggregated summary (built by digest-builder.js)
└── learning-codified.json      # Tracks what /codify has processed
```

**Per-project isolation** means different projects learn different patterns.

### Manual Observation Logging

Use the `/learn` command to log observations manually:

```
> /learn
> DataFlow bulk operations work better with batch sizes of 100
```

This creates an observation that contributes to the learning digest.

---

## Part 3: The Learning Digest

### What Is the Learning Digest?

The learning digest (`learning-digest.json`) is a **structured summary** produced by `digest-builder.js`. It aggregates raw observations into categories with frequency data:

```json
{
  "generated": "2024-01-31T12:00:00.000Z",
  "observation_count": 150,
  "categories": {
    "user_corrections": [
      {
        "pattern": "Use DataFlow instead of raw SQL",
        "frequency": 5,
        "last_seen": "2024-01-31T11:55:00.000Z"
      }
    ],
    "workflow_patterns": [
      {
        "pattern": "workflow_builder",
        "frequency": 11,
        "last_seen": "2024-01-31T11:50:00.000Z"
      }
    ]
  }
}
```

### How the Digest Is Built

The `digest-builder.js` script:

1. Reads all observations from `observations.jsonl`
2. Groups by type and identifies recurring patterns
3. Computes frequency and recency for each pattern
4. Writes the structured summary to `learning-digest.json`

### Running the Digest Builder

The digest builder runs automatically via session hooks. You can also run it manually:

```bash
node scripts/learning/digest-builder.js
```

---

## Part 4: Codification

### What Is Codification?

Codification is the process of turning **learning digest patterns** into real, permanent artifacts. Unlike the old system which used statistical thresholds, codification uses **LLM semantic analysis** via the `/codify` command.

```
┌──────────────────────────────────────────────────────────────┐
│                     CODIFICATION                              │
│                                                               │
│   Learning digest pattern:                                    │
│   "Always use batch size 100 for DataFlow bulk" (freq: 11)   │
│                                                               │
│                        ▼                                      │
│                                                               │
│   /codify analyzes with LLM reasoning:                       │
│   - Is this pattern worth codifying?                         │
│   - Does it belong in a skill, rule, or agent?               │
│   - Does it duplicate existing content?                      │
│                                                               │
│                        ▼                                      │
│                                                               │
│   Produces real artifact:                                     │
│   └── Update to skills/02-dataflow/SKILL.md                  │
│       └── New section: Bulk operation best practices          │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### How /codify Works with Learning

When you run `/codify`, it:

1. Reads `learning-digest.json` for accumulated patterns
2. Analyzes each pattern with LLM reasoning (not statistical thresholds)
3. Decides whether to create or update skills, rules, or agents
4. Writes the actual artifact files
5. Updates `learning-codified.json` to track what was processed

### What Gets Codified

| Pattern Type              | Typical Artifact                         |
| ------------------------- | ---------------------------------------- |
| Recurring user correction | New rule or updated existing rule        |
| Workflow pattern          | Updated skill with best practice section |
| Error fix pattern         | Entry in troubleshooting skill           |
| Decision pattern          | Updated architecture decision skill      |

---

## Part 5: Learning Commands

### `/learn` - Log Observations

Record a pattern or insight manually:

```
> /learn
> The MCP transport for local development should use stdio
```

Creates an observation that feeds into the learning digest.

### `/codify` - Process Learning into Artifacts

Processes the learning digest and creates real artifacts:

```
> /codify
```

This analyzes accumulated patterns and produces skills, rules, or agent updates.

### Viewing Learning Stats

```
> /learn
```

Shows current observation count, digest status, and recent patterns.

---

## Part 6: Learning Scripts

### observation-logger.js

**Purpose**: Capture and store observations

**Usage**:

```bash
# Log an observation
echo '{"type": "user_correction", "data": {...}}' | node scripts/learning/observation-logger.js
```

### digest-builder.js

**Purpose**: Aggregate observations into a structured summary

**Usage**:

```bash
# Build the learning digest from observations
node scripts/learning/digest-builder.js
```

---

## Part 7: The Learning Directory

### Structure

Learning data is stored **per-project** (not globally):

```
<project>/.claude/learning/
│
├── observations.jsonl          # Active observations (JSONL)
│
├── observations.archive/       # Archived observation files
│   └── observations_*.jsonl
│
├── learning-digest.json        # Structured summary
│   {
│     "generated": "2024-01-31T12:00:00.000Z",
│     "observation_count": 150,
│     "categories": { ... }
│   }
│
└── learning-codified.json      # What /codify has processed
    {
      "last_codified": "2024-01-31T12:00:00.000Z",
      "processed_patterns": [ ... ]
    }
```

---

## Part 8: Practical Learning Workflow

### Automated Pipeline

The learning system captures data automatically during your sessions:

1. **Hooks capture observations** - Session hooks log `user_correction`, `rule_violation`, `session_accomplishment`, and `decision_reference` observations as they occur.
2. **Digest builder aggregates** - `digest-builder.js` processes observations into a structured summary in `learning-digest.json`.
3. **`/codify` produces artifacts** - When you run `/codify`, it reads the digest, applies LLM semantic analysis, and creates or updates real skills, rules, and agents.

### Manual Input

The `/learn` command is available for recording insights that hooks would not capture:

- Patterns that took time to discover
- Solutions to tricky problems
- Non-obvious best practices

```
> /learn
> When using Nexus with DataFlow, set auto_discovery=False to prevent blocking
```

### Reviewing What Has Been Learned

Check accumulated observations:

```
> What patterns have been captured about DataFlow?
```

Claude checks the learning directory and reports findings.

---

## Part 9: Learning Best Practices

### Do Log Valuable Insights

```
> /learn
> When using Nexus with DataFlow, set auto_discovery=False to prevent blocking
```

### Do Run /codify Periodically

After accumulating observations across multiple sessions, run `/codify` to turn patterns into permanent artifacts.

### Don't Over-Log

Don't log every trivial observation. Focus on:

- Patterns that took time to discover
- Solutions to tricky problems
- Non-obvious best practices

### Don't Skip Codification

Raw observations only become useful when codified into artifacts that load into future sessions.

---

## Part 10: Key Takeaways

### Summary

1. **Observations capture raw data** - User corrections, rule violations, accomplishments, decisions

2. **Digest builder aggregates patterns** - Frequency analysis into `learning-digest.json`

3. **`/codify` creates artifacts** - LLM analysis turns patterns into real skills and rules

4. **Two commands** - `/learn` (manual observations), `/codify` (process into artifacts)

5. **Two scripts** - `observation-logger.js`, `digest-builder.js`

6. **Learning directory** - `<project>/.claude/learning/` (per-project)

### Quick Reference

| Command   | Purpose                              |
| --------- | ------------------------------------ |
| `/learn`  | Log a manual observation             |
| `/codify` | Process learning into real artifacts |

| Script                  | Purpose                        |
| ----------------------- | ------------------------------ |
| `observation-logger.js` | Capture observations           |
| `digest-builder.js`     | Aggregate into learning digest |

### The Learning Benefit

Over time, the setup becomes:

- **More personalized** - Learns your patterns
- **More efficient** - Common patterns become skills
- **More accurate** - Codified knowledge refines recommendations

---

## What's Next?

Now you understand all the components. The next guide shows how to use them together in daily workflows.

**Next: [10 - Daily Workflows](10-daily-workflows.md)**

---

## Navigation

- **Previous**: [08 - The Rule System](08-the-rule-system.md)
- **Next**: [10 - Daily Workflows](10-daily-workflows.md)
- **Home**: [README.md](README.md)
