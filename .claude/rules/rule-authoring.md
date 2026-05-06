---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/rules/**"
  - "**/.claude/variants/**/rules/**"
---

# Rule Authoring Meta-Rule

<!-- slot:neutral-body -->

Rules are the agent's linguistic tripwires. This meta-rule defines how all other rules MUST be authored so that each new rule compounds the effect of the existing ones instead of diluting it.

Origin: journal/0052-DISCOVERY-session-productivity-patterns.md §6. Validated by subprocess A/B test: rule quality improved from 2/6 to 6/6 when this meta-rule was loaded.

See `guides/deterministic-quality/01-rule-authoring-principles.md` for full evidence, anti-patterns, and reproduction protocol.

## MUST Rules

### 1. Phrased As Prohibitions, Not Encouragements

Every rule's load-bearing clauses MUST use `MUST` or `MUST NOT`. The words "should," "try to," "prefer," and "consider" are BLOCKED as the primary modal of a rule clause.

```markdown
# DO

### 1. Bulk Ops MUST Log Partial Failures at WARN

# DO NOT

### 1. Bulk Ops Should Log Partial Failures
```

**Why:** "Should" tells the agent it is permitted to skip. Under time pressure, everything permitted to be skipped is skipped. Evidence: gate reviews phrased as "recommended" were skipped 6/6 times in 0052.

### 2. Linguistic Tripwires Enumerate BLOCKED Phrases Verbatim

When a rule targets a behavior the agent is prone to rationalize, it MUST include the exact excuse phrases marked BLOCKED.

```markdown
# DO

**BLOCKED responses:**

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- ANY acknowledgement without an actual fix

# DO NOT

Do not defer work. Address issues as you find them.
```

**Why:** Abstract "do not defer" is trivially rationalized. Verbatim blocked phrases block the rationalization at the linguistic level. Subprocess test confirmed: without BLOCKED phrases, agent said "scope creep, leave it alone."

### 3. Every MUST Clause Has DO / DO NOT Examples

Every `MUST` or `MUST NOT` clause MUST include a concrete example showing both the correct and blocked pattern.

**Why:** Without examples, the agent reconstructs meaning from context and gets it wrong at edges. The example is the unambiguous anchor.

### 4. Every MUST Clause Has A `**Why:**` Line

Every `MUST` and `MUST NOT` clause MUST be followed by a `**Why:**` line (2 sentences max) explaining the failure mode the rule prevents.

**Why:** The `Why:` line converts a rote rule into a principle the agent can apply to situations the rule-author never imagined. It also serves as institutional memory when the rule becomes a backstop for a code primitive.

### 5. Rules Are Path-Scoped Unless Classified As Baseline

Every rule with `scope: path-scoped` (Rule 7) MUST include `paths:` YAML frontmatter matching the file patterns where it applies. Rules with `scope: baseline` MUST NOT include `paths:` (baseline rules emit to AGENTS.md / CLAUDE.md always-on). Rules with `scope: skill-embedded` MUST NOT include `paths:` (they are inlined into a skill's SKILL.md, not loaded as standalone rules).

**Why:** Per 0051-DISCOVERY, rules without `paths:` pay full token cost in every session's baseline — which is the correct behavior for CRIT baseline rules (zero-tolerance, security, agents, etc.) and the wrong behavior for everything else. Wide patterns (`**/*.py`) for path-scoped rules are fine; the classification is set by Rule 7's `priority:` + `scope:` pair per v6 §A.1.

### 6. Rule Credits the Originating Journal Entry

Every new rule MUST include a one-line `Origin:` reference pointing to the journal entry or discovery that motivated it.

**Why:** A rule is a frozen response to a past failure. Without provenance, future agents cannot judge whether the rule still applies after the underlying failure mode has been fixed.

### 7. Rule Declares `priority:` And `scope:` In Frontmatter

Every rule MUST declare both `priority:` (0 CRIT baseline / 10 HIGH path-scoped / 20 MED/LOW skill-embedded-or-excluded) and `scope:` (`baseline` / `path-scoped` / `skill-embedded` / `excluded`) in YAML frontmatter. Pair must be consistent: priority:0 requires scope:baseline; priority:10 requires scope:path-scoped + `paths:`; priority:20 pairs with scope:skill-embedded or scope:excluded. `scope: excluded` rules additionally declare `exclude_from: [<cli>, ...]` listing the CLIs the rule is suppressed from (the rule still emits to the other CLIs; "excluded" scopes to specific CLI targets, not wholesale removal). Mismatches are BLOCKED at emission-time validation per v6 §A.1.

DO — baseline CRIT rule frontmatter:

    priority: 0
    scope: baseline

DO — path-scoped HIGH rule frontmatter:

    priority: 10
    scope: path-scoped
    paths:
      - "**/packages/**"

DO — excluded rule (CC-only):

    priority: 20
    scope: excluded
    exclude_from: [codex, gemini]

DO NOT — missing priority or mismatched pair:

    paths:
      - "**/*.py"
    # ← no priority; emitter falls back to filename heuristic → drift
    priority: 0
    scope: path-scoped
    # ← CRIT baseline cannot be path-scoped; emission validator blocks

**BLOCKED rationalizations:**

- "The emitter can infer priority from the filename"
- "`paths:` being present is enough signal"
- "I'll add priority when the emitter needs it"
- "The combo `priority: 0` + `scope: path-scoped` is harmless"
- "scope is implied by priority, declaring both is redundant"

**Why:** Priority drives which CLI surface the rule emits to (baseline AGENTS.md/CLAUDE.md vs path-scoped vs skill-embedded); scope drives which emission mechanism applies. Without both, the emitter classifies by filename heuristic — which is exactly how the v2→v6 convergence rounds repeatedly surfaced "phantom rules" and "surplus rules" findings. Declaring both lets the v6 §A.1 validator catch mismatches at author time rather than at /sync time when the damage has already propagated to downstream USE templates.

### 8. Rule Uses Slot Markers For CLI-Divergent Content

Rules with CLI-specific content (delegation syntax, tool names, native-primitive references) MUST partition that content into slot-marker blocks per v6 §3.1: `<!-- slot:neutral-body -->...<!-- /slot:neutral-body -->`, `<!-- slot:examples -->...<!-- /slot:examples -->`, `<!-- slot:origin-extended -->...<!-- /slot:origin-extended -->`. Markers anchor at column 0, outside fenced code blocks. CLI variant overlays at `variants/<cli>/rules/<rule>.md` supply replacement bodies only for the slots that diverge.

DO — neutral body carries the MUST clause, examples slot carries the CC syntax (overlay replaces on emit):

    <!-- slot:neutral-body -->
    Every specialist delegation MUST include the relevant spec files.
    <!-- /slot:neutral-body -->

    <!-- slot:examples -->
    Agent(subagent_type="dataflow-specialist", prompt="...")
    <!-- /slot:examples -->

DO NOT — bake CC-specific syntax into the neutral body:

    Every specialist delegation MUST use Agent(subagent_type=...) with
    the relevant spec files.
    # ↑ Codex uses codex_agent(...); Gemini uses @specialist — this rule
    # is now CC-only by accident; cross-cli-parity drift audit hard-blocks.

**BLOCKED rationalizations:**

- "Most users are on CC; the example covers 95% of cases"
- "Slot markers add ceremony for one CLI-specific example"
- "The emitter can strip CC syntax for Codex/Gemini automatically"

**Why:** Without slot markers the neutral body carries CLI-specific syntax that silently weakens the rule on the other two CLIs — a MUST clause with a CC-only example gets read as "only applies on CC." The slot mechanism is the single structural defense against per-CLI drift; the `parity_enforcement.cross_cli_drift_audit` validator checks neutral-body byte-identity and can only do so when the slots exist.

## MUST NOT

- Rationale paragraphs longer than 2 sentences per `Why:` line

**Why:** Long rationale crowds the rule's load-bearing clauses out of working memory.

- Hedging phrases ("in most cases," "generally speaking") in a MUST clause

**Why:** Hedging converts a MUST into a should and reintroduces permission-to-skip.

- Rules longer than 200 lines

**Why:** Rules longer than 200 lines are skimmed; the agent misses load-bearing clauses. Extract reference material into a guide or skill.

## The "Loud, Linguistic, Layered" Test

Before committing any new rule, verify:

1. **Loud** — can the rule be ignored by quoting a standard excuse phrase? If yes, add that phrase to the BLOCKED list.
2. **Linguistic** — does the rule target wording the agent might use, not just behavior? If no, rewrite.
3. **Layered** — at which load layer does the rule fire? If session-start for a non-universal rule, add `paths:`.

Rules that fail any check MUST be revised before merging.

<!-- /slot:neutral-body -->
