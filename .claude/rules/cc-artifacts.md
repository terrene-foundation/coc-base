---
priority: 20
scope: excluded
exclude_from: [codex, gemini]
paths:
  - ".claude/agents/**"
  - ".claude/skills/**"
  - ".claude/commands/**"
  - ".claude/hooks/**"
---

# CC Artifact Quality Rules

<!-- slot:neutral-body -->

CC-specific residue. Runtime-neutral artifact quality (DO/DO NOT examples, Why: rationale, Loud/Linguistic/Layered test, dangling cross-references) lives in `rules/rule-authoring.md`; cross-CLI artifact rules live in `rules/variant-authoring.md`. See those for the general principles.

### 1. Agent Descriptions Under 120 Characters

Include trigger phrases ("Use when...", "Use for...").

```yaml
# DO:
description: "CC artifact architect. Use for auditing, designing, or improving agents, skills, rules, commands, hooks."

# DO NOT:
description: "A comprehensive specialist for Claude Code architecture who can audit and improve all types of CC artifacts including agents, skills, rules, commands, and hooks across the entire ecosystem."
```

**Why:** Descriptions load into every agent selection decision. Long descriptions waste tokens on every turn.

### 1b. Skill Descriptions Under 200 Characters

The `description:` field in `skills/*/SKILL.md` MUST be ≤200 characters. Failure-mode language only — keyword-dump patterns (`Use when asking about 'X', 'Y', 'Z', 'X with Y', ...` with ≥4 quoted alternates) are BLOCKED. Per `feedback_semantic_activation.md`: CC uses LLM semantic matching, not keyword lookup; long quoted-alternate lists DON'T improve activation, they inflate the listing budget.

```yaml
# DO — ≤200 chars, failure-mode framing
description: "Kailash validation: parameter, DataFlow, connection, import, workflow structure, security, codebase-hygiene marker scrubbing."

# DO — ≤200 chars, MANDATORY framing for skills with strong precondition
description: "Kailash ML — MANDATORY for ML training/inference/feature/drift/AutoML/RL. Engine-first km.* surface + 18 engines. Raw sklearn/pytorch BLOCKED."

# DO NOT — keyword dump pattern (575 chars, defeats semantic activation)
description: "Validation patterns and compliance checking for Kailash SDK including parameter validation, DataFlow pattern validation... Use when asking about 'validation', 'validate', 'check compliance', 'verify', 'lint', 'code review', 'parameter validation', 'connection validation', 'import validation', 'security validation', 'workflow validation', 'codebase hygiene', 'TODO marker scrub', 'marker cleanup', 'three-layer gate', or 'regex gate'."
```

**BLOCKED rationalizations:**

