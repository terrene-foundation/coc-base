---
name: purge
description: "Retention purge round. Derives the deletion surface and blocks on unproven deletions."
argument-hint: "[workspace or path]"
---

Retention purge for **$ARGUMENTS**. `rules/adversarial-coverage.md` is BINDING — READ IT FIRST. Per-step depth: `skills/30-claude-code-patterns/retention-purge-mechanics.md`.

## Target Resolution

1. If `$ARGUMENTS` names a project use `workspaces/$ARGUMENTS/`; if it is a path, purge under that path
2. Otherwise use the most recently modified directory under `workspaces/`
3. If no workspace exists, ask the user to create one first

## 1. Derive the deletion surface

Build the table from `rules/adversarial-coverage.md` §3. Do NOT substitute a hand-listed set of paths — a list is a preference, a derivation is a proof obligation. Mark each cell `purged`, `OPEN`, or `n/a` with a one-line reason; an unreasoned `n/a` is OPEN.

## 2. Prove each deletion

A `purged` cell names the command that deleted and its output. A cell warranted only by its own table row is OPEN. Delegate the storage sweep to storage-specialist and the audit sweep to security-reviewer; dispatch them in parallel, capped at 3 per wave on a cold start per `rules/worktree-isolation.md` Rule 4.

## 3. Report

Write `workspaces/<project>/04-validate/NN-purge-<slug>.md` with the table, every warrant, and the convergence block. Unproven deletions BLOCK.

## Journal (MUST — phase-complete gate)

Create **RISK** entries for data that could not be proven deleted and **GAP** entries for cells left OPEN. Use `/journal new <TYPE> <slug>`; check the highest `NNNN-` and increment.
