---
name: gold-documentation
description: "Gold standard for documentation. Use when asking 'documentation standard', 'how to document', or 'docs best practices'."
---

# Gold Standard: Documentation

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `MEDIUM`
> SDK Version: `0.9.25+`

## Documentation Principles

### 1. Code-Level Documentation
```python
def process_payment(amount: float, customer_id: str) -> dict:
    """Process a payment for a customer.

    Args:
        amount: Payment amount in USD (must be positive)
        customer_id: Unique customer identifier

    Returns:
        dict: Payment result with keys 'status', 'transaction_id'

    Raises:
        ValueError: If amount <= 0
        APIError: If payment gateway fails

    Example:
        >>> result = process_payment(99.99, "cust_123")
        >>> print(result['status'])
        'success'
    """
    if amount <= 0:
        raise ValueError("Amount must be positive")

    # Implementation...
    return {"status": "success", "transaction_id": "txn_456"}
```

### 2. Workflow Documentation
```python
from kailash.workflow.builder import WorkflowBuilder

# ✅ GOOD: Document workflow purpose and flow
workflow = WorkflowBuilder()

# Step 1: Validate payment details
workflow.add_node("CodeValidationNode", "validate_payment", {
    "schema": {"amount": "decimal > 0", "card": "credit_card"}
})

# Step 2: Process with payment gateway
workflow.add_node("HTTPRequestNode", "charge_card", {
    "url": "https://api.stripe.com/charges"
    # Creates charge with validated payment details
})

# Step 3: Record transaction in database
workflow.add_node("SQLDatabaseNode", "record_transaction", {
    "query": "INSERT INTO transactions ..."
})

workflow.add_connection("validate_payment", "result", "charge_card", "payment_data")
workflow.add_connection("charge_card", "result", "record_transaction", "transaction_data")
```

### 3. README Structure
```markdown
# Project Name

Brief description of what this project does.

## Installation

```bash
pip install package-name
```

## Quick Start

```python
from package import Class

# Minimal working example
app = Class()
app.run()
```

## Features

- Feature 1
- Feature 2

## Documentation

- [User Guide](docs/user-guide.md)
- [API Reference](docs/api.md)

## Examples

See [examples/](examples/) directory.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
```

### 4. Inline Comments
```python
# ✅ GOOD: Explain WHY, not WHAT
# Use exponential backoff to avoid overwhelming the API
# during temporary outages (max 5 retries over 31 seconds)
delay = 2 ** retry_count

# ❌ BAD: Stating the obvious
# Increment the counter by 1
counter += 1
```

## Documentation Checklist

- [ ] Docstrings for all public functions/classes
- [ ] Type hints for parameters and returns
- [ ] Examples in docstrings
- [ ] README with quick start
- [ ] User guides for major features
- [ ] API reference documentation
- [ ] Inline comments for complex logic
- [ ] Code examples are tested
- [ ] Documentation stays up-to-date

<!-- Trigger Keywords: documentation standard, how to document, docs best practices, documentation gold standard -->
