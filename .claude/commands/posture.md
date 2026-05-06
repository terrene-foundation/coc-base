---
description: Inspect or change the per-repo trust posture (L1–L5). Read-only show/history/init by default; upgrade and override require user-paste-back challenge nonce.
---

# /posture — Trust Posture Management

The graduated-trust-posture system (`rules/trust-posture.md` + `skills/32-trust-posture/`) defines five autonomy levels per repo. This command surfaces and changes posture state.

State lives at `<main_checkout>/.claude/learning/posture.json` (per `skills/32-trust-posture/posture-spec.md`). Direct edits are blocked by `settings.json::permissions.deny`.

## Subcommands

### `/posture` (no args) — show current

Read posture.json and report:

- Current posture (L1_PSEUDO_AGENT … L5_DELEGATED)
- Time at current posture (e.g., "3 days 14h")
- Pending verification entries (rule_id, day N of grace, regression-within-grace policy)
- Last 5 transitions with type + reason
- Last 10 violations (rule_id, severity, evidence head, addressed_by)
- Fresh-repo flag, fail-closed flag (if applicable)

Output is plain markdown — no state mutation.

### `/posture init` — initialize fresh repo

Used once on a repo that has never run the trust system. Writes `posture.json` with `posture: L5_DELEGATED` + creates `.initialized` marker. Refuses to run if `.initialized` already exists (use `/posture override` to change posture on an initialized repo).

### `/posture history [--all | --recent N]` — transition log

Reads `transition_history` from posture.json. Defaults to last 10 transitions. Each row: from → to, type, reason, ts, approved_by. `--all` dumps every transition since INIT.

### `/posture violations [--rule X | --since DATE | --limit N]` — violation log

Tail of `violations.jsonl`. Filters: by rule_id, by ISO date, by count. Read-only.

### `/posture upgrade [--to LEVEL] [--ack NONCE]` — request posture upgrade

Two-step challenge-nonce flow (mitigates red-team H3 forged ACK + M4 upgrade audit-trail):

**Step 1**: User runs `/posture upgrade --to L5_DELEGATED`. Command:

1. Reads posture.json — verifies all four upgrade requirements (≥7d at posture, 0 violations of triggering class, ≥1 demonstrated correction, target = current_posture + 1).
2. Writes a random nonce to `<main_checkout>/.claude/learning/.posture-upgrade-nonce` (file readable only by hooks).
3. Prints to user: `"To confirm upgrade to L5_DELEGATED, paste this nonce in your next message: <NONCE>"`.

**Step 2**: User pastes the nonce as the next user message AND runs `/posture upgrade --to L5_DELEGATED --ack <NONCE>`. Command:

1. Reads `.posture-upgrade-nonce`. If absent or mismatched → reject.
2. Validates the user's PRIOR turn contained the nonce literal.
3. Updates posture.json: appends transition `EARNED` with `approved_by: human`, sets `posture` to target, clears nonce file.
4. Prints confirmation.

If validation fails: nonce stays valid for ONE more attempt then is cleared. Repeated failures log `acknowledgement_failure` violation.

### `/posture override --to LEVEL --reason "<text>" [--ack NONCE]` — manual override

Same two-step nonce flow as `upgrade`. Used for:

- False-positive recovery (downgrade was wrongful)
- Initial bootstrap on a repo that's already mid-cycle (set L4 directly without earning L5)
- Emergency restoration after fail-closed event

Records transition with `type: OVERRIDE` and `approved_by: human`.

## Implementation notes (for /posture command author)

The command MUST be implemented as a thin shell over `state-io.js`:

```js
const {
  readPosture,
  writePosture,
  readRecentViolations,
} = require(".claude/hooks/lib/state-io.js");
```

For Steps 1/2 nonce flow, write nonce to file with mode 0600. Hooks read the file via state-io extension; user reads via the command echoing it. The transcript capture (user's PRIOR turn containing the nonce) is verified by reading the conversation transcript path the harness exposes; if unavailable, fall back to in-message confirmation as fail-loud.

## Posture-bound restrictions on this command

- `/posture init`, `show`, `history`, `violations` work at any posture (read or single-write fresh init).
- `/posture upgrade`, `/posture override` are NEVER usable below L1 (always available regardless of posture — humans must always have escape hatch).
- Agent invoking `/posture upgrade` autonomously without user instruction = `acknowledgement_failure` violation logged.

## Output canonical format

```
=== /posture: L4_CONTINUOUS_INSIGHT ===
Repo:    /Users/esperie/repos/loom
Since:   2026-05-06T09:14:00Z (1 day 23h)

Pending Verification:
  - test-completeness/MUST-1 (day 2 of 7) — emergency downgrade on regression
  - <none if list empty>

Recent Transitions (last 5):
  2026-05-06 09:14   L5 → L4   EMERGENCY_DOWNGRADE   "regression_within_grace: test-completeness/MUST-1 day 1"
  2026-05-05 14:30   ─  → L5   INIT                  "fresh repo init via /posture init"

Recent Violations (last 10):
  2026-05-06 09:14   sweep-completeness/MUST-2   halt-and-report   "Sweep 5: 0/0/0 (clean)…"   [unaddressed]
  ...

To upgrade: /posture upgrade --to L5_DELEGATED   (requires 7+ days, 0 violations, ack nonce)
To override (false positive recovery): /posture override --to L5_DELEGATED --reason "false positive on test-completeness"
```
