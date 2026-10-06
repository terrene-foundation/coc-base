# Cross-CLI Artifact Hygiene — Extended Evidence and Per-CLI Detail

Depth companion for the path-scoped rule `.claude/rules/cross-cli-artifact-hygiene.md`. The rule body
carries the CLI-neutral contract: every MUST clause, every DO/DO-NOT block, every
BLOCKED-rationalization entry, and the failure-mode statement of every `**Why:**` line stay THERE,
verbatim. This file carries what the rule body pointed OUT: the per-CLI translation mechanics
(runnable detail that is illustrative, never normative), the correct-citation worked examples, the
measured fixture-coverage and consumer-asymmetry narratives from the Trust-Posture Wiring's
detection-mechanism field, the layer-positioning cross-reference, and the Origin narrative.

Read it when authoring or auditing a workspace artifact under `workspaces/**/*.md` or `briefs/**/*.md`,
and when a gate-review adjudicates a flagged cross-CLI leak.

## Layer Positioning

Moved from the rule's preamble. The rule sits below `rules/cross-cli-parity.md` (rule-layer parity;
**kailash tier** — absent at a stack-agnostic base template) and above `rules/upstream-issue-hygiene.md`
(public-issue layer); this rule controls the project-artifact layer in between.

The three layers are not interchangeable. `cross-cli-parity.md` governs what loom EMITS (neutral-body
byte-identity across the three CLI emissions of one rule). `cross-cli-artifact-hygiene.md` governs what
a SESSION WRITES into a project artifact that any CLI may later read. `upstream-issue-hygiene.md`
governs what leaves the repo onto a public surface. A leak caught at one layer is not caught at the
others: the emitter never reads `workspaces/**`, and the public-issue scrub never reads a local todo.

## MUST-1 — Per-CLI Delegation Translation Mechanics

Runnable detail moved from the MUST-1 `**Why:**` line. Illustrative, NOT normative — the neutral
phrase is the contract; these are the per-CLI implementations of it, and they change upstream without
changing the rule.

> Codex delegates through named `.codex/agents/*.toml` agents; compatibility operating-spec
> text remains under `.codex/prompts/`. Gemini uses its native agent surface.
> The parent includes the same task/spec context whichever runtime performs the delegation.

The deprecation clause is the reason this detail belongs OUT of the rule body: the `/prompts:reviewer`
form was correct when the rule landed and is now dead, so an artifact whose prescriptive prose had
baked it would today direct a Codex reader at a primitive their CLI no longer loads — the exact failure
the rule's MUST-1 blocks, one turn of the version wheel later.

## MUST-2 — Per-CLI File-Tool Surface Names

Runnable detail moved from the MUST-2 `**Why:**` line.

> Codex exposes `read-file` / `cat`-equivalent shell calls; Gemini exposes `read_file` and
> `@filesystem.read`.

CC's `Read` / `Write` / `Edit` / `Bash` are API surface names, not English. The neutral verb form
("read the file", "edit the file", "run the build") is the only phrasing that survives all three
inventories without a mental rewrite at every read.

## MUST-3 — Correct Citation Forms

Worked example moved from the MUST-3 `**Why:**` line. The normative prohibition (never cite a
CLI-specific baseline filename as prescriptive authority) stays in the rule body; these are the three
citation forms that satisfy it.

> Cite the rule (`rules/zero-tolerance.md`), the concept ("the baseline rules"), or the spec
> (`specs/auth.md` §3.1) — never the CLI-specific baseline filename as prescriptive.

## MUST-4 — Per-CLI Hook Lifecycle Event Names

Runnable detail moved from the MUST-4 `**Why:**` line.

Current Codex uses `SessionStart`, `PreToolUse`, `PostToolUse`, and related lifecycle
names also used by CC; event payloads and supported output fields still differ.
Gemini uses its own event taxonomy. The neutral phrasing ("the session-start hook",
"the pre-tool-use guard") names the lifecycle moment without assuming behavior from
spelling alone. Verified 2026-09-28: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Severity — Why Advisory

Rationale narrative moved from the Trust-Posture Wiring `**Severity:**` field. The normative statement
(`advisory` for all 5 MUST clauses) stays in the rule body.

> Lint reports leaks; user adjudicates rewrite vs qualify. Workspace artifacts are session records;
> advisory severity matches CARE Principle 7 graduated-trust posture for content that affects framing
> without affecting runtime directly.

