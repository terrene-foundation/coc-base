---
name: skill-authoring
description: "Authoring or auditing skills (CC/Codex/Gemini). Frontmatter, description ≤200 chars, progressive disclosure, variant overlays."
tools:
  - Read
  - Glob
  - Grep
---

# Skill Authoring

Reference for authoring and auditing skills across CC, Codex, and Gemini. Skills are L2 (Context) artifacts in the COC 5-layer architecture per `rules/cc-artifacts.md` — distinct from agents (L1 Intent), rules (L3 Guardrails), commands (L4 Instructions), and hooks (L3 Guardrails deterministic).

## When To Use

Authoring a new skill. Auditing an existing skill for description-length, progressive-disclosure, or cross-CLI portability. Deciding whether a body of knowledge belongs in a skill (reference content, semantically-activated) versus an agent (judgment + procedure) or a rule (boundary enforcement).

## Quick Reference

| Field            | Constraint                                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| `name:`          | Lowercase, hyphen-separated. Matches directory name.                             |
| `description:`   | **≤200 chars.** Failure-mode language. No keyword-dump (`'X', 'Y', 'Z', ...`).   |
| `tools:`         | Preferred for new skills. Neutral identifier set across CLIs.                    |
| `allowed-tools:` | CC-native legacy form. Equivalent semantics; emitter renames at distribute time. |
| SKILL.md body    | 150–250 lines. MUST answer 80% of routine questions without sub-file reads.      |
| Sub-files        | `<skill-dir>/<topic>.md`. Loaded on demand via SKILL.md cross-reference.         |

## Directory Layout

```
.codex/skills/<skill-name>/
├── SKILL.md                  ← primary entry, frontmatter-bearing
├── <topic-1>.md              ← progressive-disclosure depth
├── <topic-2>.md
└── fixtures/                 ← optional: example inputs the skill references
```

The directory name MUST match `name:` in SKILL.md frontmatter. Numbered prefixes (`01-`, `02-`) are conventional for ordering but not load-bearing; semantic activation uses `description:` only.

## The `description:` Field IS The Activation Mechanism

Skill selection is semantic, not keyword. The model reads every skill's `description:` in the listing and selects the one whose _failure-mode language_ matches the user's intent. Keyword-dump descriptions (`"Use when asking about 'X', 'Y', 'Z', 'X with Y'"` with ≥4 quoted alternates) are BLOCKED per `rules/cc-artifacts.md` Rule 1b — they inflate the listing budget without improving activation.

### DO — Failure-Mode Language

```yaml
description: "Authoring or auditing skills. Frontmatter, description ≤200 chars, progressive disclosure, variant overlays."
description: "Kailash testing — 3-tier, Tier 2/3 real infra (NO mocking), regression, coverage."
description: "MANDATORY for ML training/inference/drift. Raw sklearn/pytorch BLOCKED."
```

Each names the situation the skill addresses + what gets blocked / what convention applies. Selection precision is high because the listing entry tells the model what failure mode the skill prevents.

### DO NOT — Keyword Dump

```yaml
description: "Validation patterns and compliance checking including parameter validation, DataFlow pattern validation, connection validation. Use when asking about 'validation', 'validate', 'check compliance', 'verify', 'lint', 'code review', 'parameter validation', 'connection validation', 'import validation', 'security validation', 'workflow validation', 'codebase hygiene', 'TODO marker scrub', 'marker cleanup', 'three-layer gate', or 'regex gate'."
```

**Why this fails:** The total listing budget across all skills divides to ~200 chars/entry. When any single description exceeds the per-entry cap OR the cumulative listing exceeds the budget fraction, CC drops descriptions from the listing — those skills become invisible. 2026-05-06 evidence: 47 of 47 skill descriptions dropped from a listing because cumulative exceeded ~1% budget; trimming the worst 18 to ≤200 chars restored full visibility.

### `MANDATORY` Framing For Strong Preconditions

