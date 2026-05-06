# Guide 16: Context Management & Reliability

## Introduction

Context management is the difference between an agentic system that works in demos and one that works in production. Every other architectural decision — tool design, prompt engineering, multi-agent coordination — degrades when context is mismanaged. This guide covers the patterns that keep agentic systems reliable at scale.

By the end of this guide, you will understand:

- The progressive summarization trap and how persistent case facts solve it
- The lost-in-the-middle effect and information placement strategies
- When to escalate to humans (3 valid triggers, 2 traps)
- Error propagation anti-patterns and structured recovery
- Information provenance through multi-agent synthesis pipelines
- Context-specific patterns for Claude Code sessions

---

## Part 1: The Progressive Summarization Trap

### The Problem

As conversations grow, systems compress history to fit the context window. This compression systematically destroys **transactional data** — the specific numbers, IDs, and dates that downstream decisions depend on.

**Before compression**:

```
Customer called about order #8891 placed March 3rd, 2025.
Requesting refund of $247.83 for defective product received.
Customer ID: cust_8891. Shipping address: 123 Main St, Portland OR.
```

**After compression**:

```
Customer wants refund for recent order due to defective product.
```

The dollar amount, order number, date, customer ID, and address all disappear. Any downstream tool call that needs these values will fail or hallucinate.

### The Solution: Persistent Case Facts

Extract transactional data into a **structured block that is NEVER summarized**:

```python
case_facts = {
    "customer_id": "cust_8891",
    "order_id": "#8891",
    "order_date": "2025-03-03",
    "refund_amount": 247.83,
    "currency": "USD",
    "issue": "Defective product received",
    "shipping_address": "123 Main St, Portland OR 97201"
}

system_context = f"""
CASE FACTS (do not summarize or paraphrase — include verbatim in every response):
{json.dumps(case_facts, indent=2)}
"""
```

### Append-Only Fact Updates

Case facts should be **append-only** during a session. Never delete or modify existing facts. If a fact changes (e.g., the customer corrects their order number), add a correction entry rather than overwriting:

```python
case_facts.update_fact(
    field="order_id",
    old_value="#8891",
    new_value="#8892",
    source="customer_correction",
    timestamp="2026-03-27T14:30:00Z"
)
```

This creates an audit trail and prevents silent data loss.

### What to Preserve vs Summarize

| Preserve (Never Summarize)    | Safe to Summarize               |
| ----------------------------- | ------------------------------- |
| IDs (customer, order, ticket) | Exploration steps and reasoning |
| Dollar amounts and quantities | Failed approaches               |
| Dates and timestamps          | General discussion              |
| Names and addresses           | Background context              |
| Decision outcomes             | Alternative considerations      |
| Error codes and messages      | Verbose tool output             |

### How Claude Code Handles This

Claude Code's **PreCompact hook** (`pre-compact.js`) fires before context compression. It preserves critical workspace state — active workspace name, phase, todo progress — so these facts survive compression. The **UserPromptSubmit hook** (`user-prompt-rules-reminder.js`) re-injects key context every turn as an additional defense.

The CO principle at work: **Deterministic Enforcement** (Principle 5). Context preservation can't depend on the model remembering to preserve facts. It must be enforced programmatically.

---

## Part 2: The Lost-in-the-Middle Effect

### The Problem

Models process the **beginning and end** of long inputs reliably but may miss information **buried in the middle**. In a 50-page context window, findings at positions 20-30 receive less reliable attention than findings at positions 1-5 or 45-50.

### Information Placement Strategy

```
┌──────────────────────────────────────────────────────┐
│  BEGINNING — High attention                            │
│  → Critical instructions                               │
│  → Key summaries and decisions                         │
│  → Case facts block                                    │
├──────────────────────────────────────────────────────┤
│  MIDDLE — Lower attention                              │
│  → Detailed evidence and tool results                  │
│  → Historical conversation                             │
│  → Background context                                  │
├──────────────────────────────────────────────────────┤
│  END — High attention                                  │
│  → Current task/question                               │
│  → Most recent findings                                │
│  → Explicit instructions for this turn                 │
└──────────────────────────────────────────────────────┘
```

### Tool Result Trimming

A tool returns 40+ fields for an order lookup. You need 5. The other 35 fields consume context budget and push important information toward the middle where it receives less attention.

**Pattern**: Trim tool results before they enter the context.

```python
def trim_order_result(raw_result):
    """Extract only the fields needed for the current task."""
    return {
        "order_id": raw_result["id"],
        "status": raw_result["status"],
        "total": raw_result["total_amount"],
        "refund_eligible": raw_result["refund_eligible"],
        "days_since_delivery": raw_result["days_since_delivery"]
    }
    # Discards: internal IDs, audit logs, warehouse codes,
    # shipping carrier details, fulfillment metadata...
```

### In Claude Code

