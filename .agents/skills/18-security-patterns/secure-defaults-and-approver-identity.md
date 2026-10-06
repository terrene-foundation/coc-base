# Secure Defaults + Approver-Identity Derivation

Depth for two `rules/security.md` baseline clauses whose neutral-body form is held to
stub density (one MUST sentence + one `**Why:**`) to stay under the codex/gemini
baseline-emission headroom floor. The DO/DO-NOT + BLOCKED corpora live inline in the rule
(stripped from baseline emission, loaded in full under Claude Code); this file carries the
extended rationale + evidence.

## Secure-Default For A New Security Feature — Fail-Closed Or Loud-WARN, Never A Silent No-Op

A NEW security feature gated behind a config field / kwarg / injected dependency whose
DEFAULT makes the feature a SILENT NO-OP is fail-OPEN: the release ships the protection's
headline claim while every un-wired deployment believes it is protected and is not. The
enabling default MUST be either:

- **(a) fail-CLOSED** — feature ON by default, opt-OUT explicit; a deployment that forgets to
  wire it stays protected.
- **(b) a LOUD one-time WARN** — only when backward-compat genuinely forbids on-by-default
  (the feature needs a key / store / identity a pre-upgrade caller has not wired): a one-time
  WARN at init / first-use naming the OFF protection + the exact wiring to enable it.

A silent-no-op default with neither is BLOCKED. The (b) WARN path is legitimate ONLY when
fail-closed was genuinely infeasible for backward-compat — not merely assumed.

```python
# DO (a) — fail-closed: feature ON by default, opt-OUT explicit
require_caller_identity: bool = True    # a deployment that forgets to wire it stays isolated

# DO (b) — backward-compat forbids on-by-default → a LOUD one-time WARN naming the OFF protection + wiring
def __init__(self, revocation_verifier=None):
    if revocation_verifier is None:
        warn_once("revocation checking is OFF — the signed-ledger gate is skipped for every "
                  "caller; wire TrustOperations(revocation_verifier=...) to enable")

# DO NOT — silent no-op default: the headline protection ships OFF with no signal
require_caller_identity: bool = False   # deployment trusts the body tenant → zero isolation, silently
revocation_verifier=None                # signed-ledger gate skipped for every un-wired caller, no WARN
```

**BLOCKED rationalizations:** "The default is False for backward-compat — callers opt in when
ready" / "On-by-default would break existing deployments" / "The feature is documented;
operators know to enable it" / "A one-time WARN is noise" / "The feature's own tests pass with
the default, so the default is fine".

**Why:** A silent-no-op default ships the protection's headline claim while every un-wired
deployment is unprotected with no signal; the feature's OWN tests never catch it (each test
wires the feature, so none exercises the un-wired default path) — both real incidents were
caught only by an adversarial /redteam.

Origin: kailash-py #1843 (kailash-pact 0.16.0 — `McpGovernanceConfig.require_caller_identity`
defaulted False, a silent-no-op tenant-isolation bypass; flipped to fail-closed True) +
#1842-S3 (kailash 2.58.0 — `TrustOperations(revocation_verifier=None)` skipped the
signed-ledger gate for every un-wired caller; kept None for backward-compat but added a loud
one-time WARN).

## Approver / Decider Identity Is Server-Derived On BOTH Sides + Immutable At Create-Time

The approver / decider / actor identity in ANY approval, decision, authorization, or
self-approval-distinctness check MUST be derived SERVER-SIDE from the authenticated session —
NEVER from a request-body field. BOTH sides of a distinct-principal comparison MUST be
server-derived: binding only the requester while trusting a body-supplied approver defeats the
control — the attacker sets the approver to any distinct id and passes the distinctness gate,
self-approving and falsifying the audit trail. A self-approval identity MUST ADDITIONALLY be
captured IMMUTABLY at create-time, never re-resolved at decision-time from mutable role
occupancy (occupancy can change, so requester and approver resolve to different ids for the
SAME human). This is an Enforcement-Surface-Parity instance: when one approval endpoint is
fixed, the SAME change MUST sweep ALL sibling decision endpoints for the same body-trust
pattern.

```python
# DO — both principals server-derived from the authenticated session; distinctness on server ids
requester = session.authenticated_principal            # server-side, not body
approver  = approval_session.authenticated_principal    # server-side on the OTHER side too
if requester.id == approver.id: raise SelfApprovalError()
record.created_by = session.authenticated_principal.id  # self-approval id pinned once at create-time

# DO NOT — trust a body-supplied approver / re-resolve from mutable role occupancy
approver_id  = request.body["approver_id"]              # attacker sets any distinct id → gate passes
requester_id = current_holder_of_role("submitter")      # occupancy changed → same human, two ids
```

**BLOCKED rationalizations:** "The requester side is already bound server-side, that's the
sensitive one" / "The approver id comes from a trusted internal caller" / "Re-resolving the
role at decision-time reflects the current org state" / "Only the endpoint we found is
affected; siblings are out of scope" / "The body field is validated, so it can be trusted".

**Why:** A distinctness gate is only as strong as its WEAKEST-derived side; a body-supplied
approver lets the attacker name any distinct principal and self-approve while the audit trail
records a falsified approver. Re-resolving a self-approval identity from mutable role occupancy
re-opens the same hole through time — the same human resolves to two ids once occupancy moves.

Origin: kailash-coc-rs #56 downstream upflow (Step-7c), governance-fix redteam (Lesson 2).
