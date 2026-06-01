# Agent Reasoning — Extended Evidence and Examples

Companion reference for `.claude/rules/agent-reasoning.md`.

## The Principle: LLM Reasons, Tools Fetch (Full Diagram)

```
+---------------------------+       +---------------------------+
|         LLM AGENT         |       |          TOOLS            |
|                           |       |                           |
|  - Reasons about intent   |  -->  |  - Fetch data             |
|  - Decides what to do     |  <--  |  - Write data             |
|  - Classifies input       |       |  - Call APIs              |
|  - Routes to next step    |       |  - Execute queries        |
|  - Extracts information   |       |  - Return raw results     |
|  - Evaluates outcomes     |       |                           |
|                           |       |  Tools contain ZERO       |
|  ALL intelligence lives   |       |  decision logic.          |
|  in the LLM.              |       |  They are dumb endpoints. |
+---------------------------+       +---------------------------+
```

## Detection Patterns — Mechanical Anti-Pattern Grep

Codegen and code review MUST flag these anti-patterns in agent code:

```python
# ANTI-PATTERN 1: Keyword routing
if "keyword" in user_input:              # BLOCKED in agent decision paths
if any(w in text for w in [...]):        # BLOCKED in agent decision paths

# ANTI-PATTERN 2: Regex classification
intent = re.match(r"pattern", text)      # BLOCKED in agent decision paths
entities = re.findall(r"pattern", text)  # BLOCKED in agent decision paths

# ANTI-PATTERN 3: Dispatch tables
handlers = {"a": func_a, "b": func_b}    # BLOCKED in agent decision paths
action_map[classified_intent](message)   # BLOCKED in agent decision paths

# ANTI-PATTERN 4: Hardcoded classification
if sentiment_score > 0.8:                # BLOCKED — LLM evaluates sentiment
if len(message.split()) < 5:             # BLOCKED — LLM judges complexity
if message.startswith("!"):              # BLOCKED — LLM interprets commands

# ANTI-PATTERN 5: Tool-side decisions
def tool_handler(data):
    if data["type"] == "urgent":         # BLOCKED — LLM determines urgency
        return escalate(data)
```

## Full LLM-First Flow

1. **LLM Reasons** — agent receives context and thinks about what to do
2. **LLM Decides** — chooses which tool to call, what to respond, how to route
3. **LLM Acts** — calls a tool (dumb data endpoint) or produces output
4. **LLM Evaluates** — examines the result and decides the next step

## Permitted Deterministic Logic — Extended Narrative

The permitted exceptions (structural plumbing, not reasoning) are bounded by the test: **Is the conditional deciding what the agent should _think_ or _do_ based on input content?**

- **Input validation** — `if not message: raise ValueError(...)` (validating presence/type, not content) — fine because it's a precondition for the LLM to do anything at all.
- **Error handling** — `try/except` for tool failures, API errors, timeouts — fine because it's recovery from plumbing failures, not from content.
- **Output formatting** — Transforming LLM output into API response shapes — fine because the LLM decided; the code just shapes.
- **Safety guards** — Blocking dangerous operations, PII filtering, content policy enforcement — fine because these are invariants the LLM cannot be trusted to enforce.
- **Configuration branching** — `if config.mode == "async": use_async_runtime()` — fine because it's infrastructure selection, not intent routing.
- **Tool result parsing** — Extracting structured data from tool responses — fine because the tool returned data; code extracts.
- **Rate limiting / circuit breaking** — Infrastructure-level flow control — fine because it's resource protection.
- **Explicit user opt-in** — User said "use keyword matching for this specific case" — the user's explicit override beats the rule.
