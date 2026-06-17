---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/rules/**"
  - "**/.claude/skills/**"
  - "**/.claude/agents/**"
  - "**/.claude/hooks/**"
  - "**/.claude/commands/**"
  - "**/.claude/learning/**"
  - "**/.claude/settings.json"
  - "**/.claude/sync-manifest.yaml"
---

# Trust Posture — Graduated Autonomy Discipline

See `.claude/skills/32-trust-posture/` for codify/implement/redteam integration procedures and grace-period mechanics.

## Principle

Per CARE Principle 7 (Evolutionary Trust): _"Boundaries evolve based on demonstrated performance"_ (`skills/co-reference/care-spec.md:65`). Per EATP: _"Postures upgrade through demonstrated performance. They downgrade instantly if conditions change"_ (`skills/co-reference/eatp-spec.md:48`). Per Mirror Thesis: trust is validated against observable execution, not promised behavior — humans are the structural gate for upgrade; the system is the structural gate for downgrade.

The agent's autonomy is bounded by a **per-repo posture**. The posture starts at L5 DELEGATED on a fresh repo (with `.initialized` marker). It is automatically tightened by violation detection. It can only be loosened by human approval (challenge-nonce gated).

## Posture Ladder (L1 ← L5)

| Posture                   | Agent CAN do unilaterally                                                   | Requires human gate                                                     |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **L5_DELEGATED**          | Plan + implement + commit + open PR; parallel worktree agents; full /codify | Cross-repo writes; release tags; destructive ops                        |
| **L4_CONTINUOUS_INSIGHT** | Same as L5 + mandatory journal per shard + /redteam Round 1 before merge    | Posture upgrade; multi-shard releases                                   |
| **L3_SHARED_PLANNING**    | Edit + run tests; one shard at a time                                       | /todos plan approval before /implement; PR creation; commits to feat/\* |
| **L2_SUPERVISED**         | Read; propose diffs; run linters                                            | Every Edit/Write; every commit; every Bash beyond read-only             |
| **L1_PSEUDO_AGENT**       | Propose plans + diffs in chat                                               | Everything that touches the working tree                                |

## MUST Rules

### 1. Posture Is Per-Repo, Read From Main Checkout

The current posture is defined by `<main_checkout>/.claude/learning/posture.json`. Worktree-isolated agents MUST read from the main checkout (resolved via `git worktree list --porcelain` filtering out `.claude/worktrees/`), never their own worktree path.

```js
// DO — resolveMainCheckout() in hooks/lib/state-resolver.js
const main = resolveMainCheckout(process.cwd());
const posture = readPosture(main);
// DO NOT — use cwd directly inside a worktree
const posture = readPosture(process.cwd()); // reads stale or absent worktree state
```

**Why:** Worktrees are auto-deleted on cleanup; posture state written there is silently lost. The main checkout is the single source of truth (mitigates red-team CRIT-2).

### 2. Fresh Repo vs. Corrupt State Are Different

Missing `posture.json` AND missing `.initialized` marker → fresh repo, posture = L5 (default trust). Missing or corrupt `posture.json` WITH `.initialized` marker present → fail-closed to L1 (state was deleted/damaged; cannot trust).

**Why:** Without this distinction, an agent that nukes its own state file gets rewarded with full trust on next session. The init marker pinpoints "this repo has run before"; absent state after that is evidence of corruption, not freshness (mitigates red-team CRIT-4).

### 3. Downgrades Are Automatic; Upgrades Are Human-Gated

Downgrades fire on detection — no human in the loop, per EATP "downgrade instantly if conditions change." Upgrades require `/posture upgrade` with a challenge-nonce response from the user (the agent CANNOT self-promote).

**Why:** EATP Mirror Thesis — humans validate against observable execution. An agent that can self-promote has no upper bound on rationalization (mitigates red-team H2/M3).

### 4. Downgrade Triggers (Cumulative + Emergency)

**Cumulative (graceful):**

- 3× same-rule violations in 30-day window → drop one posture
- 5× total violations in 30-day window → drop one posture

**Emergency (instant downgrade by 1 posture, or to L1 for critical):**