When a skill must fire whenever a domain is touched (e.g., `34-kailash-ml`: "MANDATORY for training/inference/drift/AutoML/RL. Raw sklearn/pytorch BLOCKED."), open the description with `MANDATORY`. The framing signals to the model that this is not a tiebreaker — the skill is the authoritative entry point.

## Tools Field — `tools:` vs `allowed-tools:`

| Form             | Status                                         | When to use                                                     |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `tools:`         | Preferred, neutral across CLIs                 | New skills + any skill being audited or rewritten               |
| `allowed-tools:` | Legacy CC-native form, semantically equivalent | Existing skills not yet renamed; emitter rewrites on distribute |

The emitter at `/sync` distribute time renames `allowed-tools:` to `tools:` for non-CC targets that require the neutral form. New skills SHOULD use `tools:` directly to avoid the rename round-trip.

### Tool Names Are Identifiers, Not Verbs

Tool entries are identifiers the runtime maps to its native primitives. CLI translation tables live at `variants/<cli>/tool-translation.yaml`. Skill frontmatter is the contract: list every tool the SKILL.md body or its sub-files actually invoke.

```yaml
# DO — minimal, accurate list
tools:
  - Read
  - Glob
  - Grep

# DO NOT — list every tool the agent might ever want
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebFetch
  - WebSearch
```

Over-listing dilutes the contract. Skills are reference + lookup; if a skill genuinely needs `Bash` / `Write`, that signals the skill is doing implementation work the architecture says belongs in an agent.

## Progressive Disclosure — 80/20 Rule

SKILL.md MUST answer ~80% of routine questions in the domain without requiring a sub-file read. Sub-files exist for depth on the long tail.

### Layering Pattern

```
SKILL.md         ← Quick reference table + key conventions + DO/DO NOT examples
sub-topic-1.md   ← Full reference: every constraint, every edge case
sub-topic-2.md   ← Specialist deep-dive (e.g., fixture patterns, error taxonomy)
fixtures/        ← Optional: example payloads the skill references
```

The SKILL.md body should be enough that a session resolves common questions without expanding sub-files into context. Sub-files load on demand via explicit cross-reference (`See [topic.md](topic.md) for the full taxonomy`).

### DO — Index With Cross-References

```markdown
## Sub-File Index

- **[test-3tier-strategy.md](test-3tier-strategy.md)** — Complete 3-tier guide: tier definitions, fixture patterns, CI/CD integration.
- **[probe-driven-verification.md](probe-driven-verification.md)** — Probe-driven verification runbook. Per `rules/probe-driven-verification.md`.
```

### DO NOT — Bury Sub-Files Without Surfacing Them

If SKILL.md doesn't mention `topic-X.md`, the model has no signal to load it. Sub-files without an entry in SKILL.md's index are dead weight.

## Skill-Embedded Rule Pattern

Some rules are scoped narrowly enough that they belong inside a single skill, not in the always-on rule set. These rules carry frontmatter `scope: skill-embedded` (per `rules/rule-authoring.md` §7) and their content is inlined into the SKILL.md body, not loaded as a standalone rule file.

```yaml
# In .claude/rules/<rule-name>.md frontmatter:
priority: 20
scope: skill-embedded
```

The rule body is referenced from SKILL.md so its content reaches the model only when the skill is active. This pattern keeps the always-on baseline lean while preserving the rule as a discoverable, version-controlled artifact.

### When To Use Skill-Embedded Scope

- Rule applies only when a specific workflow is in progress (e.g., a release-procedure rule that only matters during `/release`)
- Rule is a sub-domain of a larger skill that already activates semantically
- Rule's enforcement value is high when the domain is active, near-zero otherwise

### When NOT To Use Skill-Embedded Scope

- Rule applies cross-domain (use `scope: baseline` or `scope: path-scoped`)
- Rule needs hook-layer detection (skill-embedded scope has no hook surface)
- Rule is load-bearing for safety / compliance (those MUST be baseline or path-scoped)

## Cross-CLI Variant Overlays