The Explore subagent demonstrates this pattern. Instead of dumping all file contents into the main conversation (consuming context budget), the Explore agent processes files in its own context window and returns only a summary. The main conversation gets the findings without the noise.

---

## Part 3: Escalation Triggers

### Three Valid Triggers

| Trigger                   | Example                                 | Action                                              |
| ------------------------- | --------------------------------------- | --------------------------------------------------- |
| **Explicit user request** | "I want to talk to a human"             | Honor immediately. Do NOT attempt resolution first. |
| **Policy gap**            | Request falls outside documented policy | Escalate with structured context                    |
| **Progress failure**      | Multiple attempts with no progress      | Escalate with what was tried                        |

### Two Unreliable Triggers (Traps)

**Trap 1: Sentiment-based escalation**

A frustrated customer using angry language does NOT necessarily need a human. A frustrated customer asking "where is my package?!" needs a tracking number — a simple lookup that the agent can handle. Escalating based on sentiment wastes human time and delays resolution.

**When sentiment DOES matter**: If the customer explicitly says "I want a manager" — that's Trigger 1 (explicit request), not sentiment detection.

**Trap 2: Self-reported confidence scores**

Models are often **incorrectly confident on hard cases** and **incorrectly uncertain on easy ones**. A model might report 95% confidence on a nuanced legal question (wrong) and 60% confidence on a straightforward address lookup (also wrong).

**Why:** Confidence scores reflect the model's certainty about its output token sequence, not the objective correctness of its answer. These are fundamentally different things.

**If you need confidence-based routing**, calibrate empirically: measure actual accuracy at each reported confidence level, then set thresholds based on observed performance — not the model's self-assessment.

---

## Part 4: Error Propagation in Multi-Agent Systems

### Anti-Pattern 1: Silent Suppression

A subagent encounters an error. It returns empty results marked as success. The coordinator continues as if everything worked. No recovery is possible because the coordinator doesn't know anything failed.

```python
# SILENT SUPPRESSION — the worst failure mode
def research_agent(query):
    try:
        results = search(query)
        return {"status": "success", "data": results}
    except Exception:
        return {"status": "success", "data": []}  # Looks like success!
```

**Why it's the worst**: The output appears complete. No error is visible. Downstream agents build on the missing data. The final result is confidently wrong.

### Anti-Pattern 2: Workflow Termination

A single subagent fails. The entire pipeline terminates. Everything other subagents accomplished gets discarded.

```python
# WORKFLOW TERMINATION — throws away good work
try:
    research = research_agent(query)
    analysis = analysis_agent(research)
    synthesis = synthesis_agent(analysis)
except SubagentError:
    return "Pipeline failed"  # 2 of 3 agents succeeded!
```

### Correct Pattern: Structured Error Context

When a subagent fails, it reports structured context that enables the coordinator to make an informed decision:

```python
subagent_error = {
    "status": "partial_failure",
    "failure_type": "transient",  # transient | validation | business | permission
    "what_was_attempted": "Fetch Q3 revenue data from finance API",
    "partial_results": {
        "q1_revenue": 2400000,
        "q2_revenue": 2650000
        # Q3 and Q4 missing due to API timeout
    },
    "missing_data": ["q3_revenue", "q4_revenue"],
    "potential_alternatives": [
        "Retry after 5s (transient failure)",
        "Use cached data from last week",
        "Proceed with Q1-Q2 only and annotate the gap"
    ]
}
```

The coordinator decides: retry, reroute, or proceed with partial results and annotate what's missing.

### In Claude Code

This is how Claude Code handles tool failures. When a Bash command fails, Claude receives the error output and decides whether to:

- Retry with a modified command
- Try an alternative approach
- Inform the user about the failure
- Proceed with partial information

The worst thing Claude Code could do is silently ignore the error and continue as if the command succeeded.

---

## Part 5: Information Provenance

### The Problem

In multi-agent synthesis, attribution dies at the synthesis step. Research Agent A finds "solar capacity grew 40% YoY." Research Agent B finds "wind installations doubled." Synthesis Agent C combines them into a report — but which claim came from which source?

### Claim-Source Mappings

Every finding in a multi-agent pipeline needs structured provenance:

```python
finding = {
    "claim": "Global solar capacity grew 40% year-over-year in 2024",
    "source_url": "https://example.com/iea-report-2025",
    "document_name": "IEA World Energy Outlook 2025",
    "relevant_excerpt": "Solar PV capacity additions reached 420 GW in 2024, a 40% increase...",
    "publication_date": "2025-01-15",
    "agent": "research_agent_solar"
}
```

### Conflict Handling with Temporal Awareness

When two credible sources report different statistics, **don't pick one**. Annotate both:

