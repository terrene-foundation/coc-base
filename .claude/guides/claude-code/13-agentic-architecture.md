# Guide 13: Agentic Architecture & Orchestration

## Introduction

This guide covers **architect-level patterns** for building and understanding agentic systems. Whether you're working with Claude Code's built-in agent system, designing multi-agent workflows with Kaizen, or building on the Claude API directly, these patterns determine whether your system works reliably at scale.

By the end of this guide, you will understand:

- The complete agentic loop lifecycle and how to implement it correctly
- Three critical anti-patterns that cause premature termination or wasted iterations
- Hub-and-spoke multi-agent orchestration and why memory isolation matters
- Task decomposition strategies and the attention dilution problem
- Session management: when to resume, fork, or start fresh

---

## Part 1: The Agentic Loop

### Core Lifecycle

Every agentic system follows the same fundamental loop: send a message, check if the model wants to use a tool, execute the tool, append results, and repeat until the model signals completion.

```python
import anthropic

client = anthropic.Anthropic()
messages = [{"role": "user", "content": "Your task here"}]

while True:
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        tools=tools,
        messages=messages
    )

    # CORRECT: check stop_reason, not content type
    if response.stop_reason == "end_turn":
        break

    if response.stop_reason == "tool_use":
        tool_results = execute_tools(response.content)
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})
```

### Critical Implementation Detail: tool_use_id Matching

When appending tool results, the `tool_use_id` in the tool result **MUST match** the `id` from the corresponding `tool_use` block. This is how the API correlates which result belongs to which call. Get this wrong and the API returns a 400 error.

```python
for block in response.content:
    if block.type == "tool_use":
        result = execute_tool(block.name, block.input)
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": block.id,    # MUST match the tool_use block id
            "content": result
        })
```

### The stop_reason Contract

The `stop_reason` field is the **only reliable signal** for loop control:

| stop_reason       | Meaning                                 | Action                                  |
| ----------------- | --------------------------------------- | --------------------------------------- |
| `"end_turn"`      | Model is done — no more tools needed    | Break the loop                          |
| `"tool_use"`      | Model wants to call one or more tools   | Execute tools, append results, continue |
| `"max_tokens"`    | Response hit token limit mid-generation | Handle truncation (extend or summarize) |
| `"stop_sequence"` | Custom stop sequence matched            | Handle per your design                  |

### How This Maps to Claude Code

Claude Code itself implements this pattern. When you give it a task:

1. Claude analyzes the request and decides what tools to use (Read, Write, Bash, Agent, etc.)
2. Each tool execution is a turn in the agentic loop
3. Claude examines tool results and decides the next action
4. The loop continues until Claude determines the task is complete (`end_turn`)

When Claude spawns a subagent, that subagent runs its own independent agentic loop.

---

## Part 2: Three Critical Anti-Patterns

### Anti-Pattern 1: Natural Language Termination

**The mistake**: Parsing the model's text output for phrases like "I'm done," "Task complete," or "Here's your answer" to decide when to stop.

**Why it fails**: The model may say "I'm done with the analysis" while still intending to call a synthesis tool. Natural language is ambiguous — "complete" might describe a subtask, not the whole task.

**The fix**: Use `stop_reason == "end_turn"` exclusively. The model signals completion through the API protocol, not through prose.

### Anti-Pattern 2: Arbitrary Iteration Caps

**The mistake**: Setting `max_iterations = 10` or similar hard caps on the loop.

**Why it fails in both directions**:

- **Too low**: Complex tasks get cut short. A 12-step debugging session terminates at step 10 with partial results that look complete but aren't.
- **Too high**: Wastes compute on tasks that finished at iteration 3 but the loop keeps checking.

**The fix**: Trust `stop_reason`. If you need a safety valve (and you should), make it generous (e.g., 200 iterations) with a clear error message when hit — not a silent truncation.

### Anti-Pattern 3: Text-Content-as-Completion

