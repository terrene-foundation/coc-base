# Specs Authority — Extended Evidence and Examples

Companion reference for `.claude/rules/specs-authority.md`.

## Rule 5b — Full Sibling Re-Derivation: Two-Session Post-Mortem

The narrow-scope failure mode is empirically recurrent across two sessions, validating the rule:

**Session 2026-04-19 (journal 0007-DISCOVERY-full-specs-sweep-round.md):**

- Edited 2 ML specs.
- `/redteam` ran narrow-scope sweep against the 2 edited specs only.
- Produced "14/14 green" APPROVE verdict.
- Files NOT re-derived: remaining 20+ `specs/ml-*.md` siblings.

**Session 2026-04-20 (journal 0008-GAP-full-specs-redteam-2026-04-20-findings.md):**

- Same edits as previous session (not re-run; audit-only).
- `/redteam` ran full-sibling sweep across all `specs/ml-*.md` (20+ files).
- Found 9 HIGH cross-spec drift findings in specs the prior edit never touched.

Root cause of the drift: `specs/ml-engines.md` had introduced a `TrainingResult` dataclass change (added `device` field). Sibling specs still referenced the pre-change shape (`TrainingResult.backend`, `TrainingResult.devices` as top-level fields) in their own MUST clauses. The narrow-scope sweep never loaded the siblings; the full-sibling sweep did.

Two sessions, same failure mode → full-sibling sweep is the only structural defense.

## Rule 5c — Amend-At-Launch: W32 + W33 Evidence

**W32-32b (2026-04-23 kailash-ml-audit):**

- Todo text: "bump kailash-align 0.4.0 → 0.5.0"
- Current state at launch: W30.3 had already shipped align 0.5.0 (commit `41a217dc`) days earlier.
- Launching the agent with the stale todo would have tried to create a tag `v0.5.0` → collision with existing tag → shard fails at commit time.
- Orchestrator amended the todo text inline: "bump kailash-align 0.5.0 → 0.6.0". Saved one failed shard.

**W33 (2026-04-23):**

- Todo text: "`__all__` exports 34 symbols"
- `specs/ml-engines.md` §15.9 at launch time: "`__all__` exports 41 symbols (40 + erase_subject)"
- Spec was newer than todo; per §5b full-sibling preference, the spec is the authority.
- Orchestrator amended the prompt: "prefer spec §15.9 per specs-authority §5b; export 41 symbols."
- Agent landed 41 correctly.

Without these two amendments, both shards would have failed at commit time — collision on W32, symbol-count mismatch on W33.

Cost accounting: 2-minute launch-time amendment vs. a failed shard that costs:

- Agent context already spent investigating the conflict (~10-50k tokens)
- Orchestrator context to recover + re-launch (~5-20k tokens)
- Calendar time for sibling agents waiting on the failed branch

## Rule 2 — Process-Organized Trap

```
# DO NOT — duplicates workspaces/ structure
specs/
  _index.md
  intent.md          ← workspaces/briefs/ already captures this
  decisions.md       ← workspaces/02-plans/ + journal already captures this
  progress.md        ← workspaces/todos/ + journal already captures this
  boundaries.md      ← ambiguous; partially in briefs, partially in plans
```

Process specs drift from the authoritative workspace artifacts, and the duplication guarantees one falls behind.

## Relationship To FM-1 Through FM-6

The 6 alignment-drift failure modes that motivated `specs/`:

1. **FM-1: Brief-to-plan lossy compression** — briefs lose detail when compressed to plans.
2. **FM-2: Phase transition context thinning** — `/analyze` → `/todos` → `/implement` each drop some context.
3. **FM-3: Multi-session amnesia** — next session re-derives what last session already knew.
4. **FM-4: Agent delegation context loss** — specialist agents lack domain context from briefs.
5. **FM-5: Incremental mutation divergence** — small changes accumulate into architectural drift.
6. **FM-6: Silent scope mutation** — implementation deviates without acknowledgment.

`specs/` addresses FM-1/2/3/4/6 directly. Rule 5a (first-instance update) addresses FM-5. Rule 5b (full sibling re-derivation) closes the narrow-scope loophole that FM-5 exploits. Rule 5c (amend-at-launch) prevents orchestrator-side FM-4 at the agent-dispatch boundary.
