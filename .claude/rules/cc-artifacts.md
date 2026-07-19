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

CC-specific residue. Runtime-neutral artifact quality (DO/DO NOT examples, Why: rationale, Loud/Linguistic/Layered test) lives in `rules/rule-authoring.md`; cross-CLI artifact rules live in `rules/variant-authoring.md`. See those for the general principles. The no-dangling-cross-references discipline (verify cross-refs after extraction; grep for references after removal) is the MUST NOT § "No Dangling Cross-References After Extraction" below.

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

**Named-rationale exception (procedural commands only).** A command MAY exceed 150 lines ONLY when ALL THREE hold: (a) the body is genuinely PROCEDURAL — an ordered multi-step runbook whose steps are load-bearing and NON-extractable to a skill without fragmenting the step sequence (a command that is mostly reference material FAILS this — extract it and restore ≤150); (b) redundancy was minimized FIRST (no duplicated rationale, no verbose comments); (c) a named length-rationale is recorded in the `/govern`/`/codify` receipt journal that LANDS the overage (commands carry no Origin footer; for a pre-existing command amended into overage this is the amending codify's receipt, not the command's first-creation receipt), stating the line count, why the overage is procedural-non-decomposable, and what was trimmed. Overage without all three is BLOCKED.

```markdown
# DO — /sweep at ~166 lines: 9 ordered load-bearing sweeps; receipt records the named rationale + the redundancy trimmed

# DO NOT — a 170-line command that is 40 lines of reference tables (extract the tables to a skill, restore ≤150)
```

**BLOCKED rationalizations:**

- "It's over but the content is all important" (procedural-non-decomposable is the test, NOT importance)
- "I'll add the rationale to the receipt later"
- "Another command is already over, so mine can be too" (each overage needs its OWN named rationale)
- "150 is arbitrary"

**Why (exception):** A genuinely procedural runbook (9 ordered sweeps; an N-step ceremony) is the command-analogue of the >200-line rule the meta-rule permits with a named rationale (`rule-authoring.md` MUST NOT § "Rules longer than 200 lines"); forcing extraction fragments the ordered step sequence the command exists to carry. The three conditions keep the escape narrow — reference material still extracts to skills; only load-bearing PROCEDURE earns the overage. Contrast `/onboard` (`knowledge-convergence.md` MUST-5 forced it ≤150 by extracting its runbook DEPTH — JSON schema, matrices — to `skills/41-onboard/`): condition (a) resolves both the SAME way — reference-depth is extractable (`/onboard`), ordered irreducible procedure is not (`/sweep`); the two dispositions are consistent, not opposed.

Origin: 2026-07-04 — surfaced by the Directive-2 self-referential redteam (reviewer vs cc-architect disagreement on the `/sweep` 9th-sweep overage), resolved by-construction by adding the command-escape parallel to the pre-existing rules-cap escape; receipt journal/0429.

### 4. CLAUDE.md Under 200 Lines

Contains repo-specific directives, absolute rules, and navigation tables. MUST NOT restate rules or embed reference material.

**Why:** CLAUDE.md loads on every turn. Every line beyond navigation and directives is wasted context.

### 4a. Baseline Artifacts MUST Be Cache-Stable

