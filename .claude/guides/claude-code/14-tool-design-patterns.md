# Guide 14: Tool Design & MCP Integration

## Introduction

Tools are how agents interact with the world. The quality of your tool design directly determines how reliably an agent selects the right tool, interprets results, and recovers from errors. This guide covers architect-level patterns for tool design, error handling, and MCP server integration.

By the end of this guide, you will understand:

- Why tool descriptions are the primary selection mechanism (not human documentation)
- The empirical 4-5 tool limit per agent and strategies for working within it
- How `tool_choice` modes control agent behavior
- Structured error responses that enable intelligent recovery
- MCP server configuration patterns for teams
- Built-in tool selection strategies for codebase exploration

---

## Part 1: Tool Descriptions as Selection Mechanism

### The Core Principle

Tool descriptions are **NOT documentation for humans**. They are the **PRIMARY mechanism the model uses to decide which tool to call**. The model reads every tool description on every turn and selects based on semantic matching between the user's request and available descriptions.

### The Misrouting Problem

Two tools with similar descriptions cause systematic misrouting:

```python
# BAD — nearly identical descriptions cause confusion
tools = [
    {
        "name": "get_customer",
        "description": "Retrieves customer information from the database"
    },
    {
        "name": "lookup_order",
        "description": "Retrieves order information from the database"
    }
]
# Agent routes "check order #12345 status" to get_customer — wrong!
```

**Four attempted fixes** (only one is correct):

| Fix                     | Approach                                  | Why It's Wrong/Right                           |
| ----------------------- | ----------------------------------------- | ---------------------------------------------- |
| Few-shot examples       | Add routing examples to system prompt     | Token overhead, doesn't generalize             |
| Routing classifier      | Pre-classify intent before tool selection | Over-engineered, adds latency                  |
| Tool consolidation      | Merge into one `get_entity` tool          | Wrong problem — tools serve different purposes |
| **Better descriptions** | **Rewrite to differentiate**              | **Correct — 30 minutes vs 3 days**             |

### Good Description Components

A good tool description includes:

1. **What the tool does** (action + data type)
2. **Expected inputs** (with types and constraints)
3. **Example queries it handles** (2-3 representative cases)
4. **Edge cases** (what it returns when data is missing)
5. **Explicit boundaries** (what it does NOT do, especially vs similar tools)

```python
tools = [
    {
        "name": "get_customer",
        "description": (
            "Retrieves a customer's profile information including name, email, "
            "phone, and account status. Use when the user asks about WHO a "
            "customer is, their contact details, or their account status. "
            "Does NOT return order history — use lookup_order for that. "
            "Input: customer_id (string). Returns null if customer not found."
        )
    },
    {
        "name": "lookup_order",
        "description": (
            "Retrieves order details including items, amounts, shipping status, "
            "and tracking info. Use when the user asks about a specific order, "
            "order status, delivery tracking, or refund eligibility. "
            "Input: order_id (string, format: ORD-XXXXX). "
            "Returns null if order not found — distinct from access failure."
        )
    }
]
```

### System Prompt Conflicts

If your system prompt says "always use get_customer first" but the tool description says "use for customer profiles only," the model receives contradictory signals. **Tool descriptions win in practice** because they're evaluated at selection time, while system prompt instructions compete with the full conversation context.

**Rule**: Don't put tool routing logic in the system prompt. Put it in tool descriptions.

---

## Part 2: The 4-5 Tool Limit

### The Empirical Degradation Curve

| Tool Count | Selection Accuracy | Notes                                                                |
| ---------- | ------------------ | -------------------------------------------------------------------- |
| 1-5        | ~95-99%            | Optimal range. Descriptions can be moderate quality.                 |
| 6-10       | ~90-95%            | Still good. Clear descriptions with disambiguation required.         |
| 11-15      | ~80-90%            | Noticeable degradation. Negative routing becomes essential.          |
| 16-18      | ~70-80%            | Marginal. Some misrouting expected even with excellent descriptions. |
| 19+        | <70%               | Unreliable. Model confuses semantically similar tools regularly.     |

The inflection point is around 15-18 tools. Beyond this, even perfect descriptions cannot overcome the combinatorial disambiguation challenge.

### The Optimal Range

**4-5 tools per agent** is the sweet spot. This gives enough capability for specialized work while maintaining high selection accuracy.

### Strategies for Working Within the Limit

**Strategy 1: Scope agents narrowly**