**The mistake**: Checking `if response.content[0].type == "text": break` — assuming that if the model returns text, it's done.

**Why it fails**: Claude returns text AND tool_use blocks in the same response. A response might contain:

1. A text block explaining what it's about to do
2. A tool_use block requesting a tool call

Breaking on text content prevents the tool from ever executing.

```python
# WRONG — kills agent mid-task
if response.content[0].type == "text":
    break  # Claude returns text AND tool_use in the same response!

# CORRECT — model signals completion explicitly
if response.stop_reason == "end_turn":
    break
```

### The Principle

**Model-driven decision-making always outperforms pre-configured decision trees.** The model knows when it's done. Your loop control should defer to that signal, not impose external heuristics.

---

## Part 3: Multi-Agent Orchestration

### Hub-and-Spoke Topology

The dominant pattern for multi-agent systems is **hub-and-spoke**: one coordinator agent at the center, specialized subagents around the perimeter.

```
                    ┌─────────────┐
                    │   Research   │
                    │   Subagent   │
                    └──────┬──────┘
                           │
┌─────────────┐    ┌──────┴──────┐    ┌─────────────┐
│  Analysis   │────│ Coordinator │────│  Synthesis   │
│  Subagent   │    │   (Hub)     │    │  Subagent    │
└─────────────┘    └──────┬──────┘    └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  Validation  │
                    │  Subagent    │
                    └─────────────┘
```

**Coordinator responsibilities**:

1. **Task decomposition** — Break the user's request into subtasks
2. **Subagent selection** — Choose which specialist handles each subtask
3. **Context passing** — Provide each subagent with the information it needs
4. **Result aggregation** — Combine subagent outputs into a coherent response

**How Claude Code implements this**: When you ask Claude Code to "analyze requirements, then implement," it acts as the coordinator — delegating to `analyst`, then `analyst`, then `pattern-expert`, passing context between each.

### Critical Memory Isolation Principle

**Subagents do NOT share memory with the coordinator or each other.**

This is the most commonly misunderstood aspect of multi-agent systems. Each subagent:

- Starts with a fresh context window
- Does not see the coordinator's conversation history
- Does not see other subagents' inputs or outputs
- Receives only what the coordinator explicitly passes to it
- Returns only its output — the coordinator decides what to forward

**Why this matters**: If you assume subagents share context, you'll pass insufficient information and get incomplete results. The coordinator must be explicit about what each subagent needs.

### Context Passing with Structured Metadata

When passing context to a subagent, use structured metadata to preserve attribution:

```python
subagent_context = {
    "task": "Analyze renewable energy adoption trends",
    "sources": [
        {
            "url": "https://example.com/report-2025",
            "document_name": "IEA World Energy Outlook 2025",
            "relevant_pages": [12, 15, 23],
            "key_finding": "Solar capacity grew 40% YoY"
        }
    ],
    "constraints": {
        "focus_areas": ["solar", "wind", "battery storage", "hydrogen"],
        "time_range": "2020-2025",
        "geographic_scope": "global"
    }
}
```

**Without structured metadata**, the subagent receives a summary that strips away source URLs, page numbers, and specific data points. When the synthesis agent later tries to cite findings, attribution is lost.

### Decomposition Failures

The most insidious multi-agent failure occurs in the coordinator's task decomposition — not in any subagent's execution.

**Example**: A coordinator decomposes "research report on renewable energy" into:

1. Research solar energy → Subagent A
2. Research wind energy → Subagent B
3. Synthesize findings → Subagent C

**The bug**: The coordinator's decomposition missed hydrogen, geothermal, and battery storage. Each subagent executes perfectly. The synthesis looks complete. But the report covers only 2 of 5 major areas.

**Root cause tracing**: When output is incomplete, trace backward through the coordinator's decomposition before debugging individual subagents. The problem is usually in the plan, not the execution.

---

## Part 4: Task Decomposition Patterns

### Fixed Sequential Pipelines

Use when the steps are **known upfront** and the problem has a predictable shape.

