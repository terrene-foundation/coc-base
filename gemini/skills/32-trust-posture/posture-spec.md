# Posture State Specifications

Data shapes for `posture.json` and `violations.jsonl`. State files live in `<main_checkout>/.claude/learning/`.

## posture.json

```json
{
  "posture": "L5_DELEGATED",
  "since": "2026-05-05T00:00:00.000Z",
  "transition_history": [
    {
      "from": null,
      "to": "L5_DELEGATED",
      "type": "INIT",
      "reason": "fresh repo init via /posture init",
      "ts": "2026-05-05T00:00:00.000Z",
      "approved_by": "system"
    },
    {
      "from": "L5_DELEGATED",
      "to": "L4_CONTINUOUS_INSIGHT",
      "type": "EMERGENCY_DOWNGRADE",
      "reason": "regression_within_grace: test-completeness/MUST-1 day 1",
      "ts": "2026-05-06T09:14:00.000Z",
      "approved_by": "system"
    }
  ],
  "pending_verification": [
    {
      "rule_id": "test-completeness/MUST-1",
      "since": "2026-05-05T14:30:00.000Z",
      "grace_period_days": 7,
      "first_violation": "vio_2026-05-05T14:22_a3f"
    }
  ],
  "violation_window_30d": {
    "test-completeness/MUST-1": 2,
    "sweep-completeness/MUST-2": 0
  },
  "_initialized": true
}
```

### Field semantics

- `posture` — current level; one of L1_PSEUDO_AGENT / L2_SUPERVISED / L3_SHARED_PLANNING / L4_CONTINUOUS_INSIGHT / L5_DELEGATED
- `since` — ISO timestamp of last transition into current posture
- `transition_history` — append-only; oldest first; types: INIT / EARNED / EMERGENCY_DOWNGRADE / CUMULATIVE_DOWNGRADE / FAIL_CLOSED / OVERRIDE
- `pending_verification` — rules in grace period; cleared when grace expires OR when rule promoted to permanent
- `violation_window_30d` — rolling counter per rule_id; updated on append; pruned at SessionStart for entries older than 30d
- `_initialized` — distinguishes fresh-repo from corrupted-state (per `rules/trust-posture.md` MUST 2)

### Validation invariants (state-io.js enforces)

- `posture` MUST be in `VALID_POSTURES` set
- `transition_history[i].from === transition_history[i-1].to` (chain consistency)
- `pending_verification[].grace_period_days` between 0 and 30
- `violation_window_30d` keys all present in either history or pending list

## violations.jsonl (append-only JSONL)

One JSON object per line. Each line ≤2KB (POSIX atomic-append safety).

```json
{
  "id": "vio_1715000000_a3f",
  "timestamp": "2026-05-05T14:22:00.000Z",
  "session_id": "abc-123",
  "repo": "<repo-root>",
  "rule_id": "test-completeness/MUST-1",
  "severity": "halt-and-report",
  "evidence": "agent ran `pytest tests/unit/` only; spec required tier 2",
  "posture_at_time": "L5_DELEGATED",
  "addressed_by": null,
  "type": "detected"
}
```

### Field semantics

- `id` — globally unique; format `vio_<unix_ms>_<random_hex>`
- `severity` — block / halt-and-report / advisory / post-mortem
- `evidence` — truncated to keep line ≤2KB; `_truncated: true` set if so
- `posture_at_time` — repo's posture when violation fired (forensic; downgrade decisions use current posture)
- `addressed_by` — null until /codify links to a rule; format `rules/<file>.md@<commit_sha>`
- `type` — one of `detected` (regex/AST hit), `self_reported` (Stop-hook self-confession scan), `acknowledgement_failure` (missing receipt token), `regression_within_grace` (grace-period violation)

### Rotation

violations.jsonl rotates at 10MB or 90 days, whichever first. Old file → `violations.jsonl.YYYY-MM`. Posture decisions consider only last 30d window regardless.

## File-system layout

```
<main_checkout>/.claude/learning/
├── posture.json              # current state (denied to agent edits)
├── posture.json.bak          # write-ahead backup
├── violations.jsonl          # append-only log (denied to agent edits)
├── violations.jsonl.YYYY-MM  # rotated archives
├── observations.jsonl        # existing accomplishments log
└── .initialized              # marker; absence + missing posture.json = fresh repo
```

`permissions.deny` in `.claude/settings.json` blocks Edit/Write/Bash(rm|mv|cat>) against the first three.
