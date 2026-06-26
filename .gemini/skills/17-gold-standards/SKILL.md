---
name: gold-standards
description: "Kailash gold standards — imports, params, errors, NO-mocking Tier 2/3, security."
---

# Kailash Gold Standards - Mandatory Best Practices

These are **required** patterns that prevent bugs, ensure consistency, and maintain code quality.

## When to Use

Use gold-standards when asking about best practices, standards, gold standards, mandatory rules, required patterns, absolute imports, testing policy, error handling standards, security best practices, documentation standards, or workflow design standards. Covers absolute imports, parameter passing, error handling, Tier 2/3 testing with real infrastructure (NO mocking per `rules/testing.md`), workflow design, custom node development, security, documentation, and test creation.

## Sub-File Index

### Code Organization

- **[gold-absolute-imports](gold-absolute-imports.md)** - ALWAYS absolute, NEVER relative
  - `from kailash.workflow.builder import WorkflowBuilder` (not `from ..workflow import builder`)
- **[gold-parameter-passing](gold-parameter-passing.md)** - 4-parameter connections + dict result access
  - `workflow.add_connection(source_id, source_param, target_id, target_param)`
  - `results["node_id"]["result"]` (not `results["node_id"].result`)

### Testing

- **[gold-mocking-policy](gold-mocking-policy.md)** - Real infrastructure in Tiers 2-3
  - Mocking ONLY in Tier 1 unit tests; Tiers 2-3 use real databases, APIs, infrastructure
- **[gold-testing](gold-testing.md)** - 3-tier strategy, deterministic tests, resource cleanup
- **[gold-test-creation](gold-test-creation.md)** - TDD, one assertion focus, AAA pattern
- **Release-blocking regression tier** (W33b) — every public km.\* surface has a fingerprint test + an e2e `execute(...)` pattern that round-trips from workflow → node → engine → registry. See skill **34-kailash-ml** for the exact contract. Release PRs block on this tier independently of unit/integration status.

### Error Handling

- **[gold-error-handling](gold-error-handling.md)** - Explicit handling, no silent swallowing, actionable messages, cleanup in `finally`

### Workflow & Node Design

- **[gold-workflow-design](gold-workflow-design.md)** - Always `.build()` before execute, string-based node API, single responsibility
- **[gold-custom-nodes](gold-custom-nodes.md)** - Extend BaseNode, validate inputs, consistent output format

### Security & Documentation

- **[gold-security](gold-security.md)** - No hardcoded secrets, env vars for credentials, input validation, injection prevention
- **[gold-documentation](gold-documentation.md)** - Document all public APIs, include examples, explain WHY not just WHAT

## Quick Reference

All workflow patterns follow the **canonical 4-parameter pattern** from `/01-core-sdk`.

| Standard    | Correct                                                       | Wrong                                            |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Imports     | `from kailash.workflow.builder import WorkflowBuilder`        | `from ..workflow.builder import WorkflowBuilder` |
| Connections | `workflow.add_connection("n1", "result", "n2", "input_data")` | `workflow.add_connection("n1", "n2")`            |
| Execution   | `runtime.execute(workflow.build())`                           | `runtime.execute(workflow)`                      |
| Results     | `results["node_id"]["result"]`                                | `results["node_id"].result`                      |
| Secrets     | `os.environ["API_KEY"]`                                       | `api_key = "sk-..."`                             |
| Testing     | Real DB in Tier 2-3                                           | `Mock(spec=DataFlow)` in Tier 2-3                |
| Errors      | `except WorkflowExecutionError as e: logger.error(...)`       | `except: pass`                                   |
| Development | Write test first, then implement                              | Implement first, add tests later                 |

## Before Every Commit

- All imports absolute
- All connections use 4 parameters
- `.build()` called before execute
- No hardcoded secrets
- Error handling present
- Tests written (TDD)
- No mocking in Tier 2-3 tests
- Documentation updated

## Related Skills

- **[16-validation-patterns](../16-validation-patterns/SKILL.md)** - Validation tools
- **[31-error-troubleshooting](../31-error-troubleshooting/SKILL.md)** - Error patterns
- **[12-testing-strategies](../12-testing-strategies/SKILL.md)** - Testing strategies
- **[01-core-sdk](../01-core-sdk/SKILL.md)** - Core patterns

## Support

- `gold-standards-validator` - Automated compliance checking
- `pattern-expert` - Pattern validation
- `testing-specialist` - Testing compliance
