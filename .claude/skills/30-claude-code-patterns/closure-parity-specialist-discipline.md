# Closure-Parity Specialist Discipline

Procedural depth for the `agents.md` MUST clause "Audit/Closure-Parity Verification Specialist Has Bash + Read". The core MUST requirement lives in `.claude/rules/agents.md`; this sub-file carries the BLOCKED-rationalization corpus, the delegation-time detection signals the orchestrator scans pre-launch, the BLOCKED auto-promotion patterns, and the multi-incident Origin evidence.

## Why this lives in a skill (not the rule)

The MUST clause itself is load-bearing baseline content. The BLOCKED corpus + signal enumeration + Origin block are reference material that the agent needs available when it's about to delegate a /redteam round — not on every session start. Per `cc-artifacts.md` MUST NOT "No knowledge dumps: Agent files ≤400 lines. Extract reference to skills" and per the established `worktree-orchestration.md` precedent (`agents.md:121-123`), depth goes here; the load-bearing tripwire stays in the rule.

## BLOCKED Rationalizations (read-only analyst on closure-parity verification)

When the orchestrator considers assigning a read-only analyst (`Read, Grep, Glob`) to a closure-parity verification round, the following rationalizations MUST NOT be used as authority. Each one has appeared as the cited justification for an audit round that subsequently FORWARDED verification rows the next round had to redo:

- "Analyst is the audit specialist; closure parity IS audit"
- "The reviewer round can pick up the FORWARDED rows"
- "I'll instruct the analyst to skip rows it can't verify"
- "Read+Grep+Glob covers most verification"
- "Analyst can write a recommendation; verification can be done by the next reviewer"

## Delegation-Time Detection Signals (orchestrator self-check before launch)

Before delegating, the orchestrator MUST scan the prompt-being-drafted for closure-parity mission markers. Presence of ANY of the following in the prompt obligates a Bash+Read specialist (general-purpose, pact-specialist, or framework specialist with full tool inventory) — selecting analyst with these markers present is BLOCKED:

- **Verification verbs**: "verify closure", "closure parity", "FORWARDED → VERIFIED", "convert FORWARDED rows", "map findings to delivered code"
- **Bash-required commands named in mission**: `gh pr view`, `gh pr diff`, `gh issue view`, `pytest --collect-only`, `ast.parse(`, `cargo nextest`, `find -type f`, `grep -c`
- **Closure-parity nouns**: "Round N closure parity", "post-merge verification", "wave-N → wave-N+1 audit", "redteam round N convergence check"

The orchestrator MUST run this scan as a pre-flight before EVERY closure-parity-class delegation; surfacing the mismatch at delegation-time is O(1), re-launching after the agent FORWARDS rows is O(N) on row count and burns the round.

(See `agents.md` Example 5 for the delegation-time scan pattern.)

## BLOCKED Auto-Promotion Rationalizations

When the delegation-time scan surfaces a mismatch (closure-parity markers present + analyst selected), the following auto-promotion rationalizations MUST NOT be used as authority to launch anyway:

- "I'll let the agent figure out it lacks the tool"
- "Analyst handles audit by name, the markers don't override"
- "Execution-time error is fine; the agent will surface it"
- "Skipping the scan saves the orchestrator one step"

## Why The Discipline Holds

Tool-inventory mismatch costs one full audit round; verifying pre-launch is O(1) while re-launch is O(N) on row count. The delegation-time scan converts the Bash+Read specialist mandate from a recall-it-yourself principle into a draft-time check the orchestrator runs every cycle.

## Origin Evidence (multi-incident)

**2026-04-27 /redteam Round 3** — analyst FORWARDED 16 of 22 verification rows; Bash-equipped specialist re-ran Round 3 and converted all 16 to VERIFIED in one shard.

**2026-05-09 stale-workspace disposition Round 3** — analyst (Read/Grep/Glob) FORWARDED 5 rows on phantom-citation chain; re-launched as general-purpose caught the HIGH-class phantom in `.session-notes:20`.

