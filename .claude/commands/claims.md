---
description: List all active claims in the multi-operator coordination log — own first, then siblings by granted_at DESC. Surfaces F2-1 contested claims (ADJACENT later overridden by SAME).
---

# /claims — Multi-Operator Active-Claim Surface

Read surface for the multi-operator coordination log's active-claim view. No writes. The command folds the log through A2a's `foldLog` and projects the accepted set to the active sibling-claim shape (rule 7 isClaimActive predicate).

Per multi-operator-coc architecture §2.2 + §4.1 + §4.5: this command is the operator's window into "who claims what right now," including the F2-1 surfaced-not-eliminated residual (ADJACENT-class claim later overridden by a sibling SAME-class claim).

## Usage

```
/claims
```

No arguments. The command always operates on the current repo's coordination log.

## Flow

1. **Resolve identity** via `.claude/hooks/lib/operator-id.js::resolveIdentity(cwd)`. Print `verified_id` + `display_id` so the operator knows which entries are theirs.
2. **Read coordination log** via filesystem Transport (`.claude/hooks/lib/transport-filesystem.js`).
3. **Fold** via A2a's `foldLog(records, roster, {})`. The folded `accepted[]` includes all records that passed rule 1 (sig) + rule 2 (chain) + rule 3 (fork) + per-record-type predicate.
4. **Walk accepted for active claims** — same projection logic M2 B1's `adjacency-leasecheck.js::projectActiveSiblingClaims` uses:
   - Filter `type === "claim"`.
   - Build a `released` set (records of `type: "release"` indexed by their `content.claim_id`) and a `reaped` set (records of `type: "reap"` indexed by their `content.claim_id` or `content.reaped_claim_ref`).
   - Resolve last-heartbeat-per-emitter via `accepted.filter(r => r.type === "heartbeat")` for the rule-7 session-live predicate.
   - Skip if released, reaped, or session-expired.
5. **Group by `display_id`** — own claims first; sibling claims grouped per operator.
6. **Sort siblings** by `granted_at` DESC (most-recently-granted first).
7. **Surface F2-1 contested claims** — for each ADJACENT-class claim, check whether a LATER record exists that would have promoted to SAME against the same target (sibling claim's path/dir/workspace overlaps this claim's `target_path_or_glob`). Mark as `contested: true`.

## Output shape

```
You are: alice (pid-alice, SHA256:abc…)

Your active claims:
  - claim-alice-1747000001  src/lib/foo.js         INDEPENDENT  2026-05-21T08:12:00Z
  - claim-alice-1747000123  src/lib/bar.js         ADJACENT     2026-05-21T08:30:00Z  (advisory)

Sibling active claims:
  - bob (pid-bob)
    - claim-bob-1747000050   src/auth/login.js     INDEPENDENT  2026-05-21T08:15:00Z
    - claim-bob-1747000200   src/auth/oauth.js     ADJACENT     2026-05-21T07:45:00Z  (advisory) [contested by claim-alice-…]

  - carol (pid-carol)
    - claim-carol-1747000180 workspaces/alpha/**   INDEPENDENT  2026-05-21T07:50:00Z

3 sibling operators, 3 sibling claims, 1 contested.
```

Each line shows:

- `claim_id` — the unique identifier of the claim record.
- `target_path_or_glob` — `content.path` / `content.glob` / `content.dir` / `content.workspace`.
- `granted_relation` — `INDEPENDENT` / `ADJACENT` (from `content.granted_relation`; auto-claims from B1 print as `INDEPENDENT [auto]`).
- `granted_at` — `content.granted_at` or fallback to record `ts`.
- `(advisory)` flag — when `content.advisory === true`.
- `[contested by …]` flag — when F2-1 residual fires (see below).

## F2-1 contested-claim surface

Per architecture §4.5: F2-1 is the "ADJACENT-then-promoted-SAME" residual. The relation library evaluates adjacency at CLAIM TIME against the cohort window then-current; if the cohort window slides AND a sibling's SAME-class claim later lands against the same dir/workspace, the earlier ADJACENT claim becomes contested.

The `/claims` surface walks each ADJACENT-class claim and checks: did any LATER `type: "claim"` record from a DIFFERENT `verified_id` land with `content.granted_relation: "SAME"` AND a path that overlaps this claim's dir/workspace? If yes, the earlier claim is flagged `contested`.

Contested claims are NOT auto-released. The operator decides:

- `/release-claim <my-contested-ref>` — yield to the SAME-class sibling.
- Continue with no action — the advisory claim remains on the log; siblings see the contention via this surface.

## What this command does NOT do

- Does NOT write — pure read.
- Does NOT enforce — surface is informational. The structural enforcement lives in `.claude/hooks/adjacency-leasecheck.js` (PreToolUse on Edit/Write).
- Does NOT show released or reaped claims — those are filtered by the rule-7 active predicate.

## See also

- `/claim <path-or-glob>` — write a new claim.
- `/release-claim <claim-ref>` — release a self-owned claim.
- `.claude/hooks/lib/coordination-log.js` — A2a fold engine.
- `journal/0128-DECISION-multi-operator-coc-m1-complete-2026-05-21.md` — M1 completion receipt.