- "More keywords help discovery" (no — semantic matching, not keyword lookup)
- "200 chars is too short for a complex skill" (use the SKILL.md body for depth; description is the activation hook)
- "Other skills have long descriptions, mine should match" (those are the ones being trimmed)
- "The cap is arbitrary" (it isn't — total listing budget × 47 skills divides to ~200 chars/entry; longer descriptions get TRUNCATED out of the listing entirely)

**Why:** When ANY skill exceeds the per-entry cap OR the cumulative listing exceeds the budget fraction, CC drops descriptions from the listing — those skills become invisible to semantic activation. 2026-05-06 evidence: 47 of 47 skill descriptions were dropped because the cumulative description bytes exceeded the 1% budget fraction (≈10KB across 47 entries → ~213 chars/entry average; 18 skills exceeded that average and pushed cumulative over). Trimming the worst 18 to ≤200 chars freed ~3.5KB and restored full listing visibility. Same root cause as `agent-reasoning.md` MANDATORY framing: descriptions are the LLM's semantic-match input, not a search engine's keyword index.

### 2. Skills Follow Progressive Disclosure

SKILL.md MUST answer 80% of routine questions without requiring sub-file reads.

**Why:** Claude reads SKILL.md first. If it must read 5 additional files for basic answers, that's 5 unnecessary tool calls.

### 3. Commands Under 150 Lines

Move reference material to skills, review criteria to agents.

**Why:** Commands inject as user messages. Long commands compete with actual user intent.

### 4. CLAUDE.md Under 200 Lines

Contains repo-specific directives, absolute rules, and navigation tables. MUST NOT restate rules or embed reference material.

**Why:** CLAUDE.md loads on every turn. Every line beyond navigation and directives is wasted context.

### 5. Path-Scoped Rules Use `paths:` Frontmatter

Domain-specific rules MUST use `paths:` (not `globs:`) for YAML frontmatter scoping.

**Why:** `globs:` is not a recognized frontmatter key in Claude Code, so rules using it load on every file instead of being scoped, wasting context on irrelevant turns.

### 6. /codify Deploys cc-architect

Every `/codify` execution MUST include `cc-architect` in its validation team.

**Why:** Without artifact validation, `/codify` creates agents with 800-line knowledge dumps and unscoped rules.

### 7. Hooks Include Timeout Handling

Every hook MUST include a setTimeout fallback that returns `{ continue: true }` and exits.

```javascript
const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);
```

**Why:** A hanging hook blocks the entire Claude Code session indefinitely.

### 8. Workspace-Walking Hooks Filter Leading-Underscore Meta-Dirs

Hooks that enumerate `workspaces/<name>/` MUST filter directories whose name starts with underscore (`_archive`, `_template`, `_draft`, etc.) alongside the existing `instructions` skip. Pattern: `entries.filter(e => e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"))`. Same filter applies in any `for ... of entries` loop that walks the workspaces directory.

```javascript
// DO — filter both `instructions` and leading-underscore meta-dirs
const projects = entries.filter(
  (e) =>
    e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"),
);

// DO NOT — filter only `instructions` (leaves `_archive`, `_template` to surface as active)
const projects = entries.filter(
  (e) => e.isDirectory() && e.name !== "instructions",
);
```

**BLOCKED rationalizations:**

- "`_archive` is rarely the most-recent dir, the bug is theoretical"
- "We'll add the filter when someone hits the failure mode"
- "The hook only runs at SessionStart, low blast radius"
- "Operators can rename `_archive` to something else"

**Why:** Archival operations (`git mv workspaces/X workspaces/_archive/X`) bump `_archive/`'s mtime to most-recently-modified; without the filter, `detectActiveWorkspace` surfaces `_archive` as the active workspace, and `SessionEnd` routes journal stubs into `workspaces/_archive/journal/.pending/` — invisible drift the next session must triage. The same failure mode applies to `findAllSessionNotes` (SessionStart drift dashboards). Leading-underscore is the convention for workspace meta-dirs (`_archive`, `_template`, future `_draft`); filtering by prefix makes the contract durable as new meta-dir conventions emerge.

Origin: kailash-rs PR #759 (2026-05-02) — `git mv` of 4 workspaces into `_archive/` caused 3 SessionEnd stubs to land in `workspaces/_archive/journal/.pending/`. Fix landed at `.claude/hooks/lib/workspace-utils.js::detectActiveWorkspace` + `findAllSessionNotes`. Codified GLOBAL via /sync rs Gate 1 (2026-05-02 second cycle).

### 9. Audit Tools Ship With Committed Test Fixtures

Every mechanical audit tool (lint, grep-based check, sweep) added to `/cc-audit`, `/sweep`, or a hook MUST ship with at least one committed test fixture per scope-restriction predicate the tool relies on. Fixtures live under `.claude/audit-fixtures/<tool-name>/` with a per-fixture expected-output file.

```text
# DO — fixture committed alongside the lint
.claude/audit-fixtures/frontmatter-lint/
  fixture-01-real-rule.md          ← real rule shape, expects empty output
  fixture-01-real-rule.expected
  fixture-02-invalid-key.md        ← invalid key in opening frontmatter, expects flag
  fixture-02-invalid-key.expected
  fixture-03-body-example.md       ← invalid key in body fenced block, expects empty output
  fixture-03-body-example.expected

# DO NOT — only prose description in spec, no committed fixture
specs/lint-mechanism.md says "test the lint with a stub file containing X..."
(no fixture on disk; future contributor must reconstruct from prose)
```

**BLOCKED responses:**

- "Synthetic fixtures are temp files; committing them is overhead"
- "The validation gate is described in the spec; fixtures duplicate that"
- "I'll add fixtures later when someone modifies the audit tool"
- "The audit tool is too simple to need fixtures"

**Why:** Mechanical audit tools have non-obvious scope-restriction predicates (block-scoping, glob anchoring, regex word boundaries) that future modifications can silently weaken. Committed fixtures make those regressions mechanically detectable before the audit produces false positives at scale and gets disabled, which would restore the original bug class.

Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (load-bearing `i==1` invariant case study + adversarial /vet round). Inbound from atelier `/sync-to-coc`.

### 10. Mechanical Sweeps Use Positive Allowlists Where Vocabulary Is Enumerable

When a mechanical audit sweep (in `/cc-audit`, `/sweep`, or a hook) checks for membership in an enumerable vocabulary, the sweep MUST be implemented as a positive allowlist (flag everything not in the allowlist) rather than an enumerated denylist (flag only specific known-bad entries).

```text
# DO — positive allowlist (catches unknown bad entries)
awk '... /^[A-Za-z][A-Za-z0-9-]*:/ && !/^paths:/' .claude/rules/*.md
# Flags any YAML-style key in opening frontmatter except paths:.
# Catches any future typo (pathRegex:, applies_to:, match:, etc.)
# without enumerating each one.

# DO NOT — enumerated denylist (catches only specifically known bad entries)
awk '... /^(globs|applies_to|pathRegex|match|scope):/ ...' .claude/rules/*.md
# Catches exactly the keys someone has thought of. Misses every novel
# typo until it appears, gets diagnosed, gets added to the list, and
# the list is re-shipped.
```

**BLOCKED responses:**

- "Denylist is more conservative; allowlist might false-positive"
- "We don't know all the valid keys yet; can't write an allowlist"
- "The denylist works fine; just add new entries when bugs appear"
- "Allowlist requires more thought; denylist is faster to ship"

**Why:** A denylist scales linearly with brainstormed typos and never closes the bug class — audit sweeps exist to catch silent failures, which by definition are "things that should be flagged but currently aren't." An allowlist closes the class on day one by shifting the cost from diagnosing future silent failures to documenting valid vocabulary upfront, which is small and one-time for enumerable vocabularies (frontmatter keys, hook events, license names).

**Scope clarification:** This rule applies when the vocabulary IS enumerable. For non-enumerable vocabularies (e.g., free-form prose, user-generated content), positive allowlists are not feasible; denylists or pattern matching may be the only option. A sweep using denylist style for a non-enumerable vocabulary should note the rationale in its surrounding documentation; this is guidance, not a separate MUST.

Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (allowlist vs denylist trade-off). Inbound from atelier `/sync-to-coc`.

## MUST NOT

- **No knowledge dumps**: Agent files ≤400 lines. Extract reference to skills.

**Why:** Oversized agent files are loaded into context on every delegation, consuming thousands of tokens that crowd out the actual task.

- **No CLAUDE.md duplication**: Skills and rules MUST NOT repeat CLAUDE.md content.

**Why:** Duplicated content loads twice per turn -- once from CLAUDE.md (always loaded) and once from the rule/skill -- doubling context cost for zero benefit.

- **No semantic analysis in hooks**: Hooks check structure; agents check semantics.

**Why:** Hooks run synchronously with hard timeouts; semantic analysis is slow and non-deterministic, causing spurious hook failures that block the session.

<!-- /slot:neutral-body -->