```
Input → Extract → Transform → Validate → Output
```

**When to use**: File processing, data pipelines, form validation — tasks where every document goes through the same stages.

**In Claude Code**: `/analyze` → `/todos` → `/implement` → `/redteam` → `/codify` is a fixed sequential pipeline. Each phase has known outputs that feed the next.

### Dynamic Adaptive Decomposition

Use when the **problem shape is unknown** and steps must be discovered during execution.

```
Input → Explore → [Discover subproblems] → Solve each → Integrate
```

**When to use**: Bug investigation, open-ended research, exploratory analysis — tasks where you don't know what you'll find.

**In Claude Code**: When you say "debug why this is slow," Claude can't predefine the steps. It explores, discovers bottlenecks, and adapts its approach based on findings.

### Decision Framework

| Factor                    | Fixed Pipeline              | Dynamic Decomposition   |
| ------------------------- | --------------------------- | ----------------------- |
| Steps known upfront?      | Yes                         | No                      |
| Each item independent?    | Usually                     | Often interdependent    |
| Predictable output shape? | Yes                         | No                      |
| Example                   | "Process these 50 invoices" | "Why did revenue drop?" |

### The Attention Dilution Problem

When processing **14+ items in a single pass**, analysis depth becomes inconsistent. Some items get detailed feedback while others with identical issues get minimal attention.

**Why it happens**: The model's attention distributes across all items. With many items, later items receive progressively less analytical depth — not because the model can't analyze them, but because the context budget for each shrinks.

### Multi-Pass Solution

Split large analyses into two phases:

**Pass 1: Per-item analysis** — Process each item individually for consistent depth.

**Pass 2: Cross-item integration** — Synthesize individual analyses into patterns, trends, and recommendations.

```
# Instead of: analyze_all(14_files)

# Do:
per_file_results = []
for file in files:
    result = analyze_one(file)  # Consistent depth
    per_file_results.append(result)

synthesis = cross_file_analysis(per_file_results)  # Integration pass
```

**In Claude Code**: This is why the Explore agent is valuable — it isolates per-file analysis from the main context, ensuring consistent depth, then returns a summary for integration.

---

## Part 5: Session Management

### Three Approaches

| Approach            | When to Use                                                | Mechanism                                  |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| **Resume**          | Prior context still valid, continuing same task            | `--resume` flag or session continuation    |
| **Fork**            | Need to explore a different direction from shared baseline | `fork_session` or parallel worktrees       |
| **Fresh + Summary** | Tool results stale, context degraded, or switching focus   | New session with findings summary injected |

### Resume: Continuing Named Sessions

Use `--resume` when:

- You're picking up where you left off
- No external changes invalidated the context
- The task is the same as before

**The stale context trap**: If you resume a session after modifying files externally (in another terminal, IDE, or session), the agent may give contradictory advice based on cached tool results that no longer reflect reality.

**Fix**: Either inform the agent explicitly about what changed ("I modified files X, Y, Z since last session") or start fresh with a summary.

### Fork: Divergent Exploration

Use fork when:

- You want to explore an alternative approach without losing the current one
- Multiple independent investigations should proceed in parallel
- You need to compare outcomes of different strategies

**In Claude Code**: Parallel worktrees (`docs/04-codegen-instructions/01-backend-worktree.md`, `02-web-worktree.md`) are a form of forking — each Claude session works independently on its own branch.

### Fresh Start with Summary Injection

Use fresh + summary when:

- Tool results are stale (files changed externally)
- Context has degraded (long session with accumulated noise)
- You're switching to a different phase of work

**Pattern**: Extract key findings from the prior session into a structured summary, then inject it at the start of a new session:

```markdown
## Context from Prior Session

### Key Findings

- Database bottleneck identified in user_query.py:142 (N+1 query)
- Auth middleware adds 200ms per request (Redis session lookup)
- Frontend bundle size: 2.4MB (target: 500KB)

### Decisions Made

- Chose DataFlow over raw SQL for the refactor
- Will use Nexus for API deployment

### Open Questions

- Should we cache session data in-memory or keep Redis?
```

