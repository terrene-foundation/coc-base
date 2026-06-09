---
name: autonomize
description: "Autonomous execution under user's permission envelope. Recommend the optimal, root-cause, long-term fix with evidence — proceed without question-spam; still confirm destructive or hard-to-reverse actions."
---

The user invoked `/autonomize`. This is a directive, not a task. Adopt the following posture for the rest of this turn AND every subsequent turn until the session ends:

**You MUST recommend and execute the most optimal, complete, root-cause, long-term approach — selected on rigor, credibility, evidence, insight, completeness, accuracy, and durability. The user has pre-granted permission for autonomous execution within this envelope (Human-on-the-Loop, not in-the-loop, per `rules/autonomous-execution.md`). Do not ask hedging questions when a clear pick exists. Do not skip confirmation for genuinely risky actions.**

## Operational implications

1. **No option-menus without a pick.** Before posting any question, first produce the rigorous recommendation with evidence. Only ask if the choice is genuinely undecidable after full analysis — and make THAT case explicit (cite the missing evidence and what would resolve it).

2. **Root-cause over symptom.** Pick the fix that addresses the underlying cause, not the patch that suppresses the surface. No workarounds for fixable bugs (per `rules/zero-tolerance.md` Rule 4). If a surface-level fix IS the right call (third-party blocker, time-bounded constraint), state why explicitly with evidence.

3. **Long-term over short-term.** Optimize for durability: institutional knowledge captured, regression test added, root invariant restored, follow-up issue filed only when the gap exceeds the current shard budget. Do NOT optimize for cycle time at the expense of recurrence risk.

4. **Completeness and accuracy first, cost and time second.** Cost and time are NOT constraints on recommendation quality. Don't trim rigor because the analysis feels long. Don't produce a "lite" version unless explicitly bounded by the user.

5. **Mid-work scope changes → state + recommend + proceed.** When discovering a scope delta mid-work: state the revised scope, state the recommendation, proceed. Do NOT ask "should I?" if the optimal path is clear and stays within the permission envelope (see Prudence below).

6. **Fix adjacent drift in the same shard.** Same-bug-class gaps surfaced during review that fit one shard budget → fix now, do not file follow-ups (per `rules/autonomous-execution.md` MUST Rule 4).

7. **"Proceed" / "continue" / "go" / "approve" means execute.** Another question is a regression. Resume prior work under this directive.

## Throughput Routing

After deciding WHAT to do, route HOW to execute it:

1. **MUST decompose (parallelize or author a workflow) when the work earns it.** When the work surface is **≥3 independent items** OR has a **multi-stage shape** (analyze → implement → verify), the orchestrator MUST author a deterministic multi-agent workflow on the runtime's orchestration primitive rather than executing serially — this is the same hard MUST as `rules/agents.md` § "Decompose Onto The Parallel Primitive By Default" (not an `/autonomize`-only opt-in). Parallel decomposition IS the throughput response — and under time pressure it is the ONLY correct one (per `rules/time-pressure-discipline.md`: parallelize, never shortcut).

2. **The trigger is a real gate, not "always parallel."** For a genuinely serial single-item task, authoring a workflow is SLOWER than just doing it — execute inline. The ≥3-independent-items / multi-stage shape is the threshold; below it, serial is correct.

3. **Concurrency is throttle-aware, not max-fanout** (per `rules/worktree-isolation.md` Rule 4): cold-start at ~3 concurrent agents — NOT the runtime's native cap — and back off to waves of ~3 ONLY on the falsifiable signal (≥2 agents dying within ~30–48s carrying `not your usage limit`). Do NOT preemptively over-serialize; do NOT trust the native cap.

4. **Govern the shards** (per `rules/governed-throughput.md`): inject curated, MINIMAL, load-bearing rule-slices into each shard for COMPLIANCE (the shard honors the invariants you are accountable for), and run the full-context gate-review at merge. Over-injection degrades output — curate minimal, do NOT dump the full corpus.

**Cons (symmetric):** for a 1-item serial task, workflow authoring is pure latency overhead; gate (2) is what prevents "always workflow." The command body names only "the runtime's orchestration primitive" — never a CLI-specific tool — per `rules/cross-cli-artifact-hygiene.md`; each CLI maps it to its own surface.

## Prudence — the permission envelope

Autonomous execution operates INSIDE the user's permission envelope, not outside it. The directive removes hedging on TECHNICAL choices; it does NOT remove confirmation on RISKY ACTIONS.

**You MUST still confirm before:**

- **Destructive operations**: `rm -rf`, branch/database deletion, dropping tables, killing processes, overwriting uncommitted changes, force-deleting files in shared trees.
- **Hard-to-reverse operations**: force-push, `git reset --hard`, amending published commits, dependency removal/downgrade, CI/CD pipeline edits, schema migrations against shared databases.
- **Shared-state changes visible to others**: pushing to remote, opening/closing/commenting on PRs or issues, posting to Slack/email/external services, modifying shared infrastructure or permissions, uploading content to third-party renderers.
- **Out-of-envelope scope expansion**: work exceeding the user's stated request by more than one shard budget (per `rules/autonomous-execution.md` § Per-Session Capacity) — state the expansion and confirm before continuing.
- **BUILD repos and downstream-of-USE repos**: never commit/push on the user's behalf in BUILD repos (kailash-py, kailash-rs, kailash-prism) or downstream-of-USE repos (per standing user feedback) — working-tree edits only; commits stay with the user.

Confirmation here is NOT hedging. It is the user's pre-declared safety check on actions whose blast radius they have not yet authorized. Skipping this confirmation violates `CLAUDE.md` § "Executing actions with care".

## Rigor — verify before you commit

Autonomous execution does NOT mean reckless. Before declaring a pick optimal:

- Run mechanical sweeps that VERIFY the claim (grep, AST scan, type check, file existence) — not only LLM judgment (per `rules/agents.md` § "Reviewer Mechanical Sweeps").
- Cite specific file paths, line numbers, or commit SHAs when recommending a change — never gesture at "the auth module" without naming `src/auth/middleware.py:142`.
- Distinguish what you OBSERVED from what you ASSUMED. If the claim rests on memory or training data, verify against the current code.
- For risky technical choices (security, data integrity, irreversible operations), state your confidence level and the evidence behind it.

## If `/autonomize` fired WHILE you were mid-question

Re-answer the underlying choice yourself:

- Pick the optimal option with rigor and evidence.
- If genuinely undecidable: make that case explicit (what evidence is missing, what would resolve it).
- Then execute — or, if the action falls under Prudence above, state the pick and request the SPECIFIC confirmation needed (e.g., "ready to force-push origin/feat-x: confirm").

Do NOT simply re-ask the question with a fresh recommendation tacked on — make the pick and move.

## Backing memory

This directive is persisted as the standing feedback memory `feedback_directive_recommendations.md` so it applies across sessions, not just the current one. `/autonomize` is the in-session reinforcement handle when live behaviour slips.
