---
name: documentation-validation-patterns
description: "Documentation validation patterns including test file creation, infrastructure setup, and validation reporting. Use for 'doc validation', 'example testing', 'documentation verification'."
---

# Documentation Validation Patterns

> **Skill Metadata**
> Category: `documentation`
> Priority: `MEDIUM`
> Use Cases: Validating code examples, testing documentation

## Validation Process

### Phase 1: Example Extraction

```python
# For each documentation file:
1. Extract all code blocks (```python, ```bash, etc.)
2. Identify imports, setup requirements, and dependencies
3. Determine which infrastructure is needed (Docker services, etc.)
4. Map examples to their test categories (unit, integration, E2E)
```

### Phase 2: Test File Creation

```python
# Create temporary test files
import pytest
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime

def test_example_from_docs():
    '''Test example from {doc_file} line {line_num}'''
    # [Copy exact code from documentation]
    # Add assertions to verify it works
```

### Phase 3: Infrastructure Setup

```bash
# For integration/E2E examples
cd tests/utils
./test-env up && ./test-env status

# Verify services are ready:
# ✅ PostgreSQL: Ready
# ✅ Redis: Ready
# ✅ MinIO: Ready
# ✅ Elasticsearch: Ready
```

### Phase 4: Execution & Validation

```bash
# Run each temp test file
pytest /tmp/test_docs_feature.py -v

# Capture and verify:
# - All tests pass
# - No deprecation warnings
# - Output matches documented behavior
# - Performance is acceptable
```

## Validation Report Template

```markdown
## Documentation Validation: [file_path]

### Summary
- Total examples: 12
- Validated: 11
- Fixed: 1
- Blocked: 0

### Validation Details
1. **Example: CSV Processing** (lines 23-45)
   - Test: /tmp/test_csv_example.py::test_csv_processing
   - Result: PASSED
   - Execution time: 0.34s

2. **Example: Async Workflow** (lines 67-89)
   - Test: /tmp/test_async_example.py::test_async_workflow
   - Result: FAILED → FIXED
   - Issue: Used deprecated execute() instead of async_run()
   - Fix: Updated to current API

### Infrastructure Requirements
- Docker services: PostgreSQL, Redis
- Python packages: All from requirements.txt
- Environment variables: None required

### User Journey Validation
- New user quickstart: ✅ Works as documented
- Database integration: ✅ Connects successfully
- Error handling: ✅ Errors match documentation
```

## Common Documentation Issues

### 1. Outdated API Examples
```python
# ❌ OUTDATED
workflow.addNode("CSVReader", {...})  # Old camelCase

# ✅ CORRECT
workflow.add_node("CSVReaderNode", "reader", {...})  # Current snake_case
```

### 2. Missing Infrastructure Setup
```python
# ❌ INCOMPLETE - no mention of Docker requirement

# ✅ COMPLETE
# Prerequisites: Start test infrastructure (e.g., Docker containers for databases)
# This example requires PostgreSQL from test infrastructure
```

### 3. Incorrect Parameter Names
```python
# ❌ WRONG (parameter renamed)
workflow.add_node("LLMAgentNode", "agent", {"max_length": 1000})

# ✅ CORRECT
workflow.add_node("LLMAgentNode", "agent", {"max_tokens": 1000})
```

## Documentation Directories

```
├── 1-overview/          - Architecture and decision guides
├── 2-core-concepts/     - Core patterns, nodes, workflows
├── 3-development/       - Implementation guides
├── 4-getting-started/   - Quickstart and tutorials
├── 5-enterprise/        - Enterprise patterns
├── 6-examples/          - Working examples
├── 7-gold-standards/    - Compliance standards
└── apps/                - Framework-specific guides
```

## Update Guidelines

2. **Content Guidelines**: Include only absolute essentials, be directive and actionable
3. **Validation Requirements**: Test all instructions with real infrastructure
4. **Cross-reference validation**: Ensure examples work with actual SDK

<!-- Trigger Keywords: doc validation, example testing, documentation verification, documentation update, validate docs, test examples -->
