---
priority: 10
scope: path-scoped
paths:
  - "**/kaizen/**"
  - "**/*agent*"
  - "**/agents/**"
  - "**/*classifier*"
  - "**/*extractor*"
  - "**/*delegate*"
  - "**/*router*"
  - "**/*dispatcher*"
  - "**/*intent*"
---

# Agent Reasoning Architecture — LLM-First Rule

See `.claude/guides/rule-extracts/agent-reasoning.md` for the principle diagram, full Detection Patterns anti-pattern list, and extended permitted-exception narrative.

## Scope

ALL agent code, ALL Kaizen implementations, ALL AI agent patterns, ALL codegen producing agent logic. Includes any file creating/extending/configuring a `BaseAgent`, implementing agent routing/dispatch/classification/decision-making, or processing user input to determine agent behavior.

## The Principle: LLM Reasons, Tools Fetch

The LLM IS the router, classifier, extractor, evaluator. Tools are dumb data endpoints — fetch, store, relay. They do not decide.

## ABSOLUTE RULE: No Deterministic Logic Where LLM Reasoning Belongs

The DEFAULT and ONLY mode is: LLM Reasons → LLM Decides → LLM Acts (calls tool) → LLM Evaluates.

Under NO circumstances shall the following be used for agent decision-making:

- `if-else` chains for intent routing
- Keyword matching (`if "cancel" in user_input`)
- Regex matching (`re.match(r"order.*refund", text)`)
- Dictionary dispatch (`handlers = {"intent_a": func_a, ...}`)
- Enum-based routing (`if intent == Intent.BILLING`)
- Hardcoded classification (`if any(w in text for w in ["help", "support"])`)
- Switch/match statements on user input content
- Embedding similarity with hardcoded thresholds for routing

**UNLESS the user EXPLICITLY says**: "use deterministic logic here", "use keyword matching", "use regex", "this needs to be rule-based", or equivalent explicit opt-in.

## MUST Rules

### 1. LLM-First For All Agent Decisions

Every agent decision — routing, classification, extraction, evaluation — MUST go through an LLM call (`self.run()`, `self.run_async()`), NOT through code conditionals.

```python
# DO — LLM reasons about intent
class CustomerServiceAgent(BaseAgent):
    class Sig(Signature):
        user_message: str = InputField(description="Customer message")
        action: str = OutputField(description="refund, escalate, answer, transfer")
        response: str = OutputField(description="Response to customer")
    def handle(self, message: str) -> dict:
        return self.run(user_message=message)  # LLM decides everything

# DO NOT — script pretending to be an agent
def handle(self, message):
    lower = message.lower()
    if "refund" in lower: return self.process_refund(message)   # BLOCKED
    elif re.match(r"order\s*#?\d+", lower): return self.lookup_order(message)  # BLOCKED
    else: return self.run(user_message=message)
```

**Why:** Code conditionals create brittle keyword-matching systems that fail on paraphrased input; LLMs generalize across natural language variations.

### 2. Tools Are Dumb Data Endpoints

Tools MUST be pure data operations: fetch, store, transform, relay. MUST NOT contain decision logic, routing, or classification.

```python
# DO — tool fetches, no decisions
async def get_order(order_id: str) -> dict:
    return await db.orders.find_one({"id": order_id})

# DO NOT — decision logic in tool
async def handle_order_issue(order_id, message):
    order = await db.orders.find_one({"id": order_id})
    if order["status"] == "delivered": return await process_return(order)   # BLOCKED
    elif order["total"] < 50: return await auto_refund(order)               # BLOCKED
```

**Why:** Decision logic in tools is invisible to the LLM's reasoning trace, making agent behavior unexplainable, untestable, and impossible to improve via prompt engineering.

### 3. Signatures Describe, Code Doesn't Decide

Agent signatures MUST describe the reasoning the LLM should perform. Code around `self.run()` MUST NOT pre-filter, pre-classify, or pre-route before the LLM sees the input.

