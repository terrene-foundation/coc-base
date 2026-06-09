---
description: Release a claim from the multi-operator coordination log — self-release for own claims, cross-operator reap (--reap + --cosigner) for stale sibling claims per §4.4.
---

# /release-claim — Multi-Operator Claim Release

Release a claim from the coordination log. Two modes:

- **Self-release** — operator releases their own claim. Writes a signed `release` record.
- **Cross-operator reap** (`--reap … --cosigner …`) — releases a STALE claim held by a SIBLING. Requires the §4.4 reap ceremony (distinct-person_id cosigner + pinned victim heartbeat past LIVENESS_TTL_MS).

## Usage

```
/release-claim <claim-ref>
/release-claim --reap <other-claim-ref> --cosigner <person_id>
```

- `<claim-ref>` — either `<verified_id>:<seq>` (canonical) OR the `claim_id` from `/claims` output.
- `--reap` — explicit dispatch to the cross-operator reap ceremony. The `<other-claim-ref>` MUST point at a stale sibling claim (verified_id != self).
- `--cosigner <person_id>` — required on `--reap`; the person_id of a distinct, eligible cosigner per `.claude/hooks/lib/eligibility.js::isEligibleSigner("gate-approval")` (R5-S-04: CI hosts BLOCKED).

## Self-release flow

1. **Parse `<claim-ref>`** — resolve to `(verified_id, seq)`. If passed as `claim_id`, look up the matching claim record in the folded accepted set.
2. **Resolve identity** via `operator-id.js::resolveIdentity(cwd)`.
3. **Bind check** — the resolved claim's `verified_id` MUST equal the current operator's `verified_id`. If they differ, halt-and-report:
   ```
   Cross-operator claim release attempted via self-release.
   Use the reap ceremony for stale sibling claims:
     /release-claim --reap <other-claim-ref> --cosigner <person_id>
   ```
   Direct the user to `/claims` to see the stale claim's current `display_id` and a candidate cosigner.
4. **Build release record:**
   ```js
   {
     type: "release",
     verified_id, person_id, display_id, seq, prev_hash, ts,
     content: {
       claim_id: <released claim_id>,
       released_claim_ref: { verified_id, seq },
       reason: "self-release",
     },
     sig
   }
   ```
5. **Sign + append** via filesystem Transport `appendRecord`. Print confirmation.

## Cross-operator reap flow (`--reap`)

The reap ceremony dispatches to `.claude/hooks/lib/reap-ceremony.js::buildReapRecord` + `validateReap`. Per architecture §4.4 the ceremony has THREE bases:

| Basis          | When                                                              |
| -------------- | ----------------------------------------------------------------- |
| `co-signed`    | Two distinct operators co-sign; pinned victim heartbeat past TTL. |
| `owner-2-of-N` | Owner-class quorum signs; same pinned-heartbeat predicate.        |
| `self-reap`    | Reaper IS the victim's verified_id (clearing own stale claim).    |

### Flow

1. **Resolve identities** for reaper (current operator) and cosigner (`--cosigner <person_id>` lookup in `.claude/operators.roster.json`).
2. **Distinct-person check** — reaper.person_id != cosigner.person_id (architecture §4.4; enforced by reap-ceremony.js::buildReapRecord).
3. **Cosigner eligibility** — `isEligibleSigner(cosignerPerson, "gate-approval")` MUST return `{eligible: true}`. CI hosts (`host_role: "ci"`) ARE BLOCKED per R5-S-04; only owners and seniors pass the gate-approval role floor.
4. **Pin victim heartbeat** — read the folded accepted set; find the MAX-seq `type: "heartbeat"` record from the victim's `verified_id`. The `{verified_id, seq, ts}` of that heartbeat is the pin.
5. **Pre-validate** — call `validateReap({record: <draft>, now, observedPeerVictimHighWaterSeq})` BEFORE append. The predicates per §4.4:
   - **(a)** `observedPeerVictimHighWaterSeq <= pinned.seq` (pinned IS the latest the reaper has seen).
   - **(b)** `now - Date.parse(pinned.ts) >= LIVENESS_TTL_MS` (wall-clock; the LIVENESS_TTL_MS constant is identical to `.claude/hooks/lib/fold-rule-10.js::LIVENESS_TTL_MS` per R10-A-01 — re-exported through `coordination-log.js`).
   - If `honored: false`, halt-and-report citing the predicate that failed.
6. **Two-stage sign** — cosigner first signs the canonical `reap-cosignature` payload (subset of reap content); their signature lands in `content.cosignature`. Then the reaper signs the outer reap core (which now includes the cosignature). Both signatures verifiable by any consumer with the roster's pubkeys.
7. **Append** via filesystem Transport. Print confirmation including the basis, pinned heartbeat, and both signers.

## Record shapes

### Release (self-release)

```js
{
  type: "release",
  verified_id, person_id, display_id, seq, prev_hash, ts,
  content: {
    claim_id: <released claim_id>,
    released_claim_ref: { verified_id, seq },
    reason: "self-release",
  },
  sig
}
```

### Reap (cross-operator)

```js
{
  type: "reap",
  verified_id: <reaper>, person_id, display_id, seq, prev_hash, ts,
  content: {
    reaped_claim_ref: { verified_id: <victim>, seq },
    claim_id: <reaped claim_id>,
    reaper: <reaper person_id>,
    cosigner: <cosigner person_id>,
    cosigner_verified_id: <cosigner verified_id>,
    cosignature: <cosigner's sig over reap-cosignature payload>,
    pinned_victim_heartbeat: { verified_id, seq, ts },
    basis: "co-signed" | "owner-2-of-N" | "self-reap",
  },
  sig: <reaper's sig over the outer core>
}
```

## What this command does NOT do

- Does NOT release siblings without cosignature (except self-reap). The reap ceremony's distinct-person + LIVENESS_TTL_MS + cosigner-eligibility predicates are non-negotiable.
- Does NOT override SAME-class conflicts on its own — that requires a `lease-override` record (architecture §4.5; gate-approval gate). The reap ceremony is for STALE claims, not contested ones.
- Does NOT modify the roster, the operator's identity cache, or the posture state file.

## See also

- `/claim <path-or-glob>` — write a new claim.
- `/claims` — read the active-claim surface.
- `.claude/hooks/lib/reap-ceremony.js` — writer-side library implementing buildReapRecord + validateReap + verifyCosignature.
- `.claude/hooks/lib/eligibility.js` — R5-S-04 deploy-key-exclusion predicate.
- `journal/0128-DECISION-multi-operator-coc-m1-complete-2026-05-21.md` — M1 completion receipt.