The per-CLI baseline (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`), every `scope: baseline` rule, and the agent/skill/command listings form the CACHED system-prompt prefix of every consumer session. They MUST NOT carry per-turn-varying content — a date/timestamp, a session ID/UUID, or a value computed fresh at load time. Listings MUST emit in a DETERMINISTIC order. Prompt caching is a prefix match: any byte change invalidates the cached prefix for the rest of the session.

```text
# DO — accurate STATIC count (updated when it changes), deterministic ordering
## Agents (38 total)

# DO NOT — load-time-interpolated count or date in the always-on baseline
## Agents ({{agent_count}} total) — generated 2026-06-27
```

**Why:** A mutating byte in the always-on prefix invalidates the cache every turn across all 30 consumers, dropping each off the ~0.1× cache-read path onto the 1× full-input path — the most expensive authoring mistake a distributor can ship, and invisible without `usage.cache_read_input_tokens`. This makes "fix the stale count" a STATIC-accurate edit, never a dynamic-interpolation one. Mechanics + the loom#678 size-vs-stability composition: `skills/30-claude-code-patterns/prompt-caching-coc-artifacts.md`.

### 5. Path-Scoped Rules Use `paths:` Frontmatter

Domain-specific rules MUST use `paths:` (not `globs:`) for YAML frontmatter scoping.

**Why:** `globs:` is not a recognized frontmatter key in Claude Code, so rules using it load on every file instead of being scoped, wasting context on irrelevant turns.

### 6. /codify Deploys cc-architect

Every `/codify` execution MUST include `cc-architect` in its validation team.

**Why:** Without artifact validation, `/codify` creates agents with 800-line knowledge dumps and unscoped rules.

### 6a. cc-architect R1 Closure-Parity Sweeps Recently-Landed Proposals

cc-architect's Round-1 mechanical sweep at `/codify` MUST verify closure-parity against (i) every other rule/proposal landed in the SAME codify cycle AND (ii) any baseline rule whose last Origin date is within the prior 7 calendar days — sweeping overlapping Violation-scope declarations, overlapping Why failure-mode claims, and overlapping BLOCKED-rationalization corpus entries. Scoping the R1 sweep to the diff under review alone is BLOCKED. The sweep MUST log its target list to the cycle's receipt journal under "R1 closure-parity sweep targets:"; a cycle shipping without that line is flagged at the next `/codify` as a same-class violation.

**Why:** Sibling rule amendments landing in one cycle carry adjacent Violation scopes and partial BLOCKED-corpus overlap that per-diff review approves in isolation; collisions then surface a round late (or at loom Gate-1). The 7-day window matches the trust-posture grace period, also catching rules still inside grace from the prior week.

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

**Why:** Archival operations (`git mv workspaces/X (loom-internal reference)`) bump `_archive/`'s mtime to most-recently-modified; without the filter, `detectActiveWorkspace` surfaces `_archive` as the active workspace, and `SessionEnd` routes journal stubs into (loom-internal reference) — invisible drift the next session must triage. The same failure mode applies to `findAllSessionNotes` (SessionStart drift dashboards). Leading-underscore is the convention for workspace meta-dirs (`_archive`, `_template`, future `_draft`); filtering by prefix makes the contract durable as new meta-dir conventions emerge.

Origin: the Rust SDK PR #759 (2026-05-02) — `git mv` of 4 workspaces into `_archive/` caused 3 SessionEnd stubs to land in (loom-internal reference). Fix landed at `.claude/hooks/lib/workspace-utils.js::detectActiveWorkspace` + `findAllSessionNotes`. Codified GLOBAL via /sync rs Gate 1 (2026-05-02 second cycle).

**Related — mutation-tool SSOT extension path:** when Anthropic ships a new mutation tool surface (a tool that writes to the working tree), the canonical extension is `.claude/hooks/lib/tool-classes.js::MUTATION_TOOLS`. Append the tool name to the Set; every hook consulting `isMutationTool(tool)` picks up the change automatically. No per-site sweep required. The iter-3 structural sweep test at `tests/integration/multi-operator/c2-auth-hardening-iter3.test.js` enforces "no bare `tool === 'Edit' || tool === 'Write'`" via `grep -rn` exit-code assertions; missed extensions surface as sweep failures.

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

Fixtures MAY use per-case sidecar files (as shown above) OR inline-case definition in `run.mjs`/`run.test.js` — the runner contract (assert expected vs actual + non-zero exit on mismatch) is the load-bearing primitive; the storage layout is operator-choice (see `.claude/audit-fixtures/codex-dispatcher/README.md` § "Fixture layout" for the inline-runner variant and selection criteria; receipts: cc-architect R2 LOW-2 + journal/0167 § R3 wave).

**BLOCKED responses:**

- "Synthetic fixtures are temp files; committing them is overhead"
- "The validation gate is described in the spec; fixtures duplicate that"
- "I'll add fixtures later when someone modifies the audit tool"
- "The audit tool is too simple to need fixtures"

**Why:** Mechanical audit tools have non-obvious scope-restriction predicates (block-scoping, glob anchoring, regex word boundaries) that future modifications can silently weaken. Committed fixtures make those regressions mechanically detectable before the audit produces false positives at scale and gets disabled, which would restore the original bug class.

Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (load-bearing `i==1` invariant case study + adversarial /vet round). Inbound from atelier `/sync-to-coc`.

**Generalized to ALL COC artifact types + a semantic-probe half by `rules/coc-artifact-eval-coverage.md`.** This rule mandates committed structural fixtures for mechanical audit TOOLS; `coc-artifact-eval-coverage.md` lifts that contract to every COC artifact type (rule / agent / skill / command / hook) AND adds the LLM-judge probe tier (a structural fixture proves SHAPE; a probe proves EFFICACY). A `type:tool` entry stays fixture-only (`probes:null` per its bootstrap note — an audit tool's correctness is its committed fixtures/self-tests, not an LLM-judge probe of the very engine that dispatches probes), so this Rule 9 remains the governing contract for the tool subset; the two-tier generalization applies to the prose/behavioral artifact types. Informational cross-reference only — no new MUST here.

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

- **No Dangling Cross-References After Extraction**: When extracting reference material from an agent / command / rule to a skill, MUST verify every cross-reference in the trimmed file still points to an existing file AND a real clause. When removing a skill / agent / rule from a repo, MUST `grep` for references in the remaining files and update each one.

```text
# DO — after removing skills/10-governance/, grep for refs and re-point each
grep -rn "10-governance" .claude/agents/ .claude/commands/ .claude/rules/  # find → re-point or delete each ref
# DO NOT — rm -rf skills/10-governance/ leaving dangling refs in agent / rule files
```

**Why:** Dangling references cause file-not-found errors when an agent tries to load a referenced skill, degrading agent performance; the trim-direction half also catches a redirect that points at a concept the target file never carries (a reference that resolves to a file but not to a clause). An extraction is "complete" only when every surviving reference still resolves to real content.

- **No CLAUDE.md duplication**: Skills and rules MUST NOT repeat CLAUDE.md content.

**Why:** Duplicated content loads twice per turn -- once from CLAUDE.md (always loaded) and once from the rule/skill -- doubling context cost for zero benefit.

- **No semantic analysis in hooks**: Hooks check structure; agents check semantics.

**Why:** Hooks run synchronously with hard timeouts; semantic analysis is slow and non-deterministic, causing spurious hook failures that block the session.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body exceeds the 200-line guidance. Named rationale: **CC-artifact-quality scope** — the rule enumerates 10+ numbered CC-artifact-quality rules (descriptions, progressive disclosure, command/CLAUDE.md size caps, cache-stability, `paths:` frontmatter, /codify cc-architect deploy, hook timeout/meta-dir/SSOT discipline, committed audit fixtures, positive-allowlist sweeps) each carrying the DO/DO-NOT + `**Why:**` + per-rule `Origin:` the meta-rule mandates. The rule is `priority: 20` + `scope: excluded` + `exclude_from: [codex, gemini]` (CC-only, path-scoped — loaded only on `.claude/**` edits, never baseline), so it pays NO always-on baseline-emission cost; splitting would fragment the CC-artifact-quality surface across files and force cross-rule lookups for every artifact-authoring decision. Per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines": overage is permitted with named rationale. Sibling precedent: `user-flow-validation.md` + `artifact-flow.md` length rationales.

<!-- /slot:neutral-body -->
