# Guide 15: Prompt Engineering & Structured Output

## Introduction

Prompt engineering at the architect level is about building **systems** that produce reliable output — not writing clever one-off prompts. This guide covers the patterns that determine whether your agentic system produces consistent, trustworthy results or generates plausible-looking output that erodes user trust over time.

By the end of this guide, you will understand:

- Why explicit criteria outperform vague instructions every time
- Few-shot examples as the most effective consistency technique
- JSON schema design that prevents fabrication and handles uncertainty
- Validation-retry loops and their effectiveness boundaries
- Batch processing trade-offs (50% cost savings, 24-hour window)
- Why self-review fails and how multi-instance review fixes it

---

## Part 1: Explicit Criteria Over Vague Instructions

### The Problem with "Be Conservative"

Vague instructions like "be conservative," "only report high-confidence findings," or "flag important issues" produce **intermittently correct** results. Sometimes the model flags everything. Sometimes it flags nothing. The behavior varies unpredictably across runs.

**Ineffective**:

```
Review this code. Be conservative. Only flag high-confidence findings.
```

**Effective**:

```
Review this code. Flag comments ONLY when:
- Claimed behavior contradicts actual code behavior
- A security vulnerability exists (SQL injection, XSS, auth bypass)
- A runtime error will occur under normal usage

Do NOT flag:
- Style preferences
- Minor naming inconsistencies
- Performance suggestions unless they cause >100ms latency
```

### Converting Vague to Measurable

| Vague Instruction       | Measurable Criteria                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| "Be conservative"       | "Flag only when claimed behavior contradicts code behavior"          |
| "Important issues only" | "Security vulnerabilities and runtime errors. Not style."            |
| "High confidence"       | "Flag when you can point to the specific line that proves the issue" |
| "Be thorough"           | "Check every function for: null handling, error paths, edge cases"   |

### Severity Calibration

Severity levels require **concrete code examples**, not prose descriptions. Show what a critical issue looks like vs. a minor one:

```
CRITICAL — Runtime failure:
    result = data["key"]  # KeyError if "key" missing — no default, no try/except

MAJOR — Security vulnerability:
    query = f"SELECT * FROM users WHERE id = {user_id}"  # SQL injection

MINOR — Style inconsistency:
    def processData():  # Should be process_data() per project convention
```

### The Trust Erosion Dynamic

High false positive rates destroy adoption faster than missed findings:

1. Agent flags 50 issues, 30 are false positives
2. Developer reviews first 10, finds 6 are noise
3. Developer stops reading the remaining 40
4. Real issues in positions 11-50 go unaddressed

**Fix**: Temporarily disable the categories with highest false positive rates. Restore trust first. Improve those specific prompts. Re-enable when false positive rate drops below 10%.

---

## Part 2: Few-Shot Examples

### The Most Effective Technique

When you need consistent output format or consistent judgment, **few-shot examples outperform additional instructions, confidence thresholds, and rule elaboration**.

Not more words. Not stricter rules. **Examples.**

### How to Construct Effective Examples

Each example should show:

1. The input
2. The correct output
3. **The reasoning** — why this output and not a plausible alternative

```
Example 1:
Input: "def calculate_tax(amount): return amount * 0.1"
Analysis: No issues. Tax rate is hardcoded but this is a simple utility function.
         A hardcoded rate is appropriate here — it's not a configuration value
         that changes per customer or jurisdiction.
Severity: None

Example 2:
Input: "def calculate_tax(amount): return amount * TAX_RATES[region]"
Analysis: Potential KeyError if region is not in TAX_RATES. No default value
         or error handling. This WILL crash in production when a new region
         is added but TAX_RATES isn't updated.
Severity: CRITICAL — runtime failure

Example 3:
Input: "def calculate_tax(amount): return amount * 0.1  # TODO: use config"
Analysis: Hardcoded rate with TODO comment. The TODO suggests this is
         intentionally temporary. Flag for tracking, not as a bug.
Severity: MINOR — tracked technical debt
```

**Why reasoning matters**: The model learns to generalize from the reasoning, not just pattern-match the output. Example 1 and Example 3 both have hardcoded rates, but the reasoning explains why one is fine and the other needs flagging.

### When to Deploy Few-Shot

| Situation                            | Few-Shot Needed?        |
| ------------------------------------ | ----------------------- |
| Output format is ambiguous           | Yes — show exact format |
| Judgment calls between similar cases | Yes — show reasoning    |
| Simple factual extraction            | Usually not needed      |
| Classification with clear boundaries | 2 examples per boundary |

### The "Resist Extraction" Example