**In Claude Code**: The `/wrapup` command generates `.session-notes` — a structured summary for exactly this purpose. The next session's startup hook reads and displays these notes automatically.

---

## Part 6: Workflow Enforcement — Hooks vs Prompts

### The Decision Framework

| Enforcement Type         | Mechanism                         | Reliability            | Use When                                 |
| ------------------------ | --------------------------------- | ---------------------- | ---------------------------------------- |
| **Prompt-based**         | Instructions in system prompt     | Works ~95% of the time | Formatting preferences, style guidelines |
| **Programmatic (hooks)** | Code that runs before/after tools | Works 100% of the time | Financial, security, compliance          |

**The decision rule**: If a single failure costs money, creates a security incident, or violates compliance — use programmatic enforcement. Everything else can be prompt-based.

### Structured Handoff for Human Escalation

When an agent escalates to a human, the human does NOT have access to the conversation transcript. The handoff must be self-contained:

```python
handoff = {
    "customer_id": "cust_8891",
    "conversation_summary": "Customer reported defective product, requested refund of $247.83",
    "root_cause": "Product quality issue — not a shipping or billing error",
    "recommended_action": "Process refund per standard policy (< $500 auto-approve)",
    "urgency": "normal",
    "relevant_order": "#ORD-8891"
}
```

**In Claude Code**: The `/wrapup` command creates a similar handoff — a self-contained summary that the next session (human or AI) can act on without the original conversation context.

---

## Part 7: Practice Exercises

### Test Your Understanding

1. A loop uses `if "done" in response.text.lower(): break`. What's wrong?
   - **Answer**: Natural language termination. Use `stop_reason == "end_turn"` instead.

2. A coordinator spawns 3 subagents. Subagent B needs information from Subagent A's output. How should this be handled?
   - **Answer**: The coordinator must receive A's output first, then explicitly pass relevant findings to B. Subagents don't share memory.

3. A research agent analyzes 20 documents in one pass. The first 5 get detailed analysis, the last 5 get one-line summaries. Why?
   - **Answer**: Attention dilution. Use multi-pass: analyze each document individually, then synthesize.

4. After modifying 3 files in VS Code, you resume a Claude Code session. Claude suggests changes that conflict with your edits. What happened?
   - **Answer**: Stale context. The session cached the old file contents. Start fresh with summary injection, or explicitly tell Claude what changed.

5. A refund processing agent has a prompt instruction: "Never process refunds over $500." It processes a $600 refund. How do you fix this?
   - **Answer**: Prompt instructions are probabilistic. Use a PreToolUse hook that programmatically blocks the tool call when amount > $500.

### Build Exercise

Design a coordinator with:

- Two subagents (research + synthesis)
- Structured context passing with source attribution
- A programmatic prerequisite gate (must have 3+ sources before synthesis)
- A PostToolUse hook that logs all file modifications

Sketch the architecture and identify: where does each piece of information live? What happens when the research subagent finds only 2 sources?

---

## Quick Reference

| Concept                | Key Principle                                             |
| ---------------------- | --------------------------------------------------------- |
| **Loop control**       | Use `stop_reason`, never parse text or cap iterations     |
| **Multi-agent memory** | Subagents are isolated — pass context explicitly          |
| **Task decomposition** | Trace failures to the coordinator's plan first            |
| **Attention dilution** | >14 items → multi-pass (per-item then cross-item)         |
| **Session management** | Resume (same task), fork (diverge), fresh (stale context) |
| **Enforcement**        | Money/security/compliance → hooks; style → prompts        |

---

## Navigation

- **Previous**: [12 - Troubleshooting](12-troubleshooting.md)
- **Next**: [14 - Tool Design Patterns](14-tool-design-patterns.md)
- **Home**: [README.md](README.md)
