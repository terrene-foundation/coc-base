# CC Artifact Quality — Depth Extract

Depth companion for `.claude/rules/cc-artifacts.md`. The rule body carries every obligation (MUST /
MUST NOT / BLOCKED corpus / `**Why:**` line / DO-DO NOT blocks); this file carries the measurement
history, per-rule provenance, mechanism narrative and cross-reference depth moved out of it under
`rule-authoring.md` Rule 10 path (a). Nothing here is normative on its own.

## Rule 1b

Moved verbatim from Rule 1b's `**Why:**` line:

> 2026-05-06 evidence: 47 of 47 skill descriptions were dropped because the cumulative description bytes exceeded the 1% budget fraction (≈10KB across 47 entries → ~213 chars/entry average; 18 skills exceeded that average and pushed cumulative over). Trimming the worst 18 to ≤200 chars freed ~3.5KB and restored full listing visibility. Same root cause as `agent-reasoning.md` MANDATORY framing: descriptions are the LLM's semantic-match input, not a search engine's keyword index.

The per-entry cap arithmetic, moved from the `"The cap is arbitrary"` BLOCKED entry:

> total listing budget × 47 skills divides to ~200 chars/entry; longer descriptions get TRUNCATED out of the listing entirely

And the activation-mechanics note moved from Rule 1b's body:

> Per `feedback_semantic_activation.md`: CC uses LLM semantic matching, not keyword lookup; long quoted-alternate lists DON'T improve activation, they inflate the listing budget.

The `# DO NOT` fence in the rule quotes the keyword-dump anti-pattern in abridged form. The full
575-character original read:

> description: "Validation patterns and compliance checking for Kailash SDK including parameter validation, DataFlow pattern validation... Use when asking about 'validation', 'validate', 'check compliance', 'verify', 'lint', 'code review', 'parameter validation', 'connection validation', 'import validation', 'security validation', 'workflow validation', 'codebase hygiene', 'TODO marker scrub', 'marker cleanup', 'three-layer gate', or 'regex gate'."

## Rule 3

Which receipt carries the named rationale, moved verbatim from Rule 3 condition (c):

> (commands carry no Origin footer; for a pre-existing command amended into overage this is the amending codify's receipt, not the command's first-creation receipt)

The `/onboard` contrast, moved verbatim from `**Why (exception):**`:

> Contrast `/onboard` (`knowledge-convergence.md` MUST-5 forced it ≤150 by extracting its runbook DEPTH — JSON schema, matrices — to `skills/41-onboard/`): condition (a) resolves both the SAME way — reference-depth is extractable (`/onboard`), ordered irreducible procedure is not (`/sweep`); the two dispositions are consistent, not opposed.

## Rule 6a

The second half of Rule 6a's `**Why:**` line, moved verbatim (the rule keeps "The 7-day
window matches the trust-posture grace period."):

> also catching rules still inside grace from the prior week

## Rule 4a

Moved verbatim from Rule 4a's body:

> Prompt caching is a prefix match: any byte change invalidates the cached prefix for the rest of the session.

And from its `**Why:**` line:

> This makes "fix the stale count" a STATIC-accurate edit, never a dynamic-interpolation one. Mechanics + the loom#678 size-vs-stability composition: `skills/30-claude-code-patterns/prompt-caching-coc-artifacts.md`.

## Rule 8

The inline pattern moved out of Rule 8's body (the DO fence in the rule still shows it):

> Pattern: `entries.filter(e => e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"))`.

Moved verbatim from Rule 8's `**Why:**` line:

> The same failure mode applies to `findAllSessionNotes` (SessionStart drift dashboards). Leading-underscore is the convention for workspace meta-dirs (`_archive`, `_template`, future `_draft`); filtering by prefix makes the contract durable as new meta-dir conventions emerge.

### Mutation-tool SSOT extension path

Moved verbatim from the rule body:

> **Related — mutation-tool SSOT extension path:** when Anthropic ships a new mutation tool surface (a tool that writes to the working tree), the canonical extension is `.claude/hooks/lib/tool-classes.js::MUTATION_TOOLS`. Append the tool name to the Set; every hook consulting `isMutationTool(tool)` picks up the change automatically. No per-site sweep required. The iter-3 structural sweep test at `tests/integration/multi-operator/c2-auth-hardening-iter3.test.js` enforces "no bare `tool === 'Edit' || tool === 'Write'`" via `grep -rn` exit-code assertions; missed extensions surface as sweep failures.

## Rule 9 — Predicate Classes

Moved from Rule 9's `**Why:**` line — the non-obvious scope-restriction predicate classes committed fixtures protect:

> (block-scoping, glob anchoring, regex word boundaries)

## Rule 9 — Fixture Layout

Moved verbatim from the rule body:

