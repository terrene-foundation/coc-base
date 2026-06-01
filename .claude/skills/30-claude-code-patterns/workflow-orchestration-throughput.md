# Workflow-Orchestration Throughput (Claude Code)

The CC how-to behind `rules/governed-throughput.md` (the L1/L2/L3 contract) and `rules/worktree-isolation.md` Rule 4 (throttle-aware concurrency). CC-only by design — `30-claude-code-patterns/**` is excluded from Codex/Gemini emission (`sync-manifest.yaml::cli_emit_exclusions`); Codex/Gemini get the CLI-neutral routing trigger via `/autonomize`, not this file.

On Claude Code the orchestration primitive is the **Workflow tool** (deterministic multi-agent script: `agent()` / `parallel()` / `pipeline()`, `schema:` structured returns, `resumeFromRunId`, runs outside the main context). `/autonomize` routes ≥3-independent-item OR multi-stage work onto it.

## The evidence that shapes HOW you orchestrate (journal/0193)

The governance-for-performance ablation (2 model tiers × 4 arms × 3 tasks × 2 blind judges) found, and these are the load-bearing design constraints:

1. **Lean generation + full-context merge gate beats inject-everything.** The "+12 from injecting rules" did NOT replicate; lean prompts produced the highest-quality plans at both tiers. → Govern at the **gate** (L3), inject only **minimal** slices at generation (L2).
2. **Over-injection DEGRADES output** — a dense rule-slice dropped a rule-authoring plan from ~93 to 82. → Inject **curated, load-bearing clauses only** (no examples/Origin/Wiring); never the full corpus.
3. **Curated COC slices beat generic verbosity, and the gap GROWS as the model weakens** (Haiku ΔCD=+8.3). → If you delegate to a cheaper/weaker model, curated slices matter MORE, generic "be thorough" preambles actively harm.
4. **Injection's value is COMPLIANCE, not quality** (spec-citation + security). → Inject to ensure the shard honors invariants you're accountable for, not to make it "smarter."

## Patterns

- **Read-only fan-out** (surveys, audits, claim-verification): independent `agent()` calls, no shared-source edits → no worktree needed. Cap concurrency throttle-aware (below), not at the native 14.
- **verify → implement pipeline** (`pipeline()`, no barrier): each item flows through stages independently; wall-clock = slowest single chain, not sum-of-slowest-per-stage. Use the barrier (`parallel()`) ONLY when a stage needs ALL prior results (dedup, early-exit on zero, cross-item comparison).
- **loop-until-budget / loop-until-dry**: accumulate to a target or until K consecutive empty rounds; honest tails beat fixed counts.
- **schema returns**: for machine-checkable verdicts (judges, structured findings). **Fragility lesson (2026-06-01):** schema-forced specialist agents can fail `StructuredOutput-not-called`, esp. across an account/auth interruption mid-run. Mitigation: use **non-schema agents for analysis** (return text — reliable); reserve `schema:` for judges/verdicts; tolerate dropout via `.filter(Boolean)`; keep waves small so a failed wave is cheap to re-run.
- **resumeFromRunId recovery**: a killed/edited workflow re-runs only the changed `agent()` calls; the unchanged prefix returns cached. Edit the persisted `scriptPath`, re-invoke with `{scriptPath, resumeFromRunId}`.
- **worktree isolation for compiling agents** (`isolation: "worktree"`): own `target/` / `.venv/` per agent — retained unchanged (`rules/worktree-isolation.md` Rules 1-3, 5-6). Only the concurrency-count mechanism (Rule 4) is throttle-aware now.

## Throttle-aware concurrency (dogfood `rules/worktree-isolation.md` Rule 4)

The Workflow tool's native cap is `min(16, cores−2)≈14` — **too high**. #419: a 7-agent fan-out synchronized-died at ~37–48s with `(not your usage limit)`. Cap your own waves at **~3**:

```js
function chunk(a, n) {
  const o = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}
async function wavesOf3(thunks) {
  const out = [];
  for (const w of chunk(thunks, 3)) out.push(...(await parallel(w))); // ≤3 concurrent
  return out;
}
```

Back off to serial waves of ~3 ONLY on the falsifiable signal (≥2 agents dying within ~30–48s carrying `not your usage limit`). Do NOT preemptively over-serialize below ~3; do NOT trust the native 14.

## The L2 injection how-to (curated, minimal — per `rules/governed-throughput.md`)

Before delegating a governed-path shard, build its slice deterministically:

1. **Tier 1:** shard work-domain → specialist (`framework-first.md` table) — the specialist's concern is the first slice (optionally set `agentType`).
2. **Tier 2:** glob the shard's touched-file set against every rule's `paths:` frontmatter; inject the matching rules' MUST/MUST-NOT clauses ONLY.

```js
// DO — curated minimal slice (clauses only), then the full-context gate at merge
const slice = "GOVERNANCE (honor these):\n- security.md: parameterize all DB queries...\n- testing.md Tier 2: real infra, read-back verify...";
await agent(slice + "\n\n" + taskPrompt, { agentType: "dataflow-specialist", schema: ... });
// L3: reviewer + security-reviewer at merge run FULL context (not slice-limited).

// DO NOT — full-corpus dump (degrades output + re-triggers the throttle) OR zero governance.
```

Why curated-minimal and not "inject everything": over-injection degrades the shard's output (finding #2) AND re-triggers the concurrency throttle. The minimal slice is for compliance; the full-context merge gate (L3) is the quality backstop.

Origin: F110 / loom#419 (folds #418); receipts journal/0193 (ablation) + journal/0194 (DECISION).
