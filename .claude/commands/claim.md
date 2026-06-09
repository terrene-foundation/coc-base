---
description: Stake an explicit claim on a path/glob before editing — writes a signed claim record to the multi-operator coordination log. Halts on SAME-class conflict (advisory on ADJACENT, silent on INDEPENDENT).
---

# /claim — Multi-Operator Explicit Claim

Stake an explicit advisory claim on a path or glob. The same shape M2's `adjacency-leasecheck.js` writes on INDEPENDENT auto-claim — except `/claim` is the user-driven path: the operator says "I'm about to work on this; surface conflicts before I start."

Per multi-operator-coc architecture §4.1 + §4.2: claims are advisory (leases-advisory). The only `block`-severity halt comes from the §4.2 filesystem exception (`git status --porcelain` cross-worktree contention); `/claim` itself emits **halt-and-report** on SAME and **advisory** on ADJACENT.

## Usage

```
/claim <path-or-glob>
```

- `<path-or-glob>` — repo-relative path (`src/lib/foo.js`) or glob (`src/lib/**/*.js`).

## Flow

1. **Resolve identity** via `.claude/hooks/lib/operator-id.js::resolveIdentity(cwd)`. If no signing key is configured, halt with `next: configure signing key, then run /whoami --register` (architecture §6.1 block-into).
2. **Read coordination log** via filesystem Transport (`.claude/hooks/lib/transport-filesystem.js::createFilesystemTransport(repoDir)`).
3. **Fold** via A2a's `foldLog(records, roster, {})` (`.claude/hooks/lib/coordination-log.js`). Folded `accepted[]` is the authoritative active-claim view.
4. **Project active sibling claims** — filter `accepted` by `type === "claim"`, exclude own `verified_id`, exclude released/reaped (rule 7 isClaimActive predicate).
5. **Evaluate §4.1 relation** via `.claude/hooks/lib/adjacency.js::sameReason` then `adjacentReason` against the candidate path. Pass `{ phase, candidateCommits }` opts where known (the optional axis-3 cohort promotion).
6. **Dispatch by verdict:**
   - **SAME** → halt-and-report. Print the conflicting `claim_id`, sibling `display_id`, and the matched predicate (`exact` / `dir-contains` / `workspace` / `commit-cohort` / `axis-3`). Do NOT append a claim record (this prevents the F2-1 race-to-write). Direct the operator to either `/release-claim <conflicting-ref>` (if the sibling has consented) or proceed via `lease-override` (gate-approval needed; see §4.5).
   - **ADJACENT** → write the claim record with `content.granted_relation = "ADJACENT"` and `content.advisory = true`. Print the nearby sibling's `claim_id` and the matched predicate.
   - **INDEPENDENT** → write the claim record with `content.granted_relation = "INDEPENDENT"`. Silent success.

## Record shape

The claim shape MUST match M2 B1's auto-claim shape exactly (parity asserted by `tests/integration/claim-commands.test.js::claim_writes_record_with_correct_shape_matching_b1_auto_claim`). The only difference: B1 sets `content.auto = true` on the implicit-coordination path; `/claim` omits the `auto` field on the explicit path.

```js
{
  type: "claim",
  verified_id, person_id, display_id,
  seq, prev_hash, ts,
  content: {
    claim_id: `claim-<verified_id>-<nowMs>`,
    path: "<arg>",                                 // when path argument
    glob: "<arg>",                                 // when glob argument
    cohort_window_seq: <current fold head seq>,    // optional, for F2-2
    granted_relation: "ADJACENT" | "INDEPENDENT",
    granted_at: "<ISO>",
    advisory: true,                                // only when ADJACENT
  },
  sig
}
```

The record signature is produced via `.claude/hooks/lib/coc-sign.js::sign` over `canonicalSerialize(core)`. Tier-2 verification re-derives the bytes and confirms `verify(bytes, sig, pubKey)`.

## Severity contract

Per architecture §4.3 + `rules/hook-output-discipline.md`:

| Relation    | Severity        | Why                                                                |
| ----------- | --------------- | ------------------------------------------------------------------ |
| SAME        | halt-and-report | Registry-class signal; not structural. Operator adjudicates.       |
| ADJACENT    | advisory        | Proximity surfaced; operator MAY proceed.                          |
| INDEPENDENT | silent + append | No conflict; advertise intent to siblings via the appended record. |
| §4.2 fs exc | block (caller)  | Reserved for adjacency-leasecheck.js's porcelain-match path.       |

`/claim` itself never emits `block` — the structural filesystem signal lives in the hook (M2 B1), not in this command.

## What this command does NOT do

- Does NOT enforce — claims are advisory per architecture §4.2. Edits proceed regardless; the adjacency-leasecheck.js PreToolUse hook is where structural contention surfaces.
- Does NOT modify the roster — use `/whoami --register` for that.
- Does NOT release someone else's claim — use `/release-claim --reap` (cross-operator reap ceremony per §4.4).

## See also

- `/claims` — read surface for active claims.
- `/release-claim <claim-ref>` — release one's own claim; dispatches to reap ceremony with `--reap <other-ref> --cosigner <person_id>`.
- `.claude/hooks/adjacency-leasecheck.js` — the PreToolUse hook that writes the SAME-shape record on INDEPENDENT auto-claim and emits the §4.2 filesystem-exception `block`.
- `journal/0128-DECISION-multi-operator-coc-m1-complete-2026-05-21.md` — M1 completion + M2/M3 work plan.
