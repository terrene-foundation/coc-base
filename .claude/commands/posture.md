---
description: Inspect or change the per-repo trust posture (L1–L5). Read-only show/history/init by default; upgrade and override require user-paste-back challenge nonce.
---

# /posture — Trust Posture Management

The graduated-trust-posture system (`rules/trust-posture.md` + `skills/32-trust-posture/`) defines five autonomy levels per repo. This command surfaces and changes posture state.

State lives at `<main_checkout>/.claude/learning/posture.json` (per `skills/32-trust-posture/posture-spec.md`). Direct edits are blocked by `settings.json::permissions.deny`.

## Subcommands

### `/posture` (no args) — show current

Read posture.json and report:

- Current posture for THIS operator (L1_PSEUDO_AGENT … L5_DELEGATED)
- Operative posture = min(operator_posture, repo_floor) per `posture-v2.js::computeOperativePosture`
- repo_floor (the shared constraint across all operators)
- Time at current posture (e.g., "3 days 14h")
- Pending verification entries (rule_id, day N of grace, regression-within-grace policy)
- Last 5 own transitions with type + reason
- Last 10 own violations (rule_id, severity, evidence head, addressed_by)
- Fresh-repo flag, fail-closed flag (if applicable)
- Genesis-generation partition signal (degrades to L3 if partitioned)

**Multi-operator surface (C2):** if the invoking operator has role
`owner` or `senior`, the report ALSO lists every other operator's
operative posture (read-only view; cross-operator postures are
otherwise siloed by `posture-v2.js`'s operator partition). Contributor-
role operators see only their own posture.

Output is plain markdown — no state mutation.

### `/posture init` — initialize fresh repo

Used once on a repo that has never run the trust system. Writes `posture.json` with `posture: L5_DELEGATED` + creates `.initialized` marker. Refuses to run if `.initialized` already exists (use `/posture override` to change posture on an initialized repo).

### `/posture history [--all | --recent N]` — transition log

Reads `transition_history` from posture.json. Defaults to last 10 transitions. Each row: from → to, type, reason, ts, approved_by. `--all` dumps every transition since INIT.

### `/posture violations [--rule X | --since DATE | --limit N]` — violation log

Tail of `violations.jsonl`. Filters: by rule_id, by ISO date, by count. Read-only.

### `/posture upgrade [--to LEVEL] [--ack NONCE]` — request posture upgrade

Two-step challenge-nonce flow + operator-gate.js 4-eyes gate (mitigates
red-team H3 forged ACK + M4 upgrade audit-trail + R5-S-07 collaborator
distinctness):

**Multi-operator gate (C2):** `/posture upgrade` is intercepted by
`.claude/hooks/operator-gate.js` per §6.4 row 'posture-upgrade'. The
gate requires a signed `gate-approval` record by a DISTINCT
`person_id` operator of role `owner` or `senior` whose bound
GitHub-collaborator login DIFFERS from the requester's (R5-S-07).
`host_role: ci` operators are NEVER eligible (R5-S-04). Self-approval
or same-collaborator approval → operator-gate halt-and-report with
the §6.4 rule citation in the structured handoff.

**Step 1**: User runs `/posture upgrade --to L5_DELEGATED`. Command:

1. Reads posture.json — verifies all four upgrade requirements (≥7d at posture, 0 violations of triggering class, ≥1 demonstrated correction, target = current_posture + 1).
2. Writes a random nonce to `<main_checkout>/.claude/learning/.posture-upgrade-nonce` (file readable only by hooks).
3. Prints to user: `"To confirm upgrade to L5_DELEGATED, paste this nonce in your next message: <NONCE>"`.
4. Surfaces the gate-approval pre-flight (F14 MED-2): mints a SECOND `requester_nonce` (distinct from the user-paste nonce; bound to THIS upgrade invocation) and instructs the distinct owner/senior to sign over `{target_tool:'posture-upgrade', requester_person_id, requester_verified_id, consumed_nonce:<this-nonce>, ts}`.

**Step 2**: User pastes the nonce as the next user message AND runs `/posture upgrade --to L5_DELEGATED --ack NONCE --approver <distinct-person_id>`. Command:

1. Reads `.posture-upgrade-nonce`. If absent or mismatched → reject.
2. Validates the user's PRIOR turn contained the nonce literal.
3. Resolves the approver's signed gate-approval record from the coordination log; operator-gate.js runs `lib/gate-approval.js::verifyGateApproval` (F14 MED-1 sig verify + MED-2 nonce/target_tool/TTL binding) and the gate-matrix evaluator (4-eyes + R5-S-07 case-insensitive + R5-S-04).
4. Updates posture.json: appends transition `EARNED` with `approved_by: human`, sets `posture` to target, clears nonce file.
5. Prints confirmation.

If validation fails: nonce stays valid for ONE more attempt then is cleared. Repeated failures log `acknowledgement_failure` violation.

### `/posture override --to LEVEL --reason "<text>" [--ack NONCE]` — manual override

Same two-step nonce flow as `upgrade` + the same operator-gate.js
4-eyes gate (§6.4 row 'posture-override'). A distinct-person_id
owner/senior co-signature is required; `host_role: ci` excluded; same
bound GitHub login rejected.

Used for:

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
Repo:    <repo-root>
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
