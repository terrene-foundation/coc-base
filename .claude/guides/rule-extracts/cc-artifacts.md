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

The rule's second `# DO` arm, moved verbatim 2026-10-19 (the first DO arm and the DO NOT arm stay):

```yaml
# DO — ≤200 chars, MANDATORY framing for skills with strong precondition
description: "Kailash ML — MANDATORY for ML training/inference/feature/drift/AutoML/RL. Engine-first km.* surface + 18 engines. Raw sklearn/pytorch BLOCKED."
```

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

## Rule 7

Moved from the deny-capable-row bullet 2026-10-19 (paired extraction funding the row-class split;
the rule keeps the MUST, the BLOCKED list and the `**Why:**`). What `runGuard` owns:

> which owns the one try/catch, the budget and the stdin read, and denies (exit 2, via `instruct-and-wait.js::emit`) on a throw, a rejection, a budget overrun or unreadable stdin

Why `readStdinBounded` is BLOCKED in a deny-row file:

> (it resolves `{}` on timeout, read by the guard as "not my tool")

Two more Rule 7 BLOCKED rationalizations, moved verbatim 2026-10-19 when `check-context-budget` held the
rule to its prior size (the rule keeps the first three):

- "it only times out under load"
- "the guard is fast, the catch never fires"

The advisory bullet's tail read `(…, cannot deny) MAY fail open: a setTimeout fallback emitting
`{ continue: true }` and exiting.`, and the deny bullet's denial list read `a throw, a rejection, a budget
overrun or unreadable stdin`. The deny-row Why read `vanishes exactly when broken`, the deny bullet ended
`; the deny-row lint reds each.`, and the clause's opening sentence joined its row-class tail with ` — and`.

The advisory-row arm of the worked block, moved verbatim (the rule's advisory bullet states it in prose):

```javascript
// DO — advisory row only: the fail-open fallback
function hookMain() {
  setTimeout(() => { console.log(JSON.stringify({ continue: true })); process.exit(1); }, 5000);
}
```

The rule's Rule 7 pointer was shortened to a bare path 2026-10-19; the probe-suite citation stays in
the rule body, because `probe-suite-integrity.test.mjs` requires a probed rule to name its own probe
file (`coc-artifact-eval-coverage.md` MUST-4).

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

The rule's compressed form before the 2026-10-19 extraction, moved verbatim:

> Cases MAY be sidecars (above) OR inline in `run.mjs` — the runner contract (assert expected vs actual + non-zero exit on mismatch) is the load-bearing primitive; layout is operator-choice (inline variant: `.claude/audit-fixtures/codex-dispatcher/README.md`).

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

2026-10-19 paired extraction (fail-closed completeness lane), ZERO de-scoping: Rule 7's row-class
split grew the rule +1810 B while the rule-injection ledger's aggregate cap was 0 B (surfaces above
target), so the growth was FUNDED here rather than accepted — never by raising a cap. Every MUST,
BLOCKED entry and `**Why:**` line stayed in the rule body; the moved spans are the Rule 7 and Rule 9 Fixture Layout additions above, plus the second Rule 1b DO arm
and the Rule 1b and Rule 8 depth pointers (shortened; Rule 8's keeps its `MUTATION_TOOLS` citation), whose
former wording read:

> Depth — the measured listing-budget evidence and semantic-activation mechanics — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 1b.

> Depth — the `findAllSessionNotes` sibling surface, the leading-underscore meta-dir convention, and the mutation-tool SSOT extension path (`.claude/hooks/lib/tool-classes.js::MUTATION_TOOLS`, swept by `tests/integration/multi-operator/c2-auth-hardening-iter3.test.js`) — lives in `.claude/guides/rule-extracts/cc-artifacts.md` § Rule 8.

Five clause-prose units the same extraction first condensed here were RESTORED verbatim to the rule
body by the lane's committer: Rule 3's named-rationale exception, Rule 9's generalization note, Rule 10's
scope clarification, the length rationale and the Origins pointer. `rule-slim-conserve.mjs` counts a
normative unit moved only to `guides/**` as LOST (its injected-destination policy, the same reading as
`check-descoping.mjs::isInjectedMoveDestination`), so the bytes were funded from fence comments and the
lane's own new Rule 7 prose instead. Rule 7's base `**Why:**` sentence also stays a whole unit of its own.

### Pre-extraction text of the deny-row bullet

The rule keeps the bullet below in a SHORTER form; the lane-authored text is carried here whole. Of the
spans it lost, the rows live in `hooks/dispatch-registry.json` or `hook-registry.json`, the refusal is emitted
through `instruct-and-wait.js::emit`, and the lint is loom's deny-row fail-closed lint (it runs in loom CI and
does not ship). The Rule 9 generalization note's own depth pointer was dropped the same day: the Origins
pointer below it already names this file.


- **Deny-capable row** (declares `on_incomplete: "deny"` in `hooks/dispatch-registry.json` or `hook-registry.json`) MUST FAIL CLOSED: build `hookMain` with `guard-runner.js::runGuard(name, main, {budgetMs, standalone})`, which owns the one try/catch, the budget and the stdin read, and denies (exit 2, via `instruct-and-wait.js::emit`) on a throw, a rejection, a budget overrun or unreadable stdin. A `{ continue: true }` emitter or an exit-0 pass-through inside a `catch`, a `.catch(` or a timer callback, and `readStdinBounded` (it resolves `{}` on timeout, read by the guard as "not my tool"), are BLOCKED in a deny-row file; the deny-row fail-closed lint reds each.





Fence-comment wording compressed the same day (no arm removed, every example still shows its case):
the Rule 1b DO NOT comment read `(575 chars, defeats semantic activation; full text: extract § Rule 1b)`;
the Rule 3 DO comment read `receipt records the named rationale + the redundancy trimmed`; the
dangling-references DO comment read `# find → re-point or delete each ref`; the Rule 9 fixture listing
was column-aligned with extra spaces. Later the same day, to fund the restored units: the Rule 1 DO NOT
quote read `who can audit and improve all types of CC artifacts …`; the Rule 3 DO comment ended
`+ what was trimmed`; the Rule 4a comments read `(updated when it changes), deterministic ordering` and
`… date in the always-on baseline`; the Rule 7 DO NOT comment read `a deny row carrying the advisory
fallback, or passing through on throw`; the Rule 8 filter spanned four lines and its DO comment read
`filter both`; the Rule 9 DO comment read `committed alongside the lint`; each Rule 10 comment carried a
second line (`typos like pathRegex:/applies_to:/match: are caught without enumerating them` and `novel
typo ships until it appears, is diagnosed, is added, and is re-released`); the dangling-references DO NOT
comment ended `in agent / rule files`.
