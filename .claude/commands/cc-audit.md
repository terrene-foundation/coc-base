---
name: cc-audit
description: "Audit CC artifacts for quality, completeness, effectiveness, token efficiency, and sync integrity"
---

# CC Artifact Audit (COC Source)

Reviews all artifacts for quality AND sync correctness. This is the **COC source** version — it audits loom/'s variant system, manifest integrity, and USE template distribution.

For project-level audits in downstream repos, see the USE template version.

**Repo type scope**: loom/ has no `agents/project/` or `skills/project/` subdirectories — it is the authority, not a project. This audit never expects `project/` subdirectories. (BUILD repos also never have `project/` — those are a downstream-USE-only convention. See `rules/artifact-flow.md`.)

## Your Role

Specify scope: `all`, `fidelity`, `sync`, or a specific file/type.

## Phase 1: Fidelity Audit

1. **Inventory**: List all artifacts with file paths and line counts.

2. **Four-dimension audit** per artifact:
   - **Competency**: Precise instructions? Knows its domain?
   - **Completeness**: Edge cases? Missing handoffs?
   - **Effectiveness**: Reliable behavior? Output format specified?
   - **Token Efficiency**: Lean? Path-scoped? No redundancy?

3. **Hard limits** (cc-artifacts rules):
   - Agent descriptions under 120 chars with trigger phrases
   - Agents under 400 lines, commands under 150 lines
   - CLAUDE.md under 200 lines, no restated rules
   - Rules have DO/DO NOT examples and Why rationale

4. **Cross-reference check**: Every referenced artifact exists on disk.

5. **Token budget**: Estimate per-turn cost.

## Phase 2: Sync Integrity Audit (COC-specific)

6. **Manifest validation** (`sync-manifest.yaml`):
   - Every `variants:` entry has global + variant files on disk
   - Every `variant_only:` entry exists on disk
   - No orphan files in `variants/` undeclared in manifest
   - Every syncable file in a tier (cc/co/coc) or explicitly excluded
   - No contradictions (tier + exclude, or variants + variant_only)

7. **Exclusion verification**:
   - Management agents (sync-reviewer, coc-sync, repo-ops, repo-ops, settings-manager) excluded
   - Management commands (repos, inspect, settings) excluded
   - Meta files (\_README, \_subagent-guide) excluded
   - Per-repo data (learning/) excluded

8. **Authority chain**:
   - `artifact-flow.md` Rule 1 says atelier/ owns CC+CO, loom/ owns COC
   - Consistent with atelier/'s artifact-flow.md? No contradictions?

9. **USE template contamination** (scan kailash-coc-claude-py/ and -rs/):
   - `grep -rl "src/kailash/" .claude/agents/ .claude/rules/` → must be 0
   - `grep -rl "packages/kailash-" .claude/rules/` → must be 0
   - Management agents must NOT be present
   - BUILD-only commands (/release) flagged

10. **Hook integrity**:
    - Every hook in settings.json has a script on disk
    - Source and template settings.json are consistent

## Phase 3: Report + Convergence

Report findings as CRITICAL/HIGH/NOTE. Run iteratively until zero CRITICAL and zero HIGH remain.
