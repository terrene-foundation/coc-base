---
name: onboard
description: "/onboard procedure: read roster + team-memory + posture + claims + codify lease + rules-changed for a new operator joining a multi-operator COC repo."
---

# /onboard — deterministic operator onboarding

This skill is the procedural detail for the `/onboard` command (`.claude/commands/onboard.md`). The command is the entry point; this skill is the runbook the orchestrator follows.

## When to use

- An operator opens a fresh session in a multi-operator COC repo for the first time.
- An operator joins a repo someone else owns and needs the shared state surface.
- After `/clear` / auto-compaction — the operator wants to re-validate the team-memory + posture + claim surface without inferring from a stale `.session-notes`.
- Pre-`/codify` sanity check: confirm no other operator holds the codify lease before drafting a proposal.

## Read-only contract

`/onboard` writes ZERO state. Every read goes through an existing helper:

| Surface           | Helper                                                                                              | Returned shape                                               |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Operator identity | `operator-id.js::resolveIdentity()`                                                                 | `{display_id, verified_id, posture, blocked_into?}`          |
| Roster            | `roster-schema-validate.js` + reading `operators.roster.json`                                       | `{operators: [{display_id, ...}]}`                           |
| Team-memory       | direct `fs.readdir(.claude/team-memory)` + `fs.readFile` per file + `integrity-guard.js` validation | `[{slug, body, frontmatter, integrity_ok}]`                  |
| Active workspace  | `workspace-utils.js::detectActiveWorkspace()`                                                       | `{workspace, recent_journal[]}`                              |
| Posture           | `state-io.js::readPosture()`                                                                        | `{posture, since, transition_history, pending_verification}` |
| Adjacency claims  | `coordination-log.js::foldLog()`                                                                    | active-claim slice                                           |
| Codify lease      | `codify-lease.js::readActiveLease()`                                                                | `{lease, leasePath}`                                         |
| Rules-changed     | reuse `multi-operator-sessionstart.js` helper or re-derive via `git log`                            | list of rule files + MUST-clause line refs                   |

If a helper returns a typed error (e.g. `readPosture` fail-closes to L1), `/onboard` surfaces the error verbatim per `rules/zero-tolerance.md` Rule 3.

## Section-by-section runbook

### 1. Operator identity

```
identity = operatorId.resolveIdentity()
if (identity.blocked_into) → emit "/whoami --register" + stop
```

The blocked_into value (`UNROSTERED_BLOCKED_INTO` or `NO_KEY_BLOCKED_INTO`) is the action the operator must take. Do NOT proceed to subsequent sections if blocked — the rest of the briefing assumes a registered identity.

### 2. Team-memory surface

```
files = readdir(".claude/team-memory")
  .filter(f => f.endsWith(".md") && f !== "README.md")
for f in files:
  content = readFile(f)
  parsed = parseFrontmatter(content)
  if parsed.superseded_by → skip (historical record)
  integrity = integrityGuard.validate(content)
  if !integrity.ok → add to failed_integrity[]; continue
  emit {slug, body, signed: parsed.signed, promoted_by: parsed.promoted_by}
```

Sort by `promoted_at` descending so recently-promoted facts surface first.

The `failed_integrity` section is REQUIRED in the output even when empty — its presence is the operator's signal that the integrity check ran (an empty list with the heading is informative; a missing heading is ambiguous).

### 3. Active workspace + recent decisions

```
ws = workspaceUtils.detectActiveWorkspace()
recent = listJournalEntries(ws, limit=5, types=["DECISION","DISCOVERY","DEFER"])
emit {workspace: ws, recent_journal: recent}
```

The journal listing excludes `.pending/` (per existing M6 contract — pending entries are not yet committed and may carry uncleared sensitive content).

### 4. Posture + pending_verification

```
p = stateIo.readPosture(repoRoot)
if (p._fail_closed) → emit verbatim with fail-closed banner
emit {posture: p.posture, since: p.since, last_transition: p.transition_history[-1]}
if p.pending_verification.length > 0:
  emit "pending_verification: " + p.pending_verification.join(", ")
  emit "Your next response in a real session MUST include [ack: <rule_id>] for each."
```

### 5. Active claims + codify lease

Two independent helpers — combine into one section because they share the "what's locked right now" semantics.

```
claims = coordinationLog.foldLog({filter: "active_claim"})
for c in claims: emit {holder: c.display_id, path: c.path, expires: c.lease_expiry}

lease = codifyLease.readActiveLease(repoRoot)
if lease.lease:
  emit {holder: lease.lease.display_id, branch: lease.lease.branch,
        acquired_at: lease.lease.acquired_at, scope: lease.lease.scope}
  emit "Concurrent /codify is BLOCKED until released."
else:
  emit "No active codify lease."
```

### 6. Rules-changed

The M5 session-start hook (`multi-operator-sessionstart.js`) computes this surface. `/onboard` calls the same helper (extracted into a shared library at M5 time) OR re-derives via `git log --since` against `.claude/rules/`.

For each modified rule file, grep for MUST clauses (`grep -n '^### .*MUST'`) added/changed in the diff window. These are the candidates for `pending_verification` per `rules/trust-posture.md` MUST-7.

### 7. Action items

The actionable footer. Format:

```
## Action Items

- [ ] Acknowledge: include `[ack: <rule_id>]` in next real-session response (for each pending_verification entry)
- [ ] Repair integrity: <slug>.md frontmatter invalid (for each failed_integrity file)
- [ ] Posture: current L<N>; upgrade requires <gate> (only if posture < L5)
- [ ] Lease: held by <other_operator> on branch <branch> — wait for release before /codify
```

Empty when nothing requires action — the empty list IS the green-light signal.

## --json mode

Emit a single JSON object with the seven section keys:

```json
{
  "operator": {...},
  "team_memory": {"facts": [...], "failed_integrity": [...]},
  "workspace": {"name": "...", "recent_journal": [...]},
  "posture": {...},
  "claims": [...],
  "codify_lease": null | {...},
  "rules_changed": [...],
  "action_items": [...]
}
```

The schema is stable — downstream tooling (CI, audit scripts, repo-ops dashboards) MAY parse the JSON output as the canonical state snapshot.

## Composition with other commands

- **`/whoami`** answers "who am I" — `/onboard` answers "who am I AND what's the team state". `/onboard` calls `resolveIdentity` internally but surfaces more.
- **`multi-operator-sessionstart.js`** auto-renders a subset on every session start. `/onboard` is the on-demand full read.
- **`/claims`** lists adjacency claims only. `/onboard` includes the same data plus the codify lease.
- **`/posture`** shows the posture in isolation. `/onboard` shows it inline with everything else.

There is no overlap-as-duplication risk because `/onboard` is read-only and the other commands either write state or render a single surface. Calling `/onboard` then `/claims` is fine — the second call just re-reads.

## Origin

F14 M7 Shard E (workspaces/multi-operator-coc 02-plans/01-architecture.md §7.4). Procedure separated from the ≤150-line command body per `rules/cc-artifacts.md` Rule 3.
