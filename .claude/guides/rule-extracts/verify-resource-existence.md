# Verify Resource Existence — Extended Examples & Origin

Reference for `rules/verify-resource-existence.md`. The main rule keeps the load-bearing MUST/MUST NOT clauses; this extract carries the full BLOCKED-rationalization enumerations, extended DO/DO NOT examples, and the origin post-mortem.

## Rule 1 — Existence Check Precedes Permission Debugging

### Full DO / DO NOT examples

```bash
# DO — existence check first
$ gh api orgs/<org>/actions/hosted-runners
{"total_count":1,"runners":[{"name":"<runner-name>","labels":["self-hosted","linux","arm64"],...}]}
# → no 16-core runner exists; the workflow step targeting it can never succeed
# → recommendation: delete the dead step (no PAT, no rotation, no debugging)

# DO NOT — chase permission scopes against an empty target
$ gh api orgs/<org>/actions/hosted-runners → 403
"Try scope A" → 403 → "Try scope B" → 403 → user fatigue → eventual deletion anyway
```

### Full BLOCKED rationalizations

- "The script obviously expects this resource to exist"
- "The 403 confirms the endpoint is real, just the permission is wrong"
- "Existence is implied by the documentation reference"
- "We can verify existence after we get the permission right"
- "The user already approved the credential workflow, no need to detour"
- "The previous engineer set this up, so the resource must be there"
- "It's faster to try the obvious credential fix first"

### Why (full)

A 403 says "you cannot access this thing" — it does NOT say the thing exists. GitHub (and most APIs) return 403 for both "missing permission to access an existing resource" AND "missing permission to even discover whether the resource exists" — the message is identical. Trial-and-error against the permission axis can succeed only when the resource is real; against an absent resource it produces unbounded rotation cycles. The existence check is a single read query that costs <1 second and resolves the recursion.

## Rule 2 — Existence Check Cites the Endpoint, Not the Documentation

### Full DO / DO NOT examples

```bash
# DO — verify against the live API
$ gh api orgs/<org>/actions/hosted-runners --jq '.runners[].name'

# DO — verify a database table actually exists
$ psql -c "\dt schema.table_name"

# DO — verify a secret slot is populated
$ gh secret list --repo <org>/<repo> | grep '^ORG_ADMIN_TOKEN'

# DO NOT — trust the comment block
$ grep -A 5 "16-core" .github/workflows/ci-queue-monitor.yml
# (the script targets a 16-core runner — but that's INTENT, not EXISTENCE)

# DO NOT — trust the spec / ADR / README
$ grep -l "rust-heavy" specs/ci-infrastructure.md
# (the spec describes a recommended pattern — but it may never have been wired)
```

### Full BLOCKED rationalizations

- "The README says it's deployed"
- "The spec mandates this resource"
- "The script wouldn't be checked in if the resource didn't exist"
- "Past commits reference setting it up"
- "Operators told me it was provisioned"

### Why (full)

Documentation, source comments, and operator memory all describe INTENT — what the system was supposed to look like at some point. None of them are evidence of CURRENT runtime state. A spec can mandate a 16-core runner that operations never actually provisioned; a script can target a database table that a half-finished migration left undefined; a workflow can read a secret that was rotated out of existence. The live API query is the only evidence; everything else is hearsay.

## Rule 3 — Default Disposition is Delete-Or-Stub, Not Provision

### Full DO / DO NOT examples

```yaml
# DO — resource doesn't exist; remove dependent step
- name: Auto-remove rust-heavy label from 16-core when idle
  # DELETED 2026-05-03: targeted runner does not exist in the org;
  # see PR #773 for removal rationale.

# DO NOT — auto-recommend provisioning a resource the user never asked for
"You should provision a 16-core runner so this step can succeed."
# (the user inherited this script; nobody asked for the runner; the step
#  was speculative-add. The right disposition is removal, not building
#  more infrastructure to feed the speculation.)
```

### Full BLOCKED rationalizations

- "The script is here, so someone wanted this feature"
- "It would be wasteful to delete; we might need it someday"
- "Provisioning is the more 'correct' fix"
- "Removing without a follow-up issue loses the design intent"

### Why (full)

Code that targets a non-existent resource is dead by definition — it cannot have ever worked. Treating it as live and recommending the user build infrastructure to make it work inverts the cost model: the user pays now for a capability they never requested, against the speculation that they might want it. Removal is the cheap, reversible disposition (revert is one command); provisioning is the expensive, durable commitment (server costs, secret rotation, monitoring). When the user genuinely wants the capability, they will say so; until then, dead code is dead.

## Origin (full post-mortem)

