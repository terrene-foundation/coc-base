# Grace Period Mechanics

When `/codify` authors a rule that addresses a violation, the rule enters `pending_verification` for a grace period (default 7 days). During grace, the rule has heightened detection and emergency-downgrade triggers.

## Lifecycle

```
/codify authors rule        7 days elapse        rule "graduates"
       │                          │                    │
   pending_verification ────────────────────────→  permanent
       │                          │                    │
   first_violation logged      grace_clock              standard cumulative threshold applies
       │                          │
   ↓ violation matches rule       ↓ no violation
   │
   regression_within_grace
       │
       ↓
   EMERGENCY DOWNGRADE (1 posture)
```

## Detection escalation during grace

| Phase                              | Detector mode                            | Severity at hit                                |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Pre-grace (before /codify authors) | Observer-only (logs but doesn't surface) | post-mortem                                    |
| In-grace (days 1-7)                | Active surface                           | halt-and-report + emergency downgrade          |
| Post-grace (days 8+)               | Active surface                           | halt-and-report (cumulative threshold applies) |

## SessionStart behavior during grace

`session-start.js` injects via `additionalContext`:

```
⚠️ TRUST GATE — Verification Pending (Day N of 7)

Rule: <rule_id>
Authored: <ISO ts> to address <vio_id>
Cause: <evidence text from violations.jsonl>

This session MUST follow the rule. Hooks will scan for: <detection pattern>

RECEIPT REQUIRED: include `[ack: <rule_id>]` in your first response.

Violation within grace = EMERGENCY DOWNGRADE to <next lower posture>.
```

## Stale-record skepticism

PreToolUse(Read) on `.session-notes`, `observations.jsonl`, `journal/*` files dated BEFORE the most recent pending_verification rule injects:

```
⚠️ This file pre-dates rule <rule_id> (authored <date>).
Any "tests pass" / "complete" / "verified" claim within is UNVERIFIED under the new rule.
Do not inherit conclusions; re-verify per rule.
```

This defends against the compound failure: agent inherits its own pre-rule "all-clear" record and assumes the new rule is satisfied.

## Promotion (graduation) logic

After 7 days with zero violations of the rule, the entry is REMOVED from `pending_verification`. The rule is now "permanent" — standard cumulative threshold (3× in 30d) applies. No special SessionStart banner. Detector mode stays active.

Promotion is automatic; no human gate. The rule has earned its place.

## Demotion (rule rollback)

If the rule generates 3+ false positives in grace, `/codify` MAY author a follow-up rule that scopes or repeals the original. The `pending_verification` entry stays until the follow-up replaces it. Repealed rules do NOT graduate — they're flagged as `repealed_at: <ts>` in the rule's frontmatter.

## Multi-rule coordination

Multiple rules in pending_verification simultaneously is normal. SessionStart concatenates banners; receipt token requires `[ack: <rule_id_1>]` + `[ack: <rule_id_2>]`. UserPromptSubmit hook validates each.

`violation_window_30d` tracks each rule independently. A regression on one rule emergency-downgrades by 1; a regression on two simultaneously stacks (drop 2 postures).

## Bootstrapping the very first rule

The first rule authored under this system is `rules/trust-posture.md` itself. It enters `pending_verification` at /codify time with grace period 0 (teeth-from-day-one). Per `rules/trust-posture.md` Phase 1 / Phase 2 rollout, the /codify wiring step doesn't enforce on bootstrap — by design.
