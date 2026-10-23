# Self-Referential /codify Discipline — Extended DO/DO-NOT Examples

Companion reference for `.claude/rules/self-referential-codify.md`. The full examples below moved
here verbatim (context-budget workstream,
2026-10-10). Examples only — every obligation, BLOCKED corpus and Why lives in the rule or its
wiring sibling `.claude/skills/32-trust-posture/wiring/self-referential-codify.md`.

## MUST-1 — Tier 1 (enforcement-bearing)

```markdown
# DO — /codify touches a self-referential surface file → multi-agent redteam runs in parallel before merge

Surface touched: .claude/rules/trust-posture.md (allowlist match)
Dispatched team (parallel): reviewer, security-reviewer, cc-architect, analyst
Each receives: proposal + receipt journal + originating evidence
Cross-agent verdicts reconciled by construction against the contract
Merge proceeds only when ≥0 genuine CRIT/HIGH across all four

# DO NOT — surface touched, posture L5, ship with mechanical-only per-round depth

Surface touched: .claude/rules/cc-artifacts.md (allowlist match)
Posture: L5_DELEGATED → per-round depth = mechanical-sweeps-only → skip the multi-agent team
Merge proceeds with no independent multi-agent review
(this is exactly the failure mode the rule blocks)
```

## MUST-1 — Tier 2 (prose-only, non-enforcement)

```markdown
# DO — Tier 2: a prose-only edit to an allowlisted rule → single cc-architect pass

Diff: reword a `**Why:**` line in trust-posture.md + fix one cross-reference. No MUST
delta, no detector, no allowlist change → Tier 2 → single cc-architect structural pass.

# DO NOT — run Tier 2 on an enforcement-bearing diff

Diff: adds a new BLOCKED-corpus phrase to security.md → that IS new load-bearing content
→ Tier 1 (full team), NOT a single cc-architect pass. (Tier 2 is prose-only, non-enforcement.)
```

## MUST-3

```markdown
# DO — first codify of this rule ships Phase-1 observer, declared in receipt

journal/NNNN § Bootstrap-circularity disposition:
"F4 IS a self-referential codification. Per trust-posture.md MUST-7
two-phase rollout, this codify ships F4 as Phase-1 observer under
L5_DELEGATED's reduced per-round depth. Phase-2 enforcement starts at
the NEXT self-referential codify."

# DO NOT — every future self-referential codify cites bootstrap-circularity to skip the gate

journal/NNNN: "this codify is self-referential, citing bootstrap-circularity
carve-out to skip multi-agent redteam-with-tests"
(BLOCKED — the carve-out is one-time-per-rule, not a per-session shortcut)
```