```python
conflicting_data = {
    "metric": "Global EV market share",
    "source_a": {
        "value": "18%",
        "source": "IEA Global EV Outlook 2024",
        "date": "2024-04",
        "methodology": "New car sales, all markets"
    },
    "source_b": {
        "value": "23%",
        "source": "Bloomberg NEF EV Report 2025",
        "date": "2025-02",
        "methodology": "New car registrations, top 20 markets"
    },
    "resolution": "Not contradictory — different time periods and methodologies"
}
```

A 2024 study and a 2025 study reporting different numbers aren't contradicting each other — they're measuring different moments in time. A study of "all markets" and a study of "top 20 markets" aren't contradicting each other — they're measuring different populations.

**The principle**: Annotate rather than arbitrate. Let downstream consumers evaluate the sources.

---

## Part 6: Context Patterns for Claude Code

### Context Degradation Over Long Sessions

Long sessions accumulate:

- Stale tool results (files changed externally)
- Conflicting instructions (early guidance vs later corrections)
- Verbose exploration noise (failed attempts still in context)

**Signs of degradation**: Claude gives contradictory advice, forgets constraints mentioned earlier, or suggests approaches that were already tried and failed.

### Scratchpad Files for Persistent Notes

For complex investigations, use a scratchpad file to persist findings that survive context compression:

```markdown
## Investigation Scratchpad

### Confirmed Findings

- Database bottleneck at user_query.py:142 (N+1 query, confirmed with EXPLAIN)
- Auth middleware: 200ms per request (Redis session lookup)

### Ruled Out

- NOT a network issue (latency same on localhost)
- NOT a memory issue (heap stable at 400MB)

### Next Steps

- Profile the Redis session lookup
- Check if connection pooling is configured
```

### The /compact Command

Claude Code's `/compact` command compresses the conversation context. Use it when:

- The context window is filling up (Claude mentions it or responses feel degraded)
- You've completed a major subtask and the exploration details are no longer needed
- You're about to start a different kind of work in the same session

**Before compacting**: Save important findings using `/wrapup` or a scratchpad file. Compression will strip detailed tool results.

### Subagent Delegation for Discovery Isolation

When exploring a codebase or researching a topic, the Explore agent runs in its own context window. This means:

1. All the verbose file contents, search results, and dead ends live in the subagent's context — not yours
2. Only the summary comes back to your main context
3. Your main context stays clean for the actual implementation work

**When to use Explore**: Broad codebase exploration, multi-file analysis, deep research. Not needed for targeted lookups (use Grep/Glob directly).

---

## Part 7: Practice Exercises

### Test Your Understanding

1. After conversation compression, an agent can't remember the refund amount ($247.83) and makes up "$200." What pattern prevents this?
   - **Answer**: Persistent case facts block, injected into every prompt, excluded from summarization.

2. A 50-page context window has critical instructions at position 25. The agent ignores them. Why?
   - **Answer**: Lost-in-the-middle effect. Move critical instructions to the beginning or end.

3. An angry customer says "this is ridiculous, where is my package?!" The agent escalates to a human. Was this correct?
   - **Answer**: No. Sentiment-based escalation is unreliable. The customer needs a tracking number (simple lookup), not a human.

4. A research subagent fails with a timeout. The synthesis agent produces a report anyway, with fabricated data for the missing section. What went wrong?
   - **Answer**: Silent suppression. The subagent should have returned structured error context, and the coordinator should have annotated the gap.

5. Two sources report different EV market share: 18% and 23%. The synthesis report picks 23% as "more recent." Is this correct?
   - **Answer**: No. Annotate both with sources, dates, and methodology. Let the reader evaluate. The difference may be methodological, not temporal.

### Build Exercise

1. Design a persistent case facts block for a customer service agent handling returns
2. Implement structured error propagation between two subagents and a coordinator
3. Create a provenance-aware synthesis that handles conflicting sources
4. Write a scratchpad template for a debugging investigation

---

## Quick Reference

| Concept                       | Key Principle                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| **Progressive summarization** | Transactional data gets compressed away. Use persistent case facts.                      |
| **Lost-in-the-middle**        | Place critical info at beginning/end. Trim verbose tool results.                         |
| **Escalation**                | 3 valid: explicit request, policy gap, no progress. 2 traps: sentiment, self-confidence. |
| **Error propagation**         | Never suppress silently. Never terminate everything. Use structured error context.       |
| **Provenance**                | Every claim needs: source URL, document name, excerpt, date.                             |
| **Conflicts**                 | Annotate both sources — don't pick one. Note temporal/methodological differences.        |
| **Long sessions**             | Watch for degradation. Use scratchpad files and /compact.                                |
| **Explore agent**             | Isolates discovery noise from main context.                                              |

---

## Navigation

- **Previous**: [15 - Prompt Engineering](15-prompt-engineering.md)
- **Next**: Return to [README.md](README.md) for the complete guide index
- **Home**: [README.md](README.md)
