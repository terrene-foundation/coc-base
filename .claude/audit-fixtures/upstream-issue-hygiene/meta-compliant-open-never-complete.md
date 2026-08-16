---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/workspaces/**"
  - "**/.github/**"
---

# Completion Locus — A Proposer Opens, And The Owning Repo Disposes

Opening a pull request and completing one are two acts with two different owners.
The first is a proposal and belongs to whoever found the defect. The second is a
disposition and belongs to the repo the change lands in. A lane that lets the
proposer perform both has no review step left in it, only a receipt that says
there was one.

## Scope

ANY cross-repo proposal lane: a downstream consumer offering a fix to the template
it pulls from, a fork offering a change back to canon, or a contributor filing
against a repo they do not own.

## MUST Rules

### 1. A Cross-Repo Proposal Opens Its PR And Stops

The proposing session MUST open its pull request against the owning repo and MUST
stop there. Merging, admin-merging, enabling auto-merge, or pushing directly to any
branch of the owning repo is BLOCKED, with no exception and no human approval that
unlocks it. An approval to FILE authorizes `gh pr create`; it never authorizes
`gh pr merge`. The PR URL is the handoff, and the proposer's next act is to report
that URL and stop.

```bash
# DO — open, report the URL, stop
gh pr create --repo <owner>/<owned-repo> --body "$scrubbed"   # then echo the URL and stop

# DO NOT — open, then dispose of your own proposal
gh pr create --repo <owner>/<owned-repo> --body "$scrubbed" \
  && gh pr merge --repo <owner>/<owned-repo> --admin --merge
gh pr merge <N> --repo <owner>/<owned-repo> --auto --squash   # lands with no owner act
```

**BLOCKED rationalizations:**

- "I opened it, so I own it — merging my own PR is just housekeeping"
- "The user already approved this filing, and approving it plainly meant landing it"
- "CI is green and the scrub passed, so the owner's review is a formality"
- "The owner is unattended this week and it would sit there for days"
- "`--auto` isn't merging, it's queuing — the owner's own gate still decides"
- "I have admin on that repo, which makes me one of its maintainers"
- "I'll land it and the owner can revert if they disagree"

**Why:** The owning repo's ingest is the only place the offer is scrubbed against
the owner's denylist, read as untrusted data, deduped and lane-checked, and a
self-merged offer skips all four while producing a receipt that reads as though
they ran.

### 2. Self-Identity Is Derived From The Environment, Never Asserted

A session MUST derive which repo it IS from the live environment — the git remote —
and MUST treat any committed identity file as a refuse-only cross-check that can
contradict the derivation but never supply it. A caller-supplied repo identity is
BLOCKED, because a lane that takes its identity from its own argument can be
pointed at any repo by the same argument.

```bash
# DO — derive, then cross-check and refuse on disagreement
git remote get-url origin        # the derivation; VERSION::repo may only contradict it

# DO NOT — accept the identity the caller handed you
complete_pr --repo "$CALLER_SUPPLIED_REPO"
```

**BLOCKED rationalizations:**

- "The caller knows which repo it is running in better than the environment does"
- "The identity file is committed, so it is more authoritative than a remote"
- "Deriving it on every call is redundant when the value cannot change mid-session"

**Why:** An identity taken from the caller makes the fence configurable by the
party it constrains, so the one case it exists to stop is the one case that
supplies its own exemption.

## MUST NOT

- Merge, admin-merge, auto-merge, or push directly to a branch of a repo the session
  does not own — **Why:** completion is the owner's act, and a bypassed ingest still
  emits a receipt attesting the review ran.
- Read an approval to FILE as an approval to COMPLETE — **Why:** the two are separate
  acts, and conflating them converts one filing's consent into a standing merge right.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review — reviewer confirms every cross-repo
  proposal in the session opened and stopped.
- **Grace period:** 7 days from clause landing.
- **Cumulative posture impact:** N/A — emergency-only. A cross-repo write outside scope
  routes to `critical` on the first instance, so a cumulative window is unreachable.
- **Regression-within-grace:** the pre-existing `critical` cross-repo-write trigger,
  grace-independent; no new key minted.
- **Receipt requirement:** SessionStart soft-gate `[ack: completion-locus]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 gate-review, plus a structural refusal at the
  adapter boundary that fails closed on an underivable identity.
- **Violation scope:** MUST-1 and MUST-2, and the two MUST NOT bullets.
- **Origin:** See § Origin.

## Origin

2026-08-03 — a downstream cascade merged its own upflow PR into its template's main;
no clause prohibited it and the completion helper sat exported and caller-less.