```python
# DO — rich signature
class TriageSignature(Signature):
    ticket: str = InputField(description="Support ticket content")
    customer_history: str = InputField(description="Previous interactions")
    priority: str = OutputField(description="urgent, high, normal, low")
    category: str = OutputField(description="billing, technical, account, general")
    suggested_action: str = OutputField(description="What to do next")

# DO NOT — minimal signature because code handles logic
class TriageSignature(Signature):
    ticket: str = InputField(description="Support ticket")
    response: str = OutputField(description="Response")
    # ^ all decisions happen in if-else around self.run()
```

**Why:** Minimal signatures force developers to embed intelligence in code, defeating the purpose of LLM-based agents — producing agents that are glorified if-else chains.

### 4. Multi-Step Reasoning Uses Agent Loops, Not Code Loops

When multi-step reasoning is needed, use ReAct patterns or multi-cycle strategies — NOT imperative code loops with conditionals.

```python
# DO
agent = ReActAgent(config=config, tools="all")
result = agent.solve("Investigate why revenue dropped last quarter")
# DO NOT — hardcoded steps with code decisions
def investigate(self, query):
    data = self.fetch_revenue_data()
    if data["trend"] == "declining":                  # BLOCKED
        causes = self.fetch_cause_data()
        if causes["top"] == "churn":                  # BLOCKED
            return self.generate_churn_report()
```

**Why:** Hardcoded step sequences cannot adapt when intermediate results change the plan; ReAct agents re-evaluate strategy after each observation.

### 5. Router Agents Use LLM Routing, Not Dispatch Tables

When routing between multiple agents, the router MUST use LLM reasoning to select the target — NOT a dispatch table or keyword map.

```python
# DO — LLM-based routing
from kaizen.orchestration.pipeline import Pipeline
router = Pipeline.router(agents=[billing_agent, tech_agent, sales_agent])
result = router.run(query=user_message)

# DO NOT — dispatch table
ROUTES = {"billing": billing_agent, ...}   # BLOCKED
for kw, agent in ROUTES.items():
    if kw in message.lower(): return agent  # BLOCKED
```

**Why:** Dispatch tables require enumerating every possible intent upfront and break silently on new intents; LLM routing generalizes to unseen queries via capability cards.

## MUST NOT

- **Conditionals for agent routing** — no `if`/`elif`/`match`/ternary based on content analysis performed in code. LLM analyzes content; code routes on LLM OUTPUT structure (calling a tool the LLM selected is fine).

**Why:** Code-based routing silently drops input not matching a hardcoded branch — a class of "agent doesn't respond" bugs invisible in testing.

- **Keyword/regex matching on agent inputs** — no `in` / `str.contains()` / `re.match()` / `re.search()` / `re.findall()` on user input for agent decisions.

**Why:** Fails on synonyms, typos, multilingual input, context-dependent meaning — exactly where users most need the agent to work.

- **Decision logic in tools** — if a tool has `if-else` determining what the agent does next, that logic belongs in the signature.

**Why:** Hidden decision logic splits reasoning across LLM + code — unpredictable, impossible to debug from the prompt alone.

- **Pre-filter input before LLM sees it** — do not strip, classify, categorize, or route input before passing to `self.run()`.

```python
# BLOCKED
def process(self, message):
    category = self._classify(message)
    if category == "simple": return self.run(message=message, mode="quick")
# DO
def process(self, message):
    return self.run(message=message)   # LLM decides depth, approach, everything
```

**Why:** Pre-filtering discards context the LLM needs — a message classified "simple" by code may contain subtle cues only the LLM would catch.

## Permitted Deterministic Logic (Explicit Exceptions)

Conditionals in agent code PERMITTED when NOT reasoning — structural/safety/data-format operations:

1. Input validation (presence/type, not content)
2. Error handling (try/except for tool failures, timeouts)
3. Output formatting (LLM output → API response shape)
4. Safety guards (dangerous ops, PII filtering, content policy)
5. Configuration branching (`if config.mode == "async"`)
6. Tool result parsing (extracting structured data)
7. Rate limiting / circuit breaking
8. Explicit user opt-in

**Test:** Is the conditional deciding what the agent should _think_ or _do_ based on input content? If yes → LLM. If structural plumbing → fine.

See guide for full Detection Patterns anti-pattern grep list.

Origin: LLM-first reasoning principle; ReActAgent + Pipeline.router() API. Session-level discovery across multiple Kaizen framework iterations.
