---
name: validation-patterns
description: "Kailash validation — parameter, DataFlow, connection, workflow, security, marker scrubbing."
---

# Kailash Validation Patterns

Validation patterns and compliance checking for Kailash SDK development.

## Sub-File Index

### Core Validations

- **[validate-parameters](validate-parameters.md)** - Node parameter validation
  - Required params, type checking, value ranges, format, defaults
- **[validate-connections](validate-connections.md)** - Connection validation
  - 4-parameter format, node existence, param name matching, type compatibility, circular dependency detection
- **[validate-workflow-structure](validate-workflow-structure.md)** - Workflow validation
  - Node ID uniqueness, dead-end detection, entry/exit point validation

### Framework-Specific Validations

- **[validate-dataflow-patterns](validate-dataflow-patterns.md)** - DataFlow compliance
  - Result access: `results["node_id"]["result"]` (not `.result`)
  - String ID preservation, multi-instance isolation, transaction patterns
- **[validate-absolute-imports](validate-absolute-imports.md)** - Import validation
  - Absolute vs relative, module path correctness, circular/missing import detection
- **[validate-security](validate-security.md)** - Security checks
  - Secret exposure, SQL/code injection, file path traversal, API key handling

### Codebase Hygiene Validations

- **[validate-codebase-hygiene-markers](validate-codebase-hygiene-markers.md)** - Internal-tracker marker scrubbing + three-layer regex gate
  - 4-class disposition catalog (Class 1a banner / 1b docstring provenance / 2 active iterative / 3 cross-reference)
  - Three-layer hygiene gate (pre-commit hook + shared script + Tier-2 regression test)
  - Synthetic-PR validation protocol + multi-shard cleanup strategy + release-cycle integration
  - Authoring gotchas: YAML scalar fragility with embedded colons, `grep -I` for binary skip, `\.egg-info/` exclusion shape
  - Origin: issue #781 (TODO-NNN cleanup, May 2026)
- **[orphan-audit-playbook](orphan-audit-playbook.md)** - Orphan detection for facade/manager classes
  - Phase 5.11 evidence (2,407 LOC trust orphan); 5-step `/redteam` audit; sub-package collection-gate patterns; same-shard sweep §4a

## Quick Reference

### What Each Validation Catches

| Validation  | Catches                                  | Key Pattern                              |
| ----------- | ---------------------------------------- | ---------------------------------------- |
| Parameters  | Missing/wrong-type params                | Check before `workflow.build()`          |
| Connections | Wrong 4-param format, nonexistent nodes  | `(src_id, src_param, tgt_id, tgt_param)` |
| Workflow    | Duplicate IDs, dead-ends, no entry point | Structural integrity                     |
| DataFlow    | `.result` access, UUID conversion        | `results["id"]["result"]`                |
| Imports     | Relative imports, circular deps          | Absolute imports only                    |
| Security    | Hardcoded secrets, SQL injection         | Env vars, parameterized queries          |

### Automated Validation

```python
from kailash.validation import WorkflowValidator

validator = WorkflowValidator(workflow)
results = validator.validate_all()

if not results.is_valid:
    for error in results.errors:
        print(f"Error: {error}")
```

### Pre-Execution Checklist

- All required parameters provided
- All connections use 4-parameter format
- No missing or duplicate node IDs
- Called `.build()` before execute
- Using correct runtime type

### CI Integration

```bash
python -m kailash.validation.cli validate-all
python -m kailash.validation.cli check-security
```

## End-to-End Pipeline Regression Above Unit/Integration

Some failure modes are invisible at Tier 1 unit and Tier 2 integration because each step in a multi-step pipeline works in isolation — the break is at the seam between steps. A pipeline like `km.train(df) → km.register(result, name=...)` can have 100% unit coverage on `km.train` AND 100% integration coverage on `km.register` while the chain fails because `result` is missing a field the next step needs (the "fake-integration" failure mode).

**Defense:** A **release-blocking regression tier** above Tier 3 — a test that executes the full pipeline against real infrastructure AND asserts a deterministic fingerprint over the output. Any change that alters observable behavior flips the fingerprint and blocks release.

### Pattern

```python
# DO — release-blocking regression with pinned SHA-256 fingerprint
@pytest.mark.regression
@pytest.mark.release_blocking
async def test_readme_quick_start_end_to_end(real_conn):
    # 1. Execute the README Quick Start verbatim
    result = await km.train(df, target="churned")
    registered = await km.register(result, name="demo")
    # 2. Compute fingerprint over deterministic output
    fingerprint = hashlib.sha256(
        json.dumps(registered.artifact_uris, sort_keys=True).encode()
    ).hexdigest()
    # 3. Assert against pinned value (pinned in spec)
    assert fingerprint == "c962060cf467cc732df355ec9e1212cfb0d7534a3eed4480b511adad5a9ceb00"

# DO NOT — rely on unit + integration alone
def test_km_train_unit(): ...        # passes, km.train works in isolation
def test_km_register_integration(): ... # passes, km.register works given a valid result
# Chain still breaks because result is missing `.trainable` back-reference.
```

### When to apply

- Public multi-step pipelines documented in README / spec Quick Start sections
- Any chain where `A() → B(A's output) → C(B's output)` is the user's primary ergonomic
- Cross-package integration surfaces (`kailash.ml` facade → `dataflow.ml` → `nexus.ml` handoff)

### Origin

Session 2026-04-23 kailash-ml 1.0.0 M1 W33b shard — regression test caught the `km.train → km.register` trainable-field gap (commit `15033fa6`) that unit tests couldn't. Pinned fingerprint: `specs/ml-engines-v2.md` §16.3. See `skills/34-kailash-ml/m1-release-wave.md` § "Release-Blocking README Quick Start Regression".

## Validation Rules

- **Always validate** parameters before execution, connections before building, security before deployment, imports before commit
- **Never skip** parameter validation, connection validation, security validation

## Related Skills

- **[17-gold-standards](../17-gold-standards/SKILL.md)** - Compliance standards
- **[31-error-troubleshooting](../31-error-troubleshooting/SKILL.md)** - Error troubleshooting
- **[01-core-sdk](../01-core-sdk/SKILL.md)** - Core patterns
- **[02-dataflow](../02-dataflow/SKILL.md)** - DataFlow patterns

## Support

- `gold-standards-validator` - Compliance checking
- `pattern-expert` - Pattern validation
- `testing-specialist` - Test validation