2026-05-03 ci-queue-monitor session — 6 consecutive PRs (#766, #769, #770, #771, #772, #773) + 2 user PAT-creation cycles spent debugging access to a 16-core GitHub-hosted runner that did not exist in the `esperie-enterprise` org.

The single command `gh api orgs/esperie-enterprise/actions/hosted-runners` at the first 403 (PR #765 verification) would have shown a one-runner list with no 16-core entry and shifted the disposition immediately to "delete the dead step."

Saved by the existence-check-first discipline (counterfactual): ~15 minutes of operator browser time, two unused PAT credentials, and roughly 5 PRs of cycle.

User feedback verbatim that triggered codification:

> "why the fuck are you wasting so much time and tokens on something that don't exist??????"
> "we have a shit ton of backlogs in /sweep that is waiting"

The failure mode is structural: a 403 against an absent resource looks identical to a 403 against an inaccessible-but-real resource. Without an existence check at the FIRST 403, the agent recurses on the permission axis indefinitely. The rule is the structural defense.

## Three-Layer Defense Detail

1. **Existence check FIRST** — `gh api`, `psql \dt`, `kubectl get`, `aws describe-*`, etc. One read query against the live system.
2. **If exists** — proceed with permission/scope debugging using the standard rules (see `rules/security.md`, `rules/ci-runners.md`).
3. **If absent** — default to removal of dependent code; provisioning ONLY on explicit user request.

For convergence/round-verdict claims (MUST-4): the same three-layer shape applies — receipt FIRST (cite the journal entry / commit SHA / observation), claim-grounding SECOND (the disposition document's verdict cites the receipt), absence-disposition THIRD (if no receipt exists, the verdict cannot be claimed; spawn the receipt or surface the gap).

## Rule 4 — Convergence / Round-Verdict Claims MUST Cite Durable Receipts

### Full DO / DO NOT examples

```markdown
# DO — convergence claim cites a durable receipt

Rounds 5+6 cross-agent-clean (CONVERGENCE TARGET MET).
Receipts: `journal/.pending/0003-DISCOVERY-phantom-citation-chain-and-redteam-round-history.md` § "/redteam round-history (rounds 1–6)" — round-by-round verdict table records reviewer + analyst verdicts and the agent task IDs that produced each verdict.

# DO — convergence claim cites commit SHA

Round 8 verified clean — commit `a7f3c91` references the agent invocation transcript at `.claude/transcripts/...` and the post-round verify-overlays.sh exit 0.

# DO — convergence claim cites observation entry

Final convergence target met per `.claude/learning/observations.jsonl` entry id `obs_<id>` (round=8 verdict=clean cross_agent=true).

# DO NOT — disposition self-attests convergence

Rounds 5+6 met convergence target. (no journal entry, no SHA, no observation
record; the only place this claim exists is the document making the claim.)

# DO NOT — verdict is asserted but the named receipt does not contain it

"Per journal/0042 the round converged" — but journal/0042 contains no round-verdict table or convergence-claim text.
```

### Full BLOCKED rationalizations

- "The claim is in the document the reader is already reading; cross-citing is bureaucracy"
- "The agent task IDs are runtime artifacts; they don't survive `/clear` anyway"
- "The convergence verdict is obvious from the round count"
- "The reviewer + analyst both said clean, that IS the receipt"
- "Journal entries take time; a self-attested claim is faster"
- "If the next session disputes the verdict, they can re-run the round"
- "Self-attestation is the same epistemic shape as a journal entry"
- "The disposition document is itself the journal entry; double-recording is overhead"
- "The session transcript is the receipt"
- "We can backfill the journal entry after the disposition lands"

### Why (full)

Convergence claims are the highest-leverage claims a closure document makes — every downstream disposition rests on "the verification rounds converged." A self-attested verdict has the same structural defect as a 403 against a non-existent resource: the claim cannot be verified by inspecting itself. The journal entry, commit SHA, or observation record is the equivalent of `gh api` against the runtime — an external surface that confirms the claim independently of the document making it. Without the receipt, the next session reading the disposition has no way to distinguish a genuinely-converged process from a self-attested one. Same epistemic shape as MUST-2 (cite the endpoint, not the documentation) and `zero-tolerance.md` Rule 1c (claims about session-runtime unfalsifiable across `/clear`).

### Trust Posture Wiring (MUST-4)

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect / analyst at `/codify` — flags any "round N met convergence" / "rounds X+Y clean" / "convergence target met" claim in a closure/disposition document without an adjacent receipt citation).
- **Grace period:** 7 days from rule landing.
- **Regression-within-grace:** any same-class violation triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4.
- **Detection (review layer):** `/codify` mechanical sweep — for every closure/disposition artifact authored or updated in the session, grep for convergence-verdict markers ("convergence target met", "rounds N+M clean", "cross-agent agreement", "round N converged"); each match MUST have an adjacent journal-entry / commit-SHA / observation-entry citation within ±300 chars.

### Origin (MUST-4)

2026-05-09 stale-workspace disposition convergence cycle — Round 4 analyst flagged R4-M1 (no live receipt mechanism for prior redteam rounds; convergence claim rested on self-attestation in `.session-notes:20`). Routed via `journal/.pending/0003-DISCOVERY-phantom-citation-chain-and-redteam-round-history.md` § R4-M1 carry-over routing; landed as MUST-4 in the main rule. The journal entry IS the kind of durable receipt MUST-4 requires.
