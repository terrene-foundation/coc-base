---
name: validate-workflow-structure
description: "Validate Kailash workflow code for pattern compliance and gold standards. Use when reviewing workflow code, checking for errors, validating patterns, or ensuring best practices before execution."
---

# Validate Workflow Structure

Quick validation checklist for Kailash workflow patterns to ensure compliance with gold standards and prevent common errors.

> **Skill Metadata**
> Category: `cross-cutting` (validation)
> Priority: `HIGH`
> SDK Version: `0.9.25+`
> Related Skills: [`workflow-quickstart`](../01-core-sdk/workflow-quickstart.md), [`error-missing-build`](../31-error-troubleshooting/error-missing-build.md), [`gold-parameter-passing`](../17-gold-standards/gold-parameter-passing.md)
> Related Subagents: `gold-standards-validator` (comprehensive validation), `pattern-expert` (complex pattern debugging)

## Quick Validation Checklist

Run through this checklist for any Kailash workflow code:

### ✅ Critical Patterns (Must Pass)
- [ ] **Imports**: Using absolute imports (`from kailash.workflow.builder import...`)
- [ ] **.build() call**: Always `runtime.execute(workflow.build())`
- [ ] **String-based nodes**: `"CSVReaderNode"` not `CSVReaderNode()`
- [ ] **4-parameter connections**: `add_connection(from_node, from_output, to_node, to_input)`
- [ ] **Execution pattern**: `runtime.execute(workflow.build())` NOT `workflow.execute(runtime)`

### ✅ Common Mistakes (Check These)
- [ ] **Node suffix**: All nodes end with "Node" (CSVReader**Node**, LLMAgent**Node**)
- [ ] **Snake_case methods**: `add_node()` NOT `addNode()`
- [ ] **Snake_case config**: `file_path` NOT `filePath`
- [ ] **Parameter name**: `parameters={}` NOT `inputs={}` or `config={}`
- [ ] **Node ID uniqueness**: Each node has unique ID in workflow

## Validation Examples

### Example 1: Basic Workflow Validation

```python
# Code to validate:
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime

workflow = WorkflowBuilder()
workflow.add_node("CSVReaderNode", "reader", {"file_path": "data.csv"})
workflow.add_node("PythonCodeNode", "process", {"code": "result = len(data)"})
workflow.add_connection("reader", "data", "process", "data")

runtime = LocalRuntime()
results, run_id = runtime.execute(workflow.build())
```

**Validation Result**: ✅ PASS
- ✅ Absolute imports
- ✅ String-based nodes
- ✅ 4-parameter connections
- ✅ .build() called
- ✅ Correct execution pattern

### Example 2: Code with Violations

```python
# Code to validate:
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime
from kailash.nodes.data import CSVReader  # ❌ Wrong class name

workflow = WorkflowBuilder()
workflow.addNode("reader", CSVReader())  # ❌ camelCase, instance-based
workflow.add_connection("reader", "processor", "data")  # ❌ Only 3 parameters

runtime = LocalRuntime()
results = runtime.execute(workflow)  # ❌ Missing .build()
```

**Validation Result**: ❌ FAIL - 4 violations found
1. ❌ **Import**: Missing "Node" suffix - use `CSVReaderNode` not `CSVReader`
2. ❌ **Method**: camelCase - use `add_node()` not `addNode()`
3. ❌ **Node API**: Instance-based - use string `"CSVReaderNode"` not `CSVReader()`
4. ❌ **Connection**: Only 3 params - use `(from_node, from_output, to_node, to_input)`
5. ❌ **Build**: Missing `.build()` - use `runtime.execute(workflow.build())`

## Pattern Validation Rules

### Rule 1: Execution Pattern (CRITICAL)
```python
# ✅ VALID
runtime.execute(workflow.build())
runtime.execute(workflow.build(), parameters={...})
await runtime.execute_workflow_async(workflow.build(), inputs={})

# ❌ INVALID
workflow.execute(runtime)
runtime.execute(workflow)
runtime.execute(workflow.build(), runtime)
workflow.run()
```

### Rule 2: Node API (CRITICAL)
```python
# ✅ VALID - String-based
workflow.add_node("CSVReaderNode", "reader", {"file_path": "..."})
workflow.add_node("PythonCodeNode", "process", {"code": "..."})

# ❌ INVALID - Instance-based (deprecated)
workflow.add_node("reader", CSVReaderNode(file_path="..."))
workflow.add_node("process", PythonCodeNode(code="..."))
```

### Rule 3: Connection Pattern (CRITICAL)
```python
# ✅ VALID - 4 parameters
workflow.add_connection("source", "output", "target", "input")
workflow.add_connection("reader", "data", "processor", "data")

# ❌ INVALID - 3 parameters (deprecated)
workflow.add_connection("source", "target", "data")
workflow.add_connection("reader", "processor")
```

### Rule 4: Import Pattern (HIGH)
```python
# ✅ VALID - Absolute imports
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime
from kailash.nodes.data import CSVReaderNode

# ❌ INVALID - Relative imports
from ..workflow.builder import WorkflowBuilder
from .runtime import LocalRuntime
```

### Rule 5: Naming Conventions (HIGH)
```python
# ✅ VALID
CSVReaderNode, LLMAgentNode, HTTPRequestNode, PythonCodeNode
workflow.add_node(), workflow.add_connection(), workflow.build()
file_path="...", has_header=True, connection_string="..."

# ❌ INVALID
CSVReader, LLMAgent, HTTPRequest, PythonCode
workflow.addNode(), workflow.connectNodes()
filePath="...", hasHeader=True, connectionString="..."
```

