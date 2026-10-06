---
name: 32-trust-posture
description: "Graduated trust posture (L1-L5). MANDATORY at /codify, /redteam, /implement. Without: rules ship untagged."
---

# Trust Posture — Implementation Skill

The contract is `rules/trust-posture.md`. This skill is the **how** — what /codify, /redteam, /implement, and rule authors do to wire a rule into the graduated-trust loop.

## When to load this skill

- Authoring a new rule (anywhere in `/codify`)
- Designing audit depth (`/redteam`)
- Interpreting gate behavior (`/implement` halts, `/sweep` reports)
- Reading or recommending a posture change (`/posture`, `posture-auditor` agent)
- Reviewing whether a violation pattern should trigger automatic downgrade

If your task is none of the above, this skill is not for you.

## The five-question rule-authoring checklist

Every rule authored by `/codify` MUST answer these in a "Trust Posture Wiring" section. See `rule-authoring-checklist.md` for the canonical format.

1. **Severity** — `block` / `halt-and-report` / `advisory` / `post-mortem`. Use `block` only when the action MUST be physically prevented (PreToolUse + destructive). Use `halt-and-report` when the action already happened but the agent must surface and wait. Use `advisory` for soft warnings. Use `post-mortem` for Stop-class detections (forensic only, surfaces next session).
2. **Grace period** — 0 days (rule is teeth-from-day-one), 7 days (standard for newly codified rules), 30 days (large surface change requiring migration time). During grace, the rule is in `pending_verification`; SessionStart announces it; violations trigger `regression_within_grace`.
3. **Receipt requirement** — does the rule warrant `[ack: <rule_id>]` from the agent in the first response of every new session? Reserve for high-stakes rules where evidence shows the agent ignores SessionStart context.
4. **Cumulative threshold** — default 3× same-rule in 30 days = 1 posture downgrade. Override only if the rule's failure mode is so severe that 1× should emergency-downgrade (e.g., destructive bash without confirm, secret leak).
5. **Detection mechanism** — regex (lexical), AST (structural), behavioral (cross-reference), or human-only. Lexical alone is `advisory`/`post-mortem`. Auto-downgrade requires structural or behavioral signal.

## Severity decision matrix

| If the action is…                                            | And it's at this hook event… | Severity                                         |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------ |
| Destructive + reversible (rm -rf in tmp dir)                 | PreToolUse                   | `block`                                          |
| Destructive + irreversible (force-push to main, secret leak) | PreToolUse                   | `block`                                          |
| Already executed (Edit wrote a fastapi import)               | PostToolUse                  | `halt-and-report`                                |
| Policy violation, file already on disk                       | PostToolUse                  | `halt-and-report`                                |
| Soft warning, work continues                                 | Pre/PostToolUse              | `advisory`                                       |
| Detected in agent's final message                            | Stop                         | `post-mortem`                                    |
| User regression signal in prompt                             | UserPromptSubmit             | `additionalContext` injection (no violation log) |

## What this skill DOES NOT do

- It does NOT define the posture ladder or transition rules — that's `rules/trust-posture.md`.
- It does NOT define the EATP / CARE / PACT canonical specs — that's `skills/co-reference/`.
- It does NOT implement the hooks — that's `.claude/hooks/detect-violations.js` + `lib/instruct-and-wait.js`.

## Sub-files

- `codify-integration.md` — what `/codify` reads, writes, and emits per cycle
- `implement-integration.md` — how `/implement` behaves at L4/L3/L2
- `redteam-integration.md` — how `/redteam` audit depth scales with posture
- `rule-authoring-checklist.md` — the canonical "Trust Posture Wiring" section format
- `posture-spec.md` — data shapes for posture.json, violations.jsonl
- `grace-period-mechanics.md` — pending_verification lifecycle, regression-within-grace

Origin: 2026-05-05 design session validated by 21/21 subprocess tests; promoted from `.claude/test-harness/trust-posture-poc/`.