> Fixtures MAY use per-case sidecar files (as shown above) OR inline-case definition in `run.mjs` — the runner contract (assert expected vs actual + non-zero exit on mismatch) is the load-bearing primitive; the storage layout is operator-choice (see `.claude/audit-fixtures/codex-dispatcher/README.md` § "Fixture layout" for the inline-runner variant and selection criteria; receipts: cc-architect R2 LOW-2 + journal/0167 § R3 wave).

## Rule 9 — Generalization

Moved verbatim from the rule body:

> **Generalized to ALL COC artifact types + a semantic-probe half by `rules/coc-artifact-eval-coverage.md`.** This rule mandates committed structural fixtures for mechanical audit TOOLS; `coc-artifact-eval-coverage.md` lifts that contract to every COC artifact type (rule / agent / skill / command / hook) AND adds the LLM-judge probe tier (a structural fixture proves SHAPE; a probe proves EFFICACY). A `type:tool` entry stays fixture-only (`probes:null` per its bootstrap note — an audit tool's correctness is its committed fixtures/self-tests, not an LLM-judge probe of the very engine that dispatches probes), so this Rule 9 remains the governing contract for the tool subset; the two-tier generalization applies to the prose/behavioral artifact types. Informational cross-reference only — no new MUST here.

## Rule 10

The enumerable-vocabulary examples moved from Rule 10's `**Why:**` line:

> (frontmatter keys, hook events, license names)

And the cost argument, moved out of Rule 10's `**Why:**` 2026-09-13 (paired extraction funding the
citation-restoration pass; the rule keeps the failure mode):

> An allowlist closes the class on day one by shifting the cost from diagnosing future silent
> failures to documenting valid vocabulary upfront, which is small and one-time for enumerable
> vocabularies.

And the scope clarification, in its pre-compression form:

> **Scope clarification:** This rule applies when the vocabulary IS enumerable. For non-enumerable vocabularies (e.g., free-form prose, user-generated content), positive allowlists are not feasible; denylists or pattern matching may be the only option. A sweep using denylist style for a non-enumerable vocabulary should note the rationale in its surrounding documentation; this is guidance, not a separate MUST.

## Preamble — variant-authoring tier note

Moved verbatim from the rule's opening paragraph:

> (**kailash tier** — delivered only to Kailash-subscribing targets; absent at a stack-agnostic base template)

## Origins

**Rule 3 (named-rationale exception for procedural commands):**

> Origin: 2026-07-04 — surfaced by the Directive-2 self-referential redteam (reviewer vs cc-architect disagreement on the `/sweep` 9th-sweep overage), resolved by-construction by adding the command-escape parallel to the pre-existing rules-cap escape; receipt journal/0429.

**Rule 8 (workspace-walking hooks filter leading-underscore meta-dirs):**

> Origin: the Rust SDK PR #759 (2026-05-02) — `git mv` of 4 workspaces into `_archive/` caused 3 SessionEnd stubs to land in (loom-internal reference). Fix landed at `.claude/hooks/lib/workspace-utils.js::detectActiveWorkspace` + `findAllSessionNotes`. Codified GLOBAL via /sync rs Gate 1 (2026-05-02 second cycle).

**Rule 9 (audit tools ship with committed test fixtures):**

> Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (load-bearing `i==1` invariant case study + adversarial /vet round). Inbound from atelier `/sync-to-coc`.

**Rule 10 (mechanical sweeps use positive allowlists):**

> Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (allowlist vs denylist trade-off). Inbound from atelier `/sync-to-coc`.

## Length Rationale — The Enumeration

Moved verbatim from the rule's length-rationale paragraph:

> Rule body exceeds the 200-line guidance. Named rationale: **CC-artifact-quality scope** — the rule enumerates 10+ numbered CC-artifact-quality rules (descriptions, progressive disclosure, command/CLAUDE.md size caps, cache-stability, `paths:` frontmatter, /codify cc-architect deploy, hook timeout/meta-dir/SSOT discipline, committed audit fixtures, positive-allowlist sweeps) each carrying the DO/DO-NOT + `**Why:**` + per-rule `Origin:` the meta-rule mandates. The rule is `priority: 20` + `scope: excluded` + `exclude_from: [codex, gemini]` (CC-only, path-scoped — loaded only on `.claude/**` edits, never baseline), so it pays NO always-on baseline-emission cost; splitting would fragment the CC-artifact-quality surface across files and force cross-rule lookups for every artifact-authoring decision. Sibling precedent: `user-flow-validation.md` + `artifact-flow.md` length rationales.

## Extraction Record

2026-09-13 paired extraction (`rule-authoring.md` Rule 10 path (a)), ZERO de-scoping: every MUST,
MUST NOT, BLOCKED-corpus entry, DO/DO-NOT block and `**Why:**` line stayed in the rule body. What
moved is enumerated by the sections above; each removal site in the rule carries a whole-line pointer
back here. `rule-authoring.md` Rule 10's proximity-band gate does NOT fire on this rule — it is
`priority: 20` + `scope: excluded`, so it contributes nothing to baseline emission; the extraction is
rule-injection-budget hygiene, not Rule-10 compliance.