```
# Instead of: one agent with 18 tools
research_agent    → [web_search, read_doc, fetch_url, summarize]     # 4 tools
analysis_agent    → [query_db, run_stats, generate_chart, export]    # 4 tools
action_agent      → [send_email, create_ticket, update_record, notify] # 4 tools
```

**Strategy 2: High-frequency simple operations get scoped tools**

If 85% of fact verifications are simple database lookups, give the synthesis agent a scoped `verify_fact` tool directly — don't route through the coordinator. Reserve the coordinator for the complex 15%.

```
# 85% simple lookups → direct tool on synthesis agent
synthesis_agent.tools = [synthesize, verify_fact, format_output]

# 15% complex queries → routed through coordinator to analysis_agent
coordinator routes complex queries to analysis_agent
```

This eliminates 2-3 round trips per task for the common case.

### How This Applies to Claude Code

Claude Code's built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent) are already within the optimal range for general work. When Claude delegates to a subagent, that subagent receives a scoped subset of tools matching its specialization.

---

## Part 3: tool_choice Modes

### Three Modes

```python
# AUTO (default): model decides whether to use a tool
response = client.messages.create(
    tool_choice={"type": "auto"},  # May return text OR tool call
    ...
)

# ANY: force a tool call — model picks which one
response = client.messages.create(
    tool_choice={"type": "any"},  # MUST call a tool. Guaranteed structured output.
    ...
)

# FORCED: must call this specific tool
response = client.messages.create(
    tool_choice={"type": "tool", "name": "extract_metadata"},
    ...
)
```

### When to Use Each

| Mode              | Use Case                                 | Example                                     |
| ----------------- | ---------------------------------------- | ------------------------------------------- |
| **auto**          | Most agentic work — let the model decide | General assistants, multi-step tasks        |
| **any**           | Need guaranteed structured output        | Data extraction, form filling               |
| **tool (forced)** | Single-purpose extraction step           | "Always extract metadata using this schema" |

### The auto Trap

With `auto`, the model might return text instead of calling a tool. This is usually correct behavior — the model determined it could answer directly. But if you always need structured output, use `any` or `tool` to guarantee it.

---

## Part 4: Structured Error Responses

### Four Error Categories

Not all errors are the same. Each requires a different handling strategy:

| Category       | Example                                  | Retryable? | Agent Action          |
| -------------- | ---------------------------------------- | ---------- | --------------------- |
| **Transient**  | Timeout, service unavailable, rate limit | Yes        | Wait and retry        |
| **Validation** | Bad input format, missing required field | After fix  | Fix input, then retry |
| **Business**   | Refund exceeds policy, account frozen    | No         | Alternative workflow  |
| **Permission** | Access denied, insufficient role         | No         | Escalate to human     |

### Access Failure vs Valid Empty Result

**This distinction is critical.** A tool returns an empty array — is that:

- An unreachable database (transient error)?
- A customer that doesn't exist (valid empty result)?

Treating both identically causes the agent to retry 3 times on a non-existent customer, then escalate to a human for a simple "not found" case.

### Structured Error Metadata

```python
# Good: structured error with metadata
{
    "status": "error",
    "errorCategory": "transient",
    "isRetryable": True,
    "message": "Database connection timeout after 5s",
    "suggestedAction": "retry_after_delay",
    "retryAfterMs": 2000
}

# Good: valid empty result (NOT an error)
{
    "status": "success",
    "data": [],
    "message": "No matching customers found for query 'john.doe@example.com'"
}

# Bad: ambiguous empty result
[]  # Is this an error or valid empty? Agent can't tell.
```

### Multi-Agent Error Propagation

When a subagent fails, it must report structured context — not just "error":

```python
subagent_error = {
    "status": "partial_failure",
    "failure_type": "transient",
    "what_was_attempted": "Fetch order details for ORD-8891",
    "partial_results": {"customer_id": "cust_8891", "order_date": "2025-03-03"},
    "missing_data": ["line_items", "shipping_status"],
    "potential_alternatives": ["Retry after 5s", "Use cached order data from 2h ago"]
}
```

The coordinator can then decide: retry, reroute, or proceed with partial results and annotate the gaps.

---

## Part 5: MCP Configuration

### Two Configuration Levels

