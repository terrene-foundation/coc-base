# Rule Authoring Checklist — "Trust Posture Wiring" Section Format

Every rule authored by `/codify` after Phase 2 cutover MUST end with the section below. cc-architect rejects proposals lacking it.

## Canonical Format

```markdown
## Trust Posture Wiring

- **Severity:** halt-and-report
- **Grace period:** 7 days
- **Cumulative threshold:** 3× same-rule violations in 30d → 1 posture downgrade
- **Regression-within-grace policy:** emergency downgrade (1 posture)
- **Receipt requirement:** No (rule is purely behavioral, not procedural)
- **Detection mechanism:** regex on agent's final message (Stop hook); pattern: `<regex or AST predicate>`
- **First violation triggering this rule:** vio_2026-05-05T14:22_a3f
- **Origin evidence date:** 2026-05-05
```

## Field Reference

### Severity (one of)

- `block` — PreToolUse only; tool call physically prevented; reserved for destructive + irreversible
- `halt-and-report` — tool already executed; agent must surface and wait; default for policy violations
- `advisory` — soft warning; agent acknowledges, may proceed
- `post-mortem` — Stop-class detection; forensic only, surfaces at next SessionStart

### Grace period (integer days)

- `0` — teeth-from-day-one (use only for high-stakes rules with broad consensus, e.g., security)
- `7` — standard for newly codified rules
- `30` — large surface change requiring migration

### Cumulative threshold

Default `3× same-rule in 30d → 1 posture downgrade`. Override only if 1× should emergency-downgrade.

### Regression-within-grace policy

- `emergency downgrade (1 posture)` — default; loud signal that agent violated its own freshly-authored rule
- `emergency downgrade to L1` — if the rule prevents a critical failure mode (secret leak, destructive op)
- `cumulative only` — explicitly disable the within-grace fast-path (rare; requires justification)

### Receipt requirement

- `Yes` — SessionStart will require `[ack: <rule_id>]` from agent's first response
- `No` — rule is detected at runtime; receipt would add friction without benefit

### Detection mechanism

Concrete predicate. Regex string, AST node-type, behavioral signal, or "human-only" if no automated detection exists. Lexical alone → advisory/post-mortem only.

### First violation triggering this rule

`vio_<id>` from violations.jsonl, or `null` if rule is preventive (no violation yet).

### Origin evidence date

ISO date of the session/incident that motivated the rule. Required for `git log --grep` traceability.

## Worked Example (the trust-posture rule itself)

```markdown
## Trust Posture Wiring

- **Severity:** halt-and-report (Phase 2: posture-gate adds PreToolUse block teeth)
- **Grace period:** 0 (foundational rule; teeth-from-day-one)
- **Cumulative threshold:** 1× violation = 1 posture downgrade (state-file edit attempt)
- **Regression-within-grace policy:** N/A (no grace)
- **Receipt requirement:** Yes — `[ack: trust-posture/MUST-1]`
- **Detection mechanism:** PreToolUse(Edit|Write|Bash) regex against `.claude/learning/(posture|violations)`
- **First violation triggering this rule:** null (preventive)
- **Origin evidence date:** 2026-05-05
```