A skill authored at `.codex/skills/<name>/SKILL.md` is the canonical source. CLI-specific deltas live at `variants/<cli>/skills/<name>/SKILL.md` (or sub-files) and overlay only the diverging slot. See `rules/cross-cli-parity.md` and `guides/co-setup/05-variant-architecture.md` for the full overlay semantics.

### Slot-Marker Pattern

Skills with CLI-specific content partition that content into slot blocks per the v6 §3.1 spec:

```markdown
<!-- slot:neutral-body -->

This content emits to all CLIs.

<!-- /slot:neutral-body -->

<!-- slot:examples -->

CLI-neutral examples — overridable per CLI.

<!-- /slot:examples -->
```

Variant files at `variants/<cli>/skills/<name>/SKILL.md` supply replacement bodies only for the slots that diverge. Slots not overridden inherit from the global file.

### Variant Examples In This Repo

- `.claude/variants/codex/rules/agents.md` — Codex-specific delegation examples for the agents rule
- `.claude/variants/py-codex/rules/worktree-isolation.md` — Python + Codex ternary overlay

Skills follow the same pattern; today most skill content is CLI-neutral and lives in the global tree alone.

## Common Mistakes

### 1. Over-Long Descriptions

Most-frequent failure. Description >200 chars; cumulative listing budget exceeded; skill becomes invisible to semantic activation. Fix: rewrite using failure-mode language, drop keyword alternates, target 80–180 chars.

### 2. SKILL.md As Index-Only

SKILL.md that's just a sub-file index forces the model to expand 3–5 sub-files for any routine question. Fix: pull the 80%-coverage content INTO SKILL.md; reserve sub-files for the long tail.

### 3. Tools List Mismatch

SKILL.md body references `Bash` or `Write` but frontmatter only lists `Read`. The runtime grants permissions based on frontmatter; the body will trigger permission prompts the author didn't expect. Fix: scan SKILL.md + every sub-file for tool invocations; mirror the union in frontmatter.

### 4. CC-Native Delegation Syntax In Skill Body

Skill prose that bakes in `Agent(subagent_type="...")` or `Task(...)` is BLOCKED for the same reason as workspace artifacts (per `rules/cross-cli-artifact-hygiene.md` MUST-1) — Codex / Gemini readers cannot parse the syntax. Use neutral phrasing: "delegate to security-reviewer", "dispatch reviewer and security-reviewer in parallel".

### 5. Skill Replaces Agent Knowledge

A skill is reference content. An agent is judgment + procedure. If a "skill" prescribes a workflow with conditional branches and recovery paths, it's really an agent. Fix: move workflow content to an agent file; leave the skill as the lookup table the agent reads.

## Audit Checklist

When auditing an existing skill:

- [ ] `description:` ≤ 200 chars, failure-mode language, no keyword-dump
- [ ] `name:` matches directory name
- [ ] `tools:` (or `allowed-tools:`) lists only what SKILL.md + sub-files invoke
- [ ] SKILL.md body 150–250 lines; answers 80% of routine questions
- [ ] Sub-files surfaced via index in SKILL.md
- [ ] No CC-native delegation syntax in prescriptive prose
- [ ] No `CLAUDE.md` as prescriptive authority (use "the baseline rules" or cite a rule by path)
- [ ] No hook event names in PascalCase (`SessionStart`, `PreToolUse`) as prescriptive identifiers
- [ ] If skill-embedded rules exist, they're inlined and the rule file carries `scope: skill-embedded`

## Related

- `rules/cc-artifacts.md` §1b — description ≤200 chars enforcement + 2026-05-06 evidence
- `rules/cc-artifacts.md` §2 — progressive disclosure 80/20
- `rules/rule-authoring.md` §7 — `priority:` + `scope:` for `skill-embedded` rules
- `rules/cross-cli-artifact-hygiene.md` — neutral phrasing in skill bodies
- `rules/cross-cli-parity.md` — variant overlay semantics for cross-CLI emission
- `guides/co-setup/05-variant-architecture.md` — single-source + overlay architecture
- `command-authoring` skill (F2) — command frontmatter + wrappers
- `hook-authoring` skill (F3) — hook lifecycle + validator-13 bijection