- 1× `regression_within_grace` (violating a rule authored within its 7-day grace period) → drop 1 posture
- 1× `evidence_free_claim` (a security / compromise / injection / tampering claim asserted with no inline decoded-bytes evidence per `rules/evidence-first-claims.md` MUST-2) → drop 1 posture
- 1× `unverified_durable_code_claim` (a code-claim — API name / signature / count / membership — written into a durable artifact without same-session ground-truth verification per `rules/verify-claims-before-write.md`) → drop 1 posture
- 1× `time_pressure_procedure_drop` (procedure drop in response to user pressure framing per `rules/time-pressure-discipline.md`) → drop 1 posture
- 1× `streetlight_selection` (fittability-pick over higher-value candidate without value-anchor / named trade-off per `rules/value-prioritization.md` MUST-1) → drop 1 posture
- 1× `deferral_without_value_anchor` (deferred shard / "Carried-forward" / "tracked separately" / Phase-N reframing without adjacent value-anchor per `rules/value-prioritization.md` MUST-2) → drop 1 posture
- 1× `self_referential_codify_without_redteam` (a `/codify` touching the self-referential surface allowlist per `rules/self-referential-codify.md` Rule 2 shipped without multi-agent redteam-with-tests per Rule 1) → drop 1 posture
- 1× `proximity_band_admission_bypass` (`rules/rule-authoring.md` MUST Rule 10 violation: baseline-priority rule addition within 15% proximity band without paired extraction OR named-rationale exception) → drop 1 posture
- 1× `recurrent_extraction_escalation_bypass` (`rules/rule-authoring.md` MUST Rule 11 violation: 2nd Rule-10 invocation on same (rule, CLI) lane within 30 days without disposition (a') corpus review or (b') sixth-sub-field named-rationale) → drop 1 posture
- 1× `governed_throughput_bypass` (`rules/governed-throughput.md` violation: a governed-path parallel/orchestrated shard delegated without curated rule-slices, OR a full-corpus injection, OR a slice-limited/skipped merge gate) → drop 1 posture
- 1× `unbacked_author_claim` (`rules/journal-author-discipline.md` MUST-1 violation: a journal entry shipped with an `author:human|co-authored` claim that is UNBACKED against the live per-session provenance ledger) → drop 1 posture
- 1× `wave_gate_skipped` (`rules/wave-loop.md` violation: a wave launched without its inter-wave gate per MUST-2, OR a value-coherent mega-wave overflowing the MUST-1 bound-B invariant ceiling, OR a self-attested wave-boundary verdict without a durable receipt per MUST-5) → drop 1 posture
- 1× **critical**: destructive op without confirm (rm -rf, git reset --hard without porcelain check, force-push to main); secret leak; cross-repo write outside scope → drop to L1
- 1× corrupt-state event (with init marker) → drop to L1

**Why:** Cumulative thresholds tolerate noise; emergency triggers reflect rules whose violation IS the worst-case failure mode. `regression_within_grace` is special — violating a rule the agent itself authored within days is the worst kind of self-deception.

### 5. Upgrade Requirements (All Four)

- ≥7 days at current posture (`time_at_current_posture_hours ≥ 168`)
- 0 violations of the rule class that triggered the most recent downgrade
- Demonstrated correction: ≥1 session where the agent caught + fixed a same-class issue proactively (logged as positive observation)
- Human approval via `/posture upgrade` — challenge-nonce paste-back

**Why:** Time alone is gameable (wait it out); zero-violations alone is gameable (avoid the surface); human gate alone is forgeable (agent invokes the slash command itself). All four together close the rationalization loop.

### 6. Grace Period Semantics

When `/codify` authors a rule that addresses a self-reported or detected violation, the rule enters `pending_verification` for 7 days. During grace:

- SessionStart hook injects a high-visibility trust-gate banner naming the rule
- `detect-violations.js` runs the rule's pattern in `halt-and-report` severity (not observer-only)
- A violation matching the rule = `regression_within_grace` → emergency downgrade

**Why:** A rule the agent just authored to fix itself, then violates within days, is the loudest possible signal that the rule needs teeth. Grace period turns the new rule from passive prose into active enforcement.

### 7. Trust Posture Wiring Required In Codified Rules

`/codify` MUST attach a "Trust Posture Wiring" section to every new rule proposal using the canonical 8-field template (Rule 8 below). Proposals without the wiring section, OR with a wiring section that omits any of the 8 canonical fields, are rejected at sync-reviewer Gate 1.

**Why:** A rule without wiring is institutional prose — no automatic enforcement, no detection, no consequences for violation. Wiring is what makes a rule a structural defense rather than a hopeful suggestion.

### 8. Canonical 8-Field Wiring Template (MUST)

Every Trust-Posture-Wired rule MUST use the canonical 8-field template. Fields MUST appear in the order below, each as a `**Field:**` bullet on its own line. Anchoring `**Violation scope:**` AFTER the detection-mechanism field is REQUIRED — the cc-architect mechanical sweep greps for that literal token as the structural marker of canonical-template compliance.