The most valuable few-shot example is one that shows when **NOT** to extract. Most architects include only positive examples (here's something to extract). Including a negative example — where the text looks extractable but shouldn't be — prevents false positives more effectively than any other technique.

```
Example: Text that looks like an SLA but isn't one:
Input: "Vendor acknowledges receipt of the Service Level Requirements
        and will endeavor to meet the specified uptime targets."
Analysis: NOT extractable. "Acknowledges receipt" is not an obligation.
          "Will endeavor" is aspirational, not binding. The actual SLA
          terms are in Exhibit B (not provided). Extracting this would
          fabricate specifics that don't exist.
Output: { "clauses": [] }  // Nothing to extract
```

### The 2-4 Sweet Spot

Use **2-4 targeted examples** for ambiguous scenarios. More than 4 adds token overhead without proportional improvement. Choose examples that cover the decision boundaries — the cases where reasonable people would disagree.

---

## Part 3: Structured Output with tool_use

### What Schemas Prevent (and Don't)

JSON schemas guarantee **syntactic correctness**: valid JSON, correct types, required fields present. That's all.

Schemas do **NOT prevent**:

- **Semantic errors**: Line items that don't sum to the total
- **Field placement**: Putting the vendor name in the address field
- **Fabrication**: Model invents values for required fields when the source lacks the information

### Schema Design Principles

```python
tools = [{
    "name": "extract_invoice",
    "input_schema": {
        "type": "object",
        "properties": {
            "vendor_name": {
                "type": "string",
                "description": "Company name from the invoice header"
            },
            "total_amount": {
                "type": "number",
                "description": "Final total including tax"
            },
            "currency": {
                "type": "string",
                "description": "ISO 4217 currency code (e.g., USD, EUR)"
            },
            "payment_terms": {
                "type": ["string", "null"]  # Source may not contain this
            },
            "confidence": {
                "type": "string",
                "enum": ["high", "medium", "low", "unclear"]
            },
            "category": {
                "type": "object",
                "properties": {
                    "primary": {
                        "type": "string",
                        "enum": ["services", "goods", "subscription", "other"]
                    },
                    "detail": {
                        "type": "string"  # Freeform when "other"
                    }
                }
            }
        },
        "required": ["vendor_name", "total_amount", "currency", "confidence"]
    }
}]
```

### Key Design Decisions

| Decision             | Pattern                        | Why                                                                      |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| **Nullable fields**  | `"type": ["string", "null"]`   | Source may not contain the data. Without this, model fabricates a value. |
| **"unclear" enum**   | `"enum": [..., "unclear"]`     | Gives the model an honest escape hatch for ambiguous cases               |
| **"other" + detail** | Primary enum + freeform detail | Extensible categorization without explosive enum lists                   |
| **Confidence field** | Per-extraction confidence      | Enables downstream filtering and routing                                 |

### The Required Field Trap

**Making every field required forces fabrication.** If the source document doesn't contain payment terms and you make `payment_terms` required, the model will invent plausible-looking terms to satisfy the schema. The output looks complete but contains hallucinated data.

**Fix**: Only require fields that are always present in the source. Use `"type": ["string", "null"]` for optional fields and omit them from `required`. Add an "unclear" option for ambiguous cases.

---

## Part 4: Validation-Retry Loops

### The Pattern

When extraction fails validation, send back the original document, the failed extraction, and the specific validation error. The model self-corrects:

```python
for attempt in range(max_retries):
    result = extract(document)
    errors = validate(result)

    if not errors:
        return result

    # Retry with error context
    messages.append({
        "role": "user",
        "content": f"""
Your extraction had these errors:
{format_errors(errors)}

Original document:
{document}

Previous extraction:
{json.dumps(result)}

Please re-extract, fixing the identified errors.
"""
    })
```

### Effectiveness Boundary

Validation-retry works for:

- **Format mismatches**: Wrong date format, missing currency symbol
- **Structural errors**: Fields in wrong positions
- **Misplaced values**: Vendor name in address field
- **Arithmetic**: Line items not summing to total

Validation-retry does **NOT** work for:

- **Information not in the source**: If the document doesn't contain payment terms, no amount of retrying will produce correct payment terms
- **Fabrication**: Model confidently repeats the same fabricated value

**Rule**: Don't burn retry cycles on missing data. If the first attempt produced `null` or "unclear" for a field, and the source genuinely lacks that information, accept the null.

---

## Part 5: Batch Processing

### The Batches API

| Feature               | Detail                                      |
| --------------------- | ------------------------------------------- |
| **Cost savings**      | Up to 50% reduction (check current pricing) |
| **Processing window** | Up to 24 hours                              |
| **Latency guarantee** | None — results arrive when ready            |
| **Multi-turn**        | NOT supported within a single batch request |

### The Decision Rule

| Workflow Type             | API Choice      | Reasoning                        |
| ------------------------- | --------------- | -------------------------------- |
| Pre-merge CI checks       | **Synchronous** | Developers are waiting           |
| Interactive assistant     | **Synchronous** | User expects real-time response  |
| Nightly test generation   | **Batch**       | Run overnight, review in morning |
| Weekly audit reports      | **Batch**       | No one is waiting                |
| Document processing queue | **Batch**       | Latency-tolerant by design       |

### The Multi-Turn Constraint

Batch requests do not support multi-turn tool calling within a single request. This means agentic loops (send → tool → respond → tool → ...) cannot run in batch mode. Each batch item is a single request-response.

**Implication**: Design batch items as self-contained extraction or analysis tasks, not multi-step investigations.

### The Hybrid Pattern: Batch + Sync Retry

For large-scale extraction, combine batch and synchronous for optimal cost:

```
1. BATCH: First extraction pass on all documents (50% cost savings)
2. VALIDATE: Run local validation on all results (free)
3. SYNC: Retry only failed extractions (~15% of docs, full price)
4. STORE: Final results
```

If 85% of documents extract correctly on the first batch pass, you pay 50% rate for 85% and full rate for 15%. Effective cost: ~57.5% of fully synchronous processing.

---

## Part 6: Multi-Instance Review

### The Self-Review Limitation

The same session that generated code is **less effective at reviewing its own changes**. The model retains its reasoning context from generation — the same assumptions, the same mental model — making it less likely to question its own decisions.

This is not a bug. It's a fundamental property: the model can't easily forget why it made a choice and evaluate that choice objectively.

### Independent Review Instances

Use a **separate session** for review:

```
Session 1 (Generation):
    "Implement user authentication with JWT"
    → Produces code

Session 2 (Review):
    "Review this authentication implementation for security issues"
    → No access to Session 1's reasoning
    → Evaluates code on its own merits
```

### CI/CD Application

```yaml
# Generation and review are separate Claude Code invocations
steps:
  - name: Generate
    run: claude -p "Implement feature X" --output-format json

  - name: Review
    run: claude -p "Review the changes in this PR for security and correctness" --output-format json --json-schema review_schema.json
```

**Key flags**:

- `-p`: Non-interactive mode (essential for CI — without it, job hangs waiting for input)
- `--output-format json`: Machine-parseable output for PR comments
- `--json-schema`: Enforce specific output structure

### Confidence-Based Routing

For staged review, route based on extraction confidence:

```
High confidence (>90%) → Automated approval
Medium confidence (60-90%) → Quick human spot-check
Low confidence (<60%) → Full human review
```

---

## Part 7: Practice Exercises

### Test Your Understanding

1. A code review prompt says "be thorough and flag important issues." It produces 50 findings, 30 are false positives. What's the root cause?
   - **Answer**: Vague criteria. Replace with explicit categories: "Flag only runtime errors, security vulnerabilities, and logic bugs. Skip style and naming."

2. An extraction schema makes every field required. The source document is missing 3 fields. What happens?
   - **Answer**: The model fabricates plausible values. Use `nullable: True` for optional fields.

3. Validation-retry runs 3 times on a field that's null. The source document genuinely doesn't contain this data. What should happen?
   - **Answer**: Accept the null. Don't retry on missing data — it won't appear no matter how many times you ask.

4. A batch job processes 1000 documents with 50% cost savings. But some need multi-turn tool calls. What's the constraint?
   - **Answer**: Batch API doesn't support multi-turn. Redesign those items as self-contained extractions or process them synchronously.

5. A CI pipeline has Claude generate code and then review it in the same session. Reviews always approve. Why?
   - **Answer**: Self-review limitation. The same session retains reasoning context. Use an independent review instance.

### Build Exercise

1. Create an extraction tool with JSON schema including:
   - 3 required fields, 2 nullable fields, 1 confidence enum, 1 "other" + detail category
2. Write a validation-retry loop that distinguishes retryable errors from missing data
3. Add 3 few-shot examples that cover the decision boundary between "flag" and "skip"
4. Design a CI pipeline with separate generation and review stages

---

## Quick Reference

| Concept               | Key Principle                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Explicit criteria** | Measurable thresholds, not vague adjectives                                                             |
| **Few-shot examples** | 2-4 examples with reasoning. Most effective consistency technique.                                      |
| **Schema design**     | Nullable fields, "unclear" enum, "other" + detail                                                       |
| **Required fields**   | Only require what's always in the source. Required = fabrication pressure. Use `"type": ["T", "null"]`. |
| **Validation-retry**  | Works for format/structure. Fails on missing data.                                                      |
| **Batch API**         | 50% savings, 24hr window, no multi-turn, no latency guarantee                                           |
| **Self-review**       | Same session can't objectively review its own work                                                      |
| **CI review**         | Separate generation instance from review instance                                                       |

---

## Navigation

- **Previous**: [14 - Tool Design Patterns](14-tool-design-patterns.md)
- **Next**: [16 - Context & Reliability](16-context-reliability.md)
- **Home**: [README.md](README.md)