```json
// .mcp.json — Project-level (version-controlled, shared with team)
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

```json
// ~/.claude.json — User-level (personal, not shared)
{
  "mcpServers": {
    "personal-notes": {
      "command": "node",
      "args": ["/home/me/mcp-notes/server.js"]
    }
  }
}
```

### The New-Team-Member Trap

Developer A has perfect tool access (configured in `~/.claude.json`). Developer B joins, clones the repo, and gets no MCP tools. Same repo, same code — different experience.

**Root cause**: Config lives on A's machine only.
**Fix**: Move to `.mcp.json` (project-level, version-controlled). Takes 30 seconds. Finding the root cause takes much longer.

### Build vs Use Decision

| Situation                                  | Decision                                      |
| ------------------------------------------ | --------------------------------------------- |
| Standard integration (GitHub, Jira, Slack) | Use community MCP server                      |
| Custom internal API                        | Build custom MCP server                       |
| Standard integration + custom workflow     | Start with community server, extend if needed |

**Rule of thumb**: Don't build what the community already maintains.

---

## Part 6: Built-in Tool Patterns

### Grep vs Glob

| Tool     | Searches          | Use For                                                    |
| -------- | ----------------- | ---------------------------------------------------------- |
| **Grep** | File **contents** | Finding function callers, error messages, import usages    |
| **Glob** | File **paths**    | Finding `**/*.test.tsx`, config files, specific file types |

```
# Find who calls the process_refund function
Grep: pattern="process_refund" → shows files and lines

# Find all test files
Glob: pattern="**/*.test.tsx" → shows file paths
```

### Codebase Exploration Strategy

**Wrong**: Read all files upfront. Kills the context budget before actual work begins.

**Right**: Progressive narrowing.

```
1. Grep for entry point keywords → find relevant files
2. Read the most relevant file → understand the structure
3. Grep for imports/dependencies → trace the call graph
4. Read only the connected files → build targeted understanding
```

**The Explore subagent**: For broad codebase exploration, use the Explore agent type. It isolates verbose discovery output from your main conversation context, preventing discovery noise from consuming the token budget needed for actual work.

---

## Part 7: Practice Exercises

### Test Your Understanding

1. Two tools have the description "Retrieves entity information." Agent misroutes 40% of calls. What's the fix?
   - **Answer**: Rewrite descriptions with explicit differentiation — what each handles, boundaries against the other.

2. An agent has 18 tools and selection accuracy dropped to 70%. How do you fix this?
   - **Answer**: Split into 3-4 specialized subagents with 4-5 tools each.

3. A tool returns `[]`. The agent retries 3 times, then escalates. The customer simply doesn't exist. What went wrong?
   - **Answer**: No distinction between access failure and valid empty result. Add structured error metadata with `errorCategory`.

4. Team member B has no MCP tools despite cloning the repo. Team member A's setup works fine. Root cause?
   - **Answer**: MCP config is in A's `~/.claude.json` (user-level) instead of `.mcp.json` (project-level).

5. You need the model to always return structured JSON. Which `tool_choice` mode?
   - **Answer**: `{"type": "any"}` forces a tool call. Or `{"type": "tool", "name": "extract"}` for a specific schema.

### Build Exercise

Design 3 MCP tools where two have ambiguous overlap:

1. Write initial (bad) descriptions that cause misrouting
2. Rewrite with proper differentiation
3. Write structured error responses for all four categories (transient, validation, business, permission)
4. Create a `.mcp.json` configuration with environment variable expansion

---

## Quick Reference

| Concept               | Key Principle                                                                 |
| --------------------- | ----------------------------------------------------------------------------- |
| **Tool descriptions** | Written for the model, not humans. Include what, inputs, examples, boundaries |
| **Tool limit**        | 4-5 per agent. Split larger sets into specialized subagents                   |
| **tool_choice**       | auto (default), any (force tool call), tool (force specific)                  |
| **Error categories**  | Transient, validation, business, permission — each needs different handling   |
| **Empty results**     | Distinguish access failure from valid empty — use structured metadata         |
| **MCP config**        | Project-level (.mcp.json) for team, user-level (~/.claude.json) for personal  |
| **Grep vs Glob**      | Grep = contents, Glob = paths                                                 |
| **Exploration**       | Progressive narrowing, not read-everything-first                              |

---

## Navigation

- **Previous**: [13 - Agentic Architecture](13-agentic-architecture.md)
- **Next**: [15 - Prompt Engineering](15-prompt-engineering.md)
- **Home**: [README.md](README.md)
