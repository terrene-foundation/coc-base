# Redteam Reviewer Dispatch — Evidence Gate + Concurrency Back-Off + Concurrency Safety

Depth file for `rules/agents.md` § "MUST: Redteam Reviewer Dispatch — Errored/Empty Is Zero Evidence, Never A Clean Round". The rule body carries the load-bearing MUST (the evidence gate + the back-off principle); this file carries the DO/DO-NOT block, the BLOCKED-rationalization corpus, the throttle-signal contract, the concurrency-safety axis (Axis 3, below), and the Trust Posture Wiring. Axis 3 does NOT introduce a new standalone MUST — it is the redteam-dispatch INSTANTIATION of two existing rule-body MUSTs (`rules/agents.md` § "MUST: Worktree Orchestration" concurrent-readers-read-committed-HEAD + `rules/evidence-first-claims.md` MUST-2, a security/anomaly finding is verified against ground truth before it is characterized — generalizing the MUST-3 errored-is-zero-evidence family to an uncommitted-transient observation), collected here because both bite at once on a `/redteam` wave.

## The failure mode

A `/redteam` round dispatches N reviewers (reviewer + security-reviewer + closure-parity verifier, often run in one parallel wave per `rules/agents.md` § Parallel Execution + § Holistic Post-Multi-Wave Redteam). The orchestrator then tallies findings across the wave. The trap: provider rate-limiting can throttle the fan-out so one or more agents return **errored / empty / timed-out** — and an errored agent's "no findings returned" is indistinguishable, in a naive tally, from a genuinely-clean agent's "0 findings". The round is declared converged on a partial wave; the throttled reviewer's shard ships UN-reviewed under the converged banner.

This is the `rules/evidence-first-claims.md` MUST-3 failure ("an errored or empty command is zero evidence, never confirmation") applied to the redteam-dispatch layer: an errored REVIEWER is not an all-clear.

## The three axes

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

### Axis 3 — CONCURRENCY SAFETY (read/write isolation on a committed base)

The dispatch fan-out is a mix of READ-ONLY review lenses (reviewer / security-reviewer / closure-parity — they only observe) and, sometimes, a WRITING or PERTURBING agent in the same wall-clock window (a fixer applying a patch, a falsifier mutating a file to test a hypothesis, an agent editing shared source). Read-only lenses MAY run CONCURRENTLY with each other — they contend on nothing. But ANY writing/perturbing agent MUST run SOLO against a COMMITTED base, never concurrently with the review lenses, and every reviewer MUST evaluate the COMMITTED tree (`git show <tip>:<path>`), never the live working tree. Two failure modes bite when this is violated (per `rules/agents.md` § "MUST: Worktree Orchestration" concurrent-readers-read-committed-HEAD + `rules/evidence-first-claims.md` MUST-2/3):

- **(a) Commit-race.** A concurrent writer advances HEAD (or dirties the tree) mid-review; the readers scoped their pass to one base but observe a moving one — the round's verdict is against a base that no longer exists, and the writer's own commit races the readers evaluating it.
- **(b) False finding from a transient perturbation.** A reviewer reads the LIVE working tree and catches a writing/falsifier agent's TRANSIENT, uncommitted mutation, then reports it as a finding (often escalated to CRITICAL — an unexpected byte in a security-sensitive file reads as an attack). The mutation was never in the committed base the wave is scoped to; the finding is an artifact of the concurrency, not a defect. It is `rules/evidence-first-claims.md` MUST-2 at the dispatch layer: a security/anomaly finding (an unexpected byte reads as tampering) MUST be verified against ground truth — here the committed base — BEFORE it is characterized (generalizing the MUST-3 errored-is-zero-evidence family to an uncommitted-transient observation). A **byte-presence** finding ("unexpected byte B in file P") is confirmed against the committed base — `git show <tip>:<path>` — and DISCARDED (with the confirm output recorded) if the byte is not there. A finding that does NOT reduce to a single greppable byte (an absence-class "auth check MISSING", a semantic or cross-file finding) is NOT auto-discarded — it is RE-DERIVED against the committed base (re-run the check) and kept if it still holds. See the DO block.

```text
# DO — read-only lenses concurrent; writer solo on a committed base; findings confirmed against the PINNED base
tip=$(git rev-parse HEAD)                                          # PIN the base — HEAD can move mid-wave
wave = dispatch([reviewer, security-reviewer, closure-parity])    # all READ-ONLY → concurrent OK
# each lens reads `git show $tip:<path>`, never the working tree
# a fixer/falsifier that WRITES runs SOLO, after the read wave drains, on a committed base
for f in wave.findings:
  if f.is_byte_presence:                                          # "unexpected byte B in file P"
    git show "$tip:${f.path}" | grep -q "${f.trigger}" \
      || discard(f, evidence="git show $tip:${f.path} — byte absent")   # transient perturbation → ZERO evidence, recorded
  else:                                                           # absence / semantic / cross-file finding
    re_derive(f, base="$tip")   # RE-RUN the check on the committed base; keep if it still holds
# NEVER blanket-discard a finding just because a single-file grep does not match — an
# absence-class finding ("auth check MISSING") has no byte to grep and is the highest-value class.

# DO NOT — run a writing/perturbing agent alongside the read lenses, review the live tree
wave = dispatch([reviewer, security-reviewer, falsifier_that_writes])   # writer perturbs the tree...
# ...reviewer reads the LIVE working tree, catches the falsifier's transient byte,
#    reports "CRITICAL" on a mutation that is not in `git show $tip:<path>` (commit-race + false finding)
```

