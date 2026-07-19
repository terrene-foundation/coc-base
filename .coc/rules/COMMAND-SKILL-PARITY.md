---
id: "COMMAND-SKILL-PARITY"
paths: [".claude/commands/**", ".claude/skills/**"]
---

# Command-Skill Parity — A Command And Its Paired Skill Move Together, Never Drift Or Orphan

A command whose procedural depth exceeds the 150-line budget (`cc-artifacts.md` Rule 3) extracts that depth into a **paired skill** and REFERENCES it — the command carries the user-facing flow, the skill carries the runbook. That extraction creates a two-artifact contract: the command and its skill are now a PAIR, and a pair drifts. When a later edit changes the command's declared flow without updating the skill's runbook (or vice-versa), the reader following the command's reference lands on a runbook that no longer matches — the exact failure `cc-artifacts.md` § "No Dangling Cross-References After Extraction" blocks, one artifact-class over. This rule owns the PARITY half of that split: the command references the skill (not inlines it), the two do not drift, and neither ships orphaned.

This rule binds `cc-artifacts.md` Rule 3 (the ≤150-line command budget + the extract-to-skill remedy) from the parity side; it does not restate the budget itself.

## MUST Rules

### 1. Over-Budget Procedural Depth Is REFERENCED In A Paired Skill, Not Inlined

When a command's procedural depth would push its body over the `cc-artifacts.md` Rule-3 150-line budget, that depth MUST be extracted to a paired skill (`.claude/skills/<name>/**`) and REFERENCED from the command by a grep-stable anchor (`skills/<name>/SKILL.md § <section>`), NOT inlined past the budget and NOT copied into both. The command carries the user-facing flow + the reference; the skill carries the runbook. Inlining over-budget depth, OR duplicating the runbook in both the command and the skill, is BLOCKED.

```text
# DO — command references the paired skill's runbook by a grep-stable anchor
# commands/foo.md (≤150 lines): "Full N-step runbook: skills/foo/SKILL.md § Runbook."

# DO NOT — inline the over-budget runbook in the command, OR copy it into both
# commands/foo.md (210 lines, full runbook inlined) + skills/foo/SKILL.md (same runbook again)
```

**Why:** A command over the 150-line budget is skimmed and its load-bearing steps are missed (`cc-artifacts.md` Rule 3 § Why); duplicating the runbook into both artifacts guarantees the two copies drift the moment one is edited. A single referenced source is the only shape that stays coherent.

### 2. A Command And Its Paired Skill MUST NOT Drift — An Edit To One Re-Derives The Other

Every step, flag, or flow the command DECLARES MUST resolve in the paired skill's runbook, AND the skill's runbook MUST describe the SAME flow the command declares. An edit to either side (a new step, a renamed flag, a changed sequence) MUST re-derive the other side IN THE SAME `/codify` — the command↔skill pair is one contract, not two files. Shipping a command-flow change without the matching skill-runbook update (or vice-versa) is BLOCKED.

```text
# DO — command gains a `--verify` step → its paired skill's runbook gains the matching step, same codify
# commands/sync.md adds "Step 4: --verify"  →  skills/sync/SKILL.md § Runbook adds the Step-4 procedure

# DO NOT — edit one side, leave the pair divergent
# commands/sync.md adds the --verify step; skills/sync/SKILL.md still documents the 3-step flow
# (reader following the command's reference lands on a runbook missing Step 4)
```

**Why:** The command's reference is a promise that the skill's runbook matches the command's flow; a one-sided edit silently breaks that promise, and the reader who trusts the reference executes a stale procedure. Re-deriving both sides in the same codify is the only point the drift is cheap to catch.

### 3. Neither The Command Nor Its Paired Skill Ships Orphaned

A command that references a paired skill MUST have that skill EXIST on disk AND carry a declared distribution fate in `sync-manifest.yaml` (per `knowledge-cascade-routing.md` MUST-2); a skill authored to back a command MUST be REACHABLE from that command (referenced by ≥1 command, or manifest-declared loom-only with a recorded reason). A command referencing a non-existent or unregistered skill, OR a skill backing no command and declared nowhere, is BLOCKED.

```text
# DO — command references an existing, manifest-registered skill; skill is reachable from the command
# commands/foo.md → skills/foo/**; sync-manifest.yaml declares skills/foo/** (tier OR loom_only)

# DO NOT — dangling reference, OR an unreachable/unregistered skill
# commands/foo.md → skills/foo/SKILL.md § Runbook   (skills/foo/ never created → dangling)
# skills/bar/**  authored, referenced by no command, absent from the manifest → silent orphan
```