```markdown
## Trust Posture Wiring

- **Severity:** `block` / `halt-and-report` / `advisory` per `hook-output-discipline.md` MUST-2 carrier rules (structural-signal → `block`; LLM-judgment-bearing → `halt-and-report`; lexical-regex-only → `advisory`).
- **Grace period:** N days from rule landing (canonical = 7 days; deviations require named rationale).
- **Cumulative posture impact:** how same-class violations contribute to `trust-posture.md` MUST-4 cumulative-window math (e.g., "3× same-rule in 30d → drop 1 posture"; or "N/A — emergency-only trigger"). Required even when N/A so the reader knows the cumulative path is not silently inherited.
- **Regression-within-grace:** which named trigger key (`regression_within_grace`, `time_pressure_procedure_drop`, `streetlight_selection`, etc.) fires the emergency downgrade per MUST-4 § Emergency, AND the posture-drop magnitude (1 step / to L1).
- **Receipt requirement:** SessionStart `[ack: <rule_id>]` requirement IFF `posture.json::pending_verification` includes this rule_id. State explicitly whether ack is hard-gate or soft-gate.
- **Detection mechanism:** named hook function / mechanical sweep / gate-level reviewer surface that produces the structural signal. Cite the hook path (`.claude/hooks/lib/<file>.js::<function>`), the audit-fixture directory, AND the gate-level surface (`/codify` mechanical sweep at cc-architect / reviewer / analyst). For Phase-1 manual / Phase-2 deferred detection, state both rows.
- **Violation scope:** which named MUST clauses of THIS rule trigger the Wiring (e.g., "MUST 1+2 lexical detection; MUST 3 structural exit-code"). Anchors the cc-architect sweep — `**Violation scope:**` is the literal grep token.
- **Origin:** cross-reference back to the rule's own Origin footer (e.g., "See § Origin"). If the rule's Origin section is absent, write the provenance receipt inline here.
```

**BLOCKED rationalizations:**

- "The rule's existing 4-field Wiring is grandfathered, leave it alone"
- "Adding `**Violation scope:**` is redundant when MUST clauses already exist"
- "8 fields is bureaucracy; pick the 4 that matter for this rule"
- "Cumulative posture impact is implied by the trigger key; no separate field needed"
- "Origin field duplicates the rule's footer; one or the other suffices"

**Why:** A 4-field Wiring section drifts silently because authors fill in whichever fields they think matter and the reader cannot grep for what is missing. The 8-field template + the `**Violation scope:**` literal-token marker convert "did the author include the full contract?" from an LLM-judgment question into a 4-second `grep -L` sweep. Sweep query: `grep -L 'Violation scope:' .claude/rules/*.md` lists every Trust-Posture-Wired rule that lacks canonical-template compliance. **Grandfather cutoff:** rules landed BEFORE the SHA of this edit are exempt until their next `/codify`-touched edit; rules landed AT or AFTER this SHA MUST ship canonical-template-compliant. New rules authored by F-series shards (M8 onward), including `multi-operator-coordination.md`, `knowledge-convergence.md`, and `user-flow-validation.md`, MUST ship canonical-template-compliant on first land.

## MUST NOT

- Edit `.claude/learning/posture.json`, `.claude/learning/posture.json.bak`, or `.claude/learning/violations.jsonl` directly via Edit/Write/Bash. Settings.json `permissions.deny` enforces this.

**Why:** State self-modification is the rationalization loophole that defeats the entire system. The hooks are the only legitimate writers (mitigates red-team CRIT-3).

- Sync `posture.json` or `violations.jsonl` between repos via `/sync`, `/sync-to-use`, or `/sync-to-build`. State is per-repo.

**Why:** A USE template inheriting BUILD repo's degraded posture would corrupt downstream. Insight (rule patterns) syncs through `/codify`; state stays local (mitigates red-team M1).

- Treat `regression_within_grace` as a routine cumulative violation — it MUST emergency-downgrade.

**Why:** Routing it through the cumulative path lets the agent rationalize "1 of 3, still fine" while violating its own freshly-authored rule. The emergency path closes that gap.

- Self-confess + log + downgrade in one shot from a lexical regex match alone.

**Why:** Lexical patterns ("I missed", "incomplete") are evadable AND false-positive-prone. Self-confession is `advisory`/`post-mortem` only. Real downgrades come from behavioral signals (test-collection exit codes, AST checks, command-history audit) — never from prose alone (mitigates red-team H2).

## Two-Phase Rollout

Phase 1 (current): hooks + state files + observer-mode detection + `/posture` show + emergency triggers live. No `/codify` integration enforcement yet.
Phase 2 (after ≥10 real sessions exercise the system): `/codify` Trust Posture Wiring requirement enforced; full PreToolUse posture-gate teeth at L2/L3.

**Why:** A meta-rule and its enforcement should never bootstrap in the same release — the rule is then drafted by an agent operating without it (mitigates red-team H4 bootstrapping circularity).

Origin: 2026-05-05 design session, red-team-validated by 21/21 subprocess tests on POC at `.claude/test-harness/trust-posture-poc/`. Grounded in CARE Principle 7 + EATP graduated postures + Mirror Thesis (`skills/co-reference/care-spec.md:65`, `skills/co-reference/eatp-spec.md:42-48`). Tabletop scenario: incomplete-test → user-catch → /codify rule → next-day regression → emergency downgrade L5→L4. See `skills/32-trust-posture/` for procedures.