**Scope carve-out.** Axis 3 applies when the review subject is a COMMITTED base (the usual `/redteam` wave). When the subject legitimately IS the working-tree / uncommitted state (a pre-commit or working-tree audit), THAT state is the base and findings are confirmed against it — do NOT `git show <tip>` and discard, which would drop every real finding. The invariant is "confirm against the base the wave is SCOPED to", not "the base is always HEAD".

Distinct from Axes 1/2 (which govern WHETHER a reviewer's return counts as evidence): Axis 3 governs the BASE the wave is scoped to and the read/write ISOLATION on it — a concurrency-safety property, not an evidence-completeness one. It COMPLEMENTS `worktree-isolation.md` Rule 4's concurrency BACK-OFF (throttle governance) with concurrency SAFETY (read/write isolation); a writing agent is NOT part of the parallel review wave the back-off model sizes.

## BLOCKED rationalizations

- "All agents returned, the round is clean" (when one returned ERRORED — errored is not returned-clean)
- "0 findings across the wave = converged" (an errored agent contributes 0 to the tally; the tally is a lie)
- "The throttled agent would have found nothing anyway" (unfalsifiable — re-run it)
- "Re-running the errored reviewer doubles the round cost" (the alternative ships an un-reviewed shard)
- "Rate-limiting is transient, the next round will catch it" (the next round may throttle the same way; convergence is being claimed NOW)
- "The other two reviewers ran clean, that's enough coverage" (each reviewer covers a distinct surface — security ≠ closure-parity ≠ correctness)
- "An empty return means the agent had nothing to say" (empty is indistinguishable from errored; treat as zero evidence)
- "Back-off slows convergence, keep full concurrency" (full concurrency that throttles produces partial waves — slower in re-runs than an adaptive wave)
- "The reviewer SAW the bad byte, so it's a real finding" (Axis 3 — it saw a transient uncommitted byte; a security/anomaly finding is verified against ground truth before it counts, per `evidence-first-claims.md` MUST-2 — confirm against `git show <tip>:<path>` first)
- "The writing agent is part of the wave, run it alongside the readers" (Axis 3 — a writer perturbs the base the readers are scoped to; it runs SOLO on a committed base, not in the review wave)
- "Reviewers can read the working tree, it's faster than `git show`" (Axis 3 — the working tree is mutable mid-wave; the committed base is the only stable scope)
- "It's a CRITICAL, ship it now and confirm later" (Axis 3 — an unconfirmed transient finding is the false-positive that consumes the escalation budget real findings need; confirm against the committed base FIRST)
- "Everything's parallel by default, so the fixer parallelizes too" (Axis 3 — parallel-by-default sizes the READ wave; a writer is not a read lens and is not part of it)
- "Grep the committed base and discard every finding the grep doesn't match" (Axis 3 — that suppresses absence-class + semantic/cross-file findings, the highest-value class; ONLY a byte-presence finding is grep-confirmed, the rest are RE-DERIVED against the base)
- "It's a working-tree audit, so `git show <tip>` still confirms the findings" (Axis 3 scope carve-out — when the uncommitted state IS the subject, that state is the base; `git show <tip>` would discard every real finding)

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (the `/redteam` orchestrator + cc-architect at `/codify` confirm every dispatched reviewer in a converged round returned a genuine ran/evidence signal); `advisory` at any hook layer (a lexical "0 findings" detector cannot carry `block` per `rules/hook-output-discipline.md` MUST-2). Inherits the `evidence-first-claims.md` MUST-3 emergency posture for the errored-as-confirmation subclass.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (a converged round tallied over a partial/errored wave) contribute to `rules/trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the `evidence-first-claims.md` `evidence_free_claim` emergency trigger (1× = drop 1 posture) — an errored reviewer counted as clean IS an evidence-free convergence claim.
- **Receipt requirement:** SessionStart `[ack: agents]` IFF `posture.json::pending_verification` includes the `agents` rule_id (shared ack with the rest of `agents.md`).
- **Detection mechanism:** Phase 1 — the `/redteam` orchestrator gates each reviewer on a ran-signal before tallying; for Axis 3, it confirms no writing/perturbing agent ran concurrently with the read lenses AND every finding was confirmed against the committed base (`git show <tip>:<path>`) before counting; cc-architect at `/codify` confirms any "converged" claim cites a full wave of genuine returns evaluated on a stable committed base. Phase 2 (deferred) — a dispatch-layer detector flagging a convergence claim whose wave contains an errored/empty return, advisory.
- **Violation scope:** the EVIDENCE GATE (axis 1) + the CONCURRENCY BACK-OFF (axis 2) + the CONCURRENCY SAFETY read/write-isolation (axis 3). An axis-1/2 violation row names the throttled reviewer + the round declared converged over it; an axis-3 violation row names the concurrent writer + the finding (or verdict) that rested on a transient/racing base.
- **Origin:** kailash-py BUILD-repo `/codify` (Gate-1 classified global, shard C) for Axes 1/2; Axis 3 added 2026-07-13 (loom self-codify, `journal/0475`) from two in-session redteam incidents (a concurrent write-agent commit-race + a false "CRITICAL" a reader caught from a falsifier's transient uncommitted perturbation, disproved via `git show <tip>:<file>`). Generalizes `evidence-first-claims.md` MUST-3 (errored/uncommitted-transient = zero evidence) to the parallel-redteam-dispatch layer; pairs with `worktree-isolation.md` Rule 4 (the throttle-signal contract + adaptive back-off) + `agents.md` § "MUST: Worktree Orchestration" (concurrent-readers-read-committed-HEAD, the isolation Axis 3 instantiates) and § Holistic Post-Multi-Wave Redteam (the wave the gate protects).