## Grace Period — The Pre-Rule Leakage Backlog

Measured narrative moved from the Trust-Posture Wiring `**Grace period:**` field. The normative
statement (14 days) stays in the rule body.

> Existing artifacts in workspace artifacts and `<rust-sdk-repo>/workspaces/` carry pre-rule
> leakage; lint surfaces them as advisory until swept.

## Detection Mechanism — Fixture-Coverage Measurement

Measured narrative moved from the Trust-Posture Wiring `**Detection mechanism:**` field. Preserved
verbatim with its falsifying context; re-measure rather than citing this line if the lint's pattern set
has changed since.

> Fixtures at `.claude/audit-fixtures/cross-cli-artifact-hygiene/` (3 flag + 2 clean files) cover
> **10 of the lint's 23 pattern labels** plus both clean-pass cases; the other 13 (the `task-*`,
> `exit-plan-mode`, `agent-isolation-worktree`, `tool-noun-write|grep|glob`, five `hook-event-*`, and
> `cli-baseline-gemini-md` labels) have NO fixture coverage.

The reading that matters: a green fixture run is evidence about the 10 covered labels ONLY. It is NOT
evidence that the other 13 patterns fire, because no fixture would RED if they stopped firing — a
non-discriminating instrument for those labels in the sense of `instrument-discipline.md` MUST-1.

## Detection Mechanism — Consumer-Side Coverage Asymmetry

Measured narrative moved from the same field. The normative sentence it carries — do not read the
loom-side lint as consumer-side enforcement — stays in the rule body.

> **AT A CONSUMER: NEITHER SURFACE EXISTS.** `tools/` is in no sync tier, so `lint-workspaces.js` does
> not cascade with this rule, and `/cli-audit` is platform-role-only — so a consumer that pulled this
> rule has gate-review as its ONLY coverage, with the inline regex fallback documented at
> `commands/migrate.md` (Step 9) standing in for the lint.

Closing that asymmetry needs a distribution decision per `knowledge-cascade-routing.md` MUST-2 — a
manifest tier for `tools/`, or a consumer-side surface authored to replace it — NOT a wording change in
the rule. Until then the rule cascades with strictly weaker enforcement than it has at loom, and a
reviewer at a consumer repo IS the whole detection layer.

## Origin

2026-05-06 — audit of `workspaces/**/*.md` across `kailash-py` / the Rust SDK surfaced widespread
leakage of CC-native delegation syntax (`Agent(subagent_type=...)`, `run_in_background=true`), CC tool
nouns (`Read tool`, `Edit tool`), and CC baseline-file authority claims (`per CLAUDE.md`) in todos,
journal entries, and redteam reports. A Codex / Gemini reader inheriting any of these workspaces reads
acceptance criteria written in syntax their CLI cannot parse — silently misled.

## Extraction Record

**2026-08-19 structural cleanup — ZERO de-scoping.** Every MUST, MUST NOT, BLOCKED-rationalization
entry, DO/DO-NOT block and the failure-mode statement of every `**Why:**` line stayed in the rule body
verbatim; the `## Trust Posture Wiring` block kept all five canonical field labels it carries (Severity,
Grace period, Regression-within-grace, Receipt requirement, Detection mechanism — no label was added to
the grandfathered block), each with its normative statement intact. What moved here: the layer-positioning
cross-reference, the per-CLI runnable detail from the MUST-1 / MUST-2 / MUST-4 `**Why:**` tails, the
MUST-3 correct-citation worked example, the two measured narratives inside the detection-mechanism field
(fixture coverage; consumer asymmetry), and the Origin narrative. Every measured number moved VERBATIM
with the falsifying context that makes it readable.

`rule-authoring.md` Rule 10 / Rule 11 do **NOT** fire. Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` rules ONLY, and `cross-cli-artifact-hygiene.md` is `priority: 10` + `scope: path-scoped`
— it contributes nothing to baseline emission, so the proximity-band admission gate has no subject here.
Rule 11 counts Rule-10-MANDATED invocations only, so a structural-cleanup extraction on a path-scoped
rule is not recurrence input either. This is therefore a **STRUCTURAL-CLEANUP extraction**, the
disposition `journal/0148` § "Lesson learned" recorded for exactly this shape (and the shape
`user-flow-validation.md`, `recommendation-quality.md` and `multi-operator-coordination.md` each record
in their own extraction records).
