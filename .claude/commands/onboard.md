---
description: "Onboard a new operator to a multi-operator COC repo. Deterministic read-path: roster + posture + team-memory + active claims + recent decisions."
---

Onboard the operator into the current repo's multi-operator COC state. Read-only command — no commits, no state writes. Output is a structured briefing the operator (and the next session) can act on.

**Run `loom doctor` FIRST.** On a fresh / Windows / ADO clone, run `node .claude/bin/loom-doctor.mjs` (the `/doctor` command) before `/onboard` — it surfaces role/env/line-ending/VCS-host/resolver issues with remediations (and `--fix` repairs the safe subset). `/onboard` assumes a healthy clone; the doctor is what makes it one.

**Usage**: `/onboard` (no args; runs in current repo) — `/onboard --json` for machine-readable output

## Process

`/onboard` is a deterministic read-path: every invocation surfaces the same artifacts in the same order, so two operators starting fresh sessions see consistent state. The procedure detail lives in the skill `.claude/skills/41-onboard/SKILL.md`; this command is the entry point.

### 1. Identify the operator

Resolve identity via `.claude/hooks/lib/operator-id.js::resolveIdentity()`. The result includes `display_id`, `verified_id`, and the operator's roster status. If the operator is not registered, surface the `/whoami --register` instruction and stop — onboarding past identity is not safe.

### 2. Read the team-memory surface

List every non-superseded `<slug>.md` under `.claude/team-memory/` (skip the `README.md` governance file). For each file, surface:

- The topic slug (filename without `.md`)
- The body (≤80 lines per file by convention)
- The signed-attribution status (frontmatter `signed: true|false`, `promoted_by.display_id`, `proposal_ref`)

Files failing `integrity-guard.js` validation (broken frontmatter, body-anchor mismatch, missing signed attribution where required) are reported in a separate "failed integrity" section. Do NOT show the body of a file with broken integrity — the file is treated as absent until repaired.

### 3. Read the active workspace + recent decisions

Run the same workspace-detection logic as `multi-operator-sessionstart.js` (the M5 hook):

- Active workspace = most recently modified `workspaces/<name>/` (filter `instructions` + leading-underscore meta-dirs per `rules/cc-artifacts.md` Rule 8).
- Recent journal entries: last 5 `DECISION-` / `DISCOVERY-` / `DEFER-` entries from the active workspace's `journal/` (excluding `.pending/`).
- Surface each entry's filename + the first H2 / heading line, in date-descending order.

### 4. Read the active posture + pending verifications

Read `.claude/learning/posture.json` via `state-io.js::readPosture()`. Surface:

- Current `posture` (L5_DELEGATED through L1_PSEUDO_AGENT)
- `since` timestamp + the most recent `transition_history` entry's reason
- `pending_verification[]` — every rule_id awaiting a `[ack: <rule_id>]` receipt (per `rules/trust-posture.md` MUST-7's grace mechanism)

If any rule_id is in `pending_verification`, the onboarding output names it and instructs the operator: their next response in a real session must include the `[ack: <rule_id>]` token to clear the gate.

### 5. Read active claims + leases

Two surfaces:

- **Adjacency claims** (per F14 M3 Shard B): list active `/claim` entries via `coordination-log.js::foldLog()` filtered to non-released claims. Each entry shows the holder's `display_id`, the path/glob claimed, and the lease expiry.
- **Codify lease** (per F14 M7 Shard E): call `codify-lease.js::readActiveLease()`. If a lease is held, surface the `display_id`, `branch`, `acquired_at`, and `scope`. A held lease means concurrent `/codify` is blocked until the holder releases.

### 6. Read rules-changed-since-last-session (M5 sessionstart surface)

The M5 `multi-operator-sessionstart.js` hook already renders a "rules changed since last session" banner. `/onboard` re-renders it explicitly so the operator sees the same surface even when the session-start hook fired hours ago. Surfaces:

- Rule files modified since the operator's last attested session (per `multi-operator-sessionstart.js` staleness caveat)
- MUST-clause changes within those files (greppable via the `**Why:**` + MUST adjacency, per `rules/rule-authoring.md` Rule 4) — these require a signed `[ack]` per Step 4

### 7. Emit the briefing

In `--json` mode, emit a structured object: `{operator, team_memory, workspace, posture, claims, codify_lease, rules_changed}`. In default markdown mode, render each section under a `##` heading in the order above. The operator (and any agent reading the briefing) can act from this single read.

### Failure modes (typed errors — no silent fallbacks per `rules/zero-tolerance.md` Rule 3)

- Unregistered operator → STOP, instruct `/whoami --register`.
- Missing `.claude/team-memory/` directory → empty section (not an error; fresh repo).
- Corrupt `posture.json` (state-io.js returns fail-closed L1) → surface verbatim; do NOT proceed.
- Missing roster (`.claude/learning/operators.roster.json`) → STOP, instruct genesis ceremony.

## Output format

Default markdown briefing, ≤300 lines (excluding read content). Sections in fixed order: Operator → Team Memory → Workspace → Posture → Claims → Codify Lease → Rules Changed → Action Items.

Action Items is the actionable footer: every gate the operator must clear (pending_verification acks, integrity-failed files, posture downgrades) listed with the concrete next command.

## Next steps after onboarding

```
Next: /whoami (verify identity) → /claims (see what's locked) → /analyze or /implement (start work)
```

## Notes

- This command is read-only. It does NOT write to roster, posture, lease, or coordination log. Every state-write surface is a separate command (`/whoami --register`, `/claim`, `/release-claim`, `/posture upgrade`, `/codify`).
- Procedure detail (failure-mode handling, JSON schema, integrity-fail formatting, MUST-clause grep) lives in `.claude/skills/41-onboard/SKILL.md`. Update the skill, not this command, when the procedure changes.
- This command pairs with `multi-operator-sessionstart.js` (M5): the session-start hook auto-runs a subset (workspace + posture + rules-changed); `/onboard` is the on-demand full read that an operator invokes when joining the repo or after a `/clear`.

## Origin

F14 M7 Shard E (workspaces/multi-operator-coc 02-plans/01-architecture.md §7.4) — deterministic read-path for new-operator onboarding. Command body ≤150 lines per `rules/cc-artifacts.md` Rule 3; procedure detail in `skills/41-onboard/SKILL.md`.
