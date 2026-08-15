# Deferral-Registry Locality — depth

Paired depth for `rules/deferral-registry-locality.md`, extracted at authoring time per
`rule-authoring.md` Rule 10 path (a). The extraction was FORCED and MEASURED, not stylistic: the
un-extracted rule was 5,701 B and the `loom-rule-edit` injection profile had 3,429 B of headroom
under its +5% ceiling (347,729 B consumed against a 334,437 B budget, ceiling 351,158 B), so the
whole rule could not land. What stayed in the rule is the obligation; what moved here is
everything a reader consults only once they are already acting on it.

## What counts as a deferral

Enforcement this repo decided not to build YET, in any of these shapes:

- a Phase-2 hook detector declared and unbuilt
- a probe suite declared and unauthored
- a gate shipped `advisory` that the design says should be `block`
- a `Phase 2 (deferred per trust-posture.md § Two-Phase Rollout)` line in a Wiring block
- an audit-fixture directory named in a Wiring block that does not exist on disk

NOT a deferral: work simply not started, an idea in a journal entry, a backlog issue. The
discriminator is whether an ARTIFACT ALREADY SHIPPED makes a claim its enforcement does not yet
back. That is what rots quietly; unstarted work is visibly unstarted.

## Worked examples

```json
// DO — the deferring repo's OWN registry, dated, with a named acceptor
{
  "deferrals": {
    "my-rule.md#MUST-2": {
      "reason": "detector needs an AST pass the hook layer cannot run at tool-call time",
      "graduation": "the shared AST helper lands; detector + bipolar fixtures ship together",
      "expires": "2026-11-30",
      "accepted_by": "<named human, standing role>",
      "risk": "trust"
    }
  }
}
```

```markdown
# DO NOT — the deferral lives as a sentence in the rule and nowhere countable

- **Detection mechanism:** Phase 2 (deferred) — no hook detector yet.

# DO NOT — recorded in the UPSTREAM template's registry, where this repo's session never reads it

# DO NOT — the file deleted so the SessionStart surface stops mentioning it
```

## BLOCKED rationalizations, with what each one gets wrong

- _"the upstream template already tracks this class"_ — it tracks ITS rows. Its registry names its
  rule files and is counted by sessions in ITS repo.
- _"it is loom's rule, so it is loom's deferral"_ — the RULE is loom's; the un-built detector is
  this repo's, and only a session here can build it.
- _"the Wiring block says deferred, that IS the record"_ — prose is not countable. Nothing
  decrements, nothing expires, and the SessionStart surface reports 0.
- _"we will register it when the detector is actually written"_ — registering it after it is built
  is registering nothing; the registry exists to hold the gap, not to celebrate its closure.
- _"there is no registry here yet"_ — `.claude/deferrals.json` ships scaffolded to every target on
  both lanes (MEASURED `copy/always_include` via `buildPlan`, all seven target×lane combinations).
  If it is genuinely absent, the repo predates the cascade and the fix is to pull.
- _"the surface says verified-empty, so we are clean"_ — it says the registry was READ and declares
  no rows. That is a measurement of the file, not of the repo's honesty in writing to it.

## Why the empty case is rendered POSITIVELY

`{"deferrals": {}}` renders "✓ Verified Empty", and that is deliberate. Three states must stay
distinguishable at a glance:

| on disk                             | rendered                    | means                        |
| ----------------------------------- | --------------------------- | ---------------------------- |
| absent                              | nothing at all              | no registry here             |
| present, unparseable OR no section  | "counts NOT verified"       | UNKNOWN — never empty        |
| present, `{"deferrals": {}}`        | "✓ Verified Empty"          | read this session, no rows   |

Collapsing row 2 into row 3 is the one bug that would make the surface lie, which is why the
wrong-shaped case was fixed to take the NOT-VERIFIED branch (`instrument-discipline.md` MUST-1:
before that fix, `{"nonsense": true}` rendered verified-empty, so no output could falsify "the
backlog is empty").

## Why the scaffold is `{"deferrals": {}}` and NOT loom's skeleton emptied

MEASURED at both poles against the real `computeDeferralState` / `formatDeferralBlock`:

- `{"deferrals": {}}` → `open: 0` → "✓ Verified Empty"
- `{"deferrals": {}, "rollout": {}}` → `open: 1, undated: 1` → "⚠ PAST DUE"

The second shape ships a FALSE past-due alarm to every consumer on day one, because `rollout` is a
real deferral to the producer's semantics and an empty one carries no readable `expires`. A
standing false alarm is dismissed, then ignored, then deleted — and it takes the true alarms with
it. The scaffold is the minimal shape for that reason.

## Durability hazard — a pull can erase rows, until loom#1729

`/sync-from-template` is a category-based REPLACE, not a per-file merge, and `.claude/`-root files
sit outside the six `SHARED_GLOB_DIRS` that `bin/sync-preflight-local-mods.mjs` scans. So a future
pull can overwrite `.claude/deferrals.json` whole — no warning, no conflict marker, no preflight
finding. Rows recorded there are destructible by the very pull a consumer is instructed to run.

**Not reachable today**, and the claim is scoped rather than dramatised: no consumer carries a
registry yet, so there is nothing to overwrite. The mechanism fix is declaring the path
consumer-owned so the pull preserves it, tracked as **loom#1729** and dispositioned a prerequisite
of the distribution wave. Until it lands, a row here is recoverable from git history, and
`git status` after a `/sync-from-template` is the check. The shipped `_README` inside the registry
carries this same warning, because the party that loses the data reads that file and not this one.

## Scope residual — surfaced, not enforced, at a consumer

A consumer gets VISIBILITY (the SessionStart surface) and a PLACE to record. It does NOT get an
expiry GATE: `bin/phase2-deferral-integrity.mjs` is loom's validator and classifies
`skip/no_tier_match` on both lanes for every target (MEASURED). It is deliberately not shipped —
it validates verbatim quotes against loom's own rule files and cross-references loom's
`eval-manifest.json`, so at a consumer it would fail closed against a corpus it was never written
for. The consequence is real and named: a consumer's `expires` dates are reported, never enforced.
That is one of the two accepted residuals recorded in the E6 lane report, with an acceptor, a
revisit trigger and a calendar backstop.

## See also

- `rules/deferral-registry-locality.md` — the obligation
- `rules/completion-criterion.md` MUST-6 — residuals are accepted by a named human, never
  self-accepted
- `rules/instrument-discipline.md` MUST-1 — why an unreadable registry must never render as a
  clean one
- `hooks/lib/deferral-surface.js` — the reader, its tri-state contract, and its distribution record
