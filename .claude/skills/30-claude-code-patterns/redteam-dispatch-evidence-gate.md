# Redteam Reviewer Dispatch — Evidence Gate + Concurrency Back-Off

Depth file for `rules/agents.md` § "MUST: Redteam Reviewer Dispatch — Errored/Empty Is Zero Evidence, Never A Clean Round". The rule body carries the load-bearing MUST (the evidence gate + the back-off principle); this file carries the DO/DO-NOT block, the BLOCKED-rationalization corpus, the throttle-signal contract, and the Trust Posture Wiring.

## The failure mode

A `/redteam` round dispatches N reviewers (reviewer + security-reviewer + closure-parity verifier, often run in one parallel wave per `rules/agents.md` § Parallel Execution + § Holistic Post-Multi-Wave Redteam). The orchestrator then tallies findings across the wave. The trap: provider rate-limiting can throttle the fan-out so one or more agents return **errored / empty / timed-out** — and an errored agent's "no findings returned" is indistinguishable, in a naive tally, from a genuinely-clean agent's "0 findings". The round is declared converged on a partial wave; the throttled reviewer's shard ships UN-reviewed under the converged banner.

This is the `rules/evidence-first-claims.md` MUST-3 failure ("an errored or empty command is zero evidence, never confirmation") applied to the redteam-dispatch layer: an errored REVIEWER is not an all-clear.

## The two axes

### Axis 1 — EVIDENCE GATE (per `evidence-first-claims.md` MUST-3)

Every dispatched reviewer MUST return a ran/evidence signal — a verbatim finding list, an explicit "ran clean, 0 findings, here is what I checked", or a tool-output receipt. An errored / empty / timed-out return is ZERO evidence: it MUST be re-run and MUST NOT count as a clean reviewer. Convergence (per `skills/32-trust-posture/redteam-integration.md` — 2 consecutive clean rounds) is claimable ONLY when EVERY agent in the round genuinely ran.

```text
# DO — gate each reviewer on a ran/evidence signal before tallying
wave = dispatch([reviewer, security-reviewer, closure-parity])   # parallel
for r in wave:
  if r.errored or r.empty or r.timed_out:
    re-run r   # ZERO evidence — NOT a clean reviewer
# convergence claimable ONLY when all three returned a genuine ran-signal

# DO NOT — tally "0 findings" across a wave where one agent errored
wave = dispatch([reviewer, security-reviewer, closure-parity])
findings = sum(r.findings for r in wave)   # errored r contributes 0
if findings == 0: declare_converged()      # ships the throttled shard un-reviewed
```

### Axis 2 — CONCURRENCY BACK-OFF (per `worktree-isolation.md` Rule 4)

On an observed throttle signal (the falsifiable signal in `worktree-isolation.md` Rule 4: ≥2 agents in one launch wave fail within a ~30–48s synchronized window carrying the server string `Server is temporarily limiting requests` / `(not your usage limit)` / `Rate limited`), reduce dispatch concurrency to the adaptive back-off model (waves of ~3) and re-run the throttled reviewers. This COMPLEMENTS parallel-by-default (`rules/agents.md` § Decompose Onto The Parallel Primitive By Default) — it does NOT override it. A single agent dying, an OOM, or a quota "usage limit" error is NOT the throttle signal and does NOT trigger concurrency back-off (it triggers a plain re-run).

```text
# DO — back off concurrency on the synchronized-throttle signal, then re-run
if ≥2 of wave died within ~30-48s carrying "(not your usage limit)":
  re-dispatch the throttled reviewers in waves of ~3   # adaptive back-off
# else (single failure): plain re-run of the one errored reviewer

# DO NOT — re-dispatch the full wave at the same concurrency that just throttled
re-dispatch(wave)   # re-triggers the throttle; same partial-return failure
```

## BLOCKED rationalizations

- "All agents returned, the round is clean" (when one returned ERRORED — errored is not returned-clean)
- "0 findings across the wave = converged" (an errored agent contributes 0 to the tally; the tally is a lie)
- "The throttled agent would have found nothing anyway" (unfalsifiable — re-run it)
- "Re-running the errored reviewer doubles the round cost" (the alternative ships an un-reviewed shard)
- "Rate-limiting is transient, the next round will catch it" (the next round may throttle the same way; convergence is being claimed NOW)
- "The other two reviewers ran clean, that's enough coverage" (each reviewer covers a distinct surface — security ≠ closure-parity ≠ correctness)
- "An empty return means the agent had nothing to say" (empty is indistinguishable from errored; treat as zero evidence)
- "Back-off slows convergence, keep full concurrency" (full concurrency that throttles produces partial waves — slower in re-runs than an adaptive wave)

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (the `/redteam` orchestrator + cc-architect at `/codify` confirm every dispatched reviewer in a converged round returned a genuine ran/evidence signal); `advisory` at any hook layer (a lexical "0 findings" detector cannot carry `block` per `rules/hook-output-discipline.md` MUST-2). Inherits the `evidence-first-claims.md` MUST-3 emergency posture for the errored-as-confirmation subclass.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (a converged round tallied over a partial/errored wave) contribute to `rules/trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the `evidence-first-claims.md` `evidence_free_claim` emergency trigger (1× = drop 1 posture) — an errored reviewer counted as clean IS an evidence-free convergence claim.
- **Receipt requirement:** SessionStart `[ack: agents]` IFF `posture.json::pending_verification` includes the `agents` rule_id (shared ack with the rest of `agents.md`).
- **Detection mechanism:** Phase 1 — the `/redteam` orchestrator gates each reviewer on a ran-signal before tallying; cc-architect at `/codify` confirms any "converged" claim cites a full wave of genuine returns. Phase 2 (deferred) — a dispatch-layer detector flagging a convergence claim whose wave contains an errored/empty return, advisory.
- **Violation scope:** the EVIDENCE GATE (axis 1) + the CONCURRENCY BACK-OFF (axis 2). Every violation row names the throttled reviewer + the round declared converged over it.
- **Origin:** kailash-py BUILD-repo `/codify` (Gate-1 classified global, shard C). Generalizes `evidence-first-claims.md` MUST-3 (errored command = zero evidence) to the parallel-redteam-dispatch layer; pairs with `worktree-isolation.md` Rule 4 (the throttle-signal contract + adaptive back-off) and `agents.md` § Holistic Post-Multi-Wave Redteam (the wave the gate protects).