**Why:** A command referencing a skill that does not exist (or does not cascade) ships a runbook the consumer never receives — the command's reference dead-ends; a skill backing no command and registered nowhere is dead weight that neither loads nor distributes. Both are the same non-reaching-the-consumer failure `knowledge-cascade-routing.md` MUST-2 + `cc-artifacts.md` dangling-cross-reference block guard, at the command↔skill seam.

## MUST NOT

- Inline a command's over-150-line procedural depth instead of extracting it to a paired skill and referencing it

**Why:** The 150-line budget exists because over-budget commands are skimmed; inlining defeats the extract-to-skill remedy `cc-artifacts.md` Rule 3 mandates.

- Ship a command-flow edit (new step, renamed flag, changed sequence) without re-deriving the paired skill's runbook in the same codify

**Why:** A one-sided edit leaves the command's reference pointing at a stale runbook — the reader executes a procedure the command no longer describes.

- Reference a paired skill that does not exist or is absent from the distribution manifest, OR author a command-backing skill reachable from no command

**Why:** A dangling reference dead-ends the reader; an unreachable/unregistered skill never loads and never cascades — both strand the runbook away from the consumer.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm a command over the 150-line budget references its paired skill, the command↔skill pair is drift-free, and neither is orphaned); `advisory` at the hook layer (command↔skill drift/orphan is a cross-artifact semantic judgment per `hook-output-discipline.md` MUST-2 — a lexical scan MAY flag a dangling `skills/<name>` reference but MUST NOT carry `block`).
- **Grace period:** 7 days from rule landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (over-budget depth inlined instead of referenced; a command-flow edit shipped without its paired-skill re-derivation; a dangling or orphaned command↔skill pairing) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (command↔skill parity is a review-layer cross-artifact judgment; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `knowledge-cascade-routing.md` + `handoff-completion.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: command-skill-parity]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any codify touching a command or skill: confirm (a) a command over 150 lines references (not inlines) its paired skill, (b) every step/flag/flow the command declares resolves in the skill's runbook and vice-versa, (c) each referenced skill exists + is manifest-declared and each command-backing skill is reachable. A grep sweep (`grep -o 'skills/[a-z0-9-]*' commands/*.md` → confirm each target exists + is in `sync-manifest.yaml`) is the mechanical companion. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `PostToolUse(Edit|Write)` detector flagging a command edit whose diff changes a declared step/flag without a matching paired-skill edit, or a `skills/<name>` reference with no on-disk target; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/command-skill-parity/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (over-budget depth referenced not inlined) + MUST-2 (command↔skill drift) + MUST-3 (command/skill orphan).
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Binds** `cc-artifacts.md` Rule 3 (the ≤150-line command budget + extract-to-skill remedy) from the parity side — Rule 3 owns the budget; this rule owns the resulting command↔skill pair's coherence.
- **Instantiates** `cc-artifacts.md` § "No Dangling Cross-References After Extraction" at the command↔skill seam (MUST-3).
- **Composes with** `knowledge-cascade-routing.md` MUST-2 (a paired skill is "codified" only once its manifest distribution-fate is declared).
- **Distinct from** `rule-authoring.md` (rule↔skill extraction, Rule 10 path-a) — that governs the rule↔skill pairing; this governs the command↔skill pairing. Same extraction-coherence principle, different artifact pair.

## Origin

2026-07-19 — Gate-1 ingest of the kailash-py BUILD `command-skill-parity` proposal (absent at loom), landed via `/sync-from-build` classification (Wave-1 of the sync-from-backlog follow-ups, journal/0552). The generic principle — a command and its paired skill are one contract that must not drift or orphan — cascades; the sensitive originating specific stays in the local `/codify` receipt per `upstream-issue-hygiene.md` MUST-2. Reconstructed from that intent + the `cc-artifacts.md` Rule-3 command/skill split contract. Authored `priority:10` + `scope:path-scoped` + `cli_delivery:skill-channel` under the measured saturated-baseline constraint (codex 10.13% / gemini 10.43% headroom, within the 15% proximity band) — a path-scoped rule pays no baseline-emission cost and fires on the file surface (`.claude/{commands,skills}/**`) its concern lives on; the same disposition `knowledge-cascade-routing.md` + `handoff-completion.md` took for identical saturation.
