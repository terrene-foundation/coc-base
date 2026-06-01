---
priority: 10
scope: path-scoped
paths:
  - ".claude/agents/**"
  - ".claude/commands/**"
  - ".claude/skills/**"
  - "**/*worktree*"
  - "**/workspaces/**"
---

# Governed-Throughput — Parallel Subagents Carry Curated Governance

A parallel / deterministic-orchestration subagent runs LEAN by default: its injected preamble is the deferred-tool list + the skill listing, NOT the rule corpus (verified — loom#419: a live workflow-subagent transcript carried zero governance markers). The governance-injection obligation is the ORCHESTRATOR's; it is NOT auto-inherited (per `rules/agents.md` § Specs Context in Delegation + `rules/specs-authority.md` Rule 7).

**What injection buys is MEASURED, not assumed.** The loom#419 ablation (2 model tiers × 4 arms × 3 tasks × 2 blind judges; journal/0193) found: lean prompts produce the HIGHEST-quality plans at both tiers (the "+12 performance" n=1 did NOT replicate); injection's value is **compliance** (the shard honors the specific invariants the orchestrator is accountable for — spec-citation + security) and **harm-minimization** (curated COC slices degrade output far less than generic verbosity, especially on weaker models: Haiku ΔCD=+8.3); and **over-injection DEGRADES** (an Opus rule-authoring plan cratered 82 vs 93 under a dense slice). The ablation is DIRECTIONAL (n=3 tasks, single run, generate-a-plan proxy — journal/0193 caveats), so this rule binds its MUST to the pre-existing `agents.md` principle, not the numbers. This rule encodes that evidence: inject CURATED, MINIMAL slices for compliance; keep the full-context gate-review as the quality backstop. It does NOT claim injection raises raw quality — lean + gate does that.

## The three layers

- **L1 — governed `agentType` (OPTIONAL, insufficient alone).** The orchestrator MAY set the shard's specialist agentType. #419 arm-B (agentType-only) scored ≈ lean — noise. Never the governance mechanism on its own.
- **L2 — curated rule-slice injection (LOAD-BEARING MUST, for compliance).** Inject the matching rules' load-bearing clauses, sliced + minimal. The compliance lever.
- **L3 — full-context gate-review at merge (BACKSTOP MUST).** The existing reviewer gate, run full-context — the quality+compliance backstop for L2's deliberate slicing. An invariant the minimal L2 slice DROPPED is precisely what L3's full-corpus review exists to catch; L2-minimal is safe ONLY because L3 is non-negotiable.

## MUST Rules

### 1. Governed-Path Shards MUST Carry Curated, Minimal Rule-Slices (L2)

When an orchestrator delegates a parallel / orchestrated shard whose touched-file set matches a governed path (any path-scoped rule's `paths:` glob, OR a `framework-first.md` work-domain), the orchestrator MUST inject into that shard's delegation prompt the load-bearing MUST / MUST-NOT clauses of the matching rules — sliced to clauses ONLY (NO examples, NO Origin, NO Trust-Posture-Wiring). Injecting the FULL rule corpus is BLOCKED. Injecting ZERO governance into a shard touching a governed path is BLOCKED.

```text
# DO — curated minimal slice (the 3-5 matching MUST clauses, clauses only)
Agent(prompt="""...task...
GOVERNANCE (honor these — you are accountable):
- security.md: ALL DB queries parameterized; never f-string/concat.
- testing.md Tier 2: real infra, NO mocking; verify writes with a read-back.
- zero-tolerance Rule 2: no stubs/placeholders.""")

# DO NOT — full corpus dump (over-injection degrades + re-triggers the throttle)
Agent(prompt="...task...\n" + read_all_rules())
# DO NOT — zero governance on a governed path (shard bypasses your invariants)
Agent(prompt="...task...")
```

**BLOCKED rationalizations:** "the subagent inherits the rules" (it does NOT — verified #419) / "inject the whole corpus to be safe" (over-injection degrades output AND re-triggers the concurrency throttle) / "the specialist agentType already knows" (Layer-1 alone is noise, #419 arm-B) / "lean is fine, skip injection" (lean is fine for raw QUALITY but the shard then bypasses the invariants you are accountable for).

**Why:** A lean shard is the most accurate for raw quality (journal/0193) yet does NOT honor the specific invariants — tenant isolation, no-stubs, deprecation shims, existence-check-first — the orchestrator is accountable for. Curated slices steer the shard to those invariants (the spec-citation + security gain in the ablation) WITHOUT the over-injection degradation a full-corpus dump causes (the T2 crater). The slice is a compliance mechanism, not a quality lever.

### 2. The Slice Selector MUST Be Deterministic, Reusing On-Disk Indices

The orchestrator MUST select slices via a deterministic two-tier path-glob, NOT a free-form agent judgment of "which rules feel relevant." Tier 1: the shard's work-domain → specialist via the `framework-first.md` domain table (the specialist's declared concern is the first slice). Tier 2: glob the shard's touched-file set against every rule's `paths:` frontmatter (read the rules' frontmatter from the committed HEAD, never a sibling's mid-edit working tree, per `rules/agents.md` § concurrent-readers-read-committed-HEAD); the matching rules' MUST / MUST-NOT clauses ARE the curated slice. Selecting slices by free-form relevance judgment is BLOCKED.

**Touched-path scrub (MUST):** the shard's touched-file SET feeds the selector AND lands verbatim in the injected slice header / the persisted orchestration script / any committed audit fixture — all durable surfaces. Those path tokens MUST be genericized per `rules/upstream-issue-hygiene.md` MUST-2 + `rules/security.md` § "No secrets in logs" (no `/Users/<operator>/…`, no `src/<consumer-app>/…`, no client-named module) BEFORE durable embedding. The SLICE CONTENT (loom's own public rule clauses) is safe; the leak vector is the consumer-path SELECTOR INPUT.

**CLI-emission scope — the on-disk glob IS the guard (no separate runtime CLI-guard; F113b).** The selector globs ONLY the rules present on disk in the orchestrator's own repo, and those are already CLI-filtered at `/sync` (a single-CLI consumer never receives a rule excluded for its CLI per `sync-manifest.yaml::cli_emit_exclusions`; a CC-only rule like `30-claude-code-patterns/**` is not on a Codex/Gemini consumer's disk to be selected). A subagent runs under the orchestrator's OWN CLI runtime — there is no primitive that spawns a foreign-CLI shard from inside a session — so the selector structurally cannot inject a CC-only slice onto a non-CC shard. A separate `/sync`-time-vs-runtime emission guard is therefore NOT required; the on-disk `paths:`-glob is the guard. (Revisit only if a future multi-CLI runtime introduces cross-CLI subagent spawning — absent today; the Codex/Gemini orchestration-primitive work is parked at F111. Disposition receipt: journal/0196 § F113b.)

