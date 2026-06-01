---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/**"
  - ".claude/rules/**"
  - ".claude/skills/**"
  - ".claude/hooks/**"
  - ".claude/bin/**"
  - ".claude/agents/management/**"
  - ".claude/audit-fixtures/**"
---

# Self-Referential /codify Discipline

A `/codify` execution is **self-referential** when its proposal touches the loom-side artifacts that govern codification itself — commands like `/codify` / `/sync` / `/redteam`, the skills backing them, the rules governing artifact quality and trust posture, the hooks detecting violations, the bin scripts validating output. On those surfaces the agent is authoring rules that constrain its own next behavior, so a single-pass shipment can silently propagate a defect into every future session that loads the rule.

Per posture defaults (`.claude/skills/32-trust-posture/redteam-integration.md`), L5*DELEGATED makes Round 1 OPTIONAL. On a non-self-referential surface that is the right trade-off — the user's blast radius is bounded by the artifact and the next session catches what slipped. On the self-referential surface the same default ships defects into the gate the next session would otherwise use to catch them. The forest-ledger arc (journal/0089–0098) cost 7 redteam rounds + a mid-arc Option A→B redesign before the substring-mask failure class was structurally closed — and per journal/0098 §FD #3: *"7 rounds of evidence say the single-pass L5 default would have shipped the R1 substring-mask silently."\_

This rule overrides the posture default for that specific surface, and ONLY that surface, with a positive allowlist that names every file the gate covers.

## MUST Rules

### 1. Self-Referential /codify MUST Carry Multi-Agent Redteam-With-Tests Regardless Of Posture

When a `/codify` proposal touches ANY file matching the self-referential surface allowlist below, the orchestrator MUST dispatch a multi-agent redteam-with-tests round before merging the codify, EVEN AT L5_DELEGATED posture where Round 1 would otherwise be optional. The team MUST include at minimum: a code-review specialist (reviewer agent), a security specialist (security-reviewer), and a structural-validator specialist (cc-architect for artifact-quality surface, gold-standards-validator for naming/licensing surface, analyst for contract-design surface). The round runs in parallel — sequential single-agent review does NOT satisfy the multi-agent requirement.

The dispatched team MUST receive the proposal AND its receipt-journal entry AND the originating evidence (the journal entries the codify cites as motivation). Each team member reports findings independently; cross-agent disagreement on CRIT/HIGH MUST be resolved per `.claude/skills/32-trust-posture/redteam-integration.md` § Round-N — Cross-Agent CRIT/HIGH Disagreement Resolution (resolve by construction, never by averaging severities).

```markdown
# DO — /codify touches a self-referential surface file → multi-agent redteam runs in parallel before merge

Surface touched: .claude/rules/trust-posture.md (allowlist match)
Dispatched team (parallel): reviewer, security-reviewer, cc-architect, analyst
Each receives: proposal + receipt journal + originating evidence
Cross-agent verdicts reconciled by construction against the contract
Merge proceeds only when ≥0 genuine CRIT/HIGH across all four

# DO NOT — surface touched, posture L5, ship single-pass under "Round 1 OPTIONAL"

Surface touched: .claude/rules/cc-artifacts.md (allowlist match)
Posture: L5_DELEGATED → Round 1 OPTIONAL → skip
Merge proceeds with no independent review
(this is exactly the failure mode the rule blocks)
```

**BLOCKED rationalizations:**

- "Posture is L5, the table says Round 1 is OPTIONAL"
- "The codify is small (one bullet, one line), redteam is overkill"
- "The proposal only touches one allowlist file, the surface is narrow"
- "I am the orchestrator, I already reviewed the proposal as I drafted it"
- "The receipt journal documents the rationale, that satisfies independent review"
- "Multi-agent costs ~30–60 min of agent time; the codify ships value now"
- "Cross-agent dispatch was the prior session's rule — this session's posture overrides it"
- "Sequential review by one specialist after another is functionally equivalent"
- "The next session will catch it under its own gate"
- "If anything slips, the regression-within-grace mechanism downgrades us"
- "The rule's own bootstrap-circularity carve-out lets us skip"
  (the carve-out is one-time-per-rule per Rule 2 below, NOT a per-session shortcut)

**Why:** A defect in a self-referential artifact is a load-bearing defect for every session that loads it; the cost of letting one slip is N future sessions paying the substring-mask cost the forest-ledger arc paid. Multi-agent parallel review at one wall-clock unit (per `rules/agents.md` § Parallel Execution) is the structural defense against the failure mode the arc surfaced; sequential or single-agent review re-introduces the same blind spot.

### 2. Self-Referential Surface Is A Positive Allowlist (per `cc-artifacts.md` Rule 10)

The self-referential surface MUST be enumerated as a positive allowlist below. Files NOT in the allowlist are outside the gate. New files added to `.claude/` under categories the allowlist enumerates (a new rule under `.claude/rules/` that governs codify-class behavior, a new hook under `.claude/hooks/lib/` that detects violations) MUST be added to the allowlist in the SAME `/codify` that lands them — undeclared new self-referential files outside the allowlist is BLOCKED.

The allowlist (load-bearing paths only; edge cases at the boundary resolve in favor of the gate firing — Phase-1 false-positive cost is bounded to one extra redteam round):

- **Commands:** `.claude/commands/codify.md`, `.claude/commands/sync.md`, `.claude/commands/sync-to-build.md`, `.claude/commands/redteam.md`, `.claude/commands/sweep.md`, `.claude/commands/wrapup.md`, `.claude/commands/onboard.md` (added F14 M8: `/onboard` is the deterministic read-path that initializes a new operator's view of the codify-lease + team-memory state per M7; modifying it modifies a load-bearing precondition of every subsequent `/codify` an operator runs), `.claude/commands/certify.md` (added F30-followup 2026-05-26: `/certify` is the knowledge-gate that precedes `/claim` and roster registration per `multi-operator-coordination.md` §1; modifying it modifies a load-bearing precondition of every subsequent `/codify` an operator runs — same predicate as `/onboard`, included per Rule 2 boundary clause "edge cases at the boundary resolve in favor of the gate firing"), `.claude/commands/cc-audit.md` (added 2026-05-31 per F99: `/cc-audit` IS the CC-artifact quality gate — every `/codify` is validated through its rubric (Phase-0 mechanical battery + adversarial A/B + composed verdict). A regression to the rubric silently weakens the gate every future `/codify` runs through; same load-bearing-precondition predicate as `/onboard`/`/certify`. Its paired agent `cc-architect.md` is already covered by `cc-artifacts.md` Rule 6 + the Management-agents/structural-validator surface.)
- **Skills (codify-discipline):** `.claude/skills/spec-compliance/**`, `.claude/skills/command-authoring/**`, `.claude/skills/skill-authoring/**`, `.claude/skills/hook-authoring/**`, `.claude/skills/sweep/**`, `.claude/skills/32-trust-posture/**`, `.claude/skills/30-claude-code-patterns/**` (F20 2026-05-22: depth-files of allowlisted rules are codify-governing by extension — covers `worktree-orchestration.md` + `closure-parity-specialist-discipline.md` + `genesis-migration-n1-org-admin-anchor.md` (F87 2026-05-29: MUST-7 depth-file; multi-operator-coordination.md is allowlisted, so its depth-file is codify-governing by extension) + future `agents.md`-companion sub-files; pattern-add per `cc-artifacts.md` Rule 10 positive-allowlist + analyst FM4 resolve-by-construction; resolves the pre-existing `worktree-orchestration.md` gap retroactively)
- **Rules (codify-discipline):** `.claude/rules/{trust-posture,cc-artifacts,coc-sync-landing,artifact-flow,recommendation-quality,value-prioritization,autonomous-execution,agents,sweep-completeness,rule-authoring,variant-authoring,cross-cli-parity,specs-authority,spec-accuracy,probe-driven-verification,hook-output-discipline,verify-resource-existence,time-pressure-discipline,repo-scope-discipline,self-referential-codify,knowledge-convergence,multi-operator-coordination,user-flow-validation,governed-throughput}.md`
  - `governed-throughput.md` (F110 2026-06-01): UNCONDITIONALLY codify-governing — it governs how an orchestrator delegates parallel / orchestrated shards (curated rule-slice injection + the full-context merge gate). `/codify`'s own multi-agent redteam dispatches parallel agents; this rule decides whether those agents carry the governing invariants, so any `/codify` touching it modifies the delegation-governance gate `/codify` itself runs through. Added in the same codify that lands it per Rule 2.
  - `knowledge-convergence.md` (F14 M8 Shard F-1): UNCONDITIONALLY codify-governing — it codifies the codify-lease + team-memory promotion + `/onboard` deterministic read-path. Any `/codify` touching this rule modifies the gate `/codify` itself runs through, so the self-referential-surface allowlist MUST cover it.
  - `multi-operator-coordination.md` (F14 M8 Shard F-2): UNCONDITIONALLY codify-governing — Gate-1 classified as codify-governing 2026-05-22 per R1 reviewer Tension-2 disposition. The rule's claim system (Rule 2/MUST-2) gates SAME-class edits across ALL paths including codify-class artifacts (`.claude/.proposals/latest.yaml`, `learning-codified.json`, rules, commands, skills); the gate matrix (MUST-3, §6.4) governs `/release` via `operator-gate.js`; the lifecycle hooks (§5) surface "rules-changed" + "codify lease holder" at session-start (both codify-discipline state). The rule's `/codify`-governance is structural, not adjacent.
  - `user-flow-validation.md` (co-owner-directed 2026-05-22, journal/0134): UNCONDITIONALLY codify-governing — MUST-4 explicitly governs prose deliverables (rules, commands, skills), every `/codify` ships prose deliverables, the rule's MUST clauses fire on every `/codify`-output artifact. Re-opening the rule's prescriptions IS a codify-governing edit.
  - `onboard.md` (F14 M7 INTEGRATION-NOTES forward note per journal/0132): codify-governing IFF the rule's body authors a discipline that governs `/onboard`'s deterministic read-path interaction with `/codify` (the lease + team-memory promotion both touch onboard's read-path). Default disposition: include the command in the Commands sub-allowlist below. See guide-extract for the per-condition adjudication walkthrough.
- **Hooks:** `.claude/hooks/lib/{violation-patterns,detect-violations,state-io,state-resolver,template-resolver,workspace-utils,operator-id,genesis-ceremony,fold-rule-9c,coordination-log}.js` + `.claude/hooks/{fold-amendment-paired-with-helper,genesis-anchor-guard,validate-bash-command}.js` (`validate-bash-command.js` added 2026-05-31 per F92 / issue #401 Shard 3: it is the PreToolUse Bash tripwire that enforces `git.md`'s destructive-working-tree-op MUST clause (`git reset --hard` block + `git clean -f` halt-and-report). A regression to its segment-anchoring or severity discipline either hard-blocks every bash command or silently lets an untracked-file-deleting command escape the tripwire — the exact #401 data-loss class; same load-bearing class as the allowlisted `genesis-anchor-guard.js`, named per the Rule 2 boundary clause "edge cases at the boundary resolve in favor of the gate firing." `operator-id.js` added 2026-05-27 per #366 redteam cc-architect M1: `resolveIdentity` is the load-bearing precondition for posture → codify-lease → `/onboard`, same predicate as the allowlisted `onboard.md`/`certify.md`; a fingerprint-resolution bug here silently mis-resolves identity → wrong posture → wrong lease behavior, so per Rule 2 boundary clause it is inside the gate. `genesis-ceremony.js` + `fold-rule-9c.js` + `coordination-log.js` + the top-level `fold-amendment-paired-with-helper.js` hook added 2026-05-29 per F88 cc-architect LOW-1: these are the genesis-migration trust-root substrate — the ceremony helper, its fold predicate, the fold engine, and the paired-landing gate. A bug here silently mis-anchors the trust root or false-flags the owner as an equivocator. They were previously in-gate only by the Rule 2 boundary clause "edge cases resolve in favor of the gate firing"; naming them closes the boundary-clause-judgment gap so future edits fire the gate deterministically. `genesis-anchor-guard.js` added 2026-05-30 per F72 / issue #379: it is the PreToolUse trust-root enforcement hook — its fresh-consumer-vs-enrolled-then-deleted discrimination (the F72 branch) decides whether a commit is blocked, so a bug here either hard-blocks every consumer commit or escapes the guard entirely; same trust-root-substrate class as `genesis-ceremony.js`/`fold-rule-9c.js`, named per the same boundary-clause-closure rationale.)
- **Data files (codify-class):** `.claude/operators.roster.schema.json` (added 2026-05-28 per F67 / GH #379 / journal/0162 security-reviewer MEDIUM-1: the roster schema is the trust-root validation contract — `roster-schema-validate.js::loadSchema()` reads it at runtime to validate every roster record submitted via `/whoami --register`; a weakened schema (e.g., dropped `propertyNames` prototype-pollution rejection, relaxed GPG fingerprint constraint, added `human_admin` synonym to `host_role` enum) silently accepts forged rosters. Same load-bearing class as the allowlisted hooks: a contract bug here silently mis-validates every downstream consumer's trust root. Per Rule 2 boundary clause "edge cases at the boundary resolve in favor of the gate firing.")
- **Bin (codify-class):** `.claude/bin/{validate-*,scan-synced-disclosure,emit-cli-artifacts,emit,compose,sync-tier-aware,sync-consumer-dryrun,check-sync-freshness}.mjs` (`check-sync-freshness` added 2026-05-28 per F62 / journal/0164 cc-architect HIGH-1: the helper IS sync-class — it gates `/sync` and `/sync-to-build` distribution; a regression to its predicate silently false-passes the local-vs-remote freshness invariant. Same authority class as the existing `sync-tier-aware` / `sync-consumer-dryrun` siblings per Rule 2 boundary clause "edge cases at the boundary resolve in favor of the gate firing.")
- **Audit fixtures:** `.claude/audit-fixtures/**` (F23a 2026-05-22: broadened from `violation-patterns/**` per `cc-artifacts.md` Rule 10 positive-allowlist + cc-architect M1 finding — every audit-fixture dir backing a codify-allowlisted rule/hook/bin is codify-governing by extension; covers `violation-patterns/`, `proximity-band-budget/`, `cross-cli-drift/`, `codify-self-referential/`, `forest-ledger/`, `adjacency-leasecheck/`, `genesis-anchor-guard/`, and future fixture dirs without enumeration drift)
- **Management agents:** `.claude/agents/management/{coc-sync,sync-reviewer,repo-ops,settings-manager}.md`

**`paths:` frontmatter is the load-trigger SUPERSET; this allowlist is the firing-scope SUBSET.** This rule is `scope: path-scoped`; its `paths:` globs (`.claude/{commands,rules,skills,hooks,bin}/**`, `.claude/agents/management/**`, `.claude/audit-fixtures/**` — broadened F23a 2026-05-22 per the Audit-fixtures allowlist pattern-add) load the rule on ANY edit under those `.claude/` subtrees — deliberately broader than the named-file allowlist above. The allowlist is what the gate (Rule 1) FIRES on; the globs are only what LOADS the rule into context. Over-broad loading is fail-safe (an in-context rule that does not fire costs nothing). Narrowing the `paths:` globs to match the allowlist exactly is BLOCKED — it would drop the rule's load on a sibling surface and re-open the load-order gap that `commands/codify.md`'s gate directive closes. Every self-referential surface lives under `.claude/`, so the globs need no `workspaces/**` or filename-wildcard coverage (unlike `worktree-isolation.md`'s demotion).

**BLOCKED rationalizations:**

- "The file LOOKS self-referential but is too peripheral — skip the allowlist"
- "The allowlist is overcomprehensive, narrow it later"
- "A denylist is easier to maintain"
- "Adding the new file to the allowlist is the next codify's job"
- "The new rule under `.claude/rules/` doesn't really govern codify, it's adjacent"
- "Edge cases at the boundary should resolve in favor of NOT firing — the gate is too expensive"

**Why:** A denylist scales linearly with brainstormed exceptions and never closes the class (per `cc-artifacts.md` Rule 10). A positive allowlist closes the class on day one and surfaces drift loudly: every new self-referential file is either declared in the allowlist (gate covers it) or undeclared (this rule fires on the codify trying to ship it). Boundary-favoring-the-gate is the Phase-1 fail-closed default; tightening to fail-open requires Phase-2 evidence.

### 3. Bootstrap-Circularity Carve-Out Is One-Time-Per-Rule

The codify that AUTHORS this rule (and any future codify that authors a similar meta-rule about codify discipline) IS itself a self-referential codify under Rule 1's gate. Running the gate on the codify that authors the gate is circular. Per `rules/trust-posture.md` MUST Rule 7 § Two-Phase Rollout: _"A meta-rule and its enforcement should never bootstrap in the same release — the rule is then drafted by an agent operating without it (mitigates red-team H4 bootstrapping circularity)."_

The carve-out: the FIRST codify that lands this rule (or a similar meta-rule about codify discipline) MAY ship as Phase-1 observer under the prevailing posture default (L5_DELEGATED's Round 1 OPTIONAL). The carve-out is one-time-per-rule and MUST be declared in the codify's receipt journal under a "Bootstrap-circularity disposition" section. Phase-2 enforcement (this rule's gate fires on every subsequent self-referential codify, regardless of posture) starts at the NEXT self-referential codify, NOT at the next session.

```markdown
# DO — first codify of this rule ships Phase-1 observer, declared in receipt

journal/NNNN § Bootstrap-circularity disposition:
"F4 IS a self-referential codification. Per trust-posture.md MUST-7
two-phase rollout, this codify ships F4 as Phase-1 observer under
L5_DELEGATED's Round 1 OPTIONAL. Phase-2 enforcement starts at the
NEXT self-referential codify."

# DO NOT — every future self-referential codify cites bootstrap-circularity to skip the gate

journal/NNNN: "this codify is self-referential, citing bootstrap-circularity
carve-out to skip multi-agent redteam-with-tests"
(BLOCKED — the carve-out is one-time-per-rule, not a per-session shortcut)
```

**Why:** Without the one-time-per-rule constraint, "bootstrap circularity" becomes a rubber stamp every self-referential codify cites to skip the gate. The carve-out exists for the genuine chicken-and-egg case (a meta-rule authoring itself); every subsequent invocation has the prior rule already in scope and IS the case the gate exists to govern.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at /codify gate (cc-architect surfaces the violation at proposal-validation); `advisory` at hook layer (Phase 2, when a self-referential-detection hook lands). Per `rules/hook-output-discipline.md` MUST-2: judgment-bearing gates do not carry `block` severity.
- **Grace period:** 7 days from rule landing.
- **Regression-within-grace:** any same-class violation (a self-referential `/codify` that ships without multi-agent redteam-with-tests within 7 days of this rule landing) triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `self_referential_codify_without_redteam` added to trust-posture.md emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: self-referential-codify]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection (Phase 1 — this codify):** MANUAL. The `/codify` orchestrator reads the allowlist in Rule 2, checks the proposal's file list against it, and dispatches the multi-agent redteam-with-tests team described in Rule 1 when any match. No hook detection in Phase 1.
- **Detection (Phase 2 — deferred):** a planned `codify-self-referential.js` hook under `.claude/hooks/lib/` (not yet created). Runs on `/codify` proposal generation; mechanically detects allowlist matches per Rule 2 and emits an advisory finding the orchestrator MUST resolve before merge. Audit fixtures will be committed under `.claude/audit-fixtures/` (the `codify-self-referential/` subdir) per `rules/cc-artifacts.md` Rule 9. Phase 2 lands after ≥3 real self-referential `/codify` cycles have exercised Phase 1 (per `rules/trust-posture.md` MUST Rule 7 § Two-Phase Rollout: enforcement bootstraps after real-session-based exercise).

## Distinct From / Cross-References

- **Extends:** `rules/cc-artifacts.md` Rule 6 (every /codify deploys cc-architect) → this rule adds a parallel multi-agent redteam-with-tests requirement on the self-referential subset of `/codify` executions. cc-artifacts.md Rule 6 still applies to every /codify; this rule layers additional gating on the self-referential surface.
- **Pairs with:** `.claude/skills/32-trust-posture/redteam-integration.md` § Patterns From Convergence Arcs (Patterns a, b, c) — those patterns govern WHAT the redteam round checks; this rule governs WHEN the round MUST fire regardless of posture.
- **Distinct from:** `rules/trust-posture.md` MUST Rule 4 (downgrade triggers) — that rule defines posture-downgrade math; this rule's regression-within-grace clause feeds into MUST-4's emergency-trigger list but does NOT replace it. `rules/trust-posture.md` MUST Rule 7 § Two-Phase Rollout — that rule's principle is the foundation Rule 3 above instantiates; the carve-out language is borrowed and constrained to one-time-per-rule.

## Origin

2026-05-18 — journal/0098 §For Discussion #3 surfaced the question; co-owner approval ("approved") on the F4 recommendation in this session, both cons disclosed (bootstrap-circularity + surface-area definition). Receipt-first journal/0100 (this codify's provenance, per `rules/artifact-flow.md` § Co-Owner-Directed Origination). Originating evidence: forest-ledger arc journal/0089–0098, 7 redteam rounds + mid-arc Option A→B redesign, the substring-mask failure class structurally closed only after Option B inflection.