**2026-05-22 F20 extraction cycle** — security-reviewer's M5 finding (this audit) is a meta-instance: the security-reviewer specialist lacked Bash and FORWARDED Tier-2 verification rows that the orchestrator + reviewer-with-Bash had to cover. Confirms the rule generalizes to closure-parity verification of the rule itself. See `journal/0143-DECISION-m9-3-closure-partial-py-rb-shipped-rs-deferred-2026-05-22.md` § "Deferred shard: rs lane (value-anchored)" for the F20 provenance receipt.

Compiled-language audit toolkits substitute their own introspection commands (`cargo nextest`, `cargo doc`, `grep` on Rust source) for the Python introspection set — the underlying principle (Bash + Read required for runtime verification) generalizes across stacks.

## Closure-Parity CLEAN Is Not Convergence — A Fresh-Eyes Round Follows

A closure-parity round verifies PRIOR findings are closed; a fresh-eyes round hunts NEW defects. They are orthogonal — a CLEAN closure-parity verdict says nothing about defects nobody has looked for yet. Before declaring a wave/gate converged, run ≥1 fresh-eyes round (blind auditors, distinct lenses — e.g. spec+test / parity+security) AFTER the closure-parity round. Evidence: kailash-rs journal 0178 — R2 closure-parity returned CLEAN; R3 fresh-eyes caught a Go AlignEngine UAF (HIGH, exploitable under GC pressure) and a phantom spec section that would have shipped to v4.5.0. The pattern recurred across the whole F16/W2C wave (journals 0154/0167/0175): mechanical/closure rounds CLEAN → independent fresh-eyes still finds HIGH.

## Read-Only Reviewers: Materialize The Branches Instead Of Re-Dispatching

When the correct specialist for a REVIEW mission is read-only (security-reviewer: Read/Grep/Glob) but the artifacts live on unfetched PR branches, do NOT hand it `gh pr diff` instructions (it cannot run them and will correctly refuse per evidence-first discipline). Materialize the branches as throwaway worktrees first, then point the read-only agent at on-disk paths:

```bash
git worktree add /tmp/sec-w31 origin/feat/<branch-a>
git worktree add /tmp/sec-w32 origin/feat/<branch-b>
# prompt: "review /tmp/sec-w31/<path> ... everything is Readable; no shell required"
# afterwards: git worktree remove /tmp/sec-w31 --force
```

This preserves the read-only specialist's tool-inventory guarantees (it cannot mutate anything) while giving it the bytes. Evidence: 2026-06-11 Wave-3 security review — first dispatch with `gh pr diff` instructions returned BLOCKED (correct); re-dispatch against materialized worktrees returned a full APPROVED report.

## Cross-references

- `.claude/rules/agents.md` § "MUST: Audit/Closure-Parity Verification Specialist Has Bash + Read" — load-bearing MUST clause
- `.claude/rules/agents.md` § "MUST: Verify Specialist Tool Inventory Before Implementation Delegation" — sibling MUST clause this one extends from IMPLEMENTATION to AUDIT delegation
- `.claude/rules/agents.md` Examples 4 + 5 — CLI-specific dispatch syntax for closure-parity verification + delegation-time scan
- `.claude/skills/30-claude-code-patterns/worktree-orchestration.md` — parallel-pattern precedent for skill-extension of agents.md MUST clause depth

## Provenance

Extracted from the `agents.md` MUST clause "Audit/Closure-Parity Verification Specialist Has Bash + Read" during the F20 (M9.3 rs lane completion) cycle on 2026-05-22. See `journal/0143-DECISION-m9-3-closure-partial-py-rb-shipped-rs-deferred-2026-05-22.md` § "Deferred shard: rs lane (value-anchored)" for the originating value-anchor. The extraction closes the rs lane Codex/Gemini emission headroom-floor gap (8.76%/8.80% → ≥10% after extraction); rule MUST clause stays load-bearing in agents.md, procedural depth lives here.
