---
id: "CC-ARTIFACTS"
paths: [".claude/agents/**", ".claude/skills/**", ".claude/commands/**", ".claude/hooks/**"]
applies_to: ["claude-code"]
---

# CC Artifact Quality Rules

CC-specific residue. Runtime-neutral artifact quality lives in `rules/rule-authoring.md`; cross-CLI artifact rules in `rules/variant-authoring.md`. The no-dangling-cross-references discipline is the MUST NOT below.

### 1. Agent Descriptions Under 120 Characters

Include trigger phrases ("Use when...", "Use for...").

```yaml
# DO:
description: "CC artifact architect. Use for auditing, designing, or improving agents, skills, rules, commands, hooks."

# DO NOT:
description: "A comprehensive specialist for Claude Code architecture who can audit and improve all types of CC artifacts …" # 200+ chars
```

**Why:** Descriptions load into every agent selection decision. Long descriptions waste tokens on every turn.

### 1b. Skill Descriptions Under 200 Characters

The `description:` field in `skills/*/SKILL.md` MUST be ≤200 characters. Failure-mode language only — keyword-dump patterns (`Use when asking about 'X', 'Y', 'Z', 'X with Y', ...` with ≥4 quoted alternates) are BLOCKED.

```yaml
# DO — ≤200 chars, failure-mode framing
description: "Kailash validation: parameter, DataFlow, connection, import, workflow structure, security, codebase-hygiene marker scrubbing."

# DO — ≤200 chars, MANDATORY framing for skills with strong precondition
description: "Kailash ML — MANDATORY for ML training/inference/feature/drift/AutoML/RL. Engine-first km.* surface + 18 engines. Raw sklearn/pytorch BLOCKED."

# DO NOT — keyword dump pattern (575 chars, defeats semantic activation; full text: extract § Rule 1b)
description: "Validation patterns and compliance checking for Kailash SDK... Use when asking about 'validation', 'verify', 'lint', … 14 more quoted alternates …"
```

**BLOCKED rationalizations:**