```text
# DO — path-glob the shard's touched files against rules' paths: frontmatter
touched = ["packages/x/src/db/repo.py"]  → matches security.md, testing.md, patterns.md paths
inject(slices_of(security.md, testing.md, patterns.md))   # deterministic

# DO NOT — free-form relevance guess
inject(["I think security and testing are relevant"])     # drifts per-orchestrator
```

**Why:** Deterministic path-glob is config-branching (the permitted exception in `rules/agent-reasoning.md`), not agent reasoning — it is the SAME computation the CLI runtime already runs to decide which path-scoped rules to inject per session, front-loaded into the delegation prompt. Free-form relevance judgment drifts per-orchestrator and silently drops the rule that mattered.

### 3. The Merge Gate MUST Run Full-Context, Not Slice-Limited (L3)

Before any governed shard's work merges, the existing merge-time gate-review (reviewer + security-reviewer, per `rules/agents.md` § Quality Gates) MUST run with FULL context (the complete applicable rule corpus + the diff), NOT slice-limited to what L2 injected. L3 is the quality + compliance backstop for L2's deliberate minimal slicing. Skipping the merge gate OR limiting it to the injected slices is BLOCKED.

```text
# DO — full-context reviewer at merge (the backstop for the minimal slice)
Agent(subagent_type="reviewer", prompt="Review the diff against the FULL rule corpus...")

# DO NOT — "the shard had its slices, skip the gate" / "review only vs injected slices"
```

