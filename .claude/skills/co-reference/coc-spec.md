---
name: coc-spec
description: "COC specification: three fault lines, value inversion, five-layer implementation for codegen, autonomous execution model."
---

# COC Specification

**COC** = Cognitive Orchestration for Codegen. CO applied to software development — the first and most mature domain application.

## The Central Problem

Vibe coding works for prototypes but fails for production along three predictable fault lines:

| Fault Line             | Problem                                            | Root Cause                  |
| ---------------------- | -------------------------------------------------- | --------------------------- |
| **Amnesia**            | AI forgets your instructions as context fills up   | Context window limits       |
| **Convention Drift**   | AI follows internet conventions instead of yours   | Training data overrides     |
| **Security Blindness** | AI takes the shortest path (never the secure path) | Optimization for directness |

**The root cause is not model capability. It is the absence of institutional knowledge surrounding the model.**

## The Value Hierarchy Inversion

```
Vibe Coding:  Better Model → Better Code → Competitive Advantage
COC Reality:  Better Context → Better Output → Competitive Advantage
              (specific to you)  (any model)    (defensible)
```

## Five-Layer Implementation for Codegen

### Layer 1: Intent — The Role

Route tasks to specialized expert agents (30+ agents across 7 development phases). Mirrors how effective engineering organizations work.

### Layer 2: Context — The Library

Progressive disclosure: CLAUDE.md → SKILL.md → Topic files → Full docs. 28+ skill directories. Framework-First (never code from scratch) + Single Source of Truth. This is **context engineering**, distinct from prompt engineering.

### Layer 3: Guardrails — The Supervisor

Rules (soft, AI interprets) + Hooks (hard, deterministic scripts outside model context). Anti-amnesia hook fires every message, survives context compression. Critical rules have 5-8 independent enforcement layers.

### Layer 4: Instructions — The Operating Procedures

Five-phase COC cycle — **01 `/analyze` → 02 `/todos` → 03 `/implement` ⇄ 04 `/redteam` → 05 `/codify`**, then `/release`. The ordinals are the commands' own frontmatter, which is the only machine-checkable source for them. `/implement ⇄ /redteam` is re-entrant per wave (`wave-loop.md` MUST-2), not a single pass. Evidence-based completion (file-and-line proof). Mandatory delegation (security review before every commit).

**`/test` and `/deploy` are UTILITIES, not lifecycle phases** — they exist as commands but `CLAUDE.md` classes them with the SDK/dev utility set, so naming them as phases mis-describes the cycle.

**Checkpoints, named by kind per the glossary** (`specs/ontology/glossary.md` § "gate"): `/todos` plan approval and `/release` authorization are **gates** — a human clears them. `/redteam` convergence, `/implement` correctness and `/analyze` completeness are **convergence criteria** — the agent iterates to them and stopping to ask is BLOCKED.

> **CORRECTED 2026-09-18 (co-owner-directed).** This line read *"Seven-phase workflow (analyze → plan → implement → test → deploy → release → final)"*. MEASURED against the tree: `/plan` and `/final` **do not exist** and never have here, while every other command named does (control: `/analyze` EXISTS on the same check) — so the list named two commands a reader could not run and omitted `/todos`, `/redteam` and `/codify`, which are three of the five phases COC actually has.
>
> **This is a COC-scoped correction and deliberately NOT a reconciliation with CO.** `co-spec.md`'s six-phase table is CO's **domain-general** vocabulary; other CO domains adapt the same intent under their own names, so it is not supposed to name COC's commands and is left untouched. COC's spec carries COC's vocabulary. Editing CO's table to match loom would be loom originating methodology, which `artifact-flow.md` § "loom Splits, Never Originates" forbids; editing COC's own spec to describe COC is not.

### Layer 5: Learning — The Performance Review

Observation-Digest-Codification pipeline. JSONL observation logs → digest-builder.js (pure aggregation into learning-digest.json) → /codify (LLM semantic analysis produces real artifacts). Human approves codified output at batch review gate.

## The Autonomous Execution Model

COC executes through autonomous AI agent systems, not human teams. Human-on-the-Loop: human defines operating envelope, agents execute within it.

**10x Throughput Multiplier**: Parallel execution (3-5x) + Continuous operation (2-3x) + Knowledge compounding (1.5-2x) - Validation overhead (0.7-0.8x) = ~10x net sustained.

**Structural gates** (human required): Plan approval, release authorization, envelope changes.
**Execution gates** (autonomous convergence): Analysis quality, implementation correctness, validation rigor, knowledge capture.

## CARE → COC Mapping

| CARE/EATP Concept   | COC Equivalent            |
| ------------------- | ------------------------- |
| Trust Plane         | Rules + CLAUDE.md         |
| Execution Plane     | Agents + Skills           |
| Genesis Record      | `session-start.js`        |
| Trust Lineage Chain | Mandatory review gates    |
| Audit Anchors       | Hook enforcement          |
| Operating Envelope  | Rule files + hook scripts |

## Honest Limitations

- Novel architecture decisions (no established pattern to follow)
- Distributed systems complexity (emergent problems beyond local guardrails)
- Model-specific limitations (reduced, not eliminated)
- Legacy codebases (fewer frameworks to compose with)
- Greenfield domains (~2-3x first session, not 10x)

## Implementation

For the COC template implementation, see the Kailash COC template repos.