- "More keywords help discovery" (no — semantic matching, not keyword lookup)
- "200 chars is too short for a complex skill" (use the SKILL.md body for depth; description is the activation hook)
- "Other skills have long descriptions, mine should match" (those are the ones being trimmed)
- "The cap is arbitrary" (it isn't — the per-entry cap is the listing budget divided across the skill set; extract § Rule 1b)

**Why:** When ANY skill exceeds the per-entry cap OR the cumulative listing exceeds the budget fraction, CC drops descriptions from the listing — those skills become invisible to semantic activation.

Depth — the measured listing-budget evidence and semantic-activation mechanics — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 1b.

### 2. Skills Follow Progressive Disclosure

SKILL.md MUST answer 80% of routine questions without requiring sub-file reads.

**Why:** Claude reads SKILL.md first. If it must read 5 additional files for basic answers, that's 5 unnecessary tool calls.

### 3. Commands Under 150 Lines

Move reference material to skills, review criteria to agents.

**Why:** Commands inject as user messages. Long commands compete with actual user intent.

**Named-rationale exception (procedural commands only).** A command MAY exceed 150 lines ONLY when ALL THREE hold: (a) the body is genuinely PROCEDURAL — an ordered multi-step runbook whose steps are load-bearing and NON-extractable to a skill without fragmenting the step sequence (a command that is mostly reference material FAILS this — extract it and restore ≤150); (b) redundancy was minimized FIRST (no duplicated rationale, no verbose comments); (c) a named length-rationale is recorded in the `/govern`/`/codify` receipt journal that LANDS the overage, stating the line count, why the overage is procedural-non-decomposable, and what was trimmed (which receipt: extract § Rule 3). Overage without all three is BLOCKED.

```markdown
# DO — /sweep at ~166 lines: 9 ordered load-bearing sweeps; receipt records the named rationale + the redundancy trimmed

# DO NOT — a 170-line command that is 40 lines of reference tables (extract the tables to a skill, restore ≤150)
```

**BLOCKED rationalizations:**

- "It's over but the content is all important" (procedural-non-decomposable is the test, NOT importance)
- "I'll add the rationale to the receipt later"
- "Another command is already over, so mine can be too" (each overage needs its OWN named rationale)
- "150 is arbitrary"

**Why (exception):** A genuinely procedural runbook (9 ordered sweeps; an N-step ceremony) is the command-analogue of the >200-line rule the meta-rule permits with a named rationale (`rule-authoring.md` MUST NOT § "Rules longer than 200 lines"); forcing extraction fragments the ordered step sequence. The three conditions keep the escape narrow: only load-bearing PROCEDURE earns it. Contrast `/onboard` (`knowledge-convergence.md` MUST-5 extracted its runbook depth to `skills/41-onboard/`): reference-depth is extractable, ordered irreducible procedure is not.

### 4. CLAUDE.md Under 200 Lines

Contains repo-specific directives, absolute rules, and navigation tables. MUST NOT restate rules or embed reference material.

**Why:** CLAUDE.md loads on every turn. Every line beyond navigation and directives is wasted context.

### 4a. Baseline Artifacts MUST Be Cache-Stable

The per-CLI baseline (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`), every `scope: baseline` rule, and the agent/skill/command listings form the CACHED system-prompt prefix of every consumer session. They MUST NOT carry per-turn-varying content — a date/timestamp, a session ID/UUID, or a value computed fresh at load time. Listings MUST emit in a DETERMINISTIC order (prompt caching is a prefix match).

```text
# DO — accurate STATIC count (updated when it changes), deterministic ordering
## Agents (38 total)

# DO NOT — load-time-interpolated count or date in the always-on baseline
## Agents ({{agent_count}} total) — generated 2026-06-27
```

**Why:** A mutating byte in the always-on prefix invalidates the cache every turn across all 30 consumers, dropping each off the ~0.1× cache-read path onto the 1× full-input path — the most expensive authoring mistake a distributor can ship, and invisible without `usage.cache_read_input_tokens`. "Fix the stale count" is therefore a STATIC-accurate edit, never a dynamic-interpolation one (mechanics: `skills/30-claude-code-patterns/prompt-caching-coc-artifacts.md`).

### 5. Path-Scoped Rules Use `paths:` Frontmatter

Domain-specific rules MUST use `paths:` (not `globs:`) for YAML frontmatter scoping.

**Why:** `globs:` is not a recognized frontmatter key in Claude Code, so rules using it load on every file instead of being scoped, wasting context on irrelevant turns.

### 6. /codify Deploys cc-architect

Every `/codify` execution MUST include `cc-architect` in its validation team.

**Why:** Without artifact validation, `/codify` creates agents with 800-line knowledge dumps and unscoped rules.

### 6a. cc-architect R1 Closure-Parity Sweeps Recently-Landed Proposals

cc-architect's Round-1 mechanical sweep at `/codify` MUST verify closure-parity against (i) every other rule/proposal landed in the SAME codify cycle AND (ii) any baseline rule whose last Origin date is within the prior 7 calendar days — sweeping overlapping Violation-scope declarations, Why failure-mode claims, and BLOCKED-rationalization corpus entries. Scoping the R1 sweep to the diff under review alone is BLOCKED. The sweep MUST log its target list to the cycle's receipt journal under "R1 closure-parity sweep targets:"; a cycle shipping without that line is flagged at the next `/codify` as a same-class violation.

**Why:** Sibling rule amendments landing in one cycle carry adjacent Violation scopes and partial BLOCKED-corpus overlap that per-diff review approves in isolation; collisions then surface a round late (or at loom Gate-1). The 7-day window matches the trust-posture grace period.

### 7. Hooks Include Timeout Handling

Every hook MUST include a setTimeout fallback that returns `{ continue: true }` and exits — armed inside the exported `hookMain()`, never at module load (Rule 7a).

```javascript
const TIMEOUT_MS = 5000;
function hookMain() {
  setTimeout(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  // … read stdin, decide, emit …
}
```

**Why:** A hanging hook blocks the entire Claude Code session indefinitely.

### 7a. A New Hook Registers A Detector, Not A Process

A new CC hook MUST be registered as a group entry in `hooks/dispatch-registry.json` (run in-process by `dispatch.js <Event>`), export `hookMain()`, and have no side effects on `require()`. A new direct `settings.json` hook entry is BLOCKED (`hook-registration-regrowth.test.mjs`); a lexical advisory check goes to gate review instead (`probe-driven-verification.md` MUST-4).

```javascript
// DO — detector: dispatch-registry.json group entry + exported hookMain + CLI guard
module.exports = { hookMain };
if (require.main === module) hookMain();
// DO NOT — a new settings.json entry, or a hook that starts reading stdin at load time
```

**Why:** Every direct entry started its own node process on every matching tool call in every consumer — 23 per Bash call, two thirds of the per-call hook CPU spent starting node.

### 8. Workspace-Walking Hooks Filter Leading-Underscore Meta-Dirs

Hooks that enumerate `workspaces/<name>/` MUST filter directories whose name starts with underscore (`_archive`, `_template`, `_draft`, etc.) alongside the existing `instructions` skip. The same filter applies in any `for ... of entries` loop that walks the workspaces directory.

```javascript
// DO — filter both `instructions` and leading-underscore meta-dirs
entries.filter(
  (e) =>
    e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"),
);

// DO NOT — filter only `instructions` (leaves `_archive`, `_template` to surface as active)
entries.filter((e) => e.isDirectory() && e.name !== "instructions");
```

**BLOCKED rationalizations:**

- "`_archive` is rarely the most-recent dir, the bug is theoretical"
- "We'll add the filter when someone hits the failure mode"
- "The hook only runs at SessionStart, low blast radius"
- "Operators can rename `_archive` to something else"

**Why:** Archival operations (`git mv workspaces/X (loom-internal reference)`) bump `_archive/`'s mtime to most-recently-modified; without the filter, `.claude/hooks/lib/workspace-utils.js::detectActiveWorkspace` surfaces `_archive` as the active workspace, and `SessionEnd` routes journal stubs into (loom-internal reference) — invisible drift the next session must triage.

Depth — the `findAllSessionNotes` sibling surface, the leading-underscore meta-dir convention, and the mutation-tool SSOT extension path (`.claude/hooks/lib/tool-classes.js::MUTATION_TOOLS`, swept by `tests/integration/multi-operator/c2-auth-hardening-iter3.test.js`) — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 8.

### 9. Audit Tools Ship With Committed Test Fixtures

Every mechanical audit tool (lint, grep-based check, sweep) added to `/cc-audit`, `/sweep`, or a hook MUST ship with at least one committed test fixture per scope-restriction predicate the tool relies on. Fixtures live under `.claude/audit-fixtures/<tool-name>/` with a per-fixture expected-output file.

```text
# DO — fixture + .expected sidecar committed alongside the lint
.claude/audit-fixtures/frontmatter-lint/
  fixture-01-real-rule.md   + .expected   ← real rule shape, expects empty output
  fixture-02-invalid-key.md + .expected   ← invalid key in opening frontmatter, expects flag
  fixture-03-body-example.md + .expected  ← invalid key in a body fence, expects empty output

# DO NOT — only a prose description in the spec, no committed fixture
specs/lint-mechanism.md: "test the lint with a stub file containing X..."  (nothing on disk)
```

Cases MAY be sidecars (above) OR inline in `run.mjs` — the runner contract (assert expected vs actual + non-zero exit on mismatch) is the load-bearing primitive; layout is operator-choice (inline variant: `.claude/audit-fixtures/codex-dispatcher/README.md`). Depth — the sidecar-vs-inline layouts — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 9 — Fixture Layout.

**BLOCKED responses:**

- "Synthetic fixtures are temp files; committing them is overhead"
- "The validation gate is described in the spec; fixtures duplicate that"
- "I'll add fixtures later when someone modifies the audit tool"
- "The audit tool is too simple to need fixtures"

**Why:** Mechanical audit tools have non-obvious scope-restriction predicates that future modifications can silently weaken. Committed fixtures make those regressions mechanically detectable before the audit produces false positives at scale and gets disabled, which would restore the original bug class.

**Generalized to ALL COC artifact types + a semantic-probe half by `rules/coc-artifact-eval-coverage.md`** — a `type:tool` entry stays fixture-only, so Rule 9 governs the tool subset. Informational only — no new MUST here.

Depth — the two-tier SHAPE-vs-EFFICACY split and the `probes:null` bootstrap note — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 9 — Generalization.

### 10. Mechanical Sweeps Use Positive Allowlists Where Vocabulary Is Enumerable

When a mechanical audit sweep (in `/cc-audit`, `/sweep`, or a hook) checks for membership in an enumerable vocabulary, the sweep MUST be implemented as a positive allowlist (flag everything not in the allowlist) rather than an enumerated denylist (flag only specific known-bad entries).

```text
# DO — positive allowlist (flags any frontmatter key except paths:, so future
# typos like pathRegex:/applies_to:/match: are caught without enumerating them)
awk '... /^[A-Za-z][A-Za-z0-9-]*:/ && !/^paths:/' .claude/rules/*.md

# DO NOT — enumerated denylist (catches only the keys someone thought of; every
# novel typo ships until it appears, is diagnosed, is added, and is re-released)
awk '... /^(globs|applies_to|pathRegex|match|scope):/ ...' .claude/rules/*.md
```

**BLOCKED responses:**

- "Denylist is more conservative; allowlist might false-positive"
- "We don't know all the valid keys yet; can't write an allowlist"
- "The denylist works fine; just add new entries when bugs appear"
- "Allowlist requires more thought; denylist is faster to ship"

**Why:** A denylist scales linearly with brainstormed typos and never closes the bug class — audit sweeps exist to catch silent failures, which by definition are "things that should be flagged but currently aren't." An allowlist closes the class on day one; the cost argument is extract § Rule 10.

**Scope clarification:** this rule applies when the vocabulary IS enumerable; for non-enumerable vocabularies (free-form prose, user-generated content) denylists or pattern matching may be the only option, and a sweep using denylist style there should note the rationale in its surrounding documentation — guidance, not a separate MUST.

## MUST NOT

- **No knowledge dumps**: Agent files ≤400 lines. Extract reference to skills.

**Why:** Oversized agent files are loaded into context on every delegation, consuming thousands of tokens that crowd out the actual task.

- **No Dangling Cross-References After Extraction**: When extracting reference material from an agent / command / rule to a skill, MUST verify every cross-reference in the trimmed file still points to an existing file AND a real clause. When removing a skill / agent / rule from a repo, MUST `grep` for references in the remaining files and update each one.

```text
# DO — after removing skills/10-governance/, grep for refs and re-point each
grep -rn "10-governance" .claude/agents/ .claude/commands/ .claude/rules/  # find → re-point or delete each ref
# DO NOT — rm -rf skills/10-governance/ leaving dangling refs in agent / rule files
```

**Why:** Dangling references cause file-not-found errors when an agent tries to load a referenced skill, degrading agent performance; the trim-direction half also catches a redirect that resolves to a file but not to a clause. An extraction is "complete" only when every surviving reference still resolves to real content.

- **No CLAUDE.md duplication**: Skills and rules MUST NOT repeat CLAUDE.md content.

**Why:** Duplicated content loads twice per turn -- once from CLAUDE.md (always loaded) and once from the rule/skill -- doubling context cost for zero benefit.

- **No semantic analysis in hooks**: Hooks check structure; agents check semantics.

**Why:** Hooks run synchronously with hard timeouts; semantic analysis is slow and non-deterministic, causing spurious hook failures that block the session.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **CC-artifact-quality scope** — 10+ numbered rules, each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates. `priority: 20` + `scope: excluded` (CC-only, path-scoped — loaded only on `.claude/**` edits, never baseline), so it pays NO baseline-emission cost, and splitting would fragment the surface. Per that MUST NOT, overage is permitted with a named rationale.

Origins — per-rule provenance for Rules 3, 8, 9 and 10, plus every depth block extracted from this file — live in `.claude/guides/rule-extracts/cc-artifacts.md`.