## Automated Validation Script

```python
def validate_workflow_code(code: str) -> dict:
    """Validate workflow code against gold standards."""
    violations = []

    # Check 1: .build() usage
    if ".execute(workflow)" in code and ".execute(workflow.build())" not in code:
        violations.append({
            "rule": "Execution Pattern",
            "issue": "Missing .build() call",
            "fix": "Use runtime.execute(workflow.build())"
        })

    # Check 2: Wrong execution direction
    if "workflow.execute(runtime)" in code:
        violations.append({
            "rule": "Execution Pattern",
            "issue": "Wrong execution direction",
            "fix": "Use runtime.execute(workflow.build()) not workflow.execute(runtime)"
        })

    # Check 3: camelCase methods
    if "addNode" in code or "connectNodes" in code:
        violations.append({
            "rule": "Naming Convention",
            "issue": "camelCase methods",
            "fix": "Use snake_case: add_node(), add_connection()"
        })

    # Check 4: Missing Node suffix in imports
    missing_suffix = ["CSVReader(", "LLMAgent(", "HTTPRequest(", "PythonCode("]
    for pattern in missing_suffix:
        if pattern in code and pattern.replace("(", "Node(") not in code:
            violations.append({
                "rule": "Node Naming",
                "issue": f"Missing 'Node' suffix in {pattern}",
                "fix": f"Use {pattern.replace('(', 'Node(')} instead"
            })

    # Check 5: camelCase config keys
    camel_keys = ["filePath", "hasHeader", "connectionString", "maxTokens"]
    for key in camel_keys:
        if key in code:
            snake_key = ''.join(['_'+c.lower() if c.isupper() else c for c in key]).lstrip('_')
            violations.append({
                "rule": "Config Naming",
                "issue": f"camelCase config key: {key}",
                "fix": f"Use snake_case: {snake_key}"
            })

    # Summary
    if not violations:
        return {
            "valid": True,
            "message": "✅ No violations found - code follows gold standards"
        }
    else:
        return {
            "valid": False,
            "violation_count": len(violations),
            "violations": violations,
            "message": f"❌ Found {len(violations)} violation(s)"
        }
```

## Common Validation Scenarios

### Scenario 1: Pre-Commit Review
Run validation before committing code:
```python
validation_result = validate_workflow_code(my_workflow_code)
if not validation_result["valid"]:
    print(f"❌ {validation_result['violation_count']} issues found:")
    for v in validation_result["violations"]:
        print(f"  - {v['rule']}: {v['issue']}")
        print(f"    Fix: {v['fix']}")
```

### Scenario 2: Code Review Checklist
Use this during PR reviews:
- [ ] All imports are absolute (no relative imports)
- [ ] All nodes use string-based API
- [ ] All connections use 4-parameter pattern
- [ ] `.build()` called before execution
- [ ] Execution pattern is `runtime.execute(workflow.build())`
- [ ] All method names are snake_case
- [ ] All config keys are snake_case
- [ ] All node classes have "Node" suffix

### Scenario 3: Refactoring Legacy Code
When updating old code to new patterns:
1. Check imports - update to absolute
2. Check node API - convert instance-based to string-based
3. Check connections - update to 4 parameters
4. Check execution - add `.build()` if missing
5. Check naming - convert camelCase to snake_case

## Related Patterns

- **Workflow basics**: [`workflow-quickstart`](../01-core-sdk/workflow-quickstart.md)
- **Error fixes**: [`error-missing-build`](../31-error-troubleshooting/error-missing-build.md), [`error-connection-params`](../31-error-troubleshooting/error-connection-params.md)
- **Gold standards**: [`gold-parameter-passing`](../17-gold-standards/gold-parameter-passing.md), [`gold-absolute-imports`](../17-gold-standards/gold-absolute-imports.md)
- **Common mistakes**: [`common-mistakes-catalog`](../06-cheatsheets/common-mistakes-catalog.md)

## When to Escalate to Subagent

Use `gold-standards-validator` subagent when:
- Need comprehensive compliance check across entire codebase
- Validating against all gold standards (not just workflow structure)
- Generating compliance report for audit
- Automated CI/CD validation

Use `pattern-expert` subagent when:
- Debugging complex pattern violations
- Understanding why certain patterns are required
- Optimizing workflow structure for performance
- Implementing advanced patterns

## Documentation References

### Primary Sources

### Related Documentation
- **Pattern Expert**: [`.claude/agents/implementation/pattern-expert.md`](../../agents/implementation/pattern-expert.md)
- **Essential Pattern**: [`CLAUDE.md` (lines 139-145)](../../../CLAUDE.md#L139-L145)

## Quick Tips

- 💡 **Validate early**: Check patterns during development, not just before commit
- 💡 **Use automated tools**: Create pre-commit hooks with validation script
- 💡 **Learn from errors**: Each violation teaches a gold standard pattern
- 💡 **Template first**: Start with templates to avoid violations
- 💡 **Reference docs**: Link to specific gold standards for team education

<!-- Trigger Keywords: validate workflow, check workflow, workflow validation, verify code, code review, pattern compliance, check for errors, validate patterns, gold standards check, best practices check, workflow review -->