**Why:** L2 deliberately injects a MINIMAL slice (over-injection degrades); the full-context gate is what catches an invariant the slice did not cover. journal/0193: lean-generation + full-context-gate beats inject-everything — so the governance that does not fit the minimal slice belongs at the gate, where it does not degrade generation.

## MUST NOT

- Treat L1 (`agentType`) as a substitute for L2 slice injection.

**Why:** #419 arm-B (agentType-only) scored ≈ lean (noise); the specialist system prompt does not carry the baseline rule corpus. Only curated slice injection moves the compliance needle.

- Inject the full rule corpus into a shard prompt "to be safe."

**Why:** Over-injection re-triggers the server-side concurrency throttle (loom#418/#419) AND degrades output (journal/0193 finding #4 — the T2 crater). Minimal curated slices are the only correct injection.

- Claim a shard is "governed" because its `agentType` is a specialist, with no slices injected.

**Why:** Same as the L1-substitute failure: the agentType is necessary-context at best, never the compliance mechanism. "Governed" means the invariants were injected and the merge gate ran full-context.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect / reviewer mechanical sweep at `/codify` + the `/implement` merge gate); `advisory` only at any future hook layer (slice-injection discipline is prose-shaped, not a structural tool-call signal — per `rules/hook-output-discipline.md` MUST-2, no `block` from a lexical match).
- **Grace period:** 7 days from rule landing (2026-06-01 → 2026-06-08).
- **Cumulative posture impact:** same-class violations (a governed-path shard delegated without curated slices; a full-corpus injection; a slice-limited or skipped merge gate) contribute to `rules/trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days of landing triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `governed_throughput_bypass` added to that rule's emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: governed-throughput]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** Phase 1 — review-layer mechanical sweep at `/codify` + `/implement`. cc-architect / reviewer inspects any session transcript that delegated parallel / orchestrated shards on governed paths and confirms: (a) each shard's prompt carried a curated slice (NOT full-corpus, NOT zero) selected by path-glob; (b) the merge gate ran full-context. Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real governed-throughput delegations exercise Phase 1) — a `.claude/hooks/lib/violation-patterns.js` detector on delegation-prompt construction, advisory. Audit fixtures land WITH that Phase-2 detector at `.claude/audit-fixtures/governed-throughput/` per `rules/cc-artifacts.md` Rule 9 (Phase 1 is a manual review-layer sweep — no hook detector yet to fixture-test).
- **Violation scope:** MUST 1+2 (curated-slice injection + deterministic selector) and MUST 3 (full-context merge gate). Every `violations.jsonl` row records which MUST clause fired.
- **Origin:** See § Origin below.

## Origin

F110 / loom#419 (folds #418), co-owner-directed origination 2026-06-01. Receipt-first DECISION: journal/0194. Empirical evidence: journal/0193 (governance-for-performance ablation — 2 model tiers × 4 arms × 3 tasks × 2 blind judges; the +12 n=1 did not replicate; injection's value is compliance + harm-minimization; over-injection degrades). The L2 MUST binds to the pre-existing `rules/agents.md` Specs-Context-in-Delegation principle, NOT the contested ablation number — so the rule stands independent of the empirical claim's regime-bounds. CC how-to depth lives in `.claude/skills/30-claude-code-patterns/workflow-orchestration-throughput.md` (CC-only per `sync-manifest.yaml::cli_emit_exclusions`).
