---
priority: 10
scope: path-scoped
paths:
  # Split from recommendation-quality.md (context-budget 2026-10-10). Loads ONLY where MUST-6 binds:
  # where a human-reserved decision packet is written (plans, briefs, journal DECISION entries)
  # and the decision-packet detector that enforces it.
  - "**/02-plans/**"
  - "briefs/**"
  - "journal/*DECISION*"
  - "**/.claude/hooks/decision-packet-guard.js"
  - "**/.claude/hooks/lib/decision-packet.js"
  - "**/.claude/audit-fixtures/decision-packet/**"
---

# Recommendation Quality — The Human Decides Means Ratify (MUST-6)

## MUST Rules

### 6. "The Human Decides" Means Ratify A Recommendation — Not Fill A Blank

When a decision is reserved to the human (founder ratification, owner sign-off, a gated approval, a "clarification" the human must answer), the agent MUST still produce a full spec-grounded recommendation for **every** item. The human exercises authority by **ratifying or overriding** that recommendation — NOT by answering a blank the agent left. A "clarification packet", "decision menu", or list of open questions presented with empty answer fields for the human to fill from scratch is the MUST-1 violation in disguise and is BLOCKED.

Pointer — MUST-1, cited above, is clause 1 of `recommendation-quality.md`, a part that does not load on every path this one does.

Decide ≠ recommend. "Not an agent-decided _default_" forbids a SILENT, unstated assumption baked into code or output — it does NOT forbid a LOUD, rationale-backed, ratifiable _recommendation_. The agent always recommends; the human always decides; withholding the recommendation is never the correct expression of "the human decides."

A multi-domain decision packet (≥2 questions spanning ≥2 specialist domains) MUST have each recommendation produced by the relevant **domain specialist** (per `rules/agents.md` Specialist Delegation), so every pick is spec-grounded — a single-threaded orchestrator guess is not a spec-grounded recommendation.

`DO` (packet): each row = recommendation + spec basis + honest con + "RATIFY / OVERRIDE". `DO` (authorship): each row's pick produced by its domain specialist; the orchestrator synthesizes, does not guess. `DO NOT`: a row with an empty `→ ANSWER:` field; a recommendation cell that says "needs input" / "TBD" / "depends" (a blank in table costume); all rows guessed in one single-threaded orchestrator pass. Full examples in the guide extract.

**BLOCKED rationalizations:**

- "These are clarifications for the human to answer, not choices for me to recommend on"
- "The human / founder holds decision authority, so I should not pre-fill"
- "'Not an agent-decided default' means I must not recommend an answer"
- "Presenting the questions blank respects the human's decision authority"
- "The agent does NOT pre-fill — withholding the recommendation IS the discipline"
- "The questions are too deep / too founder-specific for me to recommend on"
- "The recommendation cell can say 'needs founder input' — that's honest"

Depth — MUST-6's decision-packet examples and detector detail — lives in `.claude/guides/rule-extracts/recommendation-quality.md`.

Probes: `.claude/test-harness/probes/recommendation-quality-packets.probes.json` (fixtures `.claude/audit-fixtures/recommendation-quality/`).

Depth — the Trust-Posture Wiring and the full Why paragraph — lives in `.claude/skills/32-trust-posture/wiring/recommendation-quality-packets.md`, which every validator reads as part of this rule.
