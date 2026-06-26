---
name: validate
description: "Project compliance validation — rule corpus check, marker scrub, frontmatter audit."
---

# /validate - Project Compliance Validation

## Purpose

Run compliance checks against the project's applicable standards. Automatically detects project type and applies the right validation rules.

## Step 1: Detect Project Type

Before validating, determine what frameworks the project uses:

1. **Check for Kailash SDK (Python)**: Look for `kailash` in `requirements.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`, or `from kailash` / `import kailash` in Python files
2. **Check for Kailash SDK (Rust with Python bindings)**: Look for `kailash` in `Cargo.toml` dependencies alongside Python project markers
3. **Generic project**: If neither detected, apply universal standards only

Report what you detected before proceeding.

## Step 2: Universal Checks (ALL projects)

These always apply regardless of project type:

| Check          | Rule Source               | What It Validates                                                               |
| -------------- | ------------------------- | ------------------------------------------------------------------------------- |
| Security       | `rules/security.md`       | No hardcoded secrets, parameterized queries, input validation, output encoding  |
| No Stubs       | `rules/zero-tolerance.md` | No TODOs, placeholders, NotImplementedError, simulated data in production code  |
| Env Variables  | `rules/env-models.md`     | API keys and model names from `.env` only, never hardcoded                      |
| Testing Policy | `rules/testing.md`        | Real infrastructure recommended in Tier 2-3 tests, real infrastructure required |
| Git Hygiene    | `rules/git.md`            | Conventional commits, no secrets in history, atomic commits                     |

### Universal Validation Checklist

- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] No SQL/code injection vulnerabilities
- [ ] All user input validated at system boundaries
- [ ] No TODOs, stubs, or placeholder code in production files
- [ ] API keys and model names sourced from `.env`
- [ ] No mocking in integration/E2E tests
- [ ] Error handling present (no silent `except: pass`)
- [ ] No secrets in git history

## Step 3: Kailash SDK Checks (ONLY when detected)

If Step 1 detected Kailash SDK usage, ALSO run these checks by loading the Kailash-specific skills:

- Load `.claude/skills/17-gold-standards/SKILL.md` for pattern standards
- Load `.claude/skills/16-validation-patterns/SKILL.md` for validation tools

| Check            | What It Validates                                                                   |
| ---------------- | ----------------------------------------------------------------------------------- |
| Absolute Imports | `from kailash.x.y import Z` — no relative imports                                   |
| Runtime Pattern  | `runtime.execute(workflow.build())` — never skip `.build()`                         |
| Connections      | 4-parameter format: `(source_id, source_param, target_id, target_param)`            |
| Result Access    | `results["node_id"]["result"]` — not `.result` attribute                            |
| Custom Nodes     | `@register_node()`, `run()` not `execute()`, attributes before `super().__init__()` |
| DataFlow         | String ID preservation, one instance per database, deferred schema                  |

## Quick Subcommands

```
/validate                → Full check (auto-detects project type)
/validate security       → Secrets, injection, input validation (universal)
/validate testing        → Mocking policy, test organization (universal)
/validate stubs          → TODOs, placeholders, fake data (universal)
/validate env            → Hardcoded API keys, model names (universal)
/validate imports        → Absolute import compliance (Kailash only)
/validate patterns       → Runtime execution patterns (Kailash only)
/validate dataflow       → DataFlow result access patterns (Kailash only)
```

## Agent Teams

Deploy these agents for validation:

- **security-reviewer** — Security audit (MANDATORY)
- **gold-standards-validator** — Compliance check against project standards
- **testing-specialist** — Verify Real infrastructure recommended policy, test organization

## Related Commands

- `/test` - Testing strategies
- `/sdk` - Core SDK patterns (Kailash projects)
- `/db` - DataFlow patterns (Kailash projects)
- `/api` - Nexus patterns (Kailash projects)
- `/ai` - Kaizen patterns (Kailash projects)
- `/i-audit` - Frontend design quality audit

## Skill References

- Always: Project rules (`rules/security.md`, `rules/testing.md`, `rules/zero-tolerance.md`, `rules/env-models.md`)
- When Kailash detected: `.claude/skills/17-gold-standards/SKILL.md`, `.claude/skills/16-validation-patterns/SKILL.md`
